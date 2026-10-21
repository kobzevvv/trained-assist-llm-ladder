import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { handle } from '../src/handler.js';
import { run, upstreamRequest, resetOpenrouterKeyCursor } from '../src/ladder.js';
import { encryptToken, decryptToken, maskToken, resolveProviderPool } from '../src/provider-credentials.js';

function d1() {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      return { all: async () => ({ results: raw.prepare(sql).all() }), bind(...values) {
        return { first: async () => raw.prepare(sql).get(...values) || null,
          all: async () => ({ results: raw.prepare(sql).all(...values) }),
          run: async () => { const r = raw.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } };
      } };
    },
  };
}

const CREDS_KEY = randomBytes(32).toString('base64');

async function schema(db) {
  db.raw.exec(await readFile(new URL('../schema/ladder_calls.sql', import.meta.url), 'utf8'));
  db.raw.exec(await readFile(new URL('../schema/migrations/0005_app.sql', import.meta.url), 'utf8'));
  db.raw.exec(await readFile(new URL('../schema/migrations/0009_identity.sql', import.meta.url), 'utf8'));
  db.raw.exec(await readFile(new URL('../schema/migrations/0016_provider_credentials.sql', import.meta.url), 'utf8'));
}

test('provider credentials are stored encrypted and never returned in plaintext', async () => {
  const key = await encryptToken('sk-or-secret-token-value', CREDS_KEY);
  assert.notEqual(key, 'sk-or-secret-token-value');
  assert.ok(!key.includes('secret-token-value'));
  assert.equal(await decryptToken(key, CREDS_KEY), 'sk-or-secret-token-value');
  // A different key must not decrypt it.
  await assert.rejects(() => decryptToken(key, randomBytes(32).toString('base64')));
  const secret = 'sk-or-secret-token-value';
  assert.equal(maskToken(secret), secret.slice(0, 6) + '•'.repeat(secret.length - 10) + secret.slice(-4));
  assert.equal(maskToken('short'), '••••••••••••');
});

test('admin adds a provider credential; the raw token never appears in the listing', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY };
    const req = (path, token = 'admin', method = 'GET', body) => handle(new Request(`https://ladder.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);

    const added = await req('/v1/admin/provider-credentials', 'admin', 'POST',
      { provider: 'openrouter', label: 'OpenRouter · основной', token: 'sk-or-abcdef123456' });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    assert.equal(addedBody.credential.provider, 'openrouter');
    assert.equal(addedBody.credential.label, 'OpenRouter · основной');
    assert.equal(addedBody.credential.status, 'active');
    // The response must not carry the raw token.
    assert.equal(JSON.stringify(addedBody).includes('sk-or-abcdef123456'), false);

    // Stored encrypted, not in plaintext.
    const row = db.raw.prepare('SELECT ciphertext, key_version, provider, label FROM provider_credentials WHERE id = 1').get();
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.label, 'OpenRouter · основной');
    assert.equal(row.key_version, 'v1');
    assert.equal(row.ciphertext.includes('abcdef123456'), false);
    assert.equal(await decryptToken(row.ciphertext, CREDS_KEY), 'sk-or-abcdef123456');

    // Listing masks the token and shows metadata only.
    const list = await req('/v1/admin/provider-credentials');
    assert.equal(list.status, 200);
    const listing = await list.json();
    assert.equal(listing.credentials.length, 1);
    assert.equal(listing.credentials[0].token_mask, 'sk-or-••••••••3456');
    assert.equal(JSON.stringify(listing).includes('sk-or-abcdef123456'), false);

    // A personal (non-admin) key cannot read or write the credential pool.
    const personal = 'personal-key-for-credentials';
    const personalHash = createHash('sha256').update(personal).digest('hex');
    db.raw.prepare("INSERT INTO identity_users (user_id,email,role,status,created_at,updated_at) VALUES ('u1','u1@example.test','user','active',1,1)").run();
    db.raw.prepare("INSERT INTO identity_api_keys (key_hash,user_id,label,status,created_at) VALUES (?,?,'Mac','active',1)").run(personalHash, 'u1');
    assert.equal((await req('/v1/admin/provider-credentials', personal)).status, 403);
    assert.equal((await req('/v1/admin/provider-credentials', personal, 'POST',
      { provider: 'openrouter', label: 'x', token: 'sk-or-abcdef123456' })).status, 403);

    // The identity provisioner creates users and nothing else — it must not touch the pool.
    const provisionerEnv = { ...env, IDENTITY_PROVISIONER_TOKEN: 'provisioner-token-for-credentials' };
    const provisioner = await handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      headers: { authorization: 'Bearer provisioner-token-for-credentials' },
    }), provisionerEnv);
    assert.equal(provisioner.status, 403);
  } finally { db.raw.close(); }
});

test('admin refuses malformed provider credentials', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY };
    const post = (body) => handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    // Unknown provider.
    assert.equal((await post({ provider: 'anthropic', label: 'x', token: 'sk-or-abcdef123456' })).status, 400);
    // Missing label.
    assert.equal((await post({ provider: 'openrouter', label: '', token: 'sk-or-abcdef123456' })).status, 400);
    // Missing token.
    assert.equal((await post({ provider: 'openrouter', label: 'x', token: '' })).status, 400);
    // An `os_sk_` prefix is the typo that killed every Go rung in incident #86.
    assert.equal((await post({ provider: 'opencode-go', label: 'x', token: 'os_sk_60d00c482dc4__YpLl' })).status, 400);
    // A well-formed Go key is accepted.
    assert.equal((await post({ provider: 'opencode-go', label: 'Go 1', token: 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0' })).status, 200);
    // An OpenRouter key with the wrong prefix is rejected.
    assert.equal((await post({ provider: 'openrouter', label: 'x', token: 'oc_sk_60d00c482dc4' })).status, 400);
  } finally { db.raw.close(); }
});

test('provider credentials are refused when PROVIDER_CREDS_KEY is missing', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db };
    const res = await handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', label: 'x', token: 'sk-or-abcdef123456' }),
    }), env);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /PROVIDER_CREDS_KEY/);
    // Nothing was written.
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM provider_credentials').get().n, 0);
  } finally { db.raw.close(); }
});

test('disabling a provider credential removes it from the resolved pool', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY,
      OPENROUTER_API_KEY: 'sk-or-env-key', OPENCODE_GO_API_KEYS: 'oc_env_1,oc_env_2' };
    const post = (body) => handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);

    await post({ provider: 'openrouter', label: 'OR db', token: 'sk-or-dbkey0001' });
    await post({ provider: 'opencode-go', label: 'GO db', token: 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0' });

    let pool = await resolveProviderPool(env, db);
    // env secret first, then the D1 credentials.
    assert.deepEqual(pool.openrouter, ['sk-or-env-key', 'sk-or-dbkey0001']);
    assert.deepEqual(pool.go, ['oc_env_1', 'oc_env_2', 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0']);

    const disable = await handle(new Request('https://ladder.test/v1/admin/provider-credentials/1/disable', {
      method: 'POST', headers: { authorization: 'Bearer admin' },
    }), env);
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).credential.status, 'disabled');

    pool = await resolveProviderPool(env, db);
    assert.deepEqual(pool.openrouter, ['sk-or-env-key']);
    // The Go credential (id 2) is untouched by disabling id 1.
    assert.deepEqual(pool.go, ['oc_env_1', 'oc_env_2', 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0']);

    // Disabling the Go credential removes it from the pool.
    await handle(new Request('https://ladder.test/v1/admin/provider-credentials/2/disable', {
      method: 'POST', headers: { authorization: 'Bearer admin' },
    }), env);
    pool = await resolveProviderPool(env, db);
    assert.deepEqual(pool.go, ['oc_env_1', 'oc_env_2']);

    // A non-numeric id never matches the route.
    const bad = await handle(new Request('https://ladder.test/v1/admin/provider-credentials/abc/disable', {
      method: 'POST', headers: { authorization: 'Bearer admin' },
    }), env);
    assert.equal(bad.status, 404);
  } finally { db.raw.close(); }
});

test('the admin page shows the provider tabs and the credential forms', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY };
    const page = await handle(new Request('https://ladder.test/admin'), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-tab="openrouter"/);
    assert.match(html, /data-tab="opencode-go"/);
    assert.match(html, /data-provider="openrouter"/);
    assert.match(html, /data-provider="opencode-go"/);
    assert.match(html, /id="or-rows"/);
    assert.match(html, /id="go-rows"/);
    // The credential listing never leaks a token value into the page markup.
    assert.equal(/sk-or-[A-Za-z0-9]{10,}/.test(html), false);
  } finally { db.raw.close(); }
});

test('the ladder uses D1-stored credentials for OpenRouter and OpenCode Go', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY,
      OPENROUTER_API_KEY: 'sk-or-env-key', OPENCODE_GO_API_KEYS: 'oc_env_1' };
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const store = {
      state: { health: {}, keys: { active: 0, exhausted: {} }, pins: {} },
      async snapshot() { return { health: {}, keys: { active: 0, exhausted: {} }, pin: null }; },
      async recordFailure() {}, async recordSuccess() {},
      async rotateKey() { return { rotated: false, retryAt: Date.now() + 1000 }; },
      async resetKeys() {}, async park() {}, async pinStats() { return { count: 0, byRung: {} }; },
    };
    const config = { ladders: { service: { build: ['opencode-go/mimo-v2.6-flash'] } } };
    const res = await run({ model: 'service', messages: [{ role: 'user', content: 'hi' }] }, {
      env, config, store, fetchImpl: fakeFetch,
    });
    assert.equal(res.ok, true);
    // The env Go key was used (the D1 pool is empty here).
    assert.equal(calls[0].auth, 'Bearer oc_env_1');

    // Now store a D1 Go credential — the pool must grow and the ladder must use both.
    await handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'opencode-go', label: 'GO db', token: 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0' }),
    }), env);
    const pool = await resolveProviderPool(env, db);
    assert.deepEqual(pool.go, ['oc_env_1', 'oc_sk_60d00c482dc4__YpLlJacy5hFyLP0']);
  } finally { db.raw.close(); }
});

test('upstreamRequest picks the OpenRouter key from the pool by cursor', () => {
  const pool = { go: ['oc_a'], openrouter: ['sk-or-1', 'sk-or-2', 'sk-or-3'] };
  const body = { messages: [] };
  const auth = (index) => upstreamRequest({}, 'openrouter/x/y', body, 0, { pool, orIndex: index }).headers.Authorization;
  assert.equal(auth(0), 'Bearer sk-or-1');
  assert.equal(auth(1), 'Bearer sk-or-2');
  assert.equal(auth(2), 'Bearer sk-or-3');
  // The cursor wraps around.
  assert.equal(auth(3), 'Bearer sk-or-1');
  // A single-key pool always resolves to that key (the previous behaviour).
  const single = { go: [], openrouter: ['sk-or-only'] };
  assert.equal(upstreamRequest({}, 'openrouter/x/y', body, 0, { pool: single, orIndex: 5 }).headers.Authorization, 'Bearer sk-or-only');
});

test('an OpenRouter key fault rotates to the next credential — once', async () => {
  const db = d1();
  try {
    await schema(db);
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: CREDS_KEY,
      OPENROUTER_API_KEY: 'sk-or-env-key' };
    await handle(new Request('https://ladder.test/v1/admin/provider-credentials', {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', label: 'OR db', token: 'sk-or-dbkey0001' }),
    }), env);

    const auth = [];
    const fakeFetch = async (url, init) => {
      auth.push(init.headers.Authorization);
      // The env credential is revoked — the D1 credential answers.
      if (init.headers.Authorization === 'Bearer sk-or-env-key') {
        return new Response('{"error":{"message":"invalid credential"}}', { status: 401 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const store = {
      state: { health: {}, keys: { active: 0, exhausted: {} }, pins: {} },
      async snapshot() { return { health: {}, keys: { active: 0, exhausted: {} }, pin: null }; },
      async recordFailure() {}, async recordSuccess() {},
      async rotateKey() { return { rotated: false, retryAt: Date.now() + 1000 }; },
      async resetKeys() {}, async park() {}, async pinStats() { return { count: 0, byRung: {} }; },
    };
    const config = { ladders: { service: { build: ['openrouter/some-model'] } } };
    resetOpenrouterKeyCursor();
    const res = await run({ model: 'service', messages: [{ role: 'user', content: 'hi' }] }, {
      env, config, store, fetchImpl: fakeFetch,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(auth, ['Bearer sk-or-env-key', 'Bearer sk-or-dbkey0001']);
    assert.equal(res.attempts.some((a) => a.outcome === 'key-rotated'), true);
  } finally { db.raw.close(); }
});
