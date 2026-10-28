// Rendering half of the speed digest (#325): a pure function over the GET /v1/analytics
// payload, kept out of scripts/speed-digest.mjs so tests can render fixtures without a token
// or a network. The v2 layout is the owner's ask after reading the v1 output: long per-model
// tables said a lot and explained little, so the digest now goes headline → funnel («сколько
// запросов по каждому шагу») → anomalies only, and the full cuts live in /admin.

// Segment display names, in the walk order of the free-first ladders: go_free → zen → or_free →
// paid. `other` is a bucket for models that fit no provider prefix (should be rare; visible so
// a new provider cannot silently vanish from the funnel).
export const SEGMENT_LABELS = {
  go_free: 'Бесплатный Go',
  zen: 'zen (ринг)',
  or_free: 'OpenRouter free',
  go_sub: 'Платный Go',
  or_paid: 'Платный OpenRouter',
  other: 'Прочее',
};
const FREE_SEGMENTS = new Set(['go_free', 'zen', 'or_free']);

const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const num = (n) => String(n ?? 0);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

export function buildDigest(d, { hours = 4, slowMs = 15_000, badMs = 45_000 } = {}) {
  const t = d.totals || {};
  const failed = t.failed || 0;
  const calls = t.calls || 0;
  const funnel = d.funnel || null;
  const servedTotal = funnel ? (funnel.served_total || 0) : 0;
  const freeServed = funnel ? (funnel.served || []).filter((s) => FREE_SEGMENTS.has(s.category)).reduce((sum, s) => sum + s.calls, 0) : 0;

  const lines = [];
  lines.push(`## ⏱ Ladder speed digest — ${hours}h`);
  lines.push('');
  lines.push(
    `**вызовов** ${num(calls)} · **отказов** ${num(failed)} (${pct(failed, calls)}) · `
    + `**стоимость** $${Number(t.cost_usd || 0).toFixed(6)}`
    + (servedTotal ? ` · **бесплатными** ${pct(freeServed, servedTotal)}` : ''),
  );
  const sources = (d.sources || []).map((s) => `${s.source} ${s.pct}%`).join(' · ');
  if (sources) lines.push(`**источники**: ${sources}`);
  // Attribution coverage (#136/#325): without this line the reader cannot tell "no automation
  // today" from "automation that does not name itself" (the doctor batches are exactly that).
  const noApp = Number(d.no_app?.calls || 0);
  if (noApp && servedTotal) lines.push(`**без метки**: ${pct(noApp, servedTotal)} вызовов не назвали приложение — автор автоматических прогонов не виден`);
  lines.push('');

  // ---- funnel: where calls are served, where failed ones die --------------------------------
  if (funnel && (funnel.served || []).length) {
    lines.push('### Воронка — где отдают зовы');
    lines.push('');
    lines.push('| сегмент | отдано | % зовов | % от обслуж. | падений на сегменте |');
    lines.push('|---|---:|---:|---:|---:|');
    const failedAt = new Map((funnel.failed_at || []).map((f) => [f.category, f.calls]));
    for (const s of funnel.served || []) {
      const dead = failedAt.get(s.category) || 0;
      failedAt.delete(s.category);
      lines.push(`| ${SEGMENT_LABELS[s.category] || s.category} | ${num(s.calls)} | ${s.pct_calls}% | ${s.pct_served}% | ${dead ? num(dead) : '—'} |`);
    }
    // Failures at a segment nobody served (the segment killed every call it met) still belong
    // on the board — that is the loudest form of «новая неоптимальность».
    for (const [category, callsAt] of failedAt) {
      lines.push(`| ${SEGMENT_LABELS[category] || category} | 0 | 0.0% | — | ${num(callsAt)} |`);
    }
    if (funnel.unserved) lines.push(`| **не отдано** | — | **${pct(funnel.unserved, calls)}** | — | — |`);
    lines.push('');
  }

  // ---- attention: what actually changed for the worse ----------------------------------------
  const warn = [];
  for (const m of d.models || []) {
    if (m.ms_p50 == null) continue;
    if (m.ms_p50 >= badMs) warn.push(`🔴 \`${m.model}\` — p50 ${secs(m.ms_p50)} (порог ${secs(badMs)}), ${num(m.calls)} вызовов`);
    else if (m.ms_p50 >= slowMs) warn.push(`⚠️ \`${m.model}\` — p50 ${secs(m.ms_p50)} (порог ${secs(slowMs)}), ${num(m.calls)} вызовов`);
  }
  for (const l of d.ladders || []) {
    if (l.calls && l.failed / l.calls > 0.4) warn.push(`⚠️ лестница \`${l.ladder}\` — отказы ${pct(l.failed, l.calls)} (${num(l.failed)}/${num(l.calls)})`);
  }
  const topErr = (d.errors || [])[0];
  if (topErr && topErr.calls >= Math.max(5, calls * 0.1)) {
    warn.push(`⚠️ топ-ошибка ×${num(topErr.calls)}: ${String(topErr.error).slice(0, 160)}`);
  }
  lines.push('### На что обратить внимание');
  lines.push('');
  if (warn.length) lines.push(...warn.map((w) => `- ${w}`));
  else lines.push('- всё в пределах порогов');
  lines.push('');
  lines.push(
    `_разрезы (лестницы, модели, часы, приложения): https://llm-ladder.trainedassist.store/admin · `
    + `пороги: ⚠️ ${secs(slowMs)} · 🔴 ${secs(badMs)} — DIGEST_SLOW_MS / DIGEST_BAD_MS_`,
  );
  return lines.join('\n');
}
