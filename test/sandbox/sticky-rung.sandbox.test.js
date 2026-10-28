// Sandbox for the sticky-rung-per-conversation scenario (epic #17, plan 4bc36b06, step 6/15).
//
// Runs the acceptance script through the REAL worker route (src/index.js `handle()`: auth, header
// parsing, /v1/chat/completions) with fake upstreams (fetchImpl) and an in-memory store. It plays a
// two-conversation scenario against one worker instance, exactly as a live opencode run would.
//
// One command:   bash scripts/sandbox/sticky-rung.sh     (or: npm run test:sandbox)
// Deterministic PASS/FAIL. RED by design: the feature is not implemented yet, so the scenario breaks
// at the first gate (turn 1 has no `pin=new`). It turns green after slices S3–S9.
//
// Store contract follows the proposal (sticky-rung-proposal.md §2): the DO is dumb persistence —
// pins it stores have NO routing effect; every behavioural assertion below is on HTTP output that
// only src/ladder.js `run()` controls. Current run() never reads `pin:`, so the scenario stays red
// until the feature lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handle } from '../../src/handler.js';
import { memoryStore } from '../../src/state.js';

const config = JSON.parse(fs.readFileSync(new URL('../../config/ladders.json', import.meta.url)));
const LADDER = config.ladders.service.build;
const short = m => m.replace(/^opencode-go\/|^openrouter\//, '');
const RUNG0 = LADDER[0]; // full rung id — what x-ladder-model carries
const RUNG1 = LADDER[1];
const RUNG0_SHORT = short(RUNG0); // what the upstream request carries (body.model)
const RUNG1_SHORT = short(RUNG1);
const TOKEN = 'sandbox-token';
const ENV = { LADDER_TOKEN: TOKEN, OPENCODE_GO_API_KEYS: 'oc_a, oc_b', OPENROUTER_API_KEY: 'or_key' };
const CTX_BODY = 'This request exceeds the context window of the model';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────

// Fake upstream: rules per rung model, switched mid-scenario (a rule returning {status,error} makes
// the rung fail, {status:200,content} answers). Rules can be swapped between turns — that is the
// "forced mid-run failure" of the script.
function fakeUpstreams() {
  const rules = {};
  return {
    setRung(rung, rule) { rules[rung] = rule; },
    clearRungs() { for (const k of Object.keys(rules)) delete rules[k]; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const rule = rules[body.model];
      const r = typeof rule === 'function' ? rule() : (rule || { status: 200, content: 'ok' });
      if (r.status !== 200) return { ok: false, status: r.status, text: async () => r.error || '', json: async () => null };
      return {
        ok: true, status: 200,
        json: async () => ({ id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: r.content } }], usage: { prompt_tokens: 3 } }),
        text: async () => '',
      };
    },
  };
}

// In-memory store with the pin-persistence extension from the proposal. Pure storage: snapshot()
// returns whatever pin the caller asks for, recordSuccess/recordFailure persist what they are told.
// No routing anywhere — run() owns the behaviour.
function sandboxStore(poolSize = 2) {
  const inner = memoryStore(poolSize);
  const pins = new Map();
  return {
    state: inner.state,
    pins,
    async snapshot(_poolSize, pinKey) {
      const s = await inner.snapshot(_poolSize || poolSize);
      const p = pinKey ? pins.get(pinKey) : undefined;
      return { ...s, pin: p ? { ladder: 'service', rung: p.rung, lastUsedAt: p.lastUsedAt } : null };
    },
    async recordSuccess(model, extra) {
      await inner.recordSuccess(model);
      if (extra && extra.pin) pins.set(String(extra.pin.pinKey), { rung: extra.pin.rung, lastUsedAt: Date.now() });
    },
    async recordFailure(model, failure, extra) {
      await inner.recordFailure(model, failure);
      if (extra && extra.pinRemove) pins.delete(String(extra.pinRemove.pinKey));
    },
    async rotateKey(size, ttlMs, failedIndex) { return inner.rotateKey(size, ttlMs, failedIndex); },
    async park(models, untilMs) { return inner.park(models, untilMs); },
    async pinStats() {
      const byRung = {};
      for (const [, v] of pins) byRung[v.rung] = (byRung[v.rung] || 0) + 1;
      return { count: pins.size, byRung };
    },
  };
}

function makeScenario() {
  const upstream = fakeUpstreams();
  const store = sandboxStore(2);
  const post = (headers, body = { model: 'service', messages: [{ role: 'user', content: 'hi' }] }) =>
    handle(new Request('https://ladder.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(body),
    }), ENV, { store, fetchImpl: upstream.fetch });
  const attemptsOf = r => r.headers.get('x-ladder-attempts') || '';
  const modelOf = r => r.headers.get('x-ladder-model');
  return { store, upstream, post, attemptsOf, modelOf };
}

// ── scenario: one conversation, one rung switch; others untouched ─────────────────────────────────
// TODO(epic #17): sticky rung per conversation — this scenario is RED by design.
// It gates slices S3–S9 of the sticky-rung proposal. Current run() never reads `pin:`,
// so the scenario stays red until the feature lands. Enable with `test()` when implemented.
test.todo('scenario: conversation A sticks to its rung through a forced mid-run failure; B and one-shots are untouched');
