-- Einmalig im SQL-Editor ausführen, NACHDEM die Function "nudges" deployt ist.
-- <PROJECT_REF> und <CRON_SECRET> ersetzen (CRON_SECRET = gleicher Wert wie das Edge-Function-Secret).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'happen_cron_secret');

select cron.schedule(
  'happen-nudges',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/nudges',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'happen_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
