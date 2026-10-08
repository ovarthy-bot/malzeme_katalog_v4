-- "Uçak tipi" kategorisini sistemden tamamen kaldırır.
-- Supabase Dashboard > SQL Editor'de BİR KEZ çalıştırın.
--
-- DİKKAT: Bu işlem geri alınamaz. parts.ac_type sütunu ve içindeki tüm veriler
-- kalıcı olarak silinir. Uygulama kodu (index.html, import.html) zaten bu sütunu
-- hiç kullanmıyor; bu script yalnızca veritabanı şemasını kodla senkronize eder.
--
-- Önce supabase/folders_a320_a330.sql ile klasör bazlı A320/A330/ORTAK taşıması
-- yapıldıysa, parçaların uçak tipi bilgisi artık klasör konumlarında saklı olur.
-- Bu script'ten sonra ac_type'a göre otomatik taşıma/eşleştirme bir daha mümkün olmaz.

alter table public.parts drop column if exists ac_type;
