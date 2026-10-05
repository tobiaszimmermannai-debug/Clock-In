-- =============================================================================
-- Clock-In · Schritt 1b: Telegram-Benachrichtigungen
-- =============================================================================
-- Ablauf
--   time_logs INSERT → Trigger → pg_net → Edge Function telegram-notify → Telegram
--   Button ✅/❌ in Telegram → Edge Function telegram-webhook → Freigabe in time_logs
--
-- Einmalige Einrichtung: docs/setup-telegram.md (Vault-Secrets
-- edge_functions_url + notify_secret). Ohne diese Secrets bleibt der Trigger stumm.
-- =============================================================================

create extension if not exists pg_net;

-- Telegram-Chat ↔ Person (privater Chat: chat_id = Telegram-User-ID)
create table public.telegram_links (
  user_id         uuid primary key references public.users (id) on delete cascade,
  chat_id         bigint not null unique,
  notify_bookings boolean not null default true,  -- jede Stempelung melden; Freigabe-Anfragen kommen immer
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on public.telegram_links
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.telegram_links
  for each row execute function private.audit_changes();

alter table public.telegram_links enable row level security;

-- Verknüpfen nur Admin (mit 2FA); abmelden darf jeder selbst
create policy telegram_links_select on public.telegram_links for select to authenticated
  using (user_id = (select private.current_user_id()) or (select private.is_admin()));
create policy telegram_links_insert on public.telegram_links for insert to authenticated
  with check ((select private.is_admin()));
create policy telegram_links_update on public.telegram_links for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy telegram_links_delete on public.telegram_links for delete to authenticated
  using (user_id = (select private.current_user_id()) or (select private.is_admin()));

revoke all on public.telegram_links from anon;
revoke truncate on public.telegram_links from authenticated;

-- Neue Buchung → Edge Function (asynchron über pg_net, blockiert das Stempeln nie)
create function private.notify_time_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return null;  -- Telegram noch nicht eingerichtet
  end if;

  perform net.http_post(
    url     := v_url || '/telegram-notify',
    body    := jsonb_build_object('type', 'time_log', 'id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret)
  );
  return null;
exception when others then
  raise warning 'Telegram-Benachrichtigung fehlgeschlagen: %', sqlerrm;
  return null;  -- Stempeln darf nie an Telegram scheitern
end $$;

create trigger notify_telegram after insert on public.time_logs
  for each row execute function private.notify_time_log();
