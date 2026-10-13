-- Short-lived request status for consumers waiting on a long ladder call. The random per-call
-- access token is stored only as SHA-256; no prompt, model output, provider error or bearer key.
CREATE TABLE IF NOT EXISTS ladder_call_progress (
  call_id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ladder_call_progress_events (
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (call_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ladder_progress_expiry ON ladder_call_progress (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ladder_progress_owner ON ladder_call_progress (owner_hash);
