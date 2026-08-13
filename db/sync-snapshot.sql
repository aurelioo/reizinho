-- =============================================================
-- Sync v1: snapshot inteiro do evento por usuário (jsonb).
-- Rodar no SQL Editor. Requer Auth → Providers → Anonymous ON.
-- =============================================================

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table if not exists event_snapshots (
  id          text not null,                 -- id do snapshot ('default')
  owner_id    uuid not null default auth.uid() references auth.users (id),
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (owner_id, id)
);

alter table event_snapshots enable row level security;

create policy snap_owner on event_snapshots for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop trigger if exists event_snapshots_touch on event_snapshots;
create trigger event_snapshots_touch before update on event_snapshots
  for each row execute function touch_updated_at();

alter publication supabase_realtime add table event_snapshots;
