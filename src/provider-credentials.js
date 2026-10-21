// Provider credentials storage (OpenRouter, OpenCode Go) — encrypted in D1, manageable via admin UI.
// Encryption: AES-GCM with PROVIDER_CREDS_KEY (32 bytes base64), random 12-byte IV per value.
// Format: base64(v1 || iv || ciphertext+tag) — 'v1' prefix for future key rotation.

export const PROVIDER_CREDS_VERSION = 'v1';

async function importKey(keyB64) {
  if (!keyB64) throw new Error('PROVIDER_CREDS_KEY not configured');
  const raw = Uint8Array.from(atob(String(keyB64).trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('PROVIDER_CREDS_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(plain, keyB64) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const bin = String.fromCharCode(...iv, ...ct);
  return PROVIDER_CREDS_VERSION + btoa(bin);
}

export async function decryptToken(enc, keyB64) {
  const key = await importKey(keyB64);
  if (!enc.startsWith(PROVIDER_CREDS_VERSION)) throw new Error('Unknown credential version');
  const bin = atob(enc.slice(PROVIDER_CREDS_VERSION.length));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

// Mask token for safe display (first 6 + last 4 chars)
export function maskToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 12) return '••••••••••••';
  return t.slice(0, 6) + '•'.repeat(t.length - 10) + t.slice(-4);
}

// --- D1 operations ---

// Pool cache (per D1 binding) — see resolveProviderPool.
const POOL_CACHE_MS = 30_000;
let poolCache = { db: null, expires: 0, pool: null };

function dropPoolCache() { poolCache = { db: null, expires: 0, pool: null }; }

export async function listProviderCredentials(db) {
  const rows = (await db.prepare(
    `SELECT id, provider, label, status, created_at, updated_at
     FROM provider_credentials
     WHERE status = 'active'
     ORDER BY provider, created_at`
  ).all()).results || [];
  return rows;
}

export async function listAllProviderCredentials(db, env) {
  const rows = (await db.prepare(
    `SELECT id, provider, label, status, ciphertext, created_at, updated_at
     FROM provider_credentials
     ORDER BY provider, created_at`
  ).all()).results || [];
  // The mask is computed from the decrypted value so the operator can tell two tokens apart.
  // A credential that cannot be decrypted (rotated key) is listed without a mask, never raw.
  const out = [];
  for (const row of rows) {
    let tokenMask = null;
    if (env?.PROVIDER_CREDS_KEY) {
      try { tokenMask = maskToken(await decryptToken(row.ciphertext, env.PROVIDER_CREDS_KEY)); }
      catch { tokenMask = null; }
    }
    const { ciphertext, ...rest } = row;
    out.push({ ...rest, token_mask: tokenMask });
  }
  return out;
}

export async function addProviderCredential(db, env, { provider, label, token }) {
  const now = Date.now();
  const ciphertext = await encryptToken(token, env.PROVIDER_CREDS_KEY);
  const result = await db.prepare(
    `INSERT INTO provider_credentials (provider, label, ciphertext, key_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind(provider, label, ciphertext, PROVIDER_CREDS_VERSION, now, now).run();
  dropPoolCache();
  return { id: result.meta.last_row_id, provider, label, status: 'active', created_at: now, updated_at: now };
}

export async function disableProviderCredential(db, id) {
  const now = Date.now();
  await db.prepare(
    `UPDATE provider_credentials SET status = 'disabled', updated_at = ? WHERE id = ?`
  ).bind(now, id).run();
  dropPoolCache();
  return { id, status: 'disabled', updated_at: now };
}

export async function resolveProviderPool(env, db) {
  // The pool changes only when the operator adds or disables a token, so it is cached briefly:
  // every ladder call would otherwise pay two D1 reads. The admin write path drops the cache,
  // so a change is visible to the operator at once and to the other isolates within the TTL.
  const now = Date.now();
  if (poolCache.db === db && poolCache.expires > now) return poolCache.pool;
  // Returns { go: string[], openrouter: string[] }
  // OpenCode Go: env pool + D1 active credentials
  const envGoPool = String(env.OPENCODE_GO_API_KEYS || env.OPENCODE_GO_API_KEY || '')
    .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const dbGoRows = (await db.prepare(
    `SELECT ciphertext FROM provider_credentials WHERE provider = 'opencode-go' AND status = 'active' ORDER BY created_at`
  ).all()).results || [];
  const dbGoPool = await Promise.all(dbGoRows.map(r => decryptToken(r.ciphertext, env.PROVIDER_CREDS_KEY)));
  const goPool = [...envGoPool, ...dbGoPool];

  // OpenRouter: env key (single) + D1 active credentials.
  // Метки едут вместе с ключами: каждый ключ пула — свой аккаунт OpenRouter (у каждого свой
  // дневной счётчик бесплатных запросов), и в отчёте о лимите нужно видеть, кто именно исчерпан.
  const openrouterPool = [];
  const openrouterLabels = [];
  if (env.OPENROUTER_API_KEY) { openrouterPool.push(env.OPENROUTER_API_KEY); openrouterLabels.push('env'); }
  const dbOrRows = (await db.prepare(
    `SELECT label, ciphertext FROM provider_credentials WHERE provider = 'openrouter' AND status = 'active' ORDER BY created_at`
  ).all()).results || [];
  const dbOrPool = await Promise.all(dbOrRows.map(async (r) => ({
    label: r.label || 'key',
    token: await decryptToken(r.ciphertext, env.PROVIDER_CREDS_KEY),
  })));
  for (const r of dbOrPool) { openrouterPool.push(r.token); openrouterLabels.push(r.label); }

  const pool = { go: goPool, openrouter: openrouterPool, openrouterLabels };
  poolCache = { db, expires: now + POOL_CACHE_MS, pool };
  return pool;
}

// For backward compat: sync env-only pool (used in tests and non-D1 contexts)
export function readPool(env) {
  return String(env.OPENCODE_GO_API_KEYS || env.OPENCODE_GO_API_KEY || '')
    .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}