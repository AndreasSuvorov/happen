-- Einmalig im SQL-Editor ausführen, NACHDEM die Function "nudges" deployt ist.
-- <FUNCTIONS_URL> und <CRON_SECRET> ersetzen (CRON_SECRET = gleicher Wert wie das Edge-Function-Secret).
-- Self-hosted (Docker): <FUNCTIONS_URL> = http://kong:8000/functions/v1
-- Cloud:               <FUNCTIONS_URL> = https://<PROJECT_REF>.supabase.co/functions/v1

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<CRON_SECRET>', 'happen_cron_secret');

select cron.schedule(
  'happen-nudges',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := '<FUNCTIONS_URL>/nudges',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'happen_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
