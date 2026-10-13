// Observe the terminal SSE frame while relaying the exact upstream bytes.
// Usage often arrives only in the final frame, after the first output token.
const MAX_LINE = 64 * 1024;

export function settleStream(stream, onSettle) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLine = false;
  let terminalFrame = false;
  let errorFrame = false;
  let usage = null;
  let settled = false;
  let cancelRequested = false;

  function inspect(value) {
    const text = value.endsWith('\r') ? value.slice(0, -1) : value;
    if (text.startsWith('event:')) {
      const event = text.slice(6).trim();
      if (event === 'error') errorFrame = true;
      if (event === 'message_stop') terminalFrame = true;
    }
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') { terminalFrame = true; return; }
    if (!data.startsWith('{')) return;
    try {
      const frame = JSON.parse(data);
      if (frame.error) errorFrame = true;
      // OpenAI-compatible streams put the final usage on the root frame. Anthropic-compatible
      // streams split input/cache usage and output usage across message_start/message_delta.
      // Keep the latest value of each counter instead of discarding the earlier event.
      const nextUsage = frame.usage || frame.message?.usage || frame.delta?.usage;
      if (nextUsage && typeof nextUsage === 'object') {
        usage = { ...(usage || {}), ...nextUsage };
        for (const key of ['prompt_tokens_details', 'input_tokens_details']) {
          if (usage[key] || nextUsage[key]) usage[key] = { ...(usage[key] || {}), ...(nextUsage[key] || {}) };
        }
      }
    } catch { /* Relay malformed frames unchanged; completion still needs [DONE]. */ }
  }

  function feed(text) {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end < 0) break;
      const part = text.slice(start, end);
      if (!skipLine && line.length + part.length <= MAX_LINE) inspect(line + part);
      line = '';
      skipLine = false;
      start = end + 1;
    }
    const rest = text.slice(start);
    if (!skipLine && line.length + rest.length <= MAX_LINE) line += rest;
    else { line = ''; skipLine = true; }
  }

  async function finish(reason) {
    if (settled) return;
    settled = true;
    try {
      await onSettle({ complete: reason === 'eof' && terminalFrame && !errorFrame, reason, usage });
    } catch { /* Diagnostics must never turn a delivered stream into an error. */ }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          feed(decoder.decode());
          if (!skipLine && line) inspect(line);
          controller.close();
          await finish('eof');
        } else {
          feed(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (error) {
        if (cancelRequested) await finish('cancelled');
        else { controller.error(error); await finish('read_error'); }
      }
    },
    async cancel(reason) {
      cancelRequested = true;
      try { await reader.cancel(reason); }
      finally { await finish('cancelled'); }
    },
  });
}
