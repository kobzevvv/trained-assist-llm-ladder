// Issue #322: the checks already write "this model is dead" into their own tables — read that
// verdict back at request time so a dead rung stops costing a hop WITHOUT editing
// config/ladders.json. (#319, the auto-PR that would have edited the config instead of reading
// the data, was rejected: the data is already in the database, the ladder just has to look.)
//
// Two signals, both refreshed by the checks themselves, both fail-open:
//
//   free_models: available = 0 AND last_seen >= now - FREE_MAX_AGE
//     collect-free-models re-marks a gone row on every pass (~4 h), so a fresh last_seen means
//     "the provider catalog has not had this model for the last day". Stop collecting → the
//     signal ages out in a day and the rung comes back; a wrong verdict never sticks.
//
//   zen_models: status = 'down' AND (last_ok_at IS NULL OR last_ok_at <= now - ZEN_DOWN_FOR)
//               AND updated_at >= now - ZEN_STALE
//     The re-check runs every 10 min, so `updated_at` is fresh while the checks live: a model
//     that is down NOW and has not been seen healthy for 3 days is provider-dead. A worker
//     wobble is minutes (rung health already handles those) and a flapping model carries a
//     recent last_ok_at, so neither trips the veto. If the checks themselves stop, the signal
//     goes stale in a day and the veto lifts (fail-open).
//     `first_failed_at` is NOT the streak start: zen-runner preserves it across a successful
//     check (it is the first failure ever), so it only grows and would veto on day one of a
//     brand-new outage that began after an old one.
//
// TTL: one fetch per D1 binding per 15 min per isolate (WeakMap) — the ladder pays two
// queries per cache, never per call. A failed fetch rethrows to the caller, and run() treats
// "no verdict" as "no veto".

const FREE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ZEN_DOWN_FOR_MS = 3 * 24 * 60 * 60 * 1000;
const ZEN_STALE_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 15 * 60 * 1000;

const freeCache = new WeakMap();
const zenCache = new WeakMap();

async function ttl(cache, db, now, load) {
  const hit = cache.get(db);
  if (hit && now - hit.at < TTL_MS) return hit.ids;
  try {
    const ids = await load();
    cache.set(db, { at: now, ids });
    return ids;
  } catch (err) {
    if (hit) return hit.ids; // a stale verdict beats an outage
    throw err;
  }
}

/** Rung ids the checks confirm dead; empty set (never a throw to the ladder's callers beyond
 *  a DB outage with no cached verdict) when no inventory is configured. */
export async function deadRungs(env, now = Date.now()) {
  const dead = new Set();
  if (!env) return dead;

  if (env.LADDER_TRACE_DB) {
    const db = env.LADDER_TRACE_DB;
    const ids = await ttl(freeCache, db, now, async () => {
      const { results = [] } = await db
        .prepare('SELECT model_id FROM free_models WHERE available = 0 AND last_seen >= ?1')
        .bind(now - FREE_MAX_AGE_MS)
        .all();
      return results.map((r) => String(r.model_id));
    });
    for (const id of ids) {
      dead.add(id);
      // Zen catalog rows are stored as opencode-zen/<id> while the ladders serve the same
      // models as zen-rings/<id> (the relay rung is retired; the ring covers the same models).
      if (id.startsWith('opencode-zen/')) dead.add(`zen-rings/${id.slice('opencode-zen/'.length)}`);
    }
  }

  if (env.ZEN_DB) {
    const db = env.ZEN_DB;
    const ids = await ttl(zenCache, db, now, async () => {
      const { results = [] } = await db
        .prepare("SELECT model FROM zen_models WHERE status = 'down' "
          + 'AND (last_ok_at IS NULL OR last_ok_at <= ?1) AND updated_at >= ?2')
        .bind(now - ZEN_DOWN_FOR_MS, now - ZEN_STALE_MS)
        .all();
      return results.map((r) => String(r.model));
    });
    for (const model of ids) dead.add(`zen-rings/${model}`);
  }

  return dead;
}
