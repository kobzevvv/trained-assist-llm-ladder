// Trace plumbing: caller-supplied ids (x-ladder-*) → one D1 row per /v1/chat/completions call.
// Kept in its own module so tests can import it without dragging in config/ladders.json.
// options.events: optional error-event publisher (createErrorPublisher from src/events.js).
//   Called fire-and-forget for failed calls, never throws.

// Caller-supplied ids that let us attribute a ladder call to a task/session/user later.
// All optional and length-capped; a missing/blank header → null (callers that send none,
// e.g. the bench or one-shot service calls, are still logged with null ids).
export function makeTrace(request) {
  const h = request.headers;
  const get = (key) => {
    const v = h.get(key);
    if (!v) return null;
    const s = String(v).trim();
    return s ? s.slice(0, 200) : null;
  };
  return {
    traceId: get('x-ladder-trace'),
    runId: get('x-ladder-run'),
    userId: get('x-ladder-user'),
    chatId: get('x-ladder-chat'),
    sessionId: get('x-ladder-session'),
    // Which concrete sub-task made this call (the caller's `source:` / tool name). Raw here —
    // the handler overwrites it with the sanitised slug it already sends to OpenRouter, so the
    // row and the OpenRouter "Application" cut can never disagree (#107).
    app: get('x-ladder-app'),
  };
}

const TRACE_SQL = `INSERT INTO ladder_calls
  (ts, trace_id, run_id, user_id, chat_id, session_id, ladder, ok, model, ms, attempts, tokens_in, tokens_out, tokens_cached, app)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`;

const SETTLE_STREAM_SQL = `UPDATE ladder_calls SET ok = ?1, ms = ?2, attempts = ?3,
  tokens_in = ?4, tokens_out = ?5, tokens_cached = ?6 WHERE rowid = ?7`;

function usageValues(r) {
  const usage = r.data?.usage;
  return [usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
    usage?.prompt_tokens_details?.cached_tokens ?? null];
}

// Commit a visible pending row before returning stream headers. Cloudflare can end an
// invocation on client disconnect without calling the response body's cancel hook; a
// settlement-only INSERT then loses the call entirely. The rowid belongs to this INSERT,
// so concurrent calls sharing a caller-supplied trace cannot update one another.
export async function beginStreamCall(env, trace, ladder, r, started) {
  const db = env.LADDER_TRACE_DB;
  if (!db) return null;
  const attempts = (r.attempts || []).map((attempt, index) =>
    index === r.attempts.length - 1 && attempt.outcome === 'ok'
      ? { ...attempt, outcome: 'stream_pending' }
      : attempt);
  try {
    const result = await db.prepare(TRACE_SQL).bind(
      Date.now(), trace.traceId, trace.runId, trace.userId, trace.chatId,
      trace.sessionId, ladder, 0, r.model || null, Date.now() - started,
      JSON.stringify(attempts), null, null, null, trace.app ?? null,
    ).run();
    const rowId = result?.meta?.last_row_id;
    return result?.success && Number.isSafeInteger(rowId) && rowId > 0 ? rowId : null;
  } catch (e) {
    console.error('trace stream pending insert failed:', e.message);
    return null;
  }
}

export async function settleStreamCall(env, rowId, trace, ladder, r, started,
  { events, retryable = false } = {}) {
  if (rowId == null) {
    await logCall(env, trace, ladder, r, started, { events, retryable });
    return;
  }
  try {
    await env.LADDER_TRACE_DB.prepare(SETTLE_STREAM_SQL).bind(
      r.ok ? 1 : 0, Date.now() - started, JSON.stringify(r.attempts || []),
      ...usageValues(r), rowId,
    ).run();
  } catch (e) {
    console.error('trace stream settlement update failed:', e.message);
  }
  if (events && !r.ok) {
    const { buildErrorEvent } = await import('./events.js');
    events.publishError(buildErrorEvent({ trace, ladder,
      error: r.error || 'stream incomplete', outcome: 'failed', retryable }));
  }
}

// Best-effort D1 append: never fails the call, never throws. Non-stream usage and
// observed terminal-frame stream usage both count toward tokens_in/out.
// tokens_cached (#94) = usage.prompt_tokens_details.cached_tokens — a subset of tokens_in,
// priced ~50x cheaper, so cost = (in-cached)*in_price + out*out_price + cached*cache_price.
// app (#107) = the caller's sub-task tag, so the cost cut can be per sub-task and not only
// per ladder — `service` covers ~20 different tools, which is too coarse to prioritise.
export async function logCall(env, trace, ladder, r, started, { events, retryable = true } = {}) {
  const db = env.LADDER_TRACE_DB;
  if (!db && !events) return;
  try {
    if (db) {
      await db.prepare(TRACE_SQL).bind(
        Date.now(),
        trace.traceId, trace.runId, trace.userId, trace.chatId, trace.sessionId,
        ladder, r.ok ? 1 : 0, r.model || null, Date.now() - started,
        JSON.stringify(r.attempts || []),
        ...usageValues(r),
        trace.app ?? null,
      ).run();
    }
  } catch (e) {
    console.error('trace d1 insert failed:', e.message);
  }
  if (events && !r.ok) {
    const { buildErrorEvent } = await import('./events.js');
    const event = buildErrorEvent({
      trace,
      ladder,
      error: r.error || 'every rung failed',
      outcome: 'failed',
      retryable,
    });
    events.publishError(event);
  }
}
