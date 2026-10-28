#!/usr/bin/env node
import { readLadderToken } from './ladder-credentials.mjs';
import { buildDigest } from './speed-digest-lib.mjs';
// Speed digest for the ladder — a compact, readable answer to "what answered, how fast, and is
// anything slow". Reads the SAME data production already records (`GET /v1/analytics`, one row per
// served call in D1), so it costs no extra LLM calls: unlike `ladder-bench` it measures real
// traffic, not probes, and it can run as often as we like.
//
// v2 (#325): headline → funnel («сколько запросов по каждому шагу»: free Go → zen → OpenRouter
// free → платный хвост, plus где падали отказы) → anomalies only. The long per-ladder/per-model
// tables moved to https://llm-ladder.trainedassist.store/admin — the digest is for reading, the
// cuts are for investigating. Rendering lives in speed-digest-lib.mjs (tested with fixtures).
//
// Usage:
//   node scripts/speed-digest.mjs               # last 4 h, markdown to stdout
//   node scripts/speed-digest.mjs --hours=24
//   LADDER_BASE=http://localhost:8787 node scripts/speed-digest.mjs
//
// Exit: 0 always — a digest is information, not a gate. Slowness is marked ⚠️ inside the text.
// (Turning it into a red check is a one-line change to `SLOW_MS` once we agree on a budget.)

const argv = process.argv.slice(2);
const hoursArg = argv.find((a) => a.startsWith('--hours='));
const HOURS = Number(hoursArg ? hoursArg.slice(8) : process.env.DIGEST_HOURS || 4);
const BASE = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');

// A rung slower than this is marked. 15 s is deliberately generous: the free tiers are slow by
// design, the question is "did it get much worse", not "is it fast".
const SLOW_MS = Number(process.env.DIGEST_SLOW_MS || 15_000);
// A rung slower than this is called out as a problem, not a warning.
const BAD_MS = Number(process.env.DIGEST_BAD_MS || 45_000);

const token = readLadderToken();
if (!token) {
  console.error('no token: run node scripts/ladder-token.mjs to inspect credential sources');
  process.exit(2);
}

const res = await fetch(`${BASE}/v1/analytics?hours=${HOURS}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`/v1/analytics answered ${res.status}`); process.exit(2); }
const d = await res.json();

console.log(buildDigest(d, { hours: HOURS, slowMs: SLOW_MS, badMs: BAD_MS }));
