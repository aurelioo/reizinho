-- =============================================================
-- Reizinho — schema Supabase (Postgres)
-- Rodar no SQL Editor do projeto. Idempotente onde possível.
-- =============================================================

-- ---------- TEMPLATES DE CONFIGURAÇÃO ----------
create table if not exists templates (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id),
  name          text not null,
  format        text not null default 'reizinho'
                check (format in ('reizinho', 'super8', 'dupla-fixa')),
  third_place_match boolean not null default true,
  best_thirds   text not null default 'performance'
                check (best_thirds in ('performance', 'group')),
  tiebreak_criteria text,
  games_per_match int not null default 4,
  created_at    timestamptz not null default now()
);

-- ---------- EVENTOS ----------
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid() references auth.users (id),
  name          text not null,
  edition       text,
  venue         text,
  event_date    date,
  template_id   uuid references templates (id),
  courts_confirmed boolean not null default false,
  stage         text not null default 'setup'
                check (stage in ('setup', 'groups', 'knockout', 'finished')),
  is_public     boolean not null default true,   -- placar público read-only
  public_slug   text unique,                     -- ex: 'reizinho-3a-etapa'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- ATLETAS (por evento) ----------
create table if not exists athletes (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events (id) on delete cascade,
  name          text not null,
  group_letter  text,                            -- null até o sorteio
  present       boolean not null default false,
  withdrawn     boolean not null default false,
  seq           int,                             -- ordem de importação
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists athletes_event_idx on athletes (event_id);

-- ---------- QUADRAS ----------
create table if not exists courts (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events (id) on delete cascade,
  name          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists courts_event_idx on courts (event_id);

-- ---------- JOGOS (fase de grupos + mata-mata) ----------
create table if not exists games (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events (id) on delete cascade,
  phase         text not null default 'groups'
                check (phase in ('groups', 'ko')),

  -- fase de grupos
  group_letter  text,
  round         int,                             -- 1..3 (rodízio reizinho)

  -- mata-mata
  ko_round_size int,                             -- 16 / 8 / 4 / 2
  ko_slot       int,
  ko_label      text,                            -- 'Q1', 'SF2', 'Final', '3º lugar'
  ko_src_a      jsonb,                           -- { "game_id": uuid, "take": "winner"|"loser" }
  ko_src_b      jsonb,
  bye           boolean not null default false,

  -- confronto
  team_a        uuid[],                          -- athlete ids (null até definir)
  team_b        uuid[],
  score_a       int,
  score_b       int,
  status        text not null default 'queued'
                check (status in ('queued', 'playing', 'waiting', 'done')),
  wo            boolean not null default false,  -- walkover (desistência/lesão)

  -- quadra / tempos
  court_id      uuid references courts (id) on delete set null,
  off_court     boolean not null default false,  -- desceu da quadra, placar pendente
  called_at     timestamptz,                     -- elapsed = now() - called_at
  finished_at   timestamptz,

  sort_order    int not null default 0,          -- ordem de chamada
  updated_at    timestamptz not null default now()
);
create index if not exists games_event_idx on games (event_id, sort_order);
create index if not exists games_status_idx on games (event_id, status);

-- ---------- DESEMPATES (simples 1x1) ----------
create table if not exists tiebreaks (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events (id) on delete cascade,
  group_letter  text not null,
  type          text not null,                   -- '1º e 2º' | '2º e 3º' | 'últimos 3'
  athlete_ids   uuid[] not null,
  winner_id     uuid references athletes (id),
  signature     text not null,                   -- grupo + ids ordenados (dedupe)
  updated_at    timestamptz not null default now(),
  unique (event_id, signature)
);

-- ---------- OUTBOX (fila de sync do client — opcional, espelho local) ----------
-- O client local-first guarda mutações offline no IndexedDB; esta tabela
-- registra a última versão aplicada por dispositivo pra auditoria de merge.
create table if not exists sync_log (
  id            bigint generated always as identity primary key,
  event_id      uuid not null references events (id) on delete cascade,
  device_id     text not null,
  mutation      jsonb not null,                  -- { table, pk, patch, client_ts }
  applied_at    timestamptz not null default now()
);

-- =============================================================
-- updated_at automático
-- =============================================================
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['events', 'athletes', 'games', 'tiebreaks'] loop
    execute format(
      'drop trigger if exists %I on %I;
       create trigger %I before update on %I
       for each row execute function touch_updated_at();',
      t || '_touch', t, t || '_touch', t);
  end loop;
end $$;

-- =============================================================
-- RLS — dono escreve; público lê placar de evento is_public
-- =============================================================
alter table templates enable row level security;
alter table events    enable row level security;
alter table athletes  enable row level security;
alter table courts    enable row level security;
alter table games     enable row level security;
alter table tiebreaks enable row level security;
alter table sync_log  enable row level security;

-- dono: acesso total
create policy tpl_owner   on templates for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy ev_owner    on events    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy ath_owner on athletes for all
  using (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()))
  with check (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()));
create policy crt_owner on courts for all
  using (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()))
  with check (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()));
create policy gm_owner on games for all
  using (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()))
  with check (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()));
create policy tb_owner on tiebreaks for all
  using (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()))
  with check (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()));
create policy log_owner on sync_log for all
  using (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()))
  with check (exists (select 1 from events e where e.id = event_id and e.owner_id = auth.uid()));

-- público (anon): leitura do placar de eventos públicos
create policy ev_public  on events    for select using (is_public);
create policy ath_public on athletes  for select
  using (exists (select 1 from events e where e.id = event_id and e.is_public));
create policy crt_public on courts for select
  using (exists (select 1 from events e where e.id = event_id and e.is_public));
create policy gm_public on games for select
  using (exists (select 1 from events e where e.id = event_id and e.is_public));
create policy tb_public on tiebreaks for select
  using (exists (select 1 from events e where e.id = event_id and e.is_public));

-- =============================================================
-- Realtime: placar ao vivo (telão / celular dos atletas)
-- =============================================================
alter publication supabase_realtime add table games;
alter publication supabase_realtime add table athletes;
alter publication supabase_realtime add table tiebreaks;
