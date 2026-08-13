-- =============================================================
-- Bucket público de logos (patrocinadores/apoiadores).
-- Upload feito pelo app (organizador autenticado); leitura pública.
-- O placar só exibe logos registradas no snapshot do organizador,
-- então arquivo solto no bucket não aparece pra ninguém.
-- =============================================================

insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

drop policy if exists logos_public_read on storage.objects;
create policy logos_public_read on storage.objects
  for select to public
  using (bucket_id = 'logos');

drop policy if exists logos_auth_insert on storage.objects;
create policy logos_auth_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'logos');

drop policy if exists logos_owner_delete on storage.objects;
create policy logos_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'logos' and owner_id = auth.uid()::text);
