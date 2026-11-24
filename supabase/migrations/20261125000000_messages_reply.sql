-- Antwort des Coaches zu einer Nachricht (Web-Chat), damit der Verlauf auf jedem Gerät vollständig ist
-- und der KI-Coach die letzten Wechsel als Kontext bekommt. Format wie die Antwort von web-chat
-- (z. B. {"kind":"coach","message":"…","cards":[…]}). Lesen über die bestehende Policy messages_self.
alter table public.messages add column if not exists reply jsonb;
