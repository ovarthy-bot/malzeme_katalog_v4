-- Görsel arama (visual search): parça fotoğrafına en benzer katalog parçalarını bulur.
--
-- Nasıl çalışır:
--   1. Görsel arama artık tamamen sunucusuz (Edge Function veya ücretli Replicate API olmadan) çalışır.
--   2. Katalog görselleri DINOv2 (Xenova/dinov2-small, 384 boyut) ile vektöre çevrilerek
--      Supabase Storage (part-images/visual-index/dinov2-small-v1.bin) üzerinde saklanır.
--   3. Kullanıcının seçtiği fotoğraf doğrudan tarayıcıda aynı modelden geçirilir ve en benzer 5 parça listelenir.
--   4. Yeni görsel eklendiğinde Ayarlar > Araçlar > "Görsel arama dizini" veya
--      `node scripts/embed-catalog.mjs` komutuyla dizin güncellenebilir.
--
-- İsteğe bağlı veritabanı tablosu (Postgres/pgvector tarafında da saklamak isterseniz):

create extension if not exists vector with schema extensions;

create table if not exists public.part_image_embeddings (
  image_id bigint primary key references public.part_images(id) on delete cascade,
  embedding vector(384) not null,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists part_image_embeddings_embedding_idx
  on public.part_image_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.part_image_embeddings enable row level security;

drop policy if exists "part_image_embeddings_select" on public.part_image_embeddings;
drop policy if exists "part_image_embeddings_insert" on public.part_image_embeddings;
drop policy if exists "part_image_embeddings_update" on public.part_image_embeddings;
drop policy if exists "part_image_embeddings_delete" on public.part_image_embeddings;

create policy "part_image_embeddings_select" on public.part_image_embeddings for select using (true);
create policy "part_image_embeddings_insert" on public.part_image_embeddings for insert with check (true);
create policy "part_image_embeddings_update" on public.part_image_embeddings for update using (true);
create policy "part_image_embeddings_delete" on public.part_image_embeddings for delete using (true);

grant select, insert, update, delete on public.part_image_embeddings to anon, authenticated, service_role;

notify pgrst, 'reload schema';
