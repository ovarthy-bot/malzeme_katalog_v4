-- Klasörleme özelliği: folders tablosu, parts.folder_id sütunu ve başlangıç klasörleri.
-- Supabase Dashboard > SQL Editor'de bir kez çalıştırın. Tekrar çalıştırmak güvenlidir
-- (tablo/sütun varsa yeniden oluşturulmaz, başlangıç klasörleri tekrar eklenmez).

create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references public.folders(id) on delete set null,
  bg_image_url text,
  created_at timestamptz not null default now()
);

create index if not exists folders_parent_id_idx on public.folders(parent_id);

-- Klasör silindiğinde içindeki parçalar silinmez, sadece öksüz (folder_id = null) kalır.
alter table public.parts
  add column if not exists folder_id uuid references public.folders(id) on delete set null;

create index if not exists parts_folder_id_idx on public.parts(folder_id);

alter table public.folders enable row level security;

drop policy if exists "folders_select" on public.folders;
drop policy if exists "folders_insert" on public.folders;
drop policy if exists "folders_update" on public.folders;
drop policy if exists "folders_delete" on public.folders;

create policy "folders_select" on public.folders for select using (true);
create policy "folders_insert" on public.folders for insert with check (true);
create policy "folders_update" on public.folders for update using (true);
create policy "folders_delete" on public.folders for delete using (true);

grant select, insert, update, delete on public.folders to anon, authenticated;

-- Başlangıç klasör hiyerarşisi (isim + üst klasöre göre tekil; varsa yeniden eklenmez)
do $$
declare
  v_ohsb uuid;
  v_galley uuid;
  v_lavatory uuid;
begin
  insert into public.folders (name)
    select 'Floor Panel' where not exists (select 1 from public.folders where name = 'Floor Panel' and parent_id is null);
  insert into public.folders (name)
    select 'OHSB (Stowage)' where not exists (select 1 from public.folders where name = 'OHSB (Stowage)' and parent_id is null);
  insert into public.folders (name)
    select 'Window (Cam)' where not exists (select 1 from public.folders where name = 'Window (Cam)' and parent_id is null);
  insert into public.folders (name)
    select 'Galley' where not exists (select 1 from public.folders where name = 'Galley' and parent_id is null);
  insert into public.folders (name)
    select 'Lavatory' where not exists (select 1 from public.folders where name = 'Lavatory' and parent_id is null);
  insert into public.folders (name)
    select 'Ceiling Panel' where not exists (select 1 from public.folders where name = 'Ceiling Panel' and parent_id is null);
  insert into public.folders (name)
    select 'Sidewall' where not exists (select 1 from public.folders where name = 'Sidewall' and parent_id is null);
  insert into public.folders (name)
    select 'Divider' where not exists (select 1 from public.folders where name = 'Divider' and parent_id is null);

  select id into v_ohsb from public.folders where name = 'OHSB (Stowage)' and parent_id is null limit 1;
  select id into v_galley from public.folders where name = 'Galley' and parent_id is null limit 1;
  select id into v_lavatory from public.folders where name = 'Lavatory' and parent_id is null limit 1;

  insert into public.folders (name, parent_id)
    select 'Handrail', v_ohsb where not exists (select 1 from public.folders where name = 'Handrail' and parent_id = v_ohsb);
  insert into public.folders (name, parent_id)
    select 'Stowage Door', v_ohsb where not exists (select 1 from public.folders where name = 'Stowage Door' and parent_id = v_ohsb);

  insert into public.folders (name, parent_id)
    select 'Lower Attachments', v_galley where not exists (select 1 from public.folders where name = 'Lower Attachments' and parent_id = v_galley);
  insert into public.folders (name, parent_id)
    select 'Upper Attachments', v_galley where not exists (select 1 from public.folders where name = 'Upper Attachments' and parent_id = v_galley);
  insert into public.folders (name, parent_id)
    select 'Oven', v_galley where not exists (select 1 from public.folders where name = 'Oven' and parent_id = v_galley);

  insert into public.folders (name, parent_id)
    select 'Bowl', v_lavatory where not exists (select 1 from public.folders where name = 'Bowl' and parent_id = v_lavatory);
  insert into public.folders (name, parent_id)
    select 'Lower Attachments', v_lavatory where not exists (select 1 from public.folders where name = 'Lower Attachments' and parent_id = v_lavatory);
  insert into public.folders (name, parent_id)
    select 'Upper Attachments', v_lavatory where not exists (select 1 from public.folders where name = 'Upper Attachments' and parent_id = v_lavatory);
end $$;
