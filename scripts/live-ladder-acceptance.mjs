import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const base = (process.env.LADDER_BASE_URL || 'https://llm-ladder.trainedassist.store').replace(/\/$/, '')
const token = process.env.LADDER_TOKEN
if (!token) throw new Error('LADDER_TOKEN is required')
const timeoutMs = 8 * 60_000
const root = randomUUID()
const prices = JSON.parse(await readFile(new URL('../config/prices.json', import.meta.url), 'utf8'))
const words = ['amber', 'birch', 'copper', 'delta', 'ember', 'frost', 'granite', 'harbor', 'indigo', 'juniper', 'kepler', 'linen', 'maple', 'nectar', 'orbit', 'pebble']

function corpus(targetChars) {
  const rows = []
  let amber = 0
  let length = 0
  for (let i = 0; length < targetChars; i++) {
    const tag = i % 13 === 0 ? 'amber' : words[(i * 7 + 3) % words.length]
    if (tag === 'amber') amber++
    const row = `row=${String(i).padStart(7, '0')} tag=${tag} source=${words[(i * 11 + 5) % words.length]} value=${(i * 7919) % 100003}`
    rows.push(row)
    length += row.length + 1
  }
  return { text: rows.join('\n'), amber, rows: rows.length }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = null }
  return { response, data }
}

async function traceFor(trace) {
  for (const wait of [0, 500, 1_000, 2_000, 4_000]) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    const { response, data } = await fetchJson(`/v1/calls?trace=${encodeURIComponent(trace)}&limit=50`)
    if (!response.ok) throw new Error(`trace lookup failed with HTTP ${response.status}`)
    if (data?.calls?.length) return data.calls
  }
  return []
}

function safeAttempt(a) {
  const error = String(a.error || '').toLowerCase()
  const category = /context|too long|token.{0,15}limit|maximum.{0,15}context/.test(error) ? 'context'
    : /timeout|timed out|aborted|first token/.test(error) ? 'timeout'
      : /empty answer|invalid json/.test(error) ? 'empty_or_invalid'
        : /http 4\d\d/.test(error) ? 'provider_4xx'
          : /http 5\d\d/.test(error) ? 'provider_5xx'
            : error ? 'other_error' : null
  return { model: a.model || null, outcome: a.outcome || null, category }
}

function estimatedCost(model, usage) {
  const price = prices[model]
  if (!price || usage?.input == null || usage?.output == null) return null
  const cached = usage.cached ?? 0
  const fresh = Math.max(0, usage.input - cached)
  return Number(((fresh * price[0] + usage.output * price[1] + cached * price[2]) / 1_000_000).toFixed(8))
}

async function one({ label, ladder, session, run, content, expected = null, inputChars = content.length }) {
  const trace = `${root}:${label}`
  const started = Date.now()
  let status = null
  let usage = null
  let quality = null
  try {
    const result = await fetchJson('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ladder-trace': trace,
        'x-ladder-run': run,
        'x-ladder-session': session,
        'x-ladder-app': 'live-acceptance',
        'x-session-affinity': session,
      },
      body: JSON.stringify({
        model: ladder,
        messages: [{ role: 'user', content }],
        stream: false,
        max_tokens: 24,
        temperature: 0,
      }),
    })
    status = result.response.status
    if (result.data?.usage) {
      const u = result.data.usage
      usage = {
        input: u.prompt_tokens ?? u.input_tokens ?? null,
        output: u.completion_tokens ?? u.output_tokens ?? null,
        cached: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? null,
        cache_write: u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? null,
      }
    }
    if (expected !== null && result.response.ok) {
      const answer = result.data?.choices?.[0]?.message?.content || ''
      try {
        const parsed = JSON.parse(answer)
        quality = parsed.amber_count === expected.amber && parsed.final_record === expected.finalRecord
      } catch { quality = false }
    }
  } catch (error) {
    status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'client_timeout' : 'client_error'
  }
  const calls = await traceFor(trace)
  const call = calls.find(item => item.run_id === run) || calls[0] || null
  const report = {
    label, ladder, trace, run_id: run, http: status, wall_ms: Date.now() - started, input_chars: inputChars,
    estimated_input_tokens: Math.ceil(inputChars / 4), usage,
    estimated_cost_usd: estimatedCost(call?.model, usage),
    cost_basis: 'config/prices.json; cached usage absent means estimate assumes no cache',
    result_model: call?.model || null, result_state: call?.state || 'trace_missing',
    ladder_ms: call?.ms ?? null,
    attempts: (call?.attempts || []).map(safeAttempt),
    trace_found: !!call, quality,
  }
  console.log(JSON.stringify(report))
  if (!call) throw new Error(`trace not found for ${label}; outcome is unknown`)
  return { report, session, content }
}

const small = 'Synthetic acceptance probe. Reply with exactly: ok'
for (const ladder of ['standard', 'free', 'fast']) {
  await one({ label: `${ladder}-small`, ladder, session: `${root}:${ladder}`, run: `${root}:${ladder}:small`, content: small })
}

// Repeated identical eligible input in one session tests actual provider cache counters.
const stablePrefix = `Synthetic cache probe; count the word amber and return only the number.\n${Array.from({ length: 4096 }, (_, i) => `segment ${i} amber ${words[(i * 5 + 2) % words.length]} value ${i % 997}`).join('\n')}`
const fastSession = `${root}:fast-cache`
for (const n of [1, 2]) {
  await one({ label: `fast-cache-${n}`, ladder: 'fast', session: fastSession, run: `${root}:fast-cache:${n}`, content: stablePrefix })
}

// Synthetic aggregation workload; count is deterministic, content contains no user data.
let freeSession = `${root}:free-stress`
for (const target of [8_000, 32_000, 128_000, 512_000, 1_000_000]) {
  const data = corpus(target)
  const finalRecord = `row=${String(data.rows - 1).padStart(7, '0')}`
  const content = `Count every row whose tag is amber. Return only JSON: {"amber_count": number, "final_record": string}. Include final_record as the ID of the final input row.\n${data.text}`
  const { report } = await one({
    label: `free-stress-${target}`, ladder: 'free', session: freeSession,
    run: `${root}:free-stress:${target}`, content,
    inputChars: content.length, expected: { amber: data.amber, finalRecord },
  })
  if (report.result_state !== 'completed' || report.http !== 200) break
}

const summary = await fetchJson(`/v1/analytics?hours=1`)
if (summary.response.ok && summary.data?.ladders) {
  const selected = summary.data.ladders.filter(row => ['fast', 'free', 'standard'].includes(row.ladder))
  console.log(JSON.stringify({ label: 'recent_aggregate_context', ladders: selected.map(row => ({ ladder: row.ladder, calls: row.calls, failed: row.failed, tokens_in: row.tokens_in, tokens_cached: row.tokens_cached, tokens_cache_write: row.tokens_cache_write, cache_read_unknown: row.cache_read_unknown })) }))
}
