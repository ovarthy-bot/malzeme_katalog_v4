#!/usr/bin/env node
// Katalogdaki parça görsellerini CLIP ile vektöre çevirip part_image_embeddings tablosuna yazar (görsel arama için).
//
// Gereksinim: Node 18+ (ek paket gerekmez) ve supabase/visual_search.sql'in çalıştırılmış olması.
//
// Çalıştırma (PowerShell):
//   $env:SUPABASE_SERVICE_ROLE_KEY = "..."     # Supabase > Project Settings > API > service_role (GİZLİ tutun)
//   $env:REPLICATE_API_TOKEN       = "r8_..."  # replicate.com/account/api-tokens
//   node scripts/embed-catalog.mjs --dry-run   # önce kaç görsel işleneceğini görün
//   node scripts/embed-catalog.mjs --limit 20  # küçük bir deneme
//   node scripts/embed-catalog.mjs             # hepsi
//
// Anahtarlar yalnızca ortam değişkeni olarak okunur; dosyaya yazılmaz, depoya girmez.
// Betik tekrar çalıştırılabilir: yalnızca vektörü olmayan (veya başka modelle üretilmiş) görselleri işler,
// yarıda kesilirse kaldığı yerden devam eder. Yeni görsel yüklendikten sonra da aynı komutla indekslenir.
//
// Seçenekler:
//   --dry-run          Hiçbir şey çağırmadan işlenecek görsel sayısını yazar
//   --limit <n>        En fazla n görsel işler
//   --concurrency <n>  Aynı anda kaç görsel işlensin (varsayılan 4)
//   --force            Vektörü olanları da yeniden üretir (model değiştirdiyseniz)
//
// Replicate görseli kendi indirir (Storage bucket'ı herkese açık), dosyalar bilgisayarınızdan geçmez.
// İlk çağrıda model soğuk başlayabilir ve dakikalar sürebilir; betik bunu bekler.

import { parseArgs } from 'node:util';

// Edge Function (supabase/functions/visual-search/index.ts) ile AYNI model ve sürüm olmalı.
const MODEL_VERSION = '1c0371070cb827ec3c7f2f28adcdde54b50dcd239aa6faea0bc98b174ef03fb4'; // krthr/clip-embeddings
const MODEL_TAG = 'krthr/clip-embeddings@' + MODEL_VERSION.slice(0, 8);
const EMBEDDING_DIMS = 768;

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rkjnyexhnkiigvwnqvtx.supabase.co').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_API = (process.env.REPLICATE_API_URL || 'https://api.replicate.com/v1').replace(/\/$/, '');

const PAGE = 1000; // PostgREST en fazla 1000 satır döndürür
const WAIT_SECONDS = 60; // Replicate'in tahmini beklemesine izin verilen süre (sonra sorgulamaya geçilir)
const PREDICTION_TIMEOUT_MS = 10 * 60 * 1000; // soğuk başlangıç dahil bir görsel için en uzun bekleme
const POLL_MS = 3000;
const MAX_ATTEMPTS = 3;

const { values: opts } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
  },
});
const limit = opts.limit === undefined ? Infinity : Number(opts.limit);
const concurrency = Number(opts.concurrency);
if (!(limit > 0) || !(concurrency >= 1 && concurrency <= 16)) {
  fail('--limit pozitif, --concurrency 1-16 arasında bir sayı olmalı.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error('HATA: ' + message);
  process.exit(1);
}

/* ---------- Supabase (PostgREST, service_role) ---------- */

async function rest(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    const hint = /PGRST205|42P01|part_image_embeddings/.test(text)
      ? ' (supabase/visual_search.sql çalıştırıldı mı?)' : '';
    throw new Error(`Supabase ${res.status} ${path.split('?')[0]}: ${text}${hint}`);
  }
  return method === 'GET' ? res.json() : null;
}

async function fetchAll(table, select, orderBy) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`${table}?select=${select}&order=${orderBy}&limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function saveEmbedding(imageId, embedding) {
  await rest('part_image_embeddings?on_conflict=image_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{ image_id: imageId, embedding: `[${embedding.join(',')}]`, model: MODEL_TAG }],
  });
}

/* ---------- Replicate ---------- */

// exact: bekleme süresi Replicate'ten geldiği için olduğu gibi uygulanır; değilse denemeler arttıkça uzar
class RetryableError extends Error {
  constructor(message, delayMs, exact = false) {
    super(message);
    this.delayMs = delayMs;
    this.exact = exact;
  }
}

async function replicate(path, init = {}) {
  let res;
  try {
    res = await fetch(`${REPLICATE_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (err) {
    throw new RetryableError(`ağ hatası (${err.cause?.code || err.message})`, 5000);
  }
  if (res.status === 429) {
    // Düşük bakiyeli hesaplarda dakikada ~6 istek sınırı vardır; Replicate ne kadar bekleneceğini bildirir
    const body = await res.json().catch(() => ({}));
    const seconds = Number(body.retry_after ?? res.headers.get('retry-after') ?? 10);
    throw new RetryableError('Replicate istek sınırı', (Number.isFinite(seconds) ? seconds : 10) * 1000 + 500, true);
  }
  if (res.status >= 500) throw new RetryableError(`Replicate ${res.status}`, 5000);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401) fail('Replicate anahtarı geçersiz (REPLICATE_API_TOKEN).');
    if (res.status === 402) fail('Replicate kredisi yetersiz (replicate.com/account/billing).');
    throw new Error(`Replicate ${res.status}: ${text}`);
  }
  return res.json();
}

// 429 / ağ / 5xx hatalarında bekleyip yeniden dener
async function withRetry(fn, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || i >= attempts) throw err;
      await sleep(err.exact ? err.delayMs : err.delayMs * Math.min(i, 3));
    }
  }
}

async function predictEmbedding(imageUrl) {
  let prediction = await withRetry(() => replicate('/predictions', {
    method: 'POST',
    headers: { Prefer: `wait=${WAIT_SECONDS}` },
    body: JSON.stringify({ version: MODEL_VERSION, input: { image: imageUrl } }),
  }));

  const deadline = Date.now() + PREDICTION_TIMEOUT_MS;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > deadline) throw new Error('zaman aşımı (model yanıt vermedi)');
    await sleep(POLL_MS);
    prediction = await withRetry(() => replicate(`/predictions/${prediction.id}`));
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`tahmin ${prediction.status}: ${String(prediction.error || '').slice(0, 200)}`);
  }
  const embedding = prediction.output?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS || !embedding.every(Number.isFinite)) {
    throw new Error(`beklenmeyen çıktı: ${EMBEDDING_DIMS} sayılık vektör bekleniyordu, ${Array.isArray(embedding) ? embedding.length + ' sayı' : typeof embedding} geldi`);
  }
  return embedding;
}

/* ---------- Ana akış ---------- */

async function main() {
  if (!SERVICE_KEY) fail('SUPABASE_SERVICE_ROLE_KEY tanımlı değil (dosyanın başındaki çalıştırma adımlarına bakın).');
  if (!REPLICATE_TOKEN && !opts['dry-run']) fail('REPLICATE_API_TOKEN tanımlı değil (dosyanın başındaki çalıştırma adımlarına bakın).');

  console.log('Katalog okunuyor…');
  const [images, existing] = await Promise.all([
    fetchAll('part_images', 'id,image_url', 'id'),
    fetchAll('part_image_embeddings', 'image_id,model', 'image_id'),
  ]);
  const doneModel = new Map(existing.map((e) => [e.image_id, e.model]));

  const withUrl = images.filter((img) => img.image_url);
  const todo = withUrl.filter((img) => opts.force || doneModel.get(img.id) !== MODEL_TAG);
  const queue = todo.slice(0, limit);

  const stale = withUrl.filter((img) => doneModel.has(img.id) && doneModel.get(img.id) !== MODEL_TAG).length;
  console.log(`Toplam görsel: ${images.length} • vektörü hazır: ${withUrl.length - todo.length}` +
    ` • işlenecek: ${queue.length}${stale ? ` (${stale} tanesi başka modelle üretilmişti)` : ''}`);
  if (opts['dry-run'] || !queue.length) {
    if (!queue.length) console.log('Yapılacak bir şey yok.');
    return 0;
  }

  let next = 0, done = 0, failed = 0, stopping = false;
  const failures = [];
  process.once('SIGINT', () => {
    stopping = true;
    console.log('\nDurduruluyor: süren görseller bitince çıkılacak (tamamlananlar kaydedildi)…');
  });

  const started = Date.now();
  async function worker() {
    while (!stopping && next < queue.length) {
      const img = queue[next++];
      try {
        let embedding;
        for (let attempt = 1; ; attempt++) {
          try {
            embedding = await predictEmbedding(img.image_url);
            break;
          } catch (err) {
            // Geçici model hatalarında bir kez daha dene; kalıcı olanlar (ör. silinmiş dosya) aynı hatayı verir
            if (attempt >= MAX_ATTEMPTS - 1) throw err;
            await sleep(2000 * attempt);
          }
        }
        await saveEmbedding(img.id, embedding);
        done++;
      } catch (err) {
        failed++;
        failures.push({ id: img.id, url: img.image_url, error: err.message });
        console.error(`  ✗ görsel #${img.id}: ${err.message}`);
      }
      const n = done + failed;
      if (n % 10 === 0 || n === queue.length) {
        const perMin = n / ((Date.now() - started) / 60000);
        const etaMin = Math.ceil((queue.length - n) / Math.max(perMin, 0.01));
        console.log(`  [${n}/${queue.length}] ${done} tamam, ${failed} hata • ~${perMin.toFixed(0)}/dk • kalan ≈ ${etaMin} dk`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  console.log(`\nBitti: ${done} görsel vektörlendi, ${failed} hata, ${queue.length - done - failed} işlenmedi.`);
  if (failures.length) {
    console.log('Hatalı görseller (tekrar çalıştırınca yeniden denenir):');
    for (const f of failures.slice(0, 20)) console.log(`  #${f.id} ${f.url}\n      ${f.error}`);
    if (failures.length > 20) console.log(`  … ve ${failures.length - 20} tane daha`);
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => fail(err.message));
