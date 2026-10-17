-- "Karışık" klasörlerindeki gereksiz kısayolları temizler: asıl klasörü Karışık olmayan
-- parçaların Karışık kısayolları silinir. Önce SELECT ile kontrol edin.
-- select p.part_number, f.name from part_folders pf join folders f on f.id = pf.folder_id join parts p on p.id = pf.part_id ...
delete from public.part_folders pf
using public.folders kf, public.parts p, public.folders pfo
where pf.folder_id = kf.id
  and kf.name ilike '%Karışık%'
  and p.id = pf.part_id
  and pfo.id = p.folder_id
  and pfo.name not ilike '%Karışık%';
