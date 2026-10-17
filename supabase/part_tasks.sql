-- İlişkili Task: bir parçaya bağlı birden çok task tutulur (parça detayında listelenir; düzenlenebilir ve silinebilir).
-- Veriler Ayarlar > Araçlar > "İlişkili Task yükle" ile Excel'den (A: parça no, B: task) toplu eklenir.
-- Supabase Dashboard > SQL Editor'de bir kez çalıştırın. Tekrar çalıştırmak güvenlidir.

create table if not exists public.part_tasks (
  id bigint generated always as identity primary key,
  part_id bigint not null references public.parts(id) on delete cascade,
  task text not null check (length(btrim(task)) > 0),
  created_at timestamptz not null default now(),
  unique (part_id, task)
);

alter table public.part_tasks enable row level security;

drop policy if exists "part_tasks_select" on public.part_tasks;
drop policy if exists "part_tasks_insert" on public.part_tasks;
drop policy if exists "part_tasks_update" on public.part_tasks;
drop policy if exists "part_tasks_delete" on public.part_tasks;

create policy "part_tasks_select" on public.part_tasks for select using (true);
create policy "part_tasks_insert" on public.part_tasks for insert with check (true);
create policy "part_tasks_update" on public.part_tasks for update using (true);
create policy "part_tasks_delete" on public.part_tasks for delete using (true);

grant select, insert, update, delete on public.part_tasks to anon, authenticated;

-- PostgREST şema önbelleğini yenile (tablo hemen görünsün)
notify pgrst, 'reload schema';
