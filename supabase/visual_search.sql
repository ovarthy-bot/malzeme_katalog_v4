-- Görsel arama (visual search): parça fotoğrafına en benzer katalog parçalarını bulur.
--
-- Nasıl çalışır:
--   1. Katalogdaki her parça görseli CLIP (ViT-L/14, 768 boyut) ile vektöre çevrilip bu tabloda saklanır
--      (scripts/embed-catalog.mjs).
--   2. Kullanıcının fotoğrafı Edge Function (supabase/functions/visual-search) ile aynı modelden geçirilir.
--   3. match_parts_by_image() kosinüs benzerliğiyle en yakın görselleri bulur, parça başına en iyisini alır
--      ve ilk N parçayı benzerlikle birlikte döndürür.
--
-- Kurulum sırası:
--   1) Bu dosyayı Supabase Dashboard > SQL Editor'de bir kez çalıştırın. Tekrar çalıştırmak güvenlidir.
--   2) Edge Function'ı yayınlayın (supabase/functions/visual-search/index.ts başındaki adımlar).
--   3) Mevcut görselleri vektörleyin: node scripts/embed-catalog.mjs
--
-- Vektörler ayrı bir tabloda tutulur: part_images tablosuna sütun eklenseydi uygulamanın select('*') sorguları
-- her görsel için 768 sayı daha indirirdi.

create extension if not exists vector with schema extensions;

create table if not exists public.part_image_embeddings (
  image_id bigint primary key references public.part_images(id) on delete cascade,
  embedding vector(768) not null,
  -- Hangi modelle üretildi. Model değişirse vektör uzayları uyuşmaz; betik farklı modelli satırları yeniden üretir.
  model text not null,
  created_at timestamptz not null default now()
);

-- Yaklaşık en yakın komşu araması için HNSW indeksi (kosinüs).
create index if not exists part_image_embeddings_embedding_idx
  on public.part_image_embeddings using hnsw (embedding vector_cosine_ops);

-- Tablo yalnızca sunucu tarafından (service_role: betik ve Edge Function) okunur/yazılır.
-- Diğer tablolardan farklı olarak anon anahtarına açık politika YOKTUR: vektörler tarayıcıya hiç inmez
-- ve kimse anon anahtarıyla vektör ekleyip arama sonuçlarını bozamaz.
alter table public.part_image_embeddings enable row level security;
revoke all on public.part_image_embeddings from anon, authenticated;
grant select, insert, update, delete on public.part_image_embeddings to service_role;

-- Sorgu vektörüne en benzer parçalar. Her parça tek satırdır (parçanın en benzer görseli sayılır),
-- similarity 0..1 aralığında kosinüs benzerliğidir (1 = aynı yönde).
create or replace function public.match_parts_by_image(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  part_id bigint,
  part_number text,
  material_desc text,
  material_type text,
  image_id bigint,
  image_url text,
  similarity double precision
)
language sql
stable
-- HNSW varsayılan olarak en fazla 40 aday döndürür; aşağıdaki aday sayısı için yeterli olsun diye yükseltilir.
set hnsw.ef_search = 100
set search_path = public, extensions
as $$
  -- Bir parçanın birden çok görseli olabilir: önce en yakın görselleri al, sonra parça başına en iyisini seç.
  with nearest as (
    select e.image_id, (e.embedding <=> query_embedding) as distance
    from public.part_image_embeddings e
    order by e.embedding <=> query_embedding
    limit least(greatest(match_count * 10, 50), 100)
  ),
  best_per_part as (
    select distinct on (pi.part_id)
      pi.part_id, n.image_id, pi.image_url, n.distance
    from nearest n
    join public.part_images pi on pi.id = n.image_id
    order by pi.part_id, n.distance, n.image_id
  )
  select
    p.id,
    p.part_number,
    p.material_desc,
    p.material_type,
    b.image_id,
    b.image_url,
    1 - b.distance
  from best_per_part b
  join public.parts p on p.id = b.part_id
  order by b.distance, p.id
  limit match_count;
$$;

-- Tarayıcı bu fonksiyonu doğrudan çağıramaz; yalnızca Edge Function (service_role) çağırır.
revoke all on function public.match_parts_by_image(vector, int) from public, anon, authenticated;
grant execute on function public.match_parts_by_image(vector, int) to service_role;

-- PostgREST şema önbelleğini yenile (fonksiyon hemen görünsün)
notify pgrst, 'reload schema';
