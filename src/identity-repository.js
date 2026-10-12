import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
  const sql = readFileSync(
    fileURLToPath(new URL('../schema/migrations/0009_identity.sql', import.meta.url)),
    'utf8'
  );
  await db.exec(sql);
}

// --- I04.a: ACL API ---

export async function listUsers(db) {
  if (!db) throw new Error('D1 binding required');
  const result = await db.prepare(
    `SELECT user_id, email, role, service, status, created_at, updated_at FROM identity_users ORDER BY user_id`
  ).bind().all();
  return (result.results || []).map(toUser);
}

export async function getUser(db, userId) {
  if (!db) throw new Error('D1 binding required');
  const row = await db.prepare(
    `SELECT user_id, email, role, service, status, created_at, updated_at FROM identity_users WHERE user_id = ?`
  ).bind(userId).first();
  return row ? toUser(row) : null;
}

function toUser(row) {
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    service: row.service,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toKey(row) {
  return {
    keyHash: row.key_hash,
    label: row.label,
    status: row.status,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export async function setUserStatus(db, userId, status) {
  if (!db) throw new Error('D1 binding required');
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE identity_users SET status = ?, updated_at = ? WHERE user_id = ?`
  ).bind(status, now, userId).run();
  return result.meta.changes > 0;
}

export async function setUserRole(db, userId, role) {
  if (!db) throw new Error('D1 binding required');
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE identity_users SET role = ?, updated_at = ? WHERE user_id = ?`
  ).bind(role, now, userId).run();
  return result.meta.changes > 0;
}

export async function listApiKeys(db, userId) {
  if (!db) throw new Error('D1 binding required');
  let query = `SELECT key_hash, label, status, expires_at, revoked_at, created_at FROM identity_api_keys WHERE 1=1`;
  const binds = [];
  if (userId) {
    query += ` AND user_id = ?`;
    binds.push(userId);
  }
  query += ` ORDER BY created_at DESC`;
  const result = await db.prepare(query).bind(...binds).all();
  return (result.results || []).map(toKey);
}

export async function disableUser(db, userId) {
  return await setUserStatus(db, userId, 'disabled');
}

export async function enableUser(db, userId) {
  if (!db) throw new Error('D1 binding required');
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE identity_users SET status = 'active', updated_at = ? WHERE user_id = ?`
  ).bind(now, userId).run();
  return result.meta.changes > 0;
}

export async function listDisabledUsers(db) {
  if (!db) throw new Error('D1 binding required');
  const result = await db.prepare(
    `SELECT user_id, email, role, service, status, created_at, updated_at FROM identity_users WHERE status = 'disabled' ORDER BY user_id`
  ).all();
  return (result.results || []).map(toKey);
}

export async function listKeysByRole(db, role) {
  if (!db) throw new Error('D1 binding required');
  const result = await db.prepare(
    `SELECT k.key_hash, k.label, k.status, k.expires_at, k.revoked_at, k.created_at, u.user_id, u.role, u.email, u.service
     FROM identity_api_keys k
     JOIN identity_users u ON u.user_id = k.user_id
     WHERE u.role = ? AND k.revoked_at IS NULL`
  ).bind(role).all();
  return (result.results || []).map(toKey);
}

export async function rotateKey(db, keyHash) {
  if (!db) return false;
  // Find the user for this key BEFORE revoking
  const keyRow = await db.prepare(
    `SELECT user_id FROM identity_api_keys WHERE key_hash = ? AND revoked_at IS NULL`
  ).bind(keyHash).first();
  if (!keyRow) return false;
  // Revoke old key
  await revokeApiKey(db, keyHash);
  // Return the userId; caller can issue a new key with same userId/label
  return { oldKeyHash: keyHash, userId: keyRow.user_id };
}
