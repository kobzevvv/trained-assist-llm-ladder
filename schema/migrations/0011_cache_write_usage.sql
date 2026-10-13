-- Cache-write token usage is nullable: NULL means the provider did not report this counter.
ALTER TABLE ladder_calls ADD COLUMN tokens_cache_write INTEGER;
