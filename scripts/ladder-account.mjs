#!/usr/bin/env node
// ladder-account.mjs — sandbox accounting ops for Ladder personal keys (Epic #253 I04.a).
//
//   node scripts/ladder-account.mjs bootstrap <user_id> <email> [role]   # first admin, local only
//   node scripts/ladder-account.mjs create <user_id> <email> [role]
//   node scripts/ladder-account.mjs list
//   node scripts/ladder-account.mjs key issue <user_id> <label> [expires_ms]
//   node scripts/ladder-account.mjs key list [user_id]
//   node scripts/ladder-account.mjs key revoke <key_hash>
//   node scripts/ladder-account.mjs disable <user_id>
//   node scripts/ladder-account.mjs enable <user_id>
//   node scripts/ladder-account.mjs role <user_id> <role>
//
// Keys are printed once to stdout so they can be piped into a protected file:
//   node scripts/ladder-account.mjs key issue u1 laptop > .local/ladder/u1.key
// Bootstrap of the first admin is a local sandbox ops command; it is never a public endpoint.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DB_NAME = 'trained-assist-llm-ladder-trace';
const CACHE = join(homedir(), '.cache', 'llm-ladder', 'account-wrangler.toml');
const DEFAULT_SERVICE = 'ladder';

function authHint(raw) {
  if (/not authenticated|Authentication error|code.?10000|login/i.test(raw)) {
    return 'Cloudflare auth expired. Run `npx wrangler login` and retry.';
  }
  return null;
}

function wrangler(args) {
  try {
    return execFileSync('npx', ['--yes', 'wrangler', ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const raw = String(e.stdout || e.stderr || e.message || '');
    const hint = authHint(raw);
    if (hint) throw new Error(hint);
    throw new Error(raw.trim().split('\n').slice(-6).join('\n'));
  }
}

function makeConfig() {
  const dbs = JSON.parse(wrangler(['d1', 'list', '--json']));
  const db = dbs.find((d) => d.name === DB_NAME);
  if (!db) throw new Error(`database ${DB_NAME} not found in \`wrangler d1 list\``);
  mkdirSync(dirname(CACHE), { recursive: true });
  // Config carries only the database id; no credentials are written here.
  return [
    'name = "ladder-account-cli"', 'compatibility_date = "2025-09-01"', '',
    '[[d1_databases]]', 'binding = "LADDER_TRACE_DB"',
    `database_name = "${DB_NAME}"`, `database_id = "${db.uuid}"`, '',
  ].join('\n');
}

function resolveConfig() {
  if (process.env.LADDER_ACCOUNT_CONFIG) return process.env.LADDER_ACCOUNT_CONFIG;
  if (existsSync(CACHE)) return CACHE;
  const cfg = CACHE;
  execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(cfg)}, ${JSON.stringify(makeConfig())})`], { cwd: ROOT });
  return cfg;
}

/** Bind `?` params safely: D1 CLI accepts literals only, so escape strings. */
function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1(sql, retry = true) {
  const cfg = resolveConfig();
  let out;
  try {
    out = wrangler(['d1', 'execute', DB_NAME, '--config', cfg, '--remote', '--json', '--command', sql]);
  } catch (e) {
    if (retry && /not found|unknown database|No such database/i.test(String(e.message))) {
      rmSync(CACHE, { force: true });
      return d1(sql, false);
    }
    throw e;
  }
  const start = out.indexOf('[');
  if (start < 0) return [];
  try { return JSON.parse(out.slice(start))?.[0]?.results ?? []; } catch { return []; }
}

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

function now() {
  return Date.now();
}

function newUserId(prefix = 'user') {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function requireArgs(args, count, usage) {
  if (args.length < count) {
    console.error(`usage: ${usage}`);
    return null;
  }
  return args;
}

function cmdBootstrap(args) {
  // First admin: local sandbox ops command, never exposed as a public endpoint.
  const got = requireArgs(args, 2, 'bootstrap <user_id> <email> [role]');
  if (!got) return 2;
  const [userId, email, role = 'admin'] = got;
  d1(`INSERT INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
      VALUES (${lit(userId)}, ${lit(email)}, ${lit(role)}, 'ladder', 'active', ${now()}, ${now()})`);
  console.log(`bootstrap: ${userId} <${email}> role=${role}`);
  return 0;
}

function cmdCreate(args) {
  const got = requireArgs(args, 2, 'create <user_id> <email> [role]');
  if (!got) return 2;
  const [userId, email, role = 'user'] = got;
  d1(`INSERT INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
      VALUES (${lit(userId)}, ${lit(email)}, ${lit(role)}, 'ladder', 'active', ${now()}, ${now()})`);
  console.log(`createUser: ${userId} <${email}> role=${role}`);
  return 0;
}

function cmdList() {
  const rows = d1(`SELECT user_id, email, role, service, status FROM identity_users ORDER BY user_id`);
  for (const row of rows) console.log(`${row.user_id}\t${row.email}\t${row.role}\t${row.status}`);
  return 0;
}

function cmdKey(args) {
  const sub = args[0];
  if (sub === 'issue') {
    const got = requireArgs(args.slice(1), 2, 'key issue <user_id> <label> [expires_ms]');
    if (!got) return 2;
    const [userId, label, expires = null] = got;
    const expiresAt = expires === null ? 'NULL' : Number(expires);
    const key = randomBytes(32).toString('base64url');
    const keyHash = hashKey(key);
    d1(`INSERT INTO identity_api_keys (key_hash, user_id, label, status, expires_at, created_at)
        VALUES (${lit(keyHash)}, ${lit(userId)}, ${lit(label)}, 'active', ${expiresAt === 'NULL' ? 'NULL' : Number(expiresAt)}, ${now()})`);
    // The raw key is emitted exactly once; pipe to a protected file, never to chat/PR.
    console.log(key);
    console.error(`keyHash=${keyHash} label=${label} user=${userId}`);
    return 0;
  }
  if (sub === 'list') {
    const userId = args[1];
    const where = userId ? `WHERE user_id = ${lit(userId)}` : '';
    const rows = d1(`SELECT key_hash, user_id, label, status, expires_at, revoked_at, created_at
                     FROM identity_api_keys ${where} ORDER BY created_at DESC`);
    for (const row of rows) {
      console.log(`${row.key_hash}\t${row.user_id}\t${row.label}\t${row.status}\t${row.revoked_at ? 'revoked' : 'active'}`);
    }
    return 0;
  }
  if (sub === 'revoke') {
    const got = requireArgs(args.slice(1), 1, 'key revoke <key_hash>');
    if (!got) return 2;
    d1(`UPDATE identity_api_keys SET revoked_at = ${now()} WHERE key_hash = ${lit(got[0])} AND revoked_at IS NULL`);
    console.log(`revokeApiKey: ${got[0]}`);
    return 0;
  }
  console.error('usage: key <issue|list|revoke> ...');
  return 2;
}

function cmdSetStatus(args, status) {
  const got = requireArgs(args, 1, `${status === 'disabled' ? 'disable' : 'enable'} <user_id>`);
  if (!got) return 2;
  d1(`UPDATE identity_users SET status = ${lit(status)}, updated_at = ${now()} WHERE user_id = ${lit(got[0])}`);
  console.log(`${status}: ${got[0]}`);
  return 0;
}

function cmdRole(args) {
  const got = requireArgs(args, 2, 'role <user_id> <role>');
  if (!got) return 2;
  d1(`UPDATE identity_users SET role = ${lit(got[1])}, updated_at = ${now()} WHERE user_id = ${lit(got[0])}`);
  console.log(`role: ${got[0]} -> ${got[1]}`);
  return 0;
}

export function accountCommand(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'bootstrap') return cmdBootstrap(rest);
  if (cmd === 'create') return cmdCreate(rest);
  if (cmd === 'list') return cmdList();
  if (cmd === 'key') return cmdKey(rest);
  if (cmd === 'disable') return cmdSetStatus(rest, 'disabled');
  if (cmd === 'enable') return cmdSetStatus(rest, 'active');
  if (cmd === 'role') return cmdRole(rest);
  console.error('usage: ladder-account <bootstrap|create|list|key|disable|enable|role> ...');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = accountCommand(process.argv.slice(2));
}
