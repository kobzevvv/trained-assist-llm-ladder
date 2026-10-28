import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import ladders from '../config/ladders.json' with { type: 'json' };

const rung = ladders.ladders.service.build.find(model => model.startsWith('openrouter/'));
const encoder = new TextEncoder();
const first = encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
const tail = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}\n\ndata: [DONE]\n\n';

function fixture() {
  const rows = [];
  const background = [];
  const db = { prepare(sql) { return { bind(...values) { return { async run() {
    if (sql.startsWith('UPDATE')) {
      // SETTLE_STREAM_SQL: ok, ms, attempts, tokens_in, tokens_out, tokens_cached,
      // tokens_cache_write, estimated_tokens_in, rowid — rowid is the last bind.
      const row = rows[values[8] - 1];
      [row[7], row[9], row[10], row[11], row[12], row[13], row[14], row[15]] = values.slice(0, 8);
      return { success: true };
    }
    rows.push(values);
    return { success: true, meta: { last_row_id: rows.length } };
  } }; } }; } };
  let upstream;
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { upstream = controller; controller.enqueue(first); },
    cancel() { cancelled = true; },
  });
  const request = new Request('https://fixture.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-ladder-trace': 'stream-fixture' },
    body: JSON.stringify({ model: 'service', ladder_rung: rung, stream: true, messages: [{ role: 'user', content: 'fixture' }] }),
  });
  const serve = () => handle(request, { LADDER_TOKEN: 'fixture', OPENROUTER_API_KEY: 'synthetic', LADDER_TRACE_DB: db }, {
    store: memoryStore(1), waitUntil: promise => background.push(promise),
    fetchImpl: async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  });
  return { serve, rows, background, get upstream() { return upstream; }, get cancelled() { return cancelled; } };
}

test('stream trace starts pending, then [DONE] settles the same row with final usage', async () => {
  const f = fixture();
  const response = await f.serve();
  assert.equal(response.status, 200);
  assert.equal(f.rows.length, 1, 'pending trace exists before returning stream headers');
  assert.equal(f.rows[0][7], 0);
  assert.equal(JSON.parse(f.rows[0][10]).at(-1).outcome, 'stream_pending');
  const reader = response.body.getReader();
  const chunks = [];
  chunks.push((await reader.read()).value);
  assert.equal(JSON.parse(f.rows[0][10]).at(-1).outcome, 'stream_pending');
  f.upstream.enqueue(encoder.encode(tail.slice(0, 22)));
  f.upstream.enqueue(encoder.encode(tail.slice(22, -5)));
  f.upstream.enqueue(encoder.encode(tail.slice(-5)));
  f.upstream.close();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await Promise.all(f.background);
  const actual = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString();
  assert.equal(actual, new TextDecoder().decode(first) + tail);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 1, 'ok only after terminal frame and EOF');
  assert.equal(f.rows[0][11], 7);
  assert.equal(f.rows[0][12], 3);
  assert.equal(f.rows[0][13], 4);
  assert.equal(f.rows[0][14], null, 'unreported cache writes remain unknown');
});

test('Anthropic terminal event combines usage split across SSE frames', async () => {
  const f = fixture();
  const response = await f.serve();
  const reader = response.body.getReader();
  await reader.read();
  f.upstream.enqueue(encoder.encode('event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}\n\n'));
  f.upstream.enqueue(encoder.encode('event: message_delta\ndata: {"usage":{"output_tokens":6}}\n\n'));
  f.upstream.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n'));
  f.upstream.close();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  await Promise.all(f.background);
  assert.equal(f.rows[0][7], 1);
  assert.deepEqual(f.rows[0].slice(11, 15), [12, 6, 5, 2]);
});

test('stream trace remains visible if runtime drops response without invoking cancel', async () => {
  const f = fixture();
  const response = await f.serve();
  assert.equal(response.status, 200);
  assert.equal(f.rows.length, 1);
  assert.equal(JSON.parse(f.rows[0][10]).at(-1).outcome, 'stream_pending');
});

test('EOF without [DONE] records an incomplete stream with unknown usage', async () => {
  const f = fixture();
  const response = await f.serve();
  f.upstream.close();
  await response.text();
  await Promise.all(f.background);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
  assert.equal(f.rows[0][11], null);
  assert.equal(JSON.parse(f.rows[0][10]).at(-1).outcome, 'stream_incomplete');
});

test('an SSE error after first output is not counted as success even with [DONE]', async () => {
  const f = fixture();
  const response = await f.serve();
  f.upstream.enqueue(encoder.encode('event: error\ndata: {"error":{"type":"upstream"}}\n\ndata: [DONE]\n\n'));
  f.upstream.close();
  await response.text();
  await Promise.all(f.background);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
});

test('client cancellation settles once as incomplete and cancels upstream', async () => {
  const f = fixture();
  const response = await f.serve();
  await response.body.cancel('client left');
  await Promise.all(f.background);
  assert.equal(f.cancelled, true);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0][7], 0);
});
