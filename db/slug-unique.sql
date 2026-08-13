-- =============================================================
-- Slug único por conta (endereço do link do atleta).
-- Rodar no SQL Editor.
-- =============================================================

-- 0) Limpeza pontual: duas contas gravaram "aldeia" antes da trava.
--    A conta da Liga Dubai (a990c4ad…) fica com o slug; a outra perde.
update event_snapshots
  set data = jsonb_set(data, '{db,slug}', '""')
  where data->'db'->>'slug' = 'aldeia'
    and owner_id <> 'a990c4ad-4cf6-434c-bad3-197a719491e7';

-- 1) Coluna gerada a partir do jsonb + unique index parcial:
--    o banco garante que duas contas nunca gravam o mesmo slug.
alter table event_snapshots
  add column if not exists slug text
  generated always as (nullif(data->'db'->>'slug', '')) stored;

create unique index if not exists event_snapshots_slug_uniq
  on event_snapshots (slug) where slug is not null;
