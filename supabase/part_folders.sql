-- Klasör kısayolları: aynı parça birden çok klasörde (ör. hem A320 hem A330) görünsün diye.
-- parts.folder_id parçanın asıl klasörüdür; bu tablodaki satırlar ek (sanal) klasörlerdir, parça kopyalanmaz.
-- Supabase Dashboard > SQL Editor'de bir kez çalıştırın. Tekrar çalıştırmak güvenlidir.

create table if not exists public.part_folders (
  part_id bigint not null references public.parts(id) on delete cascade,
  folder_id uuid not null references public.folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (part_id, folder_id)
);

create index if not exists part_folders_folder_id_idx on public.part_folders(folder_id);

alter table public.part_folders enable row level security;

drop policy if exists "part_folders_select" on public.part_folders;
drop policy if exists "part_folders_insert" on public.part_folders;
drop policy if exists "part_folders_update" on public.part_folders;
drop policy if exists "part_folders_delete" on public.part_folders;

create policy "part_folders_select" on public.part_folders for select using (true);
create policy "part_folders_insert" on public.part_folders for insert with check (true);
create policy "part_folders_update" on public.part_folders for update using (true);
create policy "part_folders_delete" on public.part_folders for delete using (true);

grant select, insert, update, delete on public.part_folders to anon, authenticated;
