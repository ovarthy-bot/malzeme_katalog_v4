-- Toplu görsel yükleme sayfasının (import.html) kapasite bilgisini okuyabilmesi için.
-- Supabase Dashboard > SQL Editor'de bir kez çalıştırın.

-- Veritabanının bayt cinsinden boyutu (500 MB sınırına karşılık gelir).
-- Çağıran rolün yetkisiyle çalışır.
create or replace function public.get_db_size()
returns bigint
language sql
stable
set search_path = ''
as $$
  select pg_database_size(current_database());
$$;

-- Tüm Storage bucket'larındaki dosyaların toplam boyutu (bayt), 1 GB sınırına karşılık gelir.
-- storage.objects tablosu anon rolüne açık olmadığı için SECURITY DEFINER kullanılır;
-- fonksiyon yalnızca tek bir toplam sayı döndürür, dosya satırlarını döndürmez.
create or replace function public.get_storage_size()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects;
$$;

revoke all on function public.get_db_size() from public;
revoke all on function public.get_storage_size() from public;
grant execute on function public.get_db_size() to anon, authenticated;
grant execute on function public.get_storage_size() to anon, authenticated;
