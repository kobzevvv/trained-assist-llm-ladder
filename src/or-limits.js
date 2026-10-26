// OpenRouter ACCOUNT-level limits (issue #297).
//
// The free-model allowance is counted per OpenRouter ACCOUNT, and the provider names the limit in
// the body of the error — the ladder sees that body while reading the failed response:
//
//   {"error":{"code":429,"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to
//     unlock 1000 free model requests per day",
//     "metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0",
//     "X-RateLimit-Reset":"1792713600000"}},
//     "limit_source":"openrouter_free_tier_daily","remedy_hint":"..."}}
//
// `limit_source` names the limit and `X-RateLimit-Reset` is the moment it lifts. Both live at the
// END of the body, so they are read from the FULL body (the error string kept in the attempts is
// cut to 300 characters and would lose them) — that is why the parse happens where the response
// is read, not where the error text is classified.
//
// The account is parked until its own reset instead of poisoning the rung for everybody: the old
// behaviour turned one account's daily cap into an hour-long skip of the rung on EVERY account of
// the pool (issue #297) — and the free profile had no other rung left.
//
// A model-level rejection (404 "unavailable for free", 400) is NOT an account signal: the model
// is gone for everyone, and that stays a rung-level decision.

export const OR_PARK_TTL_MS = Object.freeze({
  daily: 60 * 60 * 1000,      // fallback when the provider sends no reset moment
  per_minute: 60 * 1000,       // per-minute free allowance
  credits: 60 * 60 * 1000,    // 402 — the operator tops the account up
  forbidden: 60 * 1000,       // 403 without a known limit kind — a burst breaker
  unknown: 60 * 1000,
});

// A park shorter than a minute bounces straight back onto the account that just refused, so the
// floor is a minute; the ceiling keeps a bogus reset stamp from parking an account for days.
export const OR_PARK_MIN_MS = 60 * 1000;
export const OR_PARK_MAX_MS = 24 * 60 * 60 * 1000;

const STATUS_RE = /^HTTP\s+(\d{3})\b/i;
const LIMIT_SOURCE_RE = /"limit_source"\s*:\s*"([^"]*)"/i;
const RESET_RE = /"X-RateLimit-Reset"\s*:\s*"?([^",}]+)"?/i;

// The reset stamp is epoch milliseconds ("1792713600000"); a date string is accepted too.
function parseReset(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(String(raw));
  return Number.isFinite(d) ? d : null;
}

/**
 * Read the account-level limit out of a failed OpenRouter response.
 * @param {number} status    HTTP status of the failed response
 * @param {string} bodyText  the FULL provider body (the error string kept in the attempts is
 *                            truncated — `limit_source` and the reset stamp sit at its end)
 * @returns {null | { kind: 'daily'|'per_minute'|'credits'|'forbidden', resetAt: number|null }}
 *   null = not an account-level signal (a model-level rejection, a timeout, a network error).
 */
export function orAccountLimit(status, bodyText) {
  const text = String(bodyText || '');
  if (!text) return null;
  const code = Number(status) || 0;
  const source = (LIMIT_SOURCE_RE.exec(text) || [])[1] || '';
  const resetAt = parseReset((RESET_RE.exec(text) || [])[1]);
  if (/free_tier_daily/i.test(source)) return { kind: 'daily', resetAt };
  if (/free_tier_per_minute/i.test(source)) return { kind: 'per_minute', resetAt };
  // Credits are an ACCOUNT property: no rotation to another key can fix a zero balance.
  if (code === 402 || /insufficient credits/i.test(text)) return { kind: 'credits', resetAt: null };
  // 403 without a named limit: the provider refuses the account (burst / abuse protection). The
  // exact kind is unknown, so the park is short and the account is probed again shortly.
  if (code === 403) return { kind: 'forbidden', resetAt };
  // A bare 429 is a rate limit of the account (per-minute by default).
  if (code === 429) return { kind: 'per_minute', resetAt };
  return null;
}

/**
 * The same read from the error STRING kept in the attempts (`HTTP <status>: <body>`). It is a
 * fallback only: the string is cut to 300 characters, so a long body loses `limit_source`.
 * @param {string} errorText
 */
export function orAccountLimitOf(errorText) {
  const text = String(errorText || '');
  if (!text) return null;
  const status = Number((STATUS_RE.exec(text) || [])[1] || 0);
  return orAccountLimit(status, text);
}

/**
 * When the parked account may be used again.
 * @param {null | { kind: string, resetAt: number|null }} limit
 * @param {number} now epoch ms
 * @returns {number} epoch ms; 0 when there is nothing to park
 */
export function orParkUntil(limit, now = Date.now()) {
  if (!limit) return 0;
  const ttl = OR_PARK_TTL_MS[limit.kind] || OR_PARK_TTL_MS.unknown;
  // A reset moment in the PAST means the counter has already reset — probe the account again soon
  // instead of parking it for the kind's fallback TTL. Without a reset moment the kind decides.
  const until = limit.resetAt
    ? (limit.resetAt > now ? limit.resetAt : now + OR_PARK_MIN_MS)
    : now + ttl;
  return Math.min(Math.max(until, now + OR_PARK_MIN_MS), now + OR_PARK_MAX_MS);
}
