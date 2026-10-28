import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zenRingEnabled } from '../scripts/ladder-watch.mjs';

// Кольцо zen выключается ТОЛЬКО явным флагом `zen_ring: false` в config/ladders.json (#295).
// 2026-10-28 (#329): флаг снова выставлен — анонимный free-доступ убит апстримом (429 для всех
// egress), ринг вырезан из всех лестниц; возврат = вернуть ранги конфигом и снять флаг.

test('zenRingEnabled: кольцо выключается только явным флагом zen_ring: false', () => {
  assert.equal(zenRingEnabled({ zen_ring: false }), false);
  assert.equal(zenRingEnabled({ zen_ring: true }), true);
  assert.equal(zenRingEnabled({}), true, 'флага нет — кольцо считаем включённым, как раньше');
  assert.equal(zenRingEnabled(null), true, 'конфиг не прочитался — ведём себя как раньше');
});

test('конфиг лестниц: кольцо выключено флагом zen_ring: false — watcher пропускает zen-канарейку (#329)', async () => {
  const cfg = JSON.parse(await readFile(new URL('../config/ladders.json', import.meta.url), 'utf8'));
  assert.equal(cfg.zen_ring, false, 'zen_ring: false — анонимный free убит апстримом, ринг retired (#329)');
  assert.equal(zenRingEnabled(cfg), false, 'проба кольца в watcher\'е пропускается');
});
