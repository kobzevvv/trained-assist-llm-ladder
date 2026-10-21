import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/admin-ui.js', import.meta.url), 'utf8');

function extractApp() {
  const start = source.indexOf('const APP = String.raw`');
  assert.ok(start > 0, 'admin-ui.js must export the APP script');
  const from = start + 'const APP = String.raw`'.length;
  const end = source.indexOf('`;', from);
  assert.ok(end > from, 'the APP script must be a template literal');
  return source.slice(from, end);
}

const app = extractApp();

// Depth-aware scanners: they skip string literals so that braces inside strings never
// break the balance of the block we are looking for.
function blockAt(src, braceIndex) {
  let depth = 0;
  let quote = null;
  for (let i = braceIndex; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(braceIndex + 1, i), end: i + 1 };
    }
  }
  throw new Error('unbalanced block');
}

function statementAt(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
  }
  throw new Error('unbalanced statement');
}

function submitHandlers(src) {
  const handlers = [];
  let index = src.indexOf("addEventListener('submit'");
  while (index >= 0) {
    const arrow = src.indexOf('=>', index);
    const brace = src.indexOf('{', arrow);
    handlers.push({ index, body: blockAt(src, brace).body });
    index = src.indexOf("addEventListener('submit'", index + 1);
  }
  return handlers;
}

function functionSource(src, name) {
  const marker = 'async function ' + name + '(';
  const start = src.indexOf(marker);
  assert.ok(start > 0, 'the admin script must define ' + name);
  const brace = src.indexOf('{', start + marker.length - 1);
  return src.slice(start, blockAt(src, brace).end);
}

test('submit handlers never read event.currentTarget after an await', () => {
  const handlers = submitHandlers(app);
  assert.ok(handlers.length >= 2, 'the admin panel has submit handlers');
  for (const handler of handlers) {
    const awaited = handler.body.indexOf('await');
    if (awaited < 0) continue;
    const late = handler.body.indexOf('currentTarget', awaited);
    assert.equal(late, -1, 'event.currentTarget is null after dispatch; capture the element before awaiting');
  }
});

test('adding a token resets the form and reports no error when the request succeeds', async () => {
  const credForm = {
    dataset: { provider: 'openrouter' },
    fields: { label: 'рабочий токен', token: 'sk-or-test-token' },
    reset() { this.resetCalled = true; },
    addEventListener(type, fn) { if (type === 'submit') this.submitHandler = fn; },
  };
  const requests = [];
  const errors = [];
  let dispatchDone = false;
  const request = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    dispatchDone = true; // the browser finishes dispatching while the handler awaits
    return {};
  };
  const FormData = class { constructor(form) { this.form = form; } get(name) { return this.form.fields[name] ?? null; } };

  const submitCredentialForm = new Function(
    'FormData', 'request', 'error', 'loadCredentials',
    'return (' + functionSource(app, 'submitCredentialForm') + ');',
  )(FormData, request, (message) => errors.push(message), async () => {});

  // The listener reads the element while the event is still being dispatched.
  const documentStub = { querySelectorAll: () => [credForm] };
  new Function('document', 'submitCredentialForm', statementAt(app, app.indexOf("for (const form of document.querySelectorAll('.cred-form'))")).text)
    (documentStub, submitCredentialForm);
  const handler = credForm.submitHandler;
  assert.ok(handler, 'the credential form must register a submit handler');

  const event = {
    preventDefault() {},
    get currentTarget() { return dispatchDone ? null : credForm; },
  };
  await handler(event);

  assert.equal(credForm.resetCalled, true, 'the form must be cleared after a successful add');
  assert.deepEqual(errors.filter(Boolean), [], 'a successful add must not report an error');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/admin/api/provider-credentials');
  assert.equal(requests[0].body.provider, 'openrouter');
  assert.equal(requests[0].body.label, 'рабочий токен');
  assert.equal(requests[0].body.token, 'sk-or-test-token');
});

test('the token form keeps the credential out of the error message', async () => {
  const errors = [];
  const submitCredentialForm = new Function(
    'FormData', 'request', 'error', 'loadCredentials',
    'return (' + functionSource(app, 'submitCredentialForm') + ');',
  )(class { constructor(form) { this.form = form; } get(name) { return this.form.fields[name] ?? null; } },
    async () => { throw new Error('HTTP 400'); },
    (message) => errors.push(message),
    async () => {});
  await submitCredentialForm({ dataset: { provider: 'openrouter' }, fields: { label: 'l', token: 'sk-or-secret' }, reset() {} });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Не удалось добавить токен'));
  assert.ok(!errors[0].includes('sk-or-secret'), 'the token must never appear in the error message');
});
