import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zenRingEnabled } from '../scripts/ladder-watch.mjs';

// Кольцо zen выключается ТОЛЬКО явным флагом `zen_ring: false` в config/ladders.json (#295).
// Флаг удалён (2026-10-27, доделка #304/#308): кольцо снова включено, watcher обязан его
// проверять — выключенное по решению оператора кольцо помечается возвратом флага, а не
// отсутствием записи в конфиге.

test('zenRingEnabled: кольцо выключается только явным флагом zen_ring: false', () => {
  assert.equal(zenRingEnabled({ zen_ring: false }), false);
  assert.equal(zenRingEnabled({ zen_ring: true }), true);
  assert.equal(zenRingEnabled({}), true, 'флага нет — кольцо считаем включённым, как раньше');
  assert.equal(zenRingEnabled(null), true, 'конфиг не прочитался — ведём себя как раньше');
});

test('конфиг лестниц: кольцо включено — watcher проверяет его вместе с остальными рангами', async () => {
  const cfg = JSON.parse(await readFile(new URL('../config/ladders.json', import.meta.url), 'utf8'));
  assert.equal(cfg.zen_ring === false, false, 'явного zen_ring: false в конфиге нет — кольцо не выключено');
  assert.equal(zenRingEnabled(cfg), true, 'значит, проба кольца в watcher\'е идёт на общих основаниях');
});
