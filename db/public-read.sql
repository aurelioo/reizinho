-- =============================================================
-- Placar público: leitura anônima de snapshots marcados is_public.
-- Rodar depois de db/sync-snapshot.sql.
-- =============================================================

alter table event_snapshots
  add column if not exists is_public boolean not null default true;

drop policy if exists snap_public_read on event_snapshots;
create policy snap_public_read on event_snapshots
  for select
  to anon
  using (is_public);
