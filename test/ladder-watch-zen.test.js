import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zenRingEnabled } from '../scripts/ladder-watch.mjs';

// Кольцо zen выключается флагом `zen_ring` в config/ladders.json (#295). Пока флаг `false`,
// watcher не проверяет кольцо: иначе он рапортовал бы «лестница не отвечает» про кольцо,
// выключенное по решению оператора.

test('zenRingEnabled: кольцо выключается только явным флагом zen_ring: false', () => {
  assert.equal(zenRingEnabled({ zen_ring: false }), false);
  assert.equal(zenRingEnabled({ zen_ring: true }), true);
  assert.equal(zenRingEnabled({}), true, 'флага нет — кольцо считаем включённым, как раньше');
  assert.equal(zenRingEnabled(null), true, 'конфиг не прочитался — ведём себя как раньше');
});

test('конфиг лестниц: кольцо выключено — watcher не проверяет его', async () => {
  const cfg = JSON.parse(await readFile(new URL('../config/ladders.json', import.meta.url), 'utf8'));
  assert.equal(cfg.zen_ring, false, 'кольцо zen выключено в конфиге (#295)');
  assert.equal(zenRingEnabled(cfg), false, 'значит, проба кольца в watcher\'е будет пропущена');
});
