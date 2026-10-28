// #325: дайджест v2 — воронка по сегментам вместо длинных таблиц, аномалии по-прежнему
// на виду, длинные разрезы уехали в /admin. buildDigest — чистая функция над payload
// /v1/analytics, здесь фикстура, а не сеть.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, SEGMENT_LABELS } from '../scripts/speed-digest-lib.mjs';

const fixture = {
  totals: { calls: 14, failed: 4, cost_usd: 0.001234 },
  sources: [{ source: 'openrouter', calls: 10, pct: 71.4 }, { source: 'opencode-go', calls: 4, pct: 28.6 }],
  no_app: { calls: 8 },
  funnel: {
    served: [
      { category: 'go_free', calls: 5, pct_calls: 35.7, pct_served: 55.6 },
      { category: 'zen', calls: 1, pct_calls: 7.1, pct_served: 11.1 },
      { category: 'or_free', calls: 2, pct_calls: 14.3, pct_served: 22.2 },
      { category: 'go_sub', calls: 1, pct_calls: 7.1, pct_served: 11.1 },
    ],
    failed_at: [{ category: 'zen', calls: 3 }, { category: 'or_free', calls: 1 }],
    served_total: 9,
    unserved: 4,
  },
  models: [
    { model: 'openrouter/slow:free', calls: 5, ms_p50: 50_000, ms_p95: 60_000, with_usage: 5 },
    { model: 'opencode-go/beam-free', calls: 9, ms_p50: 8_000, ms_p95: 14_000, with_usage: 9 },
  ],
  ladders: [
    { ladder: 'service', calls: 10, failed: 6, rungs: [] },
    { ladder: 'free', calls: 4, failed: 1, rungs: [] },
  ],
  errors: [{ error: 'provider request failed', calls: 10 }],
};

const out = buildDigest(fixture, { hours: 4, slowMs: 15_000, badMs: 45_000 });

test('digest v2: headline несёт бесплатную долю, воронка — обе доли и падения', () => {
  assert.match(out, /## ⏱ Ladder speed digest — 4h/);
  assert.match(out, /\*\*бесплатными\*\* 88\.9%/, 'бесплатные = go_free+zen+or_free от обслуженных (8/9)');
  assert.match(out, /### Воронка — где отдают зовы/);

  // Порядок сегментов = порядок обхода (бесплатный Go → zen → OR free → платный хвост).
  const at = (needle) => out.indexOf(needle);
  assert.ok(at('| Бесплатный Go |') < at('| zen (ринг) |'), 'zen после бесплатного Go');
  assert.ok(at('| zen (ринг) |') < at('| OpenRouter free |'), 'OR free после zen');
  assert.ok(at('| OpenRouter free |') < at('| Платный Go |'), 'платный хвост последний');

  assert.ok(out.includes('| Бесплатный Go | 5 | 35.7% | 55.6% | — |'), 'строка: % от зовов и % от обслуженных');
  assert.ok(out.includes('| zen (ринг) | 1 | 7.1% | 11.1% | 3 |'), 'падения на zen-сегменте видны');
  assert.ok(out.includes('| OpenRouter free | 2 | 14.3% | 22.2% | 1 |'));
  assert.ok(out.includes('| **не отдано** | — | **28.6%** | — | — |'), 'неотдано — от всех зовов');
});

test('digest v2: атрибуция — «без метки» объясняет автоматические прогоны (doctor)', () => {
  assert.match(out, /\*\*без метки\*\*: 88\.9%/, 'no_app против обслуженных вызовов');
  assert.ok(out.includes('автор автоматических прогонов не виден'));
});

test('digest v2: только аномалии — длинные таблицы уехали в /admin', () => {
  assert.ok(!out.includes('### Ступени'), 'таблица лестница×модель больше не печатается');
  assert.ok(!out.includes('### Скорость моделей'), 'таблица скоростей больше не печатается');
  assert.match(out, /🔴 `openrouter\/slow:free` — p50 50\.0 s \(порог 45\.0 s\), 5 вызовов/);
  assert.ok(out.includes('⚠️ лестница `service` — отказы 60.0% (6/10)'), 'отказавшие лестницы — в аномалиях');
  assert.ok(out.includes('⚠️ топ-ошибка ×10: provider request failed'));
  assert.match(out, /llm-ladder\.trainedassist\.store\/admin/, 'ссылка на разрезы в админке');
  assert.match(out, /DIGEST_SLOW_MS/, 'пороги настраиваемы');
});

test('digest v2: без funnel (отставший деплой) секция пропадает, а не падает', () => {
  const legacy = buildDigest({ totals: fixture.totals, models: [], ladders: [], errors: [] }, { hours: 4 });
  assert.ok(!legacy.includes('Воронка'));
  assert.ok(!legacy.includes('бесплатными'), 'без воронки нет и выдуманной доли');
  assert.ok(!legacy.includes('без метки'), 'без no_app — без строки');
  assert.match(legacy, /На что обратить внимание/);
});

test('digest v2: сегмент, на котором погибло, но который не отдал ни разу, — строка не выбрасывается', () => {
  const loud = buildDigest({
    ...fixture,
    funnel: {
      served: [{ category: 'go_free', calls: 3, pct_calls: 30, pct_served: 100 }],
      failed_at: [{ category: 'zen', calls: 7 }],
      served_total: 3,
      unserved: 7,
    },
  }, { hours: 4 });
  const zenRow = loud.split('\n').find((l) => l.includes('zen (ринг)'));
  assert.equal(zenRow, '| zen (ринг) | 0 | 0.0% | — | 7 |', 'мёртвый сегмент виден с нулём отдач');
});

test('digest v2: метки сегментов покрывают весь каталог категорий', () => {
  for (const cat of ['go_free', 'zen', 'or_free', 'go_sub', 'or_paid', 'other']) {
    assert.ok(SEGMENT_LABELS[cat], `категория ${cat} подписана`);
  }
});

test('digest v2: мёртвый сегмент стоит на СВОЁМ шаге обхода, а не уползает в хвост', () => {
  // Живой дефект первого рендера: zen с нулём отдач и 2181 падением всплыл ПОСЛЕ платных
  // строк, читалось как «zen — последний шаг». Строка должна стоять вторым шагом.
  const out2 = buildDigest({
    ...fixture,
    funnel: {
      served: [
        { category: 'go_free', calls: 5, pct_calls: 35.7, pct_served: 71.4 },
        { category: 'or_free', calls: 2, pct_calls: 14.3, pct_served: 28.6 },
      ],
      failed_at: [{ category: 'zen', calls: 10 }],
      served_total: 7,
      unserved: 10,
    },
  }, { hours: 4 });
  assert.ok(out2.indexOf('| zen (ринг) | 0 | 0.0% | — | 10 |') < out2.indexOf('| OpenRouter free |'),
    'zen (0 отдач, 10 падений) стоит между бесплатным Go и OpenRouter free');
});
