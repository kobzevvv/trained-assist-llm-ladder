import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fetchOrUsage } from '../src/ladder.js';
import { addProviderCredential } from '../src/provider-credentials.js';

// Дневной бесплатный лимит OpenRouter считается ПО АККАУНТУ, а ключ в пуле — это разные
// аккаунты: у каждого свой `free_model_daily_requests`. Замерено 2026-10-22 на живом пуле:
// env-аккаунт 924/1000 (на нём куплено ≥ $10 кредитов), четыре аккаунта из D1 — 12–57 при
// лимите 50 (на них куплено меньше $10). Поэтому лимит пула — сумма по аккаунтам, а не счётчик
// первого ключа.

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
          run: async () => { const r = raw.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertId) } }; } };
      } };
    },
  };
}

async function schema(db) {
  db.raw.exec(await readFile(new URL('../schema/ladder_calls.sql', import.meta.url), 'utf8'));
  db.raw.exec(await readFile(new URL('../schema/migrations/0016_provider_credentials.sql', import.meta.url), 'utf8'));
}

const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

test('/v1/or-usage: the free limit is counted over EVERY account of the pool', async () => {
  const db = d1();
  await schema(db);
  const CREDS_KEY = randomBytes(32).toString('base64');
  const env = { OPENROUTER_API_KEY: 'sk-or-v1-env', PROVIDER_CREDS_KEY: CREDS_KEY, LADDER_TRACE_DB: db };
  await addProviderCredential(db, env, { provider: 'openrouter', label: 'mariam', token: 'sk-or-v1-mariam' });

  const fakeFetch = async (url, opts) => {
    const token = String(opts?.headers?.Authorization || '').replace('Bearer ', '');
    if (url.endsWith('/credits')) {
      return token === 'sk-or-v1-env' ? json({ data: { total_credits: 97, total_usage: 97.2 } }) : json({ data: { total_credits: 0, total_usage: 0 } });
    }
    return token === 'sk-or-v1-env'
      ? json({ data: { label: 'sk-or-v1-env…', is_free_tier: false, free_model_daily_requests: { used: 924, limit: 1000, remaining: 76 } } })
      : json({ data: { label: 'sk-or-v1-mariam…', is_free_tier: true, free_model_daily_requests: { used: 57, limit: 50, remaining: -7 } } });
  };

  const r = await fetchOrUsage(env, { fetchImpl: fakeFetch });

  assert.equal(r.accounts.length, 2, 'в ответе видно оба аккаунта пула');
  assert.equal(r.accounts[0].label, 'env');
  assert.equal(r.accounts[1].label, 'mariam');
  assert.equal(r.accounts[1].remaining, 0, 'used > limit → честный ноль, а не минус');
  assert.equal(r.pool.used, 981);
  assert.equal(r.pool.limit, 1050);
  assert.equal(r.pool.remaining, 76, 'осталось то, чем ещё можно пользоваться');
  assert.equal(r.pool.exhausted, 1);
  assert.equal(r.pool.credit_total, 97);
  assert.equal(r.pool.credit_used, 97.2);

  // Старый контракт жив: key/credits — сырые ответы ПЕРВОГО ключа пула.
  assert.equal(r.key.data.free_model_daily_requests.used, 924);
  assert.equal(r.credits.data.total_credits, 97);

  // Сырые токены в ответе нет.
  assert.equal(JSON.stringify(r).includes('sk-or-v1-mariam'), false);
});

test('/v1/or-usage: без ключей пул пуст, а не ошибка', async () => {
  const r = await fetchOrUsage({}, { fetchImpl: async () => { throw new Error('не звали'); } });
  assert.equal(r.pool, null);
  assert.match(r.error, /OPENROUTER_API_KEY/);
});
