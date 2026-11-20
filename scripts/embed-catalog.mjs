#!/usr/bin/env node
// Katalogdaki parça görsellerini yerel olarak DINOv2 (Xenova/dinov2-small, 384 boyut) ile vektöre çevirip
// hem yerel visual-index.bin dosyasına hem de Supabase Storage + app_notes üzerine yazar.
//
// Ücretli bir servis (Replicate vb.), Edge Function veya gizli service_role anahtarı GEREKTİRMEZ.
// Aynı işlem tarayıcı içinden de (Ayarlar > Araçlar > Görsel arama dizini) yapılabilir.

import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const MODEL_ID = 'Xenova/dinov2-small';
const EMBEDDING_DIMS = 384;
const RECORD_BYTES = 8 + EMBEDDING_DIMS; // uint32 image_id + uint32 part_id + int8[384]
const HEADER_BYTES = 16;

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rkjnyexhnkiigvwnqvtx.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_EmbtWNix9l-WR-kVoaWwDA_oBV2h29Z';
const BUCKET = 'part-images';
const FIXED_INDEX_PATH = 'visual-index/dinov2-small-v1.bin';
const INDEX_NOTE_KEY = 'visual_search_index';
const LOCAL_INDEX_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'visual-index.bin');
const PAGE = 1000;

function poolDinoEmbedding(tensor) {
  const data = tensor.data;
  const dim = EMBEDDING_DIMS;
  const tokens = Math.floor(data.length / dim);
  const vec = new Float32Array(dim);
  if (tokens <= 1) {
    for (let d = 0; d < dim; d++) vec[d] = data[d];
  } else {
    let clsNorm = 0;
    for (let d = 0; d < dim; d++) clsNorm += data[d] * data[d];
    clsNorm = Math.sqrt(clsNorm) || 1;

    const patchCount = tokens - 1;
    const patchMean = new Float32Array(dim);
    for (let t = 1; t < tokens; t++) {
      const base = t * dim;
      for (let d = 0; d < dim; d++) patchMean[d] += data[base + d];
    }
    let patchNorm = 0;
    for (let d = 0; d < dim; d++) {
      patchMean[d] /= patchCount;
      patchNorm += patchMean[d] * patchMean[d];
    }
    patchNorm = Math.sqrt(patchNorm) || 1;

    for (let d = 0; d < dim; d++) {
      vec[d] = 0.6 * (data[d] / clsNorm) + 0.4 * (patchMean[d] / patchNorm);
    }
  }
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) vec[d] /= norm;
  return vec;
}

function quantizeVec(vec) {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? 127 / maxAbs : 0;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * scale)));
  }
  return out;
}

/* ---------- İşçi iş parçacığı (Worker) ---------- */

if (!isMainThread) {
  const { items } = workerData;
  const { pipeline, RawImage } = await import('@huggingface/transformers');
  const extractor = await pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' });

  async function downloadImage(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= 8) throw new Error(`HTTP ${res.status}`);
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(15000, attempt * 2000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        return await RawImage.fromBlob(blob);
      } catch (err) {
        if (attempt >= 7) throw err;
        await new Promise((r) => setTimeout(r, Math.min(12000, attempt * 1800)));
      }
    }
  }

  // Cloudflare hız sınırına (429) takılmamak için işçi başına 2 önden indirme
  const PREFETCH = 2;
  let nextFetch = 0;
  const prefetched = new Map();

  function triggerPrefetch() {
    while (prefetched.size < PREFETCH && nextFetch < items.length) {
      const idx = nextFetch++;
      const item = items[idx];
      prefetched.set(idx, downloadImage(item.image_url).catch((err) => ({ __error: err })));
    }
  }

  triggerPrefetch();
  for (let i = 0; i < items.length; i++) {
    triggerPrefetch();
    const item = items[i];
    try {
      const imgOrErr = await prefetched.get(i);
      prefetched.delete(i);
      triggerPrefetch();
      if (imgOrErr && imgOrErr.__error) throw imgOrErr.__error;
      const out = await extractor(imgOrErr);
      const qvec = quantizeVec(poolDinoEmbedding(out));
      parentPort.postMessage({ ok: true, id: item.id, part_id: item.part_id, vec: qvec });
    } catch (err) {
      prefetched.delete(i);
      parentPort.postMessage({ ok: false, id: item.id, url: item.image_url, error: err?.message || String(err) });
    }
  }
  process.exit(0);
}

/* ---------- Ana süreç ---------- */

const { values: opts } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    limit: { type: 'string' },
    workers: { type: 'string', default: '3' },
  },
});

const limit = opts.limit === undefined ? Infinity : Number(opts.limit);
const workerCount = Number(opts.workers);
if (!(limit > 0) || !(workerCount >= 1 && workerCount <= 16)) {
  console.error('HATA: --limit pozitif, --workers 1-16 arasında bir sayı olmalı.');
  process.exit(1);
}

async function fetchAllImages() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/part_images?select=id,part_id,image_url&order=id.asc&limit=${PAGE}&offset=${offset}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase part_images HTTP ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function parseIndexBuffer(buf) {
  const map = new Map();
  if (!buf || buf.byteLength < HEADER_BYTES) return map;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const dims = view.getUint16(4, true);
  const count = view.getUint32(8, true);
  if (magic !== 'VS01' || dims !== EMBEDDING_DIMS) return map;
  if (buf.byteLength < HEADER_BYTES + count * RECORD_BYTES) return map;

  for (let i = 0; i < count; i++) {
    const base = HEADER_BYTES + i * RECORD_BYTES;
    const imageId = view.getUint32(base, true);
    const partId = view.getUint32(base + 4, true);
    const vec = new Int8Array(buf.buffer, buf.byteOffset + base + 8, EMBEDDING_DIMS).slice();
    map.set(imageId, { part_id: partId, vec });
  }
  return map;
}

async function loadExistingIndex() {
  const merged = new Map();
  // 1) Yerel dosya varsa oku
  if (existsSync(LOCAL_INDEX_FILE)) {
    try {
      const localBuf = readFileSync(LOCAL_INDEX_FILE);
      for (const [k, v] of parseIndexBuffer(localBuf)) merged.set(k, v);
    } catch {}
  }
  // 2) Sunucudaki dizini oku (app_notes veya sabit yol)
  try {
    let remoteUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${FIXED_INDEX_PATH}?t=${Date.now()}`;
    const noteRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_notes?select=content&key=eq.${INDEX_NOTE_KEY}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (noteRes.ok) {
      const notes = await noteRes.json();
      const meta = JSON.parse(notes[0]?.content || 'null');
      if (meta?.url) remoteUrl = `${meta.url}?t=${Date.now()}`;
    }
    const res = await fetch(remoteUrl);
    if (res.ok) {
      const ab = await res.arrayBuffer();
      for (const [k, v] of parseIndexBuffer(new Uint8Array(ab))) merged.set(k, v);
    }
  } catch {}
  return merged;
}

function buildIndexBuffer(entriesMap) {
  const ids = [...entriesMap.keys()].sort((a, b) => a - b);
  const totalBytes = HEADER_BYTES + ids.length * RECORD_BYTES;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8[0] = 0x56; u8[1] = 0x53; u8[2] = 0x30; u8[3] = 0x31;
  view.setUint16(4, EMBEDDING_DIMS, true);
  view.setUint16(6, 1, true);
  view.setUint32(8, ids.length, true);
  view.setUint32(12, 0, true);

  for (let i = 0; i < ids.length; i++) {
    const imageId = ids[i];
    const entry = entriesMap.get(imageId);
    const base = HEADER_BYTES + i * RECORD_BYTES;
    view.setUint32(base, imageId, true);
    view.setUint32(base + 4, entry.part_id, true);
    new Int8Array(buf, base + 8, EMBEDDING_DIMS).set(entry.vec);
  }
  return Buffer.from(buf);
}

function saveLocalIndex(entriesMap) {
  const payload = buildIndexBuffer(entriesMap);
  writeFileSync(LOCAL_INDEX_FILE, payload);
  return payload;
}

async function uploadIndex(entriesMap) {
  const payload = saveLocalIndex(entriesMap);

  // Storage RLS politikası UPDATE yerine DELETE + INSERT izinli olduğundan önce eski dosyayı silip sonra ekliyoruz
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: [FIXED_INDEX_PATH] }),
  }).catch(() => {});

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FIXED_INDEX_PATH}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'image/jpeg',
    },
    body: payload,
  });
  if (!res.ok) throw new Error(`Dizin yüklenemedi (HTTP ${res.status}): ${await res.text()}`);

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${FIXED_INDEX_PATH}`;
  const meta = {
    url: publicUrl,
    path: FIXED_INDEX_PATH,
    model: MODEL_ID,
    dims: EMBEDDING_DIMS,
    count: entriesMap.size,
    updated_at: new Date().toISOString(),
  };
  await fetch(`${SUPABASE_URL}/rest/v1/app_notes`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ key: INDEX_NOTE_KEY, content: JSON.stringify(meta), updated_at: meta.updated_at }]),
  }).catch(() => {});
  return { bytes: payload.byteLength, count: entriesMap.size };
}

async function main() {
  console.log('Katalog ve mevcut görsel arama dizini okunuyor…');
  const [images, existingMap] = await Promise.all([
    fetchAllImages(),
    opts.force ? Promise.resolve(new Map()) : loadExistingIndex(),
  ]);

  const validImages = images.filter((img) => img.image_url && img.id && img.part_id);
  const entriesMap = new Map();
  for (const img of validImages) {
    const prev = existingMap.get(img.id);
    if (prev) entriesMap.set(img.id, { part_id: img.part_id, vec: prev.vec });
  }
  const removedStale = existingMap.size - entriesMap.size;

  const todo = validImages.filter((img) => !entriesMap.has(img.id));
  const queue = todo.slice(0, limit);

  console.log(
    `Toplam görsel: ${validImages.length} • dizinde hazır: ${entriesMap.size}` +
    (removedStale > 0 ? ` (${removedStale} silinmiş görsel temizlendi)` : '') +
    ` • işlenecek: ${queue.length}`
  );

  if (opts['dry-run']) return 0;
  if (!queue.length) {
    const info = await uploadIndex(entriesMap);
    console.log(`Dizin güncel (${info.count} görsel, ${(info.bytes / 1024).toFixed(0)} KB).`);
    return 0;
  }

  const { pipeline } = await import('@huggingface/transformers');
  console.log(`Model hazırlanıyor (${MODEL_ID})…`);
  await pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' });

  const actualWorkers = Math.min(workerCount, queue.length);
  const chunks = Array.from({ length: actualWorkers }, () => []);
  queue.forEach((item, idx) => chunks[idx % actualWorkers].push(item));

  let done = 0;
  let failed = 0;
  const failures = [];
  const started = Date.now();
  const scriptPath = fileURLToPath(import.meta.url);

  await Promise.all(chunks.map((items) => new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(scriptPath, { workerData: { items } });
    worker.on('message', (msg) => {
      if (msg.ok) {
        entriesMap.set(msg.id, { part_id: msg.part_id, vec: msg.vec });
        done++;
        if (done % 100 === 0) {
          try { saveLocalIndex(entriesMap); } catch {}
        }
      } else {
        failed++;
        failures.push(msg);
        console.error(`  ✗ görsel #${msg.id}: ${msg.error}`);
      }
      const n = done + failed;
      if (n % 50 === 0 || n === queue.length) {
        const elapsedSec = Math.max((Date.now() - started) / 1000, 0.1);
        const perSec = n / elapsedSec;
        const etaSec = Math.ceil((queue.length - n) / Math.max(perSec, 0.1));
        console.log(`  [${n}/${queue.length}] ${done} tamam, ${failed} hata • ${perSec.toFixed(1)} görsel/sn • kalan ≈ ${etaSec} sn`);
      }
    });
    worker.on('error', rejectWorker);
    worker.on('exit', () => resolveWorker());
  })));

  const info = await uploadIndex(entriesMap);
  console.log(`\nBitti: ${info.count} görsel dizine kaydedildi (${(info.bytes / 1024).toFixed(0)} KB), ${failed} hata.`);
  if (failures.length) {
    for (const f of failures.slice(0, 15)) console.log(`  #${f.id} ${f.url} -> ${f.error}`);
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error('HATA:', err?.message || err);
  process.exit(1);
});
