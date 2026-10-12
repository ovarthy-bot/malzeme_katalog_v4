-- Ayarlar > "Öneriler ve hatalar" not alanı: yazılan metin bu tabloda saklanır.
-- Supabase Dashboard > SQL Editor'de bir kez çalıştırın. Tekrar çalıştırmak güvenlidir.

create table if not exists public.app_notes (
  key text primary key,
  content text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.app_notes enable row level security;

drop policy if exists "app_notes_select" on public.app_notes;
drop policy if exists "app_notes_insert" on public.app_notes;
drop policy if exists "app_notes_update" on public.app_notes;

create policy "app_notes_select" on public.app_notes for select using (true);
create policy "app_notes_insert" on public.app_notes for insert with check (true);
create policy "app_notes_update" on public.app_notes for update using (true);

grant select, insert, update on public.app_notes to anon, authenticated;
