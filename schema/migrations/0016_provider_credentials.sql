-- Provider credentials for Ladder (OpenRouter, OpenCode Go)
-- Credentials are encrypted with AES-GCM using PROVIDER_CREDS_KEY (32 bytes base64)
-- This is a system-level table, not user-specific.
CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,          -- 'openrouter' | 'opencode-go'
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,        -- base64(v1 || iv || ciphertext+tag)
  key_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider
  ON provider_credentials(provider, status);