import { createHash, randomBytes } from 'node:crypto';

export async function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export async function verifyKey(db, providedKey) {
  if (!db || typeof providedKey !== 'string' || !providedKey) return null;
  const keyHash = await hashKey(providedKey);
  const row = await db.prepare(
    `SELECT u.user_id, u.role, u.status, u.email, u.service,
            k.key_hash, k.status AS key_status, k.expires_at, k.revoked_at
     FROM identity_api_keys k
     JOIN identity_users u ON u.user_id = k.user_id
     WHERE k.key_hash = ?`
  ).bind(keyHash).first();
  if (!row) return null;
  if (row.status !== 'active') return null;
  if (row.key_status !== 'active') return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;
  return {
    userId: row.user_id,
    role: row.role,
    email: row.email,
    service: row.service,
    keyHash: row.key_hash,
  };
}

export async function createUser(db, { userId, email, role = 'user', service = 'ladder' }) {
  if (!db) throw new Error('D1 binding required');
  const now = Date.now();
  await db.prepare(
    `INSERT INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind(userId, email, role, service, now, now).run();
  return { userId, email, role, service };
}

export async function issueApiKey(db, { userId, label, expiresAt = null }) {
  if (!db) throw new Error('D1 binding required');
  const key = randomBytes(32).toString('base64url');
  const keyHash = await hashKey(key);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO identity_api_keys (key_hash, user_id, label, status, expires_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(keyHash, userId, label, expiresAt, now).run();
  return { key, keyHash, label };
}

export async function revokeApiKey(db, keyHash) {
  if (!db) return false;
  const result = await db.prepare(
    `UPDATE identity_api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL`
  ).bind(Date.now(), keyHash).run();
  return result.meta.changes > 0;
}

export async function initIdentityTables(db) {
  if (!db) throw new Error('D1 binding required');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../schema/migrations/0009_identity.sql', import.meta.url));
  const sql = readFileSync(path, 'utf8');
  await db.exec(sql);
}
