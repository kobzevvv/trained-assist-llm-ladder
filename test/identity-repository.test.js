import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  hashKey,
  verifyKey,
  createUser,
  issueApiKey,
  revokeApiKey,
  initIdentityTables,
  listUsers,
  getUser,
  setUserStatus,
  setUserRole,
  listApiKeys,
  disableUser,
  enableUser,
  rotateKey,
} from '../src/identity-repository.js';

// Real local D1 substitute: wraps node:sqlite in the D1 statement API
// (prepare().bind().first()/all()/run()) so the repository SQL runs for real —
// including UNIQUE constraints — without any Cloudflare writes.
function localD1() {
  const db = new DatabaseSync(':memory:');
  return {
    _db: db,
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => db.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          run: async () => {
            const info = db.prepare(sql).run(...params);
            return { meta: { changes: Number(info.changes) } };
          },
        }),
      };
    },
    async exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

async function seededDb() {
  const db = localD1();
  await initIdentityTables(db);
  return db;
}

const NOW = Date.now();

test('hashKey: deterministic SHA-256', async () => {
  assert.equal(await hashKey('secret'), await hashKey('secret'));
  assert.notEqual(await hashKey('secret'), await hashKey('different'));
});

test('initIdentityTables: creates both tables', async () => {
  const db = localD1();
  await initIdentityTables(db);
  const tables = db._db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('identity_users'));
  assert.ok(tables.includes('identity_api_keys'));
  db.close();
});

test('initIdentityTables: reapply is idempotent', async () => {
  const db = localD1();
  await initIdentityTables(db);
  await initIdentityTables(db);
  const count = db._db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'identity_%'")
    .get();
  assert.equal(Number(count.n), 2);
  db.close();
});

test('createUser + verifyKey: valid key resolves the active user', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const { key, keyHash } = await issueApiKey(db, { userId: 'user-1', label: 'key1' });

  const row = db._db.prepare('SELECT key_hash FROM identity_api_keys').get();
  assert.equal(row.key_hash, keyHash);

  const result = await verifyKey(db, key);
  assert.notStrictEqual(result, null);
  assert.equal(result.userId, 'user-1');
  assert.equal(result.role, 'user');
  assert.equal(result.email, 'u1@test.com');
  assert.equal(result.service, 'ladder');
  db.close();
});

test('verifyKey: null for an unknown key', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  await issueApiKey(db, { userId: 'user-1', label: 'key1' });
  assert.equal(await verifyKey(db, 'not-a-real-key'), null);
  db.close();
});

test('createUser: duplicate email is rejected by UNIQUE constraint', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'dup@test.com' });
  await assert.rejects(() => createUser(db, { userId: 'user-2', email: 'dup@test.com' }));
  db.close();
});

test('issueApiKey: two keys get distinct hashes', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const a = await issueApiKey(db, { userId: 'user-1', label: 'a' });
  const b = await issueApiKey(db, { userId: 'user-1', label: 'b' });
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.keyHash, b.keyHash);
  db.close();
});

test('revokeApiKey: revoked key stops verifying, idempotently', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const { key, keyHash } = await issueApiKey(db, { userId: 'user-1', label: 'key1' });

  assert.equal(await revokeApiKey(db, keyHash), true);
  assert.equal(await verifyKey(db, key), null);
  assert.equal(await revokeApiKey(db, keyHash), false);
  db.close();
});

test('verifyKey: expired key is rejected', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const { key, keyHash } = await issueApiKey(db, { userId: 'user-1', label: 'key1', expiresAt: NOW - 1000 });
  const stored = db._db.prepare('SELECT expires_at FROM identity_api_keys WHERE key_hash = ?').get(keyHash);
  assert.equal(Number(stored.expires_at), NOW - 1000);
  assert.equal(await verifyKey(db, key), null);
  db.close();
});

test('verifyKey: disabled user is rejected', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const { key } = await issueApiKey(db, { userId: 'user-1', label: 'key1' });
  db._db.prepare("UPDATE identity_users SET status = 'disabled' WHERE user_id = 'user-1'").run();
  assert.equal(await verifyKey(db, key), null);
  db.close();
});

test('listUsers: returns empty list initially', async () => {
  const db = await seededDb();
  const users = await listUsers(db);
  assert.deepEqual(users, []);
  db.close();
});

test('listUsers: returns users after createUser', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-1', email: 'u1@test.com' });
  const users = await listUsers(db);
  assert.equal(users.length, 1);
  assert.equal(users[0].userId, 'user-1');
  assert.equal(users[0].email, 'u1@test.com');
  assert.equal(users[0].status, 'active');
  db.close();
});

test('getUser: returns user by ID', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-2', email: 'u2@test.com', role: 'recruiter' });
  const user = await getUser(db, 'user-2');
  assert.equal(user.userId, 'user-2');
  assert.equal(user.role, 'recruiter');
  db.close();
});

test('getUser: returns null for unknown user', async () => {
  const db = await seededDb();
  const user = await getUser(db, 'nonexistent');
  assert.equal(user, null);
  db.close();
});

test('setUserStatus: activate disabled user', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-3', email: 'u3@test.com' });
  db._db.prepare("UPDATE identity_users SET status = 'disabled' WHERE user_id = 'user-3'").run();
  assert.equal(await setUserStatus(db, 'user-3', 'active'), true);
  const user = await getUser(db, 'user-3');
  assert.equal(user.status, 'active');
  db.close();
});

test('setUserStatus: set status to disabled', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-4', email: 'u4@test.com' });
  assert.equal(await setUserStatus(db, 'user-4', 'disabled'), true);
  const user = await getUser(db, 'user-4');
  assert.equal(user.status, 'disabled');
  db.close();
});

test('setUserRole: set role', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-5', email: 'u5@test.com', role: 'user' });
  assert.equal(await setUserRole(db, 'user-5', 'recruiter'), true);
  const user = await getUser(db, 'user-5');
  assert.equal(user.role, 'recruiter');
  db.close();
});

test('listApiKeys: returns empty list initially', async () => {
  const db = await seededDb();
  const keys = await listApiKeys(db);
  assert.deepEqual(keys, []);
  db.close();
});

test('listApiKeys: returns keys after issueApiKey', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-6', email: 'u6@test.com' });
  await issueApiKey(db, { userId: 'user-6', label: 'key1' });
  const keys = await listApiKeys(db, 'user-6');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].label, 'key1');
  assert.equal(keys[0].status, 'active');
  db.close();
});

test('listApiKeys: filters by userId', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-7', email: 'u7@test.com' });
  await issueApiKey(db, { userId: 'user-7', label: 'key1' });
  await issueApiKey(db, { userId: 'user-7', label: 'key2' });
  const keys = await listApiKeys(db, 'user-7');
  assert.equal(keys.length, 2);
  db.close();
});

test('disableUser: disables a user', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-8', email: 'u8@test.com' });
  assert.equal(await disableUser(db, 'user-8'), true);
  const user = await getUser(db, 'user-8');
  assert.equal(user.status, 'disabled');
  db.close();
});

test('enableUser: enables a disabled user', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-9', email: 'u9@test.com' });
  db._db.prepare("UPDATE identity_users SET status = 'disabled' WHERE user_id = 'user-9'").run();
  assert.equal(await enableUser(db, 'user-9'), true);
  const user = await getUser(db, 'user-9');
  assert.equal(user.status, 'active');
  db.close();
});

test('rotateKey: revokes old key and returns userId', async () => {
  const db = await seededDb();
  await createUser(db, { userId: 'user-10', email: 'u10@test.com' });
  const { key, keyHash } = await issueApiKey(db, { userId: 'user-10', label: 'key1' });
  const rotated = await rotateKey(db, keyHash);
  assert.equal(rotated.userId, 'user-10');
  assert.equal(await verifyKey(db, key), null);
  db.close();
});