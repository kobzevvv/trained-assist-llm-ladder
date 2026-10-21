import test from 'node:test';
import assert from 'node:assert/strict';
import { etaMinutes, plural, quotaNotice } from '../scripts/ladder-watch.mjs';

// Три способа заметить, что бесплатный лимит OpenRouter уходит: остаток, темп, факт.
// Замер 2026-10-08: 355/1000 за сутки; шторм способен сжечь остаток быстрее интервала опроса,
// поэтому одного «посмотреть, сколько осталось» — мало.
//
// Лимит считается по ПУЛУ АККАУНТОВ: каждый ключ пула — свой аккаунт OpenRouter со своим
// дневным счётчиком (замерено 2026-10-22: env-аккаунт 924/1000, четыре аккаунта из D1 —
// 12–57 при лимите 50). Пул — 1200/сутки, а не 1000 и не 4000.

const NOW = 1_791_500_000_000;
const min = (n) => n * 60_000;

// Пул из двух аккаунтов: большой (1000/сутки) и малый (50/сутки), малый исчерпан.
const accounts = [
  { label: 'env', used: 924, limit: 1000, remaining: 76 },
  { label: 'mariam', used: 57, limit: 50, remaining: 0 },
];
const pool = (over = {}) => ({
  ok: true,
  used: 981, limit: 1050, remaining: 76, etaMin: null,
  accounts,
  credit_total: 97, credit_free: -0.2,
  detail: '981/1050 за сутки, осталось 76',
  ...over,
});

test('etaMinutes: темп только между опросами, сброс счётчика его обнуляет', () => {
  assert.equal(etaMinutes(null, 10, 640, NOW), null, 'первый замер — темпа ещё нет');
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 399, 640, NOW), null, 'used ушёл назад — наступил новый день');
  assert.equal(etaMinutes({ used: 400, ts: NOW - 30_000 }, 410, 640, NOW), null, 'интервал меньше минуты — на нём темп не считаем');
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 400, 640, NOW), null, 'ничего не сожгли — темпа нет');

  // 100 запросов за 10 мин = 10/мин, осталось 640 → 64 мин
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 500, 640, NOW), 64);
  // шторм: 300 за 10 мин = 30/мин, осталось 120 → 4 мин
  assert.equal(Math.round(etaMinutes({ used: 400, ts: NOW - min(10) }, 700, 120, NOW)), 4);
});

test('quotaNotice: факт важнее темпа, темп важнее остатка; молчим в норме', () => {
  const ok = pool({ used: 355, limit: 1050, remaining: 695, accounts: [{ label: 'env', used: 355, limit: 1000, remaining: 645 }] });
  const low = pool({ used: 981, limit: 1050, remaining: 69 });

  // темп: остаток ещё приличный, но он сгорает — предупреждаем ДО исчерпания
  const burn = quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_ok', etaMin: 30 });
  assert.equal(burn.key, 'or_free_burn');
  assert.match(burn.text, /30 мин/);

  // остаток ниже 20 % потолка пула
  const lowNotice = quotaNotice({ quota: low, errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(lowNotice.key, 'or_free_low');
  assert.match(lowNotice.text, /под конец/);

  // в норме → в норме: тишина (и на первом прогоне в том числе — иначе CI слал бы пустяк)
  assert.equal(quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_ok', etaMin: null }).text, null);
  assert.equal(quotaNotice({ quota: ok, errHit: null, prevKey: undefined, etaMin: null }).text, null);

  // провал → норма: зелёное приходит только после реального провала
  const back = quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_low', etaMin: null });
  assert.equal(back.key, 'or_free_ok');
  assert.match(back.text, /в норме/);

  // квоту прочитать не удалось — не выдумываем ни остатка, ни темп
  assert.equal(quotaNotice({ quota: { skipped: 'or-usage HTTP 503' }, errHit: null, prevKey: 'or_free_ok', etaMin: null }), null);
});

test('quotaNotice: «usage limit» от провайдера — это факт, а не конец пула', () => {
  // Один аккаунт исчерпан — остальные живы: это НЕ «лимит кончился», а строка в сообщении.
  const one = quotaNotice({ quota: pool(), errHit: { error: 'Free usage limit reached', calls: 7 }, prevKey: 'or_free_ok', etaMin: null });
  assert.notEqual(one.key, 'or_free_dead', 'один исчерпанный аккаунт не выключает весь хвост');
  assert.match(one.text, /×7 за час/, 'видно, сколько именно отвалилось');
  assert.match(one.text, /по аккаунтам: env 76\/1000 · mariam 0\/50/, 'видно, кто именно исчерпан');
  assert.match(one.text, /1 аккаунт исчерпан/);
});

test('quotaNotice: пустой пул — вот это конец (красный)', () => {
  const empty = pool({ used: 1050, limit: 1050, remaining: 0, accounts: [
    { label: 'env', used: 1000, limit: 1000, remaining: 0 },
    { label: 'mariam', used: 57, limit: 50, remaining: 0 },
  ] });
  const dead = quotaNotice({ quota: empty, errHit: { error: 'Free usage limit reached', calls: 3 }, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(dead.key, 'or_free_dead');
  assert.match(dead.text, /исчерпан по всему пулу/);
  assert.match(dead.text, /сброс счётчиков в 00:00 UTC/, 'сказано, когда восстановится');
});

test('quotaNotice: пороги — доли потолка пула, а не «осталось 100»', () => {
  // 1050 потолок: 5 % = 52. Осталось 40 (3,8 %) — это crit, а не просто low.
  const crit = quotaNotice({ quota: pool({ used: 1010, limit: 1050, remaining: 40 }), errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(crit.key, 'or_free_crit');
  assert.match(crit.text, /почти исчерпан/);

  // осталось 15 % (157) — ниже 20 %, но выше 5 %: обычное «под конец».
  const low = quotaNotice({ quota: pool({ used: 893, limit: 1050, remaining: 157 }), errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(low.key, 'or_free_low');

  // осталось 25 % — в норме, молчим.
  const fine = quotaNotice({ quota: pool({ used: 787, limit: 1050, remaining: 263 }), errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(fine.text, null);
});

test('plural: русские числительные в сообщении не выглядят как «аккаунт(ов)»', () => {
  assert.equal(plural(1, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунт');
  assert.equal(plural(2, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунта');
  assert.equal(plural(4, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунта');
  assert.equal(plural(5, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунтов');
  assert.equal(plural(11, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунтов');
  assert.equal(plural(21, 'аккаунт', 'аккаунта', 'аккаунтов'), 'аккаунт');
});

test('quotaNotice: кредит аккаунта в сообщении — платный хвост может не спасти', () => {
  const negative = quotaNotice({ quota: pool(), errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.match(negative.text, /кредит пула 97 \(свободно -0\.20\)/);
  assert.match(negative.text, /платный хвост НЕ спасёт/);

  const positive = quotaNotice({
    quota: pool({ credit_total: 97, credit_free: 12.5 }), errHit: null, prevKey: 'or_free_ok', etaMin: null,
  });
  assert.match(positive.text, /платный хвост работает/);
});
