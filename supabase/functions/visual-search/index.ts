// Görsel arama Edge Function'ı: fotoğrafı CLIP ile vektöre çevirir, katalogdaki görsellerle karşılaştırır.
//
// Replicate API anahtarı tarayıcıda durmamalı; bu yüzden istemci Replicate'i doğrudan çağırmaz, bu fonksiyonu çağırır.
//
//   POST  gövde = görsel (image/jpeg | png | webp, en fazla 1 MB)
//         -> 200 { status: "done", results: [...] }     (görsel hazırsa)
//         -> 202 { status: "pending", id }               (model soğuk başlıyorsa; Replicate'te dakikalar sürebilir)
//   GET   ?id=<tahmin kimliği>  -> POST ile aynı yanıtlar (istemci 202 aldıkça bununla sorar)
//
// Kurulum (bir kez, proje klasöründe):
//   supabase login
//   supabase link --project-ref rkjnyexhnkiigvwnqvtx
//   supabase secrets set REPLICATE_API_TOKEN=r8_...          (replicate.com/account/api-tokens)
//   supabase functions deploy visual-search --no-verify-jwt
//
// --no-verify-jwt gerekli: uygulama yeni tip "publishable" anahtar kullanıyor, bu bir JWT olmadığı için
// Supabase'in varsayılan JWT doğrulaması isteği reddeder. SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY
// Supabase tarafından fonksiyona otomatik verilir.
//
// Uç nokta herkese açık olduğundan her çağrı Replicate'te küçük bir maliyet doğurur. Kötüye kullanıma karşı
// Replicate hesabında aylık harcama limiti (Billing > Spend limit) belirlemeniz önerilir.

// Katalog vektörleri aynı model ve sürümle üretilmeli (scripts/embed-catalog.mjs içindeki MODEL_VERSION ile aynı).
// Model: krthr/clip-embeddings (CLIP ViT-L/14). Sürümü değiştirirseniz tüm katalogu yeniden vektörleyin (--force).
const MODEL_VERSION = "1c0371070cb827ec3c7f2f28adcdde54b50dcd239aa6faea0bc98b174ef03fb4";
const EMBEDDING_DIMS = 768; // supabase/visual_search.sql içindeki vector(768) ile aynı
const TOP_K = 5;
const MAX_IMAGE_BYTES = 1024 * 1024; // Replicate veri URI'lerini ~1 MB'a kadar önerir; istemci zaten ~512 px gönderir
const WAIT_SECONDS = 50; // Replicate'in tahmini beklemesine izin verilen süre; dolarsa istemci sorgulamaya geçer
const REPLICATE_API = "https://api.replicate.com/v1";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type Env = (name: string) => string | undefined;
interface Deps {
  env: Env;
  fetch: typeof fetch;
}
interface Prediction {
  id: string;
  version?: string;
  status: string;
  error?: string | null;
  output?: { embedding?: unknown } | null;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function required(deps: Deps, name: string): string {
  const value = deps.env(name);
  if (!value) {
    console.error(`${name} tanımlı değil`);
    throw new HttpError(500, "Görsel arama servisi yapılandırılmamış.");
  }
  return value;
}

// Dosya uzantısına/Content-Type'a güvenmek yerine ilk baytlara bakılır; Replicate'e yalnızca gerçek görseller gider.
function detectMime(bytes: Uint8Array): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Gövdeyi akış halinde okur ve sınırı aşar aşmaz keser (content-length başlığı yalan söylenebilir / hiç olmayabilir)
async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(413, "Görsel çok büyük.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readImage(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, "Görsel çok büyük.");
  const bytes = await readBody(req, MAX_IMAGE_BYTES);
  if (bytes.length === 0) throw new HttpError(400, "Görsel gönderilmedi.");
  const mime = detectMime(bytes);
  if (!mime) throw new HttpError(415, "Desteklenmeyen görsel biçimi (JPEG, PNG veya WebP olmalı).");
  return `data:${mime};base64,${toBase64(bytes)}`;
}

async function replicate(deps: Deps, path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Prediction> {
  const token = required(deps, "REPLICATE_API_TOKEN");
  let res: Response;
  try {
    res = await deps.fetch(`${REPLICATE_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout((WAIT_SECONDS + 10) * 1000),
    });
  } catch (err) {
    console.error("Replicate bağlantı hatası:", err);
    throw new HttpError(502, "Görsel analiz servisine ulaşılamadı.");
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`Replicate ${res.status}:`, detail);
    if (res.status === 429) throw new HttpError(503, "Servis şu an yoğun, birkaç saniye sonra tekrar deneyin.");
    if (res.status === 402) throw new HttpError(503, "Görsel analiz servisinin kredisi tükenmiş.");
    if (res.status === 401 || res.status === 403) throw new HttpError(500, "Görsel arama servisi yapılandırma hatası.");
    if (res.status === 404) throw new HttpError(404, "Tahmin bulunamadı.");
    throw new HttpError(502, "Görsel analiz servisi hata verdi.");
  }
  return await res.json() as Prediction;
}

function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_DIMS && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

async function matchParts(deps: Deps, embedding: number[]) {
  const url = required(deps, "SUPABASE_URL").replace(/\/$/, "");
  const key = required(deps, "SUPABASE_SERVICE_ROLE_KEY");
  const res = await deps.fetch(`${url}/rest/v1/rpc/match_parts_by_image`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query_embedding: `[${embedding.join(",")}]`, match_count: TOP_K }),
  });
  if (!res.ok) {
    console.error(`match_parts_by_image ${res.status}:`, (await res.text()).slice(0, 300));
    throw new HttpError(500, "Katalog araması başarısız (supabase/visual_search.sql çalıştırıldı mı?).");
  }
  const rows = await res.json() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    part_id: r.part_id,
    part_number: r.part_number,
    material_desc: r.material_desc,
    material_type: r.material_type,
    image_url: r.image_url,
    similarity: Math.round(Math.min(1, Math.max(0, Number(r.similarity))) * 10000) / 10000,
  }));
}

async function respond(deps: Deps, prediction: Prediction): Promise<Response> {
  if (prediction.status === "starting" || prediction.status === "processing") {
    return json({ status: "pending", id: prediction.id }, 202);
  }
  if (prediction.status !== "succeeded") {
    console.error("Tahmin başarısız:", prediction.status, prediction.error);
    throw new HttpError(502, "Görsel analiz edilemedi.");
  }
  const embedding = prediction.output?.embedding;
  if (!validEmbedding(embedding)) {
    console.error("Beklenmeyen embedding biçimi");
    throw new HttpError(502, `Görsel analiz servisi beklenmeyen bir yanıt verdi (${EMBEDDING_DIMS} boyut bekleniyordu).`);
  }
  return json({ status: "done", results: await matchParts(deps, embedding) });
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (req.method === "POST") {
      const image = await readImage(req);
      const prediction = await replicate(deps, "/predictions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: `wait=${WAIT_SECONDS}` },
        body: JSON.stringify({ version: MODEL_VERSION, input: { image } }),
      });
      return await respond(deps, prediction);
    }
    if (req.method === "GET") {
      const id = new URL(req.url).searchParams.get("id") ?? "";
      // Kimlik doğrudan Replicate URL'sine eklendiği için biçimi sıkı denetlenir
      if (!/^[a-z0-9]{10,40}$/.test(id)) throw new HttpError(400, "Geçersiz tahmin kimliği.");
      const prediction = await replicate(deps, `/predictions/${id}`, { method: "GET" });
      // Hesaptaki başka bir modelin tahmini bu uç noktadan okunamasın
      if (prediction.version !== MODEL_VERSION) throw new HttpError(404, "Tahmin bulunamadı.");
      return await respond(deps, prediction);
    }
    throw new HttpError(405, "Yalnızca GET ve POST desteklenir.");
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("Beklenmeyen hata:", err);
    return json({ error: "Beklenmeyen bir hata oluştu." }, 500);
  }
}

// Supabase Edge Runtime (Deno) içinde çalışırken sunucuyu başlatır; testlerde dosya sadece içe aktarılır.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void } | undefined;
if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) => handleRequest(req, { env: (name) => Deno!.env.get(name), fetch }));
}
