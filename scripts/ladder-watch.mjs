#!/usr/bin/env node
import { readLadderToken } from './ladder-credentials.mjs';
// Ladder watch — is the ladder answering, and is zen answering through it.
//
// Four signals: three probes + one quota read, because "the ladder works", "zen works" and
// "there is still free quota left on OpenRouter" are three different claims:
//   4. GET  /v1/or-usage                       бесплатный лимит OpenRouter: остаток + ТЕМП
//      (`:free`-ранги едут на дневном счётчике, платный хвост — на кредите аккаунта).
//
// Лимит считается по ПУЛУ АККАУНТОВ: каждый ключ пула OpenRouter принадлежит своему аккаунту
// и имеет свой дневной счётчик (замерено 2026-10-22: env-аккаунт 924/1000, четыре аккаунта
// из D1 — 12–57 при лимите 50). Один исчерпанный аккаунт — не конец бесплатного хвоста,
// конец — когда пул пуст.
//
// Три способа это поймать, потому что «раз в 10 минут посмотреть остаток» не спасает от
// шторма (замер 2026-10-08: 355/1000 за сутки, шторм может сжечь остаток быстрее интервала):
//   по ОСТАТКУ  — remaining < доли потолка пула (медленное выгорание, ≤ интервал опроса);
//   по ТЕМПУ     — дельта used между опросами → ETA < часа  (шторм виден ДО исчерпания);
//   по ФАКТУ     — в топе ошибок /v1/analytics лежит «usage limit» — какой-то аккаунт исчерпан.
// У каждого свой ключ в watch-state.json, поэтому сообщение приходит на переходе, а не каждые
// 10 минут.
//
// Three probes, because "the ladder works" and "zen works" are different claims:
//   1. GET  /health                          the worker is up and knows its ladders
//   2. POST /v1/chat/completions (unpinned)  the real caller path — whatever rung answers
//   3. POST /v1/chat/completions (pinned to zen-rings/nemotron-3-ultra-free)
//                                            zen specifically: the head rung of every text ladder
//                                            (проба пропускается, если кольцо выключено флагом)
//
// Telegram fires on a STATE TRANSITION only — down→notify, up→notify — never on every tick,
// so a two-hour outage is two messages, not twelve. The state file is the whole memory:
// GitHub Actions has none across runs, so the workflow restores/saves it via actions/cache.
//
// Usage:
//   node scripts/ladder-watch.mjs [--state watch-state.json] [--notify] [--base URL]
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are read only when --notify is passed.
//
// Exit: 0 all green, 1 a probe failed, 2 could not probe at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const has = (n) => process.argv.includes(`--${n}`);

const BASE = String(arg('base', process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store')).replace(/\/+$/, '');
const STATE_FILE = arg('state', 'watch-state.json');
const NOTIFY = has('notify');
// The canary rung. 2026-10-28: was nemotron-3-ultra-free — removed from every ladder as a dead
// slug (#318), and pinning a rung the config no longer knows answers 400, which would turn the
// watch itself red. mimo is the zen head of the ladders that keep zen, so it is pinned whenever
// a zen health signal is wanted.
const ZEN_RUNG = arg('zen-rung', 'zen-rings/mimo-v2.6-flash-free');
const LADDER = arg('ladder', 'service');
const PROBE_TIMEOUT_MS = Number(arg('timeout', 45_000));
const TOKEN = readLadderToken() || '';
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();

const auth = { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

// Кольцо zen выключается флагом `zen_ring` в config/ladders.json (#295). Пока флаг `false`,
// кольцо НЕ проверяется: иначе watcher рапортовал бы «лестница не отвечает» про кольцо,
// выключенное по решению оператора. Конфиг читается из репозитория — тот же, что деплоится.
export function zenRingEnabled(cfg) {
  return !(cfg && cfg.zen_ring === false);
}

function readLadderConfig() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url), 'utf8'));
  } catch { return null; }            // конфиг не прочитался — ведём себя как раньше
}

async function probe(name, fn, tries = 1) {
  const t0 = Date.now();
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fn();
      last = { name, ok: !!r.ok, ms: Date.now() - t0, detail: r.detail || '' };
    } catch (e) {
      last = { name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 200) };
    }
    if (last.ok) return last;
    if (i < tries) await new Promise((r) => setTimeout(r, 2_000));
  }
  // zen answers 200 with an EMPTY body often enough that one flake would flap the alert stream
  // every few minutes — the ladder itself retries a rung once before walking on, so the watch
  // does the same before it calls anything down.
  if (tries > 1) last.detail = `${last.detail} (after ${tries} tries)`;
  return last;
}

async function health() {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const j = await r.json();
  return { ok: r.ok && j.ok === true, detail: r.ok ? `build=${String(j.build || '').slice(0, 12)}` : `HTTP ${r.status}` };
}

async function chat({ pinned }) {
  const body = {
    model: LADDER,
    messages: [{ role: 'user', content: 'Ответь одним словом: ок' }],
    max_tokens: 20,
    // Attributed in /v1/analytics — the ladder logs what the header says, and a monitor that
    // cannot be told apart from real traffic makes its own calls look like user failures.
    'x-ladder-app': 'ladder-watch',
    ...(pinned ? { ladder_rung: ZEN_RUNG } : {}),
  };
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* a non-JSON body is itself a failure below */ }
  if (!r.ok || j?.error) {
    // `every rung failed` is only useful with the per-rung reasons: the attempts array is where
    // `zen-rings: ok (finish=…, out=…)` and `HTTP 402: insufficient credits` live, and a single
    // first attempt made a dead paid tail indistinguishable from a cold ring.
    const ats = (j?.error?.attempts || [])
      .map((a) => `${String(a.model || '').split('/').pop()}: ${a.error || a.outcome || '?'}`)
      .join(' | ');
    const detail = ats || j?.error?.message || text.slice(0, 160);
    return { ok: false, detail: `HTTP ${r.status} ${detail}`.trim() };
  }
  const content = j?.choices?.[0]?.message?.content ?? '';
  if (!String(content).trim()) return { ok: false, detail: `HTTP 200 but empty content (model=${j?.model})` };
  return { ok: true, detail: `${j.model} ${String(content).trim().slice(0, 24)}` };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); } catch { /* a read-only workspace must not fail the check */ }
}

// Остаток бесплатного лимита OpenRouter: отдельный счётчик от кредита аккаунта — `:free`-ранги
// едут на нём, и на нём же упираются обе большие ступени (512K и 1M). Отказ приходит как
// «usage limit» и health-skips ранг на сутки, поэтому узнать об этом лучше из сообщения, чем
// из обхода, где каждая ступень отваливается по очереди.
// Чистая функция: сколько минут остаётся при текущем темпе. prev — прошлое снятие счётчика
// (state.or_free = { used, ts }); сброс за сутки (used вырос назад) темп не считаем.
export function etaMinutes(prev, used, remaining, now = Date.now()) {
  if (!prev || typeof prev.used !== 'number' || !prev.ts) return null;
  if (used < prev.used) return null;                       // наступил новый день
  const dtMin = (now - prev.ts) / 60000;
  if (dtMin < 1) return null;                              // интервал слишком мал для темпа
  const rate = (used - prev.used) / dtMin;                 // запросов в минуту
  if (!(rate > 0)) return null;                            // ничего не жгли — темпа нет
  return remaining / rate;
}

// Чистая функция: какое сообщение об остатке шлём сейчас.
//
// Лимит считается по ПУЛУ аккаунтов, а не по одному ключу: каждый ключ пула — свой аккаунт
// OpenRouter со своим счётчиком `free_model_daily_requests` (замерено 2026-10-22: env-аккаунт
// 924/1000, четыре аккаунта из D1 — 12–57 при лимите 50). Поэтому:
//
//   🔴 dead  — пул пуст (все аккаунты исчерпаны): бесплатный хвост не отвечает до сброса;
//   🟠 crit  — осталось ≤ 5 % потолка пула;
//   🟡 burn  — темп такой, что до сброса не хватит (ETA < часа);
//   🟡 low   — осталось ≤ 20 % потолка пула;
//   🟢 ok    — в норме.
//
// `errHit` — «usage limit» из топа ошибок за час: значит, что один из аккаунтов уже исчерпан.
// С пулом это НЕ конец хвоста (остальные аккаунты ещё живы), поэтому факт идёт строкой в
// сообщение, а не уровнем. Уровень dead ставится по пулу: пустой пул — вот это конец.
//
// Топ ошибок отдаёт санитизированный текст («provider returned HTTP 429») — тело ответа
// провайдера в трассу не пишется, поэтому этот факт сегодня почти не срабатывает. Основной
// сигнал — счётчики аккаунтов (`accounts[].remaining`): они точны и сразу показывают, кому
// именно кончилось.
// Русские числительные: 1 аккаунт / 2 аккаунта / 5 аккаунтов.
export function plural(n, one, few, many) {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function quotaNotice({ quota, errHit, prevKey, etaMin, parked }) {
  if (!quota || quota.skipped) return null;
  const limit = Number(quota.limit) || 0;
  const remaining = Number(quota.remaining) || 0;
  const share = limit > 0 ? remaining / limit : 0;
  const accounts = Array.isArray(quota.accounts) ? quota.accounts : [];
  const head = `пул ${quota.used}/${limit} за сутки, осталось ${remaining}`;
  const facts = [];
  if (accounts.length) {
    facts.push(`по аккаунтам: ${accounts.map((a) => `${a.label} ${a.remaining}/${a.limit}`).join(' · ')}`);
  }
  const exhausted = accounts.filter((a) => Number(a.remaining) <= 0).length;
  if (exhausted) {
    facts.push(`${exhausted} ${plural(exhausted, 'аккаунт исчерпан', 'аккаунта исчерпано', 'аккаунтов исчерпано')}`);
  }
  // Аккаунты, припаркованные лестницей (#297): их лимит исчерпан, и лестница не делает им
  // запросы до сброса. Это НЕ «пул пуст» — остальные аккаунты ещё живы, но помнить, кто именно
  // паркован, нужно, чтобы понять, когда хвост восстановится.
  const parkedCount = parked ? Object.keys(parked).length : 0;
  if (parkedCount) {
    const names = Object.keys(parked).map((i) => {
      const a = accounts[Number(i)];
      return a ? `${a.label} до ${new Date(parked[i]).toISOString().slice(11, 16)} UTC` : `ключ-${i}`;
    });
    facts.push(`припарковано ${parkedCount} ${plural(parkedCount, 'аккаунт', 'аккаунта', 'аккаунтов')} — не спрашиваем до сброса: ${names.join('; ')}`);
  }
  if (errHit) facts.push(`провайдер уже отдал «${String(errHit.error || '').slice(0, 60)}» (×${errHit.calls} за час)`);
  facts.push('сброс счётчиков в 00:00 UTC');
  if (quota.credit_free != null) {
    facts.push(quota.credit_free > 0
      ? `кредит пула ${quota.credit_total} (свободно ${quota.credit_free.toFixed(2)}) — платный хвост работает`
      : `кредит пула ${quota.credit_total} (свободно ${quota.credit_free.toFixed(2)}) — платный хвост НЕ спасёт, нужен долив`);
  }
  const tail = facts.join('\n   ');
  if (remaining <= 0) {
    return { key: 'or_free_dead', text: `🔴 OR free-лимит исчерпан по всему пулу: ${head}\n   ${tail}` };
  }
  if (share <= OR_FREE_CRIT_SHARE) {
    return { key: 'or_free_crit', text: `🟠 OR free-лимит почти исчерпан: ${head}\n   ${tail}` };
  }
  if (etaMin !== null && etaMin !== undefined && etaMin < OR_FREE_ETA_MIN) {
    return { key: 'or_free_burn', text: `🟡 OR free-лимит сгорает: ${head}\n   при текущем темпе хватит примерно на ${Math.max(1, Math.round(etaMin))} мин\n   ${tail}` };
  }
  if (share <= OR_FREE_WARN_SHARE) {
    return { key: 'or_free_low', text: `🟡 OR free-лимит под конец: ${head}\n   ${tail}` };
  }
  if (prevKey && prevKey !== 'or_free_ok') {
    return { key: 'or_free_ok', text: `🟢 OR free-лимит в норме: ${head}` };
  }
  return { key: 'or_free_ok', text: null };               // зелёное после зелёного — молчим
}

async function orQuota(prev) {
  if (!TOKEN) return { skipped: 'LADDER_TOKEN not set' };
  try {
    const r = await fetch(`${BASE}/v1/or-usage`, { headers: auth, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return { skipped: `or-usage HTTP ${r.status}` };
    const j = await r.json();
    const p = j?.pool;
    const q = j?.key?.data?.free_model_daily_requests;
    if (!p && !q) return { skipped: 'в ответе нет free_model_daily_requests' };
    const accounts = (Array.isArray(j?.accounts) ? j.accounts : []).map((a) => ({
      label: String(a.label || '?'), used: Number(a.used) || 0, limit: Number(a.limit) || 0, remaining: Number(a.remaining) || 0,
    }));
    const used = p ? Number(p.used) || 0 : Number(q.used) || 0;
    const limit = p ? Number(p.limit) || 0 : Number(q.limit) || 0;
    const remaining = p ? Number(p.remaining) || 0 : Math.max(0, Number(q.remaining ?? (limit - used)));
    const etaMin = etaMinutes(prev, used, remaining);
    const creditTotal = p ? Number(p.credit_total) || 0 : null;
    const creditUsed = p ? Number(p.credit_used) || 0 : null;
    const creditFree = creditTotal != null ? creditTotal - creditUsed : null;
    return {
      ok: limit > 0 ? remaining / limit > OR_FREE_WARN_SHARE : remaining > 0,
      used, limit, remaining, etaMin, accounts,
      credit_total: creditTotal, credit_free: creditFree,
      detail: `${used}/${limit} за сутки, осталось ${remaining}`,
    };
  } catch (e) {
    return { skipped: String(e?.message || e).slice(0, 120) };
  }
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return { sent: false, why: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { sent: false, why: `telegram HTTP ${res.status}` };
  return { sent: true };
}

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// «Сколько ошибок и как часто» — берём готовую агрегацию с сервера, а не считаем сами:
// GET /v1/analytics?hours=N уже умеет группировать отказы по строке и по лестнице.
// Ошибки сами по себе не роняют сервис (лестница переходит на следующий ранг), поэтому их
// доля — отдельное условие оповещения, со своим дедупом в watch-state.json: иначе каждые
// 10 минут приходил бы один и тот же отчёт.
// Порог остатка бесплатного лимита OpenRouter: доля от ПОТОЛКА ПУЛА, а не абсолютное число.
// Абсолютный порог врёт с пулом: 100 из 1200 — это 8 %, а не «почти конец» (а 100 из одного
// аккаунта на 1000 — 10 %). Потолок пула — сумма по аккаунтам, у каждого свой счётчик
// (docs/free-tier-limits.md), поэтому и порог — доля от суммы.
const OR_FREE_WARN_SHARE = Number(arg('or-free-warn-share', 0.2));   // 20 % пула
const OR_FREE_CRIT_SHARE = Number(arg('or-free-crit-share', 0.05));  // 5 % пула
// ETA, ниже которого темп считаем опасным: сгореть остаток пула за час — это шторм, а не день.
const OR_FREE_ETA_MIN = Number(arg('or-free-eta', 60));
// Отказ самого провайдера о том, что дневной лимит взят — виден в топе ошибок аналитики.
const QUOTA_ERR_RE = /usage limit|free usage|daily limit|FreeUsageLimit|exceeded.*free/i;

const ERROR_RATE_ALERT = Number(arg('error-rate', 0.5));   // доля отказов, при которой шлём
const ERROR_MIN_CALLS = Number(arg('error-min-calls', 20)); // на слишком малой выборке не шумим

async function errorReport(hours = 1) {
  if (!TOKEN) return { skipped: 'LADDER_TOKEN not set' };
  try {
    const r = await fetch(`${BASE}/v1/analytics?hours=${hours}`, {
      headers: auth, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) return { skipped: `analytics HTTP ${r.status}` };
    const j = await r.json();
    const t = j.totals || {};
    const calls = Number(t.calls) || 0;
    const failed = Number(t.failed) || 0;
    return {
      hours, calls, failed,
      rate: calls ? failed / calls : 0,
      top: (j.errors || []).slice(0, 5).map((e) => ({ calls: e.calls, error: String(e.error || '').slice(0, 110) })),
      byLadder: (j.ladders || []).filter((l) => l.failed > 0)
        .sort((a, b) => b.failed - a.failed).slice(0, 4)
        .map((l) => ({ ladder: l.ladder, calls: l.calls, failed: l.failed })),
    };
  } catch (e) {
    return { skipped: String(e?.message || e).slice(0, 120) };
  }
}

function formatErrorReport(er) {
  if (!er || er.skipped) return [`отчёт по ошибкам недоступен: ${er?.skipped || 'нет данных'}`];
  const pct = (er.rate * 100).toFixed(1);
  const out = [`за ${er.hours} ч: вызовов ${er.calls}, отказов ${er.failed} (${pct} %)`];
  for (const e of er.top) out.push(`  ×${String(e.calls).padStart(4)}  ${e.error}`);
  if (er.byLadder.length) {
    out.push('  по лестницам: ' + er.byLadder.map((l) => `${l.ladder} ${l.failed}/${l.calls}`).join(', '));
  }
  return out;
}

async function main() {
  const zenOn = zenRingEnabled(readLadderConfig());
  const probes = [
    await probe('health', health),
    await probe('ladder', () => chat({ pinned: false }), 2),
  ];
  if (zenOn) probes.push(await probe('zen', () => chat({ pinned: true }), 2));
  const errs = await errorReport(1);
  console.log(formatErrorReport(errs).join('\n'));
  const down = probes.filter((p) => !p.ok);
  const status = down.length ? 'down' : 'ok';

  const lines = probes.map((p) => `${p.ok ? 'ok  ' : 'FAIL'} ${p.name.padEnd(7)} ${String(p.ms).padStart(5)}ms  ${p.detail}`);
  console.log(lines.join('\n'));
  if (!zenOn) console.log('skip  zen     кольцо выключено флагом zen_ring: false — проверка пропущена');

  const state = readState();
  const now = Date.now();
  const changed = status !== state.last_notified;
  let notice = '';

  if (status === 'down') {
    if (!state.down_since) state.down_since = now;
    if (changed) {
      notice = [
        '🔴 llm-ladder не отвечает',
        `с ${stamp(state.down_since)} (проверка ${stamp(now)})`,
        '',
        ...down.map((p) => `— ${p.name}: ${p.detail} (${p.ms} мс)`),
        '',
        `всего проверок зелёных: ${probes.length - down.length}/${probes.length}`,
        `${BASE}`,
      ].join('\n');
    }
  } else if (state.last_notified === 'down') {
    const since = state.down_since || now;
    notice = [
      '🟢 llm-ladder снова отвечает',
      `простой был ${Math.max(1, Math.round((now - since) / 60000))} мин (${stamp(since)} → ${stamp(now)})`,
      `все ${probes.length} проверки зелёные: ${probes.map((p) => p.detail).join(' · ')}`,
    ].join('\n');
    delete state.down_since;
  } else {
    delete state.down_since;
  }

  // Отдельное состояние для доли ошибок: сервис может отвечать (все три пробы зелёные),
  // но ломать каждый второй вызов. Дедуп свой, иначе каждые 10 минут приходил бы один
  // и тот же отчёт.
  let errNotice = '';
  if (errs && !errs.skipped && errs.calls >= ERROR_MIN_CALLS) {
    const hot = errs.rate >= ERROR_RATE_ALERT;
    const key = hot ? 'err_high' : 'err_ok';
    if (key !== state.err_status) {
      if (hot) {
        errNotice = [
          '🟠 llm-ladder: высокая доля ошибок',
          `за ${errs.hours} ч: ${errs.failed} из ${errs.calls} (${(errs.rate * 100).toFixed(1)} %), порог ${(ERROR_RATE_ALERT * 100).toFixed(0)} %`,
          '',
          ...errs.top.slice(0, 3).map((e) => `  ×${String(e.calls).padStart(4)}  ${e.error}`),
          ...(errs.byLadder.length ? ['', 'по лестницам: ' + errs.byLadder.map((l) => `${l.ladder} ${l.failed}/${l.calls}`).join(', ')] : []),
        ].join('\n');
      } else if (state.err_status === 'err_high') {
        errNotice = `🟢 доля ошибок в норме: ${errs.failed} из ${errs.calls} (${(errs.rate * 100).toFixed(1)} %) за ${errs.hours} ч`;
      }
      state.err_status = key;
    }
  }

  // Квота: своё состояние и свой дедуп — она не про «сервис жив», поэтому в `probes` (и в код
  // выхода) не попадает, но попадает в то же сообщение. Три триггера (остаток / темп / факт)
  // считаются в quotaNotice; сообщение уходит только на ПЕРЕХОДЕ ключа, «зелёное» — только
  // после реального провала.
  const quota = await orQuota(state.or_free);
  const errHit = (errs && !errs.skipped ? errs.top || [] : []).find((e) => QUOTA_ERR_RE.test(e.error));
  const prevQKey = state.or_free_status;
  const qNotice = quotaNotice({ quota, errHit, prevKey: prevQKey, etaMin: quota && quota.etaMin, parked: quota && quota.parked });
  const quotaText = qNotice && qNotice.key !== prevQKey && qNotice.text ? qNotice.text : '';
  if (qNotice) state.or_free_status = qNotice.key;
  if (quota && !quota.skipped) {
    console.log(`${qNotice && qNotice.key !== 'or_free_ok' ? 'WARN' : 'ok  '} or-free  ${quota.detail}`
      + (quota.etaMin != null ? ` (темп: ~${Math.max(1, Math.round(quota.etaMin))} мин)` : '')
      + (quota.parked ? ` (припарковано ${Object.keys(quota.parked).length})` : ''));
    state.or_free = { used: quota.used, ts: now };
  } else if (quota && quota.skipped) {
    console.log(`SKIP or-free  ${quota.skipped}`);
  }

  const both = [notice, errNotice, quotaText].filter(Boolean).join('\n\n');
  let notified = { sent: false, why: 'no transition' };
  if (both && NOTIFY) notified = await sendTelegram(both);
  else if (both) notified = { sent: false, why: '--notify not passed' };

  state.last_notified = status;
  state.checked_at = now;
  writeState(state);

  if (both) console.log(`\nуведомление: ${both.split('\n')[0]}`);
  console.log(`telegram: ${notified.sent ? 'sent' : `skipped (${notified.why})`}`);
  process.exitCode = down.length === probes.length ? 2 : down.length ? 1 : 0;
}

// main() только при прямом запуске: import в тестах не должен дёргать сеть — иначе тесты
// расчёта темпа и переходов квоты не написать вовсе.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`watch failed: ${String(e?.message || e)}`);
    process.exitCode = 2;
  });
}
