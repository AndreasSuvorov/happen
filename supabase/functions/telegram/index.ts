// Telegram-Webhook für Happen: Foto, Sprache oder Text rein → Eintrag mit Kalorienspanne raus.
import { db, dayBounds, dayTotals, findUserByChatId, knownMeals, latestKg, profileOf, redeemLinkCode, weightTrend, type UserRow } from "../_shared/db.ts";
import { estimate, EstimateRefused, type Estimate } from "../_shared/estimate.ts";
import {
  baseTdee,
  dailyBudget,
  fmtKcal,
  fmtKg,
  fmtSigned,
  localDate,
  parseProfile,
  parseWeight,
  runKcalGross,
} from "../_shared/nutrition.ts";
import { sttEnabled, transcribe } from "../_shared/stt.ts";
import * as tg from "../_shared/telegram.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

// Von der Supabase Edge Runtime bereitgestellt.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// deno-lint-ignore no-explicit-any
type Update = any;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update: Update = await req.json();
  // Sofort antworten, damit Telegram nicht erneut zustellt; Verarbeitung läuft im Hintergrund.
  EdgeRuntime.waitUntil(handle(update).catch((e) => console.error("handle failed", e)));
  return new Response("ok");
});

async function handle(update: Update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if (!msg?.chat?.id) return;
  const chatId: number = msg.chat.id;
  const text0: string = (msg.text ?? "").trim();

  let user = await findUserByChatId(chatId);
  if (!user) {
    const m = text0.match(/^\/start\s+(\S+)/);
    if (m) {
      user = await redeemLinkCode(m[1], chatId);
      if (user) {
        await tg.sendMessage(chatId, "Verbunden! Dein Telegram-Chat ist jetzt mit deinem Happen-Konto verknüpft.");
        return;
      }
    }
    await tg.sendMessage(
      chatId,
      "Dieser Chat ist noch mit keinem Happen-Konto verknüpft. Öffne die App, logg dich ein und verbinde Telegram unter „Einstellungen“.",
    );
    return;
  }
  const text: string = (msg.text ?? msg.caption ?? "").trim();

  // Befehle und Gewicht brauchen keine KI.
  if (msg.text) {
    if (await handleCommand(user, text)) return;
    const kg = parseWeight(text);
    if (kg) return logWeight(user, kg);
  }

  const kind = msg.photo ? "photo" : msg.voice ? "voice" : "text";
  if (kind === "text" && !text) return;

  const { data: row, error } = await db
    .from("messages")
    .insert({
      user_id: user.id,
      telegram_message_id: msg.message_id,
      kind,
      telegram_file_id: msg.photo ? msg.photo.at(-1).file_id : msg.voice?.file_id ?? null,
      text: text || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const messageId: string = row.id;

  await tg.sendTyping(chatId);
  try {
    let image: { base64: string; mediaType: "image/jpeg" } | undefined;
    let input = text;

    if (msg.photo) {
      // Größte Variante (Telegram skaliert auf max. 1280 px).
      const { bytes } = await tg.downloadFile(msg.photo.at(-1).file_id);
      await storeRaw(user, messageId, bytes, "jpg", "image/jpeg");
      image = { base64: toBase64(bytes), mediaType: "image/jpeg" };
    } else if (msg.voice) {
      if (!sttEnabled()) {
        await tg.sendMessage(chatId, "Sprachnachrichten sind noch nicht eingerichtet. Schreib es mir kurz oder schick ein Foto.");
        await db.from("messages").update({ status: "ignored" }).eq("id", messageId);
        return;
      }
      const { bytes } = await tg.downloadFile(msg.voice.file_id);
      await storeRaw(user, messageId, bytes, "ogg", "audio/ogg");
      input = await transcribe(bytes);
      await db.from("messages").update({ transcript: input }).eq("id", messageId);
    }

    const est = await estimate({
      text: input,
      image,
      localNow: new Date().toLocaleString("de-DE", {
        timeZone: user.timezone,
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      knownMeals: await knownMeals(user),
    });

    if (est.kind === "food") await saveFood(user, messageId, est, kind === "voice" ? input : undefined);
    else if (est.kind === "activity") await saveActivity(user, messageId, est);
    else await tg.sendMessage(chatId, tg.escapeHtml(est.reply_text || "Schick mir einfach ein Foto oder schreib, was du gegessen hast."));

    await db.from("messages").update({ status: "processed" }).eq("id", messageId);
  } catch (e) {
    console.error(e);
    await db.from("messages").update({ status: "failed", error: String(e) }).eq("id", messageId);
    const hint = e instanceof EstimateRefused ? "Das konnte ich leider nicht einschätzen." : "Da ist etwas schiefgelaufen.";
    await tg.sendMessage(chatId, `${hint} Die Nachricht ist gespeichert, ich kann sie später nachholen.`);
  }
}

// ---------- Essen ----------

function eatenAt(user: UserRow, est: Estimate): string {
  const now = new Date();
  if (est.day_offset === 0 && !est.time_hint) return now.toISOString();
  const date = localDate(new Date(now.getTime() + est.day_offset * 86_400_000), user.timezone);
  const { from } = dayBounds(user.timezone, date);
  const m = est.time_hint.match(/^(\d{1,2}):(\d{2})$/);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60;
  const t = new Date(Date.parse(from) + minutes * 60_000);
  return (t > now ? now : t).toISOString();
}

async function saveFood(user: UserRow, messageId: string, est: Estimate, transcript?: string) {
  const hasQuestion = est.question.text && est.question.options.length >= 2;
  const { data: entry, error } = await db
    .from("entries")
    .insert({
      user_id: user.id,
      message_id: messageId,
      eaten_at: eatenAt(user, est),
      meal: est.meal,
      title: est.title,
      items: est.items,
      kcal_low: est.kcal_low,
      kcal_mid: est.kcal_mid,
      kcal_high: est.kcal_high,
      protein_g: est.protein_g,
      confidence: est.confidence,
      note: est.note || null,
      question: hasQuestion ? est.question : null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const text = (transcript ? `<i>„${tg.escapeHtml(transcript)}“</i>\n\n` : "") + (await entryText(user, entry));
  await tg.sendMessage(user.telegram_chat_id, text, entryButtons(entry));
}

// deno-lint-ignore no-explicit-any
async function entryText(user: UserRow, entry: any): Promise<string> {
  const lines = [
    `<b>${tg.escapeHtml(entry.title)}</b>`,
    `≈ ${fmtKcal(entry.kcal_mid)} kcal (${fmtKcal(entry.kcal_low)}–${fmtKcal(entry.kcal_high)}) · Protein ~${entry.protein_g ?? 0} g`,
  ];
  if (entry.note) lines.push(`<i>${tg.escapeHtml(entry.note)}</i>`);
  if (entry.answer) lines.push(`✓ ${tg.escapeHtml(entry.answer)}`);
  lines.push("", await todayLine(user));
  if (entry.question && !entry.answer) lines.push("", `❓ ${tg.escapeHtml(entry.question.text)}`);
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function entryButtons(entry: any): tg.InlineButton[][] {
  const rows: tg.InlineButton[][] = [];
  if (entry.question && !entry.answer) {
    rows.push(
      // deno-lint-ignore no-explicit-any
      entry.question.options.slice(0, 3).map((o: any, i: number) => ({ text: o.label, callback_data: `a:${i}:${entry.id}` })),
    );
  }
  rows.push([{ text: "🗑 Löschen", callback_data: `d:${entry.id}` }]);
  return rows;
}

async function todayLine(user: UserRow): Promise<string> {
  const t = await dayTotals(user);
  const kg = await latestKg(user);
  const tdee = kg ? baseTdee(profileOf(user), kg) : null;
  if (!tdee) {
    return `Heute: ≈ ${fmtKcal(t.mid)} kcal (${fmtKcal(t.low)}–${fmtKcal(t.high)})`;
  }
  const budget = dailyBudget(tdee, Number(user.goal_kg_per_week), t.runKcal);
  const left = budget - t.mid;
  return `Heute: ≈ ${fmtKcal(t.mid)} von ≈ ${fmtKcal(budget)} kcal · ${left >= 0 ? `noch ≈ ${fmtKcal(left)}` : `≈ ${fmtKcal(-left)} drüber`}`;
}

// ---------- Aktivität ----------

async function saveActivity(user: UserRow, messageId: string, est: Estimate) {
  const kg = (await latestKg(user)) ?? 80;
  const km = est.activity.distance_km || 0;
  const factor = est.activity.type === "walk" ? 0.5 : est.activity.type === "run" ? 1 : 0;
  const kcal = km && factor ? Math.round(runKcalGross(kg, km) * factor) : null;
  const { error } = await db.from("activities").insert({
    user_id: user.id,
    message_id: messageId,
    started_at: eatenAt(user, est),
    type: est.activity.type || "other",
    distance_km: km || null,
    duration_min: est.activity.duration_min || null,
    kcal_gross: kcal,
  });
  if (error) throw new Error(error.message);
  const what = [km ? `${fmtKg(km)} km` : null, est.activity.duration_min ? `${est.activity.duration_min} min` : null]
    .filter(Boolean)
    .join(" · ");
  const lines = [`🏃 <b>${tg.escapeHtml(est.title || "Training")}</b>${what ? ` – ${what}` : ""} notiert.`];
  if (kcal) lines.push(`Verbrauch brutto ≈ ${fmtKcal(kcal)} kcal, davon zählt die Hälfte fürs Budget.`);
  lines.push("", await todayLine(user));
  await tg.sendMessage(user.telegram_chat_id, lines.join("\n"));
}

// ---------- Gewicht ----------

async function logWeight(user: UserRow, kg: number) {
  const today = localDate(new Date(), user.timezone);
  const { error } = await db.from("weights").upsert({ user_id: user.id, measured_on: today, kg }, { onConflict: "user_id,measured_on" });
  if (error) throw new Error(error.message);
  const { series, rate } = await weightTrend(user);
  const trend = series.at(-1)?.trend ?? kg;
  const lines = [`⚖️ ${fmtKg(kg)} kg notiert.`];
  if (series.length < 5) {
    lines.push(`Trend: ${fmtKg(trend)} kg. Nach ein paar Tagen wird er aussagekräftig.`);
  } else {
    lines.push(`Trend: ${fmtKg(trend)} kg${rate !== null ? ` (${fmtSigned(rate, 2)} kg/Woche)` : ""}`);
  }
  if (Math.abs(kg - trend) >= 1.5) {
    lines.push("", "Größerer Sprung zum Trend – das ist fast immer Wasser, Salz oder Kohlenhydrate, kein Fett. Der Trend zählt.");
  }
  await tg.sendMessage(user.telegram_chat_id, lines.join("\n"));
}

// ---------- Befehle ----------

async function handleCommand(user: UserRow, text: string): Promise<boolean> {
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");
  const chat = user.telegram_chat_id;
  switch (cmd) {
    case "/start":
    case "/hilfe":
      await tg.sendMessage(
        chat,
        [
          "<b>Happen</b> – schick mir einfach, was du isst.",
          "",
          "📸 Foto vom Teller (gern mit kurzer Bildunterschrift)",
          "🎙 Sprachnachricht: „Zwei Brötchen mit Käse und ein Cappuccino“",
          "✍️ Text, auch nachträglich: „gestern Abend noch eine halbe Tüte Chips“",
          "🏃 „12 km gelaufen“",
          "⚖️ Morgens nur die Zahl: <code>101,4</code>",
          "",
          "/heute – Tagesübersicht · /woche – Wochenbilanz · /undo – letzten Eintrag löschen",
          "/profil 176 1985 m – Größe, Jahrgang, Geschlecht (für das Tagesbudget)",
        ].join("\n"),
      );
      return true;
    case "/profil": {
      const p = parseProfile(text);
      if (!p) {
        await tg.sendMessage(chat, "Format: <code>/profil 176 1985 m</code> (Größe in cm, Jahrgang, m/f)");
        return true;
      }
      await db.from("users").update({ height_cm: p.heightCm, birth_year: p.birthYear, sex: p.sex }).eq("id", user.id);
      await tg.sendMessage(chat, "Profil gespeichert. Ab jetzt zeige ich dir ein Tagesbudget.");
      return true;
    }
    case "/heute":
      await sendToday(user);
      return true;
    case "/woche":
      await sendWeek(user);
      return true;
    case "/undo":
      await undoLast(user);
      return true;
    default:
      return false;
  }
}

async function sendToday(user: UserRow) {
  const { from, to } = dayBounds(user.timezone, localDate(new Date(), user.timezone));
  const { data } = await db
    .from("entries")
    .select("title, kcal_mid, eaten_at")
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .gte("eaten_at", from)
    .lt("eaten_at", to)
    .order("eaten_at");
  const rows = (data ?? []).map((e) => {
    const time = new Date(e.eaten_at).toLocaleTimeString("de-DE", { timeZone: user.timezone, hour: "2-digit", minute: "2-digit" });
    return `${time}  ${tg.escapeHtml(e.title)} – ${fmtKcal(e.kcal_mid)} kcal`;
  });
  await tg.sendMessage(user.telegram_chat_id, [...(rows.length ? rows : ["Noch nichts erfasst."]), "", await todayLine(user)].join("\n"));
}

async function sendWeek(user: UserRow) {
  const since = localDate(new Date(Date.now() - 7 * 86_400_000), user.timezone);
  const { data } = await db.from("daily_intake").select("local_date, kcal_mid").eq("user_id", user.id).gt("local_date", since);
  const days = data ?? [];
  const avg = days.length ? days.reduce((s, d) => s + Number(d.kcal_mid), 0) / days.length : 0;
  const { series, rate } = await weightTrend(user);
  const last = series.at(-1);
  const lines = ["<b>Letzte 7 Tage</b>", `Erfasst an ${days.length} von 7 Tagen · Ø ≈ ${fmtKcal(avg)} kcal`];
  if (last) lines.push(`Trend: ${fmtKg(last.trend)} kg${rate !== null ? ` (${fmtSigned(rate, 2)} kg/Woche)` : ""}`);
  await tg.sendMessage(user.telegram_chat_id, lines.join("\n"));
}

async function undoLast(user: UserRow) {
  const { data: entry } = await db
    .from("entries")
    .select("id, title, created_at")
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!entry) {
    await tg.sendMessage(user.telegram_chat_id, "Es gibt nichts zum Löschen.");
    return;
  }
  await db.from("entries").update({ status: "deleted" }).eq("id", entry.id);
  await tg.sendMessage(user.telegram_chat_id, `🗑 „${tg.escapeHtml(entry.title)}“ gelöscht.\n\n${await todayLine(user)}`);
}

// ---------- Buttons ----------

// deno-lint-ignore no-explicit-any
async function handleCallback(cq: any) {
  const chatId: number = cq.message?.chat?.id;
  if (!ALLOWED.has(chatId)) return tg.answerCallback(cq.id);
  const user = await upsertUser(chatId);
  const [action, a, b] = String(cq.data ?? "").split(":");
  const entryId = action === "a" ? b : a;
  const { data: entry } = await db.from("entries").select("*").eq("id", entryId).eq("user_id", user.id).maybeSingle();
  if (!entry) return tg.answerCallback(cq.id, "Eintrag nicht gefunden");

  if (action === "d") {
    await db.from("entries").update({ status: "deleted" }).eq("id", entry.id);
    await tg.answerCallback(cq.id, "Gelöscht");
    await tg.editMessage(chatId, cq.message.message_id, `🗑 <s>${tg.escapeHtml(entry.title)}</s> gelöscht.\n\n${await todayLine(user)}`);
    return;
  }
  if (action === "a") {
    const opt = entry.question?.options?.[Number(a)];
    if (!opt) return tg.answerCallback(cq.id);
    const { data: updated } = await db
      .from("entries")
      .update({ kcal_low: opt.kcal_low, kcal_mid: opt.kcal_mid, kcal_high: opt.kcal_high, answer: opt.label, status: "confirmed" })
      .eq("id", entry.id)
      .select("*")
      .single();
    await tg.answerCallback(cq.id, "Angepasst");
    await tg.editMessage(chatId, cq.message.message_id, await entryText(user, updated), entryButtons(updated));
  }
}

// ---------- Hilfsfunktionen ----------

async function storeRaw(user: UserRow, messageId: string, bytes: Uint8Array, ext: string, contentType: string) {
  const d = new Date();
  const path = `${user.id}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${messageId}.${ext}`;
  const { error } = await db.storage.from("inbox").upload(path, bytes, { contentType, upsert: true });
  if (error) console.error("storage upload failed", error.message); // nicht kritisch
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
