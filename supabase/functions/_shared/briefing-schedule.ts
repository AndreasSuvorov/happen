export interface BriefingSchedule {
  briefing_mode: "after_wake" | "fixed";
  briefing_time: string;
  quiet_from: string;
  quiet_to: string;
  max_pushes_per_day: number;
}

export const defaultSchedule: BriefingSchedule = {
  briefing_mode: "after_wake", briefing_time: "07:00", quiet_from: "22:00", quiet_to: "06:00",
  max_pushes_per_day: 3,
};

function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function inQuietHours(now: number, from: string, to: string): boolean {
  const start = minutes(from);
  const end = minutes(to);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function morningDue(
  schedule: BriefingSchedule, date: string, now: number, sleepEnd: string | null, sleepAndHrvReady: boolean,
): boolean {
  const latest = minutes("09:30");
  // Beyond the fallback deadline allow one delayed run during the morning if cron was unavailable.
  if (inQuietHours(now, schedule.quiet_from, schedule.quiet_to)) return false;
  if (schedule.briefing_mode === "fixed") {
    const target = minutes(schedule.briefing_time);
    return now >= target && now < target + 30;
  }
  if (now >= minutes("12:00")) return false;
  if (now >= latest) return true;
  if (!sleepAndHrvReady || !sleepEnd?.startsWith(date)) return false;
  return now >= Math.max(minutes("06:00"), minutes(sleepEnd.slice(11)) + 15);
}
