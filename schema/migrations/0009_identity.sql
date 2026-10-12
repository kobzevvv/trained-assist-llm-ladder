-- I02.a: additive identity schema for Ladder personal keys (Epic #253)
-- No production data; additive-only. Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS identity_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  service TEXT NOT NULL DEFAULT 'ladder',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_api_keys (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(user_id),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_identity_api_keys_user_id ON identity_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_identity_users_email ON identity_users(email);
