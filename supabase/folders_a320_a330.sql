-- Klasör yapısını A320 / A330 / ORTAK köküne geçirir.
-- Supabase Dashboard > SQL Editor'de BİR KEZ çalıştırın. Önce supabase/folders.sql
-- çalıştırılmış olsun ya da olmasın, güvenle çalışır (eski yapı yoksa ilgili adımlar
-- hiçbir satırı etkilemez).
--
-- Bu script sırasıyla:
--   1) Yeni kök klasörleri oluşturur: A320, A330, ORTAK
--   2) A320 ve A330'un altına aynı 8 alt klasörü ekler
--      (Galley, Lavatory, Floor Panel, VCC, Sidewall, Window, OHSB (Stowage), Divider).
--      ORTAK'ın altında alt klasör olmaz.
--   3) Eski kök klasörlerdeki parçaları, parts.ac_type değerine göre isim eşleşmesi
--      üzerinden yeni A320/A330 alt klasörlerine ya da doğrudan ORTAK'a taşır
--      ("Window (Cam)" -> "Window" eşleşmesi dahil).
--   4) Eski kök klasörleri ve (herhangi bir derinlikteki) tüm alt klasörlerini siler.
--      parts.folder_id FK'si ON DELETE SET NULL olduğundan, 3. adımda taşınmayan
--      parçalar SİLİNMEZ, sadece öksüz (folder_id = null) kalır.

do $$
declare
  v_a320 uuid;
  v_a330 uuid;
  v_ortak uuid;
  v_old_name text;
  v_new_name text;
begin
  -- 1) Kök klasörler
  insert into public.folders (name)
    select 'A320' where not exists (select 1 from public.folders where name = 'A320' and parent_id is null);
  insert into public.folders (name)
    select 'A330' where not exists (select 1 from public.folders where name = 'A330' and parent_id is null);
  insert into public.folders (name)
    select 'ORTAK' where not exists (select 1 from public.folders where name = 'ORTAK' and parent_id is null);

  select id into v_a320 from public.folders where name = 'A320' and parent_id is null limit 1;
  select id into v_a330 from public.folders where name = 'A330' and parent_id is null limit 1;
  select id into v_ortak from public.folders where name = 'ORTAK' and parent_id is null limit 1;

  -- 2) A320 / A330 alt klasörleri (ORTAK'ın altı boş kalır)
  foreach v_new_name in array array['Galley','Lavatory','Floor Panel','VCC','Sidewall','Window','OHSB (Stowage)','Divider']
  loop
    insert into public.folders (name, parent_id)
      select v_new_name, v_a320 where not exists (select 1 from public.folders where name = v_new_name and parent_id = v_a320);
    insert into public.folders (name, parent_id)
      select v_new_name, v_a330 where not exists (select 1 from public.folders where name = v_new_name and parent_id = v_a330);
  end loop;

  -- 3) Eski kök klasörlerdeki parçaları ac_type'a göre yeni yapıya taşı
  for v_old_name, v_new_name in
    select * from (values
      ('Floor Panel', 'Floor Panel'),
      ('OHSB (Stowage)', 'OHSB (Stowage)'),
      ('Window (Cam)', 'Window'),
      ('Galley', 'Galley'),
      ('Lavatory', 'Lavatory'),
      ('Sidewall', 'Sidewall'),
      ('Divider', 'Divider')
    ) as t(old_name, new_name)
  loop
    -- ac_type = 'A320' -> A320 > <new_name>
    update public.parts p
    set folder_id = nf.id
    from public.folders ofd, public.folders nf
    where ofd.name = v_old_name and ofd.parent_id is null
      and nf.name = v_new_name and nf.parent_id = v_a320
      and p.folder_id = ofd.id
      and p.ac_type = 'A320';

    -- ac_type = 'A330' -> A330 > <new_name>
    update public.parts p
    set folder_id = nf.id
    from public.folders ofd, public.folders nf
    where ofd.name = v_old_name and ofd.parent_id is null
      and nf.name = v_new_name and nf.parent_id = v_a330
      and p.folder_id = ofd.id
      and p.ac_type = 'A330';

    -- ac_type = 'Ortak' -> doğrudan ORTAK kök klasörüne (alt klasör yok)
    update public.parts p
    set folder_id = v_ortak
    from public.folders ofd
    where ofd.name = v_old_name and ofd.parent_id is null
      and p.folder_id = ofd.id
      and p.ac_type = 'Ortak';
  end loop;

  -- 4) Eski kök klasörleri ve tüm alt ağaçlarını sil (herhangi bir derinlikte).
  --    3. adımda taşınmamış parçalar burada otomatik olarak öksüz kalır, silinmez.
  with recursive old_root as (
    select id from public.folders
    where parent_id is null
      and name in ('Floor Panel','OHSB (Stowage)','Window (Cam)','Galley','Lavatory','Ceiling Panel','Sidewall','Divider')
  ),
  old_tree as (
    select id from old_root
    union all
    select f.id from public.folders f join old_tree ot on f.parent_id = ot.id
  )
  delete from public.folders where id in (select id from old_tree);
end $$;
