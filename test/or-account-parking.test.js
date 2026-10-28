// Issue #297 — the OpenRouter ACCOUNT limit is remembered.
//
// The free-model allowance is counted per OpenRouter account. Before this, one account's daily cap
// became an hour-long quota skip of the RUNG — for every account of the pool — and the capped
// account was asked again on every rung of every call. Now the account is parked until its own
// reset, the account is stepped over, and the rung stays eligible for the accounts that still have
// allowance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, resetOpenrouterKeyCursor } from '../src/ladder.js';
import { memoryStore, emptyState, parkAccount, parkedAccounts, freeParkedAccounts, resetKeys } from '../src/state.js';
import { orAccountLimit, orAccountLimitOf, orParkUntil } from '../src/or-limits.js';
import { nextUsableOpenrouterIndex } from '../src/go-routing.js';
import { makeStore } from '../src/handler.js';
import { encryptToken } from '../src/provider-credentials.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));

// The daily free-tier body as the provider sends it (measured 2026-10-22, 4 accounts capped):
// `limit_source` and the reset stamp sit at the END of the body — the error string kept in the
// attempts is cut to 300 characters, so the limit is read from the full body.
const DAILY_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
    metadata: {
      headers: {
        'X-RateLimit-Limit': '50',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1792713600000',
      },
    },
    limit_source: 'openrouter_free_tier_daily',
    remedy_hint: 'Add credits at https://openrouter.ai/settings/credits',
  },
});
const RESET_AT = 1792713600000;

const OR_CFG = {
  ...config,
  ladders: { ...config.ladders, service: { ...config.ladders.service, build: ['openrouter/alpha:free', 'openrouter/beta:free'] } },
};
const msg = { model: 'service', messages: [{ role: 'user', content: 'hi' }] };

// behaviour[model]({ auth }) → { status, content } | { status, error }
function fakeFetch(behaviour, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const auth = init.headers.Authorization;
    calls.push({ url, model: body.model, auth, body });
    const r = (behaviour[body.model] || (() => ({ status: 200, content: 'ok' })))({ auth, body });
    const data = r.status === 200
      ? { id: 'x', object: 'chat.completion', choices: [{ finish_reason: r.finish, message: { role: 'assistant', content: r.content } }], usage: r.usage || { prompt_tokens: 3 } }
      : null;
    return { ok: r.status === 200, status: r.status, json: async () => data, text: async () => r.error || '' };
  };
}

// ── the read of the provider body ─────────────────────────────────────────────────────────────────

test('#297: the daily free-tier cap is read from the provider body, with the reset moment', () => {
  const limit = orAccountLimit(429, DAILY_BODY);
  assert.equal(limit.kind, 'daily');
  assert.equal(limit.resetAt, RESET_AT);
});

test('#297: credits and a bare 403 are account signals; a dead model is not', () => {
  assert.equal(orAccountLimit(402, '{"error":{"code":402,"message":"Insufficient credits"}}').kind, 'credits');
  assert.equal(orAccountLimit(403, '{"error":{"code":403,"message":"Forbidden"}}').kind, 'forbidden');
  assert.equal(orAccountLimit(429, '{"error":{"code":429,"message":"Rate limit exceeded"}}').kind, 'per_minute');
  // A model that is gone for everyone is a RUNG decision, not an account decision.
  assert.equal(orAccountLimit(404, '{"error":{"code":404,"message":"This model is unavailable for free"}}'), null);
  assert.equal(orAccountLimit(500, 'internal error'), null);
  assert.equal(orAccountLimit(200, ''), null);
});

test('#297: the error string of an attempt is a fallback read of the same body', () => {
  const limit = orAccountLimitOf(`HTTP 429: ${DAILY_BODY}`);
  assert.equal(limit.kind, 'daily');
  assert.equal(orAccountLimitOf('HTTP 404: {"error":{"code":404}}'), null);
});

test('#297: the park lasts until the reset — but never less than a minute', () => {
  const now = RESET_AT - 60 * 60 * 1000; // an hour before the daily reset
  assert.equal(orParkUntil({ kind: 'daily', resetAt: RESET_AT }, now), RESET_AT);
  assert.equal(orParkUntil({ kind: 'per_minute', resetAt: null }, now), now + 60_000);
  assert.equal(orParkUntil({ kind: 'credits', resetAt: null }, now), now + 60 * 60 * 1000);
  // A reset stamp in the past must not park the account for a negative time.
  assert.equal(orParkUntil({ kind: 'daily', resetAt: now - 1000 }, now), now + 60_000);
  // A bogus stamp far in the future is capped.
  assert.equal(orParkUntil({ kind: 'daily', resetAt: now + 30 * 24 * 60 * 60 * 1000 }, now), now + 24 * 60 * 60 * 1000);
  assert.equal(orParkUntil(null, now), 0);
});

// ── the state ───────────────────────────────────────────────────────────────────────────────────

test('#297: the account parks live in their own namespace, the Go key state is untouched', () => {
  const st = emptyState();
  parkAccount(st, 2, Date.now() + 60_000);
  assert.equal(Object.keys(parkedAccounts(st)).length, 1);
  assert.equal(st.keys.exhausted[2], undefined, 'the Go key rotation state is a different pool');
  // The ops lever (POST /v1/state/reset-keys) releases the account parks as well.
  resetKeys(st);
  assert.deepEqual(parkedAccounts(st), {});
});

test('#297: the worker store wires the account park to the Durable Object', async () => {
  const calls = [];
  const stub = {
    snapshot: async () => ({}), recordFailure: async () => {}, recordSuccess: async () => {},
    rotateKey: async () => ({}), resetKeys: async () => {}, park: async () => {},
    parkAccount: async (index, untilMs, opts) => { calls.push({ index, untilMs, opts }); },
    pinStats: async () => ({ count: 0, byRung: {} }),
  };
  const env = { LADDER_STATE: { idFromName: () => 'global', get: () => stub } };
  const store = makeStore(env);
  await store.parkAccount(3, 123456);
  assert.deepEqual(calls, [{ index: 3, untilMs: 123456, opts: {} }]);
  // The free-only bucket is a separate park — the store must pass it through.
  await store.parkAccount(1, 999, { freeOnly: true });
  assert.deepEqual(calls[1], { index: 1, untilMs: 999, opts: { freeOnly: true } });
});

test('#297: the account selection steps over the parked accounts', () => {
  const now = Date.now();
  assert.equal(nextUsableOpenrouterIndex(3, 0, {}, now), 0);
  assert.equal(nextUsableOpenrouterIndex(3, 0, { 0: now + 1000 }, now), 1);
  assert.equal(nextUsableOpenrouterIndex(3, 2, { 0: now + 1000, 2: now + 1000 }, now), 1);
  // Every account parked → the caller must not ask anybody.
  assert.equal(nextUsableOpenrouterIndex(2, 0, { 0: now + 1000, 1: now + 1000 }, now), -1);
  assert.equal(nextUsableOpenrouterIndex(0, 0, {}, now), -1);
});

// ── the ladder ─────────────────────────────────────────────────────────────────────────────────

// Two accounts: the env key and one admin-managed credential (the pool is env-first).
async function twoAccountEnv() {
  const keyB64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
  const enc = await encryptToken('or_d1_key', keyB64);
  const db = {
    prepare(sql) {
      return {
        bind: () => ({ run: async () => ({}) }),
        all: async () => ({ results: sql.includes("provider = 'openrouter'") ? [{ label: 'd1', ciphertext: enc }] : [] }),
      };
    },
  };
  return { OPENROUTER_API_KEY: 'or_env_key', LADDER_TRACE_DB: db, PROVIDER_CREDS_KEY: keyB64 };
}

test('#297: a capped account is parked — the other account of the pool still serves the rung', async () => {
  const env = await twoAccountEnv();
  const calls = [];
  const store = memoryStore(0);
  resetOpenrouterKeyCursor();
  // The env account is capped; the admin-managed one still has allowance.
  const behaviour = {
    'alpha:free': ({ auth }) => (auth === 'Bearer or_env_key'
      ? { status: 429, error: DAILY_BODY }
      : { status: 200, content: 'ok' }),
  };
  const r = await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r.ok, true, 'the rung is served by the account that still has allowance');
  assert.equal(r.model, 'openrouter/alpha:free');
  // The capped account is remembered, not asked again. A free-model allowance cap is a FREE-TIER
  // signal: it lands in the free-only bucket, not the account-wide one — a paid model on the same
  // account draws credits, not the free allowance, so the account must stay usable for the paid tail.
  const parked = freeParkedAccounts(store.state);
  assert.equal(Object.keys(parked).length, 1, 'exactly one account is free-parked');
  assert.ok(parked[0] > Date.now(), 'the park is in the future');
  assert.deepEqual(parkedAccounts(store.state), {}, 'no account-wide park — the account is not dead for paid rungs');

  // The next call must not touch the capped account at all.
  const before = calls.length;
  const r2 = await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r2.ok, true);
  assert.equal(calls.length - before, 1, 'one provider request — the parked account is skipped');
  assert.ok(calls.slice(before).every(c => c.auth !== 'Bearer or_env_key'), 'the capped account is not asked again');
});

// A free-tier cap (openrouter_free_tier_*) is a property of the `:free` models: a PAID model on the
// same account draws credits, not the free allowance. The ladder must keep the paid tail working
// while the free tier is capped — otherwise one exhausted free account takes the WHOLE ladder down
// (measured 2026-10-28: 93 all-skipped `every rung failed` on `standard` in 6 h).
test('#297b: a free-tier cap does NOT block the PAID tail on the same account', async () => {
  const env = { OPENROUTER_API_KEY: 'or_env_key' }; // one account
  const calls = [];
  const store = memoryStore(0);
  resetOpenrouterKeyCursor();
  // A ladder whose free rung is capped but whose PAID rung sits on the same account.
  const cfg = { ...config, ladders: { ...config.ladders, service: { ...config.ladders.service,
    build: ['openrouter/alpha:free', 'openrouter/google/gemini-3.1-flash-lite-preview'] } } };
  const behaviour = {
    'alpha:free': () => ({ status: 429, error: DAILY_BODY }),
    'google/gemini-3.1-flash-lite-preview': () => ({ status: 200, content: 'ok' }),
  };
  const r = await run(msg, { env, config: cfg, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r.ok, true, 'the paid tail serves when only the free allowance is capped');
  assert.equal(r.model, 'openrouter/google/gemini-3.1-flash-lite-preview');
  // The free rung is asked once (it has to fail to discover the cap) and the paid rung answers on the
  // SAME capped account — a free cap must not stand in the way of a model that draws credits.
  assert.equal(calls.length, 2, 'one attempt per rung: free fails, paid answers');
  assert.equal(calls[0].model, 'alpha:free', 'the free rung is tried first');
  assert.equal(calls[1].model, 'google/gemini-3.1-flash-lite-preview', 'then the paid rung');
  assert.ok(calls.every(c => c.auth === 'Bearer or_env_key'), 'the paid rung rides the capped account');
  assert.ok(r.attempts.some(a => a.outcome === 'error' && /429|free|usage/i.test(a.error || '')),
    'the free rung is tried, fails with the free-tier cap, and is not retried');
  // The free cap is recorded in the free-only bucket — the account-wide park is untouched.
  assert.deepEqual(parkedAccounts(store.state), {}, 'no account-wide park');
  assert.equal(Object.keys(freeParkedAccounts(store.state)).length, 1, 'the free cap is remembered');
});

test('#297: a capped account is skipped for the rest of the call and the rung is not poisoned for an hour', async () => {
  const env = { OPENROUTER_API_KEY: 'or_env_key' }; // one account
  const calls = [];
  const store = memoryStore(0);
  resetOpenrouterKeyCursor();
  const behaviour = {
    'alpha:free': () => ({ status: 429, error: DAILY_BODY }),
    'beta:free': () => ({ status: 429, error: DAILY_BODY }),
  };
  const r = await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, 'the capped account is asked once — not once per rung');
  assert.ok(r.attempts.some(a => a.outcome === 'skipped' && /parked/i.test(a.error || '')),
    'the second rung is skipped without a provider request');
  // The rung stays eligible: an account-level limit is NOT a shared hour-long quota.
  const health = store.state.health['openrouter/alpha:free'];
  assert.equal(health.class, 'transient');
  assert.ok(health.skipUntil - Date.now() < 5 * 60 * 1000, 'the rung is back in seconds, not in an hour');
  // A free-tier cap is a free-only park — the account is not dead for paid rungs.
  assert.deepEqual(parkedAccounts(store.state), {}, 'no account-wide park');
  assert.equal(Object.keys(freeParkedAccounts(store.state)).length, 1, 'the free cap is remembered');

  // Every account is parked → the next call fails fast, without a single provider request.
  const before = calls.length;
  const r2 = await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r2.ok, false);
  assert.equal(calls.length, before, 'no provider request while every account is parked');
});

test('#297: the ops lever releases the parked accounts', async () => {
  const env = { OPENROUTER_API_KEY: 'or_env_key' };
  const calls = [];
  const store = memoryStore(0);
  resetOpenrouterKeyCursor();
  const behaviour = { 'alpha:free': () => ({ status: 429, error: DAILY_BODY }), 'beta:free': () => ({ status: 429, error: DAILY_BODY }) };
  await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(Object.keys(freeParkedAccounts(store.state)).length, 1);
  await store.resetKeys();
  assert.deepEqual(parkedAccounts(store.state), {});
  assert.deepEqual(freeParkedAccounts(store.state), {});
  const before = calls.length;
  await run(msg, { env, config: OR_CFG, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.ok(calls.length > before, 'the released account is asked again');
});

// An ACCOUNT-WIDE limit (402 credits, 403, a bare 429 without a free-tier limit_source) blocks free
// AND paid rungs — it is not a free-tier signal, so it lands in the shared bucket.
test('#297c: a bare 429 / 403 parks the account for the paid tail too', async () => {
  const env = { OPENROUTER_API_KEY: 'or_env_key' };
  const calls = [];
  const store = memoryStore(0);
  resetOpenrouterKeyCursor();
  const cfg = { ...config, ladders: { ...config.ladders, service: { ...config.ladders.service,
    build: ['openrouter/alpha:free', 'openrouter/google/gemini-3.1-flash-lite-preview'] } } };
  const behaviour = {
    'alpha:free': () => ({ status: 403, error: 'HTTP 403: Forbidden' }),
    'google/gemini-3.1-flash-lite-preview': () => ({ status: 200, content: 'ok' }),
  };
  const r = await run(msg, { env, config: cfg, store, fetchImpl: fakeFetch(behaviour, calls) });
  assert.equal(r.ok, false, 'a 403 is an account-wide limit — the paid rung must not answer');
  assert.equal(calls.length, 1, 'the account is asked once for the free rung, then skipped');
  assert.equal(Object.keys(parkedAccounts(store.state)).length, 1, 'the account is account-wide parked');
  assert.deepEqual(freeParkedAccounts(store.state), {}, 'no free-only park — the limit is not a free-tier signal');
});
