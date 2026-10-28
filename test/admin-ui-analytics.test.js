// #325: /admin получает секцию «Воронка» — прокси /admin/api/analytics → /v1/analytics с
// зажатым окном, и разметка секции на месте. Рендер браузерного APP проверяется на уровне
// источника (как test/admin-ui-submit.test.js), живой вид — вручную после деплоя.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adminUi } from '../src/admin-ui.js';

const req = (path) => new Request(`https://l.test/admin${path}`, {
  headers: { cookie: 'ladder_admin=tok' },
});

test('GET /admin/api/analytics proxies /v1/analytics with a clamped window (#325)', async () => {
  const seen = [];
  const apiFetch = async (r) => {
    seen.push(r.url);
    return new Response('{"funnel":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ok = await adminUi.fetch(req('/api/analytics?hours=7'), apiFetch);
  assert.equal(ok.status, 200);
  assert.match(seen[0], /\/v1\/analytics\?hours=7$/, 'окно пробрасывается');

  await adminUi.fetch(req('/api/analytics?hours=9999'), apiFetch);
  assert.match(seen[1], /hours=168$/, 'верхняя зажима — как у /v1/analytics');

  await adminUi.fetch(req('/api/analytics?hours=abc'), apiFetch);
  assert.match(seen[2], /hours=24$/, 'мусор в параметре — дефолт 24, не ошибка');

  await adminUi.fetch(req('/api/analytics'), apiFetch);
  assert.match(seen[3], /hours=24$/, 'без параметра — 24');
});

test('GET /admin/api/analytics without a session is 401 (#325)', async () => {
  let called = false;
  const r = await adminUi.fetch(new Request('https://l.test/admin/api/analytics'), async () => { called = true; return new Response('{}'); });
  assert.equal(r.status, 401);
  assert.equal(called, false, 'без ключа запрос к ladder не уходит');
});

test('the admin page carries the funnel section and the client renders it (#325)', async () => {
  const source = await readFile(new URL('../src/admin-ui.js', import.meta.url), 'utf8');
  assert.ok(source.includes('id="funnel-rows"'), 'таблица воронки в разметке');
  assert.ok(source.includes('id="funnel-ladders"'), 'таблица по лестницам в разметке');
  assert.ok(source.includes('function renderFunnel'), 'рендер определён');
  assert.ok(source.includes("'/admin/api/analytics?hours=24'"), 'дашборд её подтягивает');
  assert.ok(source.includes('Воронка — где отдают зовы'), 'заголовок секции');
});
