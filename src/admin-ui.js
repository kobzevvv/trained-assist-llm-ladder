const COOKIE = 'ladder_admin';
const PERIODS = new Set(['15m', '1h', '4h', '24h', 'all']);
const ACTIONS = new Set(['suspend', 'resume', 'revoke']);
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function cookie(request) {
  const value = request.headers.get('cookie') || '';
  const match = value.match(/(?:^|;\s*)ladder_admin=([^;]+)/);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' } });
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin && origin === new URL(request.url).origin;
}
async function ladder(request, apiFetch, path, token, method = 'GET', body) {
  try {
    const response = await apiFetch(new Request(new URL(path, request.url), { method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000), cache: 'no-store' }));
    if (!response.ok) return json({ error: 'Ladder вернул HTTP ' + response.status }, response.status);
    return json(await response.json(), response.status);
  } catch { return json({ error: 'Ladder недоступен' }, 503); }
}
function redirect(location, setCookie) {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location, ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
}
function text(value, status = 200) {
  return new Response(value, { status, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trained Assist · Ключи и расход</title><link rel="stylesheet" href="/admin/style.css"></head><body><header><div class="brand"><span class="mark">T</span><div><strong>Trained Assist</strong><small>Администрирование ключей</small></div></div><form action="/admin/disconnect" method="post"><button class="link">Отключить ключ</button></form></header><main><div class="hero"><div><p class="eyebrow">LLM · НАБЛЮДЕНИЕ</p><h1>Расход по ключам</h1><p>Кто обращался к моделям и сколько токенов потратил.</p></div><button id="refresh" class="outline">↻ Обновить</button></div><section id="connect" class="panel connect" hidden><div class="connect-mark">⌁</div><h2>Подключите ключ администратора</h2><p>Ключ отправляется серверу сайта. JavaScript страницы его не получает. Он сохраняется в защищённом cookie текущей сессии.</p><form action="/admin/connect" method="post"><label for="key">Персональный ключ администратора</label><div class="connect-row"><input id="key" name="key" type="password" required autocomplete="off" placeholder="Вставьте ключ"><button class="primary">Подключить</button></div></form><p class="hint">Сайт закрыт для посторонних. Доступ к статистике дополнительно проверяется в Ladder.</p></section><section id="dashboard" hidden><nav class="tabs" aria-label="Разделы"><button data-tab="usage" class="selected">Расход и ключи</button><button data-tab="openrouter">OpenRouter</button><button data-tab="opencode-go">OpenCode Go</button></nav><p id="error" class="error" hidden></p><div data-panel="usage"><section class="panel issue"><div><h2>Создать ключ</h2><p>Для существующего аккаунта. Значение показывается один раз.</p></div><form id="issue-form"><label>Идентификатор пользователя<input name="user_id" required pattern="[A-Za-z0-9_-]{1,100}" placeholder="user_id"></label><label>Название ключа<input name="label" required maxlength="80" placeholder="OpenCode Mac"></label><button class="primary">Создать ключ</button></form></section><section class="panel analytics-filter"><div><h2>Аналитика расхода</h2><p>Сводка сразу за все периоды и детализация выбранного ключа.</p></div><label>Ключ для аналитики<select id="usage-key"><option value="">Все ключи</option></select></label></section><p id="updated" class="muted">Загрузка данных…</p><div id="summary" class="summary"></div><section class="panel"><div class="section-head"><div><h2>Воронка — где отдают зовы</h2><p>На каком сегменте обслужились вызовы и где падали отказы · шаги: бесплатный Go → zen → OpenRouter free → платный хвост</p></div><span id="funnel-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Сегмент</th><th>Отдано</th><th>% зовов</th><th>% от обслуженных</th><th>Падений на сегменте</th></tr></thead><tbody id="funnel-rows"></tbody></table></div><p class="muted">По лестницам: сколько зовов, сколько отказов и какая доля отдана бесплатными сегментами</p><div class="table-wrap"><table><thead><tr><th>Лестница</th><th>Вызовов</th><th>Отказов</th><th>Бесплатными</th></tr></thead><tbody id="funnel-ladders"></tbody></table></div></section><section class="panel"><div class="section-head"><div><h2>Вызовы за последние 24 часа</h2><p>Одна строка на ключ, приложение и модель</p></div><span id="row-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Ключ / пользователь</th><th>Приложение</th><th>Модель</th><th>Тип</th><th>Вызовы</th><th>Усп. / ошибки</th><th>Вход / кэш / выход</th><th>Цена</th></tr></thead><tbody id="usage-rows"></tbody></table></div></section><section class="panel"><div class="section-head"><div><h2>Ключи пользователей</h2><p>Приостановка действует сразу; отзыв нельзя отменить.</p></div><span id="key-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Название</th><th>Пользователь</th><th>Статус</th><th>Последний вызов</th><th>Создан</th><th>Действия</th></tr></thead><tbody id="key-rows"></tbody></table></div></section></div><div data-panel="openrouter" hidden><section class="panel"><div class="section-head"><div><h2>Токены OpenRouter</h2><p>Ключи платного хвоста: лестница чередует их и переключается на следующий при отказе ключа.</p></div><span id="or-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Название</th><th>Токен</th><th>Источник</th><th>Статус</th><th>Добавлен</th><th>Действия</th></tr></thead><tbody id="or-rows"></tbody></table></div></section><section class="panel issue"><div><h2>Добавить токен OpenRouter</h2><p>Токен шифруется и хранится в базе Ladder. Значение больше не показывается.</p></div><form class="cred-form" data-provider="openrouter"><label>Название<input name="label" required maxlength="80" placeholder="OpenRouter · основной"></label><label>Токен<input name="token" type="password" required autocomplete="off" placeholder="sk-or-..."></label><button class="primary">Добавить токен</button></form></section></div><div data-panel="opencode-go" hidden><section class="panel"><div class="section-head"><div><h2>Токены OpenCode Go</h2><p>Ключи пула Go: лестница чередует их при исчерпании лимита.</p></div><span id="go-count" class="count"></span></div><div class="table-wrap"><table><thead><tr><th>Название</th><th>Токен</th><th>Источник</th><th>Статус</th><th>Добавлен</th><th>Действия</th></tr></thead><tbody id="go-rows"></tbody></table></div></section><section class="panel issue"><div><h2>Добавить токен OpenCode Go</h2><p>Токен шифруется и хранится в базе Ladder. Значение больше не показывается.</p></div><form class="cred-form" data-provider="opencode-go"><label>Название<input name="label" required maxlength="80" placeholder="Go · workspace 2"></label><label>Токен<input name="token" type="password" required autocomplete="off" placeholder="oc_sk_..."></label><button class="primary">Добавить токен</button></form></section></div></section></main><dialog id="new-key"><p class="eyebrow">НОВЫЙ КЛЮЧ</p><h2>Сохраните ключ сейчас</h2><p>После закрытия это значение больше не будет показано.</p><code id="key-value"></code><div class="dialog-actions"><button id="copy-key" class="primary">Скопировать</button><button id="close-key" class="outline">Готово</button></div></dialog><script src="/admin/app.js" defer></script></body></html>`;

const CSS = `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;700;800&display=swap');:root{font-family:'DM Sans',sans-serif;background:#f5f7f4;color:#20332a}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.55}header{height:72px;border-bottom:1px solid #e2eae4;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 max(30px,calc((100vw - 1450px)/2))}.brand{display:flex;align-items:center;gap:11px}.brand strong{font:800 15px Manrope;display:block}.brand small{display:block;color:#819087;font-size:12px}.mark{background:#167457;color:#fff;border-radius:10px;display:grid;place-items:center;width:37px;height:37px;font:800 23px Manrope}.link{border:0;background:none;color:#5c7c6c;font-size:13px;font-weight:700}main{max-width:1510px;margin:auto;padding:38px 30px 70px}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:27px}.eyebrow{color:#258665;font-size:11px;letter-spacing:.15em;font-weight:800;margin:0 0 9px}h1{font:800 clamp(27px,3vw,38px) Manrope;letter-spacing:-.04em;margin:0}h2{font:800 18px Manrope;letter-spacing:-.02em;margin:0 0 4px}.hero p:not(.eyebrow),.section-head p,.issue p,.connect p{color:#819087;font-size:13px;margin:5px 0 0}.primary,.outline{border-radius:9px;padding:10px 15px;font-size:13px;font-weight:700}.primary{background:#16775b;color:#fff;border:1px solid #16775b}.primary:hover{background:#0c6148}.outline{border:1px solid #c5d9cc;background:#fff;color:#2b7557}.outline:hover{background:#f0f7f1}.tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:23px;padding-bottom:14px;border-bottom:1px solid #e2eae4}.tabs button{background:#e9efea;color:#6b7c70;border:1px solid transparent;border-radius:9px;padding:10px 16px;font-size:13px;font-weight:700}.tabs button.selected{background:#fff;color:#137156;border-color:#b5d4c0}.analytics-filter{display:flex;align-items:end;justify-content:space-between;gap:20px;padding:20px 23px}.analytics-filter p{color:#819087;font-size:13px;margin:5px 0 0}.analytics-filter select{display:block;margin-top:7px;border:1px solid #d7e4da;background:#fbfcfb;border-radius:8px;padding:10px 12px;color:#263b2e;min-width:250px}.muted{font-size:12px;color:#91a097;margin:0 0 15px}.error{border:1px solid #ebc2bb;background:#fff2ef;border-radius:8px;padding:11px;color:#aa5043}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:22px}.panel,.metric{background:#fff;border:1px solid #e1e9e4;border-radius:14px;box-shadow:0 4px 15px #193f2509;margin-bottom:22px;overflow:hidden}.metric{padding:20px;margin:0}.metric-head{display:flex;justify-content:space-between;align-items:center;color:#8b9a91;font-size:12px}.metric-total{font:800 31px Manrope;letter-spacing:-.03em;margin:16px 0}.metric-total small{font:600 13px 'DM Sans';color:#91a097}.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;color:#8a9990;font-size:12px}.metric-grid span{display:flex;justify-content:space-between}.metric-grid b{color:#344d3d}.metric-foot{border-top:1px solid #edf2ee;padding-top:12px;color:#8a9990;font-size:11px;margin-top:17px;line-height:1.6}.pill{display:inline-block;border-radius:6px;background:#edf1ee;color:#61766a;padding:5px 9px;font-size:11px;font-weight:800;white-space:nowrap}.pill.free,.pill.active{background:#e7f5eb;color:#298055}.pill.paid{background:#fff0e1;color:#ac6a2d}.pill.revoked{background:#fff0ef;color:#ad5147}.section-head{padding:21px 23px;border-bottom:1px solid #edf1ee;display:flex;justify-content:space-between;align-items:center}.count{background:#f2f6f3;color:#789083;font-size:12px;border-radius:6px;padding:6px 9px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:960px;text-align:left}th{background:#fbfcfb;color:#92a198;text-transform:uppercase;font-size:10px;letter-spacing:.08em;padding:12px 19px;white-space:nowrap}td{border-top:1px solid #eef2ef;padding:14px 19px;font-size:12px;color:#51665a;vertical-align:middle}td strong{display:block;color:#22382a}td small{display:block;color:#9baa9f;margin-top:3px}td code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#51665a;background:#f2f6f3;border:1px solid #e3ebe5;border-radius:6px;padding:3px 7px}td.model{max-width:215px;overflow-wrap:anywhere}td.empty{text-align:center;color:#94a49a;padding:28px}.action{border:0;background:#edf6ef;color:#2a7754;border-radius:7px;padding:7px 9px;font-size:11px;font-weight:700;margin-right:6px}.action.danger{background:#fff0ee;color:#b65449}.issue{display:flex;align-items:end;justify-content:space-between;gap:20px;padding:24px}.issue form{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.cred-form input[name=token]{min-width:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}label{font-size:12px;color:#6b7c70;font-weight:700}input{display:block;margin-top:7px;border:1px solid #d7e4da;background:#fbfcfb;border-radius:8px;padding:10px 12px;outline-color:#81bda0;color:#263b2e;min-width:190px}.connect{max-width:560px;margin:46px auto;padding:34px}.connect-mark{background:#e3f5e9;color:#258763;border-radius:12px;width:48px;height:48px;display:grid;place-items:center;font-size:29px;margin-bottom:20px}.connect p{line-height:1.5;margin:10px 0 27px}.connect-row{display:flex;gap:10px;align-items:end}.connect-row input{flex:1}.connect .hint{font-size:11px;color:#9ca99f;margin:18px 0 0}dialog{border:1px solid #dbe9df;border-radius:14px;box-shadow:0 18px 60px #14352255;padding:28px;width:min(550px,calc(100% - 30px))}dialog::backdrop{background:#14282099}dialog p:not(.eyebrow){font-size:13px;color:#819087}dialog code{display:block;background:#f2f6f3;border:1px solid #dbe7dc;padding:14px;border-radius:8px;overflow-wrap:anywhere;margin:17px 0}.dialog-actions{display:flex;justify-content:end;gap:9px}@media(max-width:980px){.summary{grid-template-columns:repeat(2,minmax(210px,1fr))}.summary .metric:last-child{grid-column:auto}.issue{display:block}.issue form{margin-top:20px}}@media(max-width:620px){.analytics-filter{display:block}.analytics-filter label{display:block;margin-top:14px}.analytics-filter select{width:100%}header{padding:0 16px}main{padding:28px 16px}.summary{grid-template-columns:1fr}.summary .metric:last-child{grid-column:auto}.connect-row{display:block}.connect-row input,.connect-row button{width:100%;margin-top:10px}.issue form{display:block}.issue label{display:block;margin-bottom:10px}.issue input{width:100%}}`;

const APP = String.raw`const $ = (id) => document.getElementById(id);
const format = (n) => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);
const date = (n) => n ? new Date(n).toLocaleString('ru-RU') : '—';
const money = (n) => n == null ? '—' : '$' + Number(n).toFixed(n < .01 ? 5 : 2);
const make = (tag, className, value) => { const e = document.createElement(tag); if (className) e.className = className; e.textContent = value == null ? '' : String(value); return e; };
const cell = (tr, value, cls) => { const e = make('td', cls, value); tr.append(e); return e; };
let selectedKey = '';
const PERIOD_LABELS = [['15m','15 минут'],['1h','1 час'],['4h','4 часа'],['24h','24 часа'],['all','Всё время']];
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
async function request(path, options) { const r = await fetch(path, { cache: 'no-store', ...options }); if (!r.ok) { const body = await r.json().catch(() => null); throw new Error(body?.error?.message || body?.error || ('HTTP ' + r.status)); } return r.json(); }
function showTab(tab) {
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('selected', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
}
async function load() {
  error(''); $('refresh').disabled = true;
  try {
    const suffix = selectedKey ? '&key_id=' + encodeURIComponent(selectedKey) : '';
    const [listing, users, ...usage] = await Promise.all([
      request('/admin/api/keys'), request('/admin/api/users'),
      ...PERIOD_LABELS.map(([period]) => request('/admin/api/usage?period=' + period + suffix)),
    ]);
    $('connect').hidden = true; $('dashboard').hidden = false;
    render(usage.map((snapshot, i) => ({ ...snapshot, label: PERIOD_LABELS[i][1] })), listing.keys || [], users.users || []);
    $('updated').textContent = 'Обновлено ' + new Date().toLocaleString('ru-RU') + ' · Время вызовов UTC';
    request('/admin/api/analytics?hours=24').then(renderFunnel).catch(e => renderFunnel(null, e.message));
  } catch (e) {
    if (String(e).includes('401')) { $('connect').hidden = false; $('dashboard').hidden = true; }
    else { $('connect').hidden = true; $('dashboard').hidden = false; error('Не удалось загрузить данные: ' + e.message); }
  } finally { $('refresh').disabled = false; }
  await loadCredentials();
}
function renderUserChoices(users) {
  const input = document.querySelector('#issue-form [name=user_id]'); if (!input) return;
  let choices = document.getElementById('user-choices'); if (!choices) { choices = document.createElement('datalist'); choices.id = 'user-choices'; document.body.append(choices); }
  choices.replaceChildren(); for (const user of users.filter(user => user.status === 'active')) { const option = document.createElement('option'); option.value = user.user_id; option.label = user.email; choices.append(option); }
  input.setAttribute('list', choices.id); input.placeholder = users.length ? 'выберите или введите новый user_id' : 'user_id';
  const note = document.querySelector('.issue p'); if (note) note.textContent = 'Выберите существующего пользователя из списка. Для нового укажите новый ID и email — аккаунт и первый ключ создадутся вместе.';
}
async function loadCredentials() {
  try {
    const data = await request('/admin/api/provider-credentials');
    renderCredentials(data.credentials || []);
  } catch (e) {
    renderCredentials([], 'Не удалось загрузить токены: ' + e.message);
  }
}
function renderCredentials(credentials, failure) {
  const groups = { openrouter: { rows: $('or-rows'), count: $('or-count') }, 'opencode-go': { rows: $('go-rows'), count: $('go-count') } };
  for (const [provider, group] of Object.entries(groups)) {
    const items = credentials.filter(c => c.provider === provider);
    group.count.textContent = format(items.length) + ' шт.';
    group.rows.replaceChildren();
    if (failure && !items.length) { const tr = document.createElement('tr'); const td = cell(tr, failure, 'empty'); td.colSpan = 6; group.rows.append(tr); continue; }
    if (!items.length) { const tr = document.createElement('tr'); const td = cell(tr, 'Токенов пока нет', 'empty'); td.colSpan = 6; group.rows.append(tr); continue; }
    for (const c of items) {
      const tr = document.createElement('tr');
      const name = cell(tr, ''); name.append(make('strong', '', c.label || 'Без названия'), make('small', '', '#' + c.id));
      const token = cell(tr, ''); token.append(make('code', '', c.token_mask || '••••••••'));
      const source = cell(tr, ''); source.append(make('span', 'pill ' + (c.source === 'env' ? 'env' : 'active'), c.source === 'env' ? 'Секрет воркера' : 'База Ladder'));
      const status = cell(tr, ''); status.append(make('span', 'pill ' + (c.status === 'active' ? 'active' : 'disabled'), c.status === 'active' ? 'Активен' : 'Отключён'));
      cell(tr, date(c.created_at));
      const actions = cell(tr, '');
      if (c.source !== 'env' && c.status === 'active') {
        const b = make('button', 'action danger', 'Отключить');
        b.addEventListener('click', async () => { if (!confirm('Отключить токен «' + (c.label || c.id) + '»?')) return; try { await request('/admin/api/provider-credentials/' + c.id + '/disable', { method: 'POST' }); await loadCredentials(); } catch (e) { error('Не удалось отключить токен: ' + e.message); } });
        actions.append(b);
      }
      group.rows.append(tr);
    }
  }
}
// Воронка (#325): клиент рендерит funnel из /admin/api/analytics — те же данные, что телеграм-
// дайджест, но здесь остаются и длинные разрезы. Отказ секции не должен ронять весь дашборд,
// поэтому load() зовёт её отдельным .then/.catch.
function renderFunnel(data, failure) {
  const rows = $('funnel-rows'); const lrows = $('funnel-ladders');
  rows.replaceChildren(); lrows.replaceChildren();
  const empty = (parent, text, cols) => { const tr = document.createElement('tr'); const td = cell(tr, text, 'empty'); td.colSpan = cols; parent.append(tr); };
  if (!data || !data.funnel) { empty(rows, 'Воронка недоступна: ' + (failure || 'нет данных'), 5); empty(lrows, '—', 4); return; }
  $('funnel-count').textContent = 'за ' + format(data.hours) + ' ч';
  const LABELS = { go_free: 'Бесплатный Go', zen: 'zen (ринг)', or_free: 'OpenRouter free', go_sub: 'Платный Go', or_paid: 'Платный OpenRouter', other: 'Прочее' };
  const failedAt = new Map((data.funnel.failed_at || []).map(f => [f.category, f.calls]));
  for (const s of data.funnel.served || []) {
    const tr = document.createElement('tr');
    cell(tr, LABELS[s.category] || s.category);
    cell(tr, format(s.calls));
    cell(tr, s.pct_calls + '%');
    cell(tr, s.pct_served + '%');
    const dead = failedAt.get(s.category) || 0; failedAt.delete(s.category);
    cell(tr, dead ? format(dead) : '—');
    rows.append(tr);
  }
  // Сегмент, на котором погибло что-то, но который ни разу не отдал — самая громкая
  // неоптимальность, поэтому строка не выбрасывается.
  failedAt.forEach((n, category) => {
    const tr = document.createElement('tr');
    cell(tr, LABELS[category] || category); cell(tr, '0'); cell(tr, '0.0%'); cell(tr, '—'); cell(tr, format(n));
    rows.append(tr);
  });
  const calls = Number(data.totals && data.totals.calls) || 0;
  if (data.funnel.unserved) {
    const tr = document.createElement('tr');
    cell(tr, 'Не отдано'); cell(tr, '—');
    cell(tr, (calls ? ((data.funnel.unserved / calls) * 100).toFixed(1) : '0') + '%');
    cell(tr, '—'); cell(tr, '—');
    rows.append(tr);
  }
  if (!rows.children.length) empty(rows, 'За окно вызовов нет', 5);
  const FREE = new Set(['go_free', 'zen', 'or_free']);
  for (const l of data.ladders || []) {
    const rungs = l.rungs || [];
    const servedN = rungs.reduce((s, r) => s + (Number(r.calls) || 0), 0);
    const freeN = rungs.filter(r => FREE.has(r.category)).reduce((s, r) => s + (Number(r.calls) || 0), 0);
    const tr = document.createElement('tr');
    cell(tr, l.ladder);
    cell(tr, format(l.calls));
    cell(tr, format(l.failed) + ' · ' + (l.calls ? ((l.failed / l.calls) * 100).toFixed(1) : '0') + '%');
    cell(tr, servedN ? Math.round((freeN / servedN) * 100) + '%' : '—');
    lrows.append(tr);
  }
  if (!lrows.children.length) empty(lrows, 'За окно вызовов нет', 4);
}
function render(snapshots, keys, users = []) {
  renderUserChoices(users);
  const select = $('usage-key');
  const remembered = selectedKey;
  select.replaceChildren(make('option','', 'Все ключи'));
  select.firstChild.value = '';
  for (const key of keys) { const option = make('option','', key.label + ' · ' + key.user_id + ' · ' + key.key_id); option.value = key.key_id; select.append(option); }
  if (!Array.from(select.options).some(option => option.value === remembered)) selectedKey = '';
  select.value = selectedKey;
  $('summary').replaceChildren();
  for (const snapshot of snapshots) {
    const rows = snapshot.rows || [];
    const sum = (tier, field) => rows.filter(row => row.tier === tier).reduce((n,row) => n + (Number(row[field]) || 0), 0);
    const section = make('section','metric');
    const head = make('div','metric-head'); head.append(make('strong','',snapshot.label), make('span','',format(sum('free','calls') + sum('paid','calls')) + ' вызовов')); section.append(head);
    const total = make('div','metric-total',format(sum('free','tokens_in') + sum('free','tokens_out') + sum('paid','tokens_in') + sum('paid','tokens_out')) + ' '); total.append(make('small','','токенов')); section.append(total);
    const grid = make('div','metric-grid');
    for (const [name,tier] of [['Бесплатные','free'],['Платные','paid']]) { const line = make('span'); line.append(make('span','',name),make('b','',format(sum(tier,'calls')))); grid.append(line); }
    for (const [name,field] of [['Успешно','successful'],['Ошибки','failed']]) { const line = make('span'); line.append(make('span','',name),make('b','',format(sum('free',field) + sum('paid',field)))); grid.append(line); }
    section.append(grid);
    section.append(make('div','metric-foot','Бесплатно: ' + format(sum('free','tokens_in') + sum('free','tokens_out')) + ' токенов · Платно: ' + format(sum('paid','tokens_in') + sum('paid','tokens_out')) + ' токенов'));
    $('summary').append(section);
  }
  const rows = (snapshots.find(snapshot => snapshot.period === '24h') || { rows: [] }).rows || [];
  $('row-count').textContent = format(rows.length) + ' строк'; $('usage-rows').replaceChildren();
  for (const r of rows) { const tr = document.createElement('tr'); const key = cell(tr,''); key.append(make('strong','',r.key_label || 'Общий ключ'),make('small','',(r.user_id || 'Без пользователя') + (r.key_id ? ' · ' + r.key_id : ''))); cell(tr,r.app || 'Без метки'); cell(tr,r.model || 'Неизвестна','model'); const tier = cell(tr,''); tier.append(make('span','pill ' + r.tier,r.tier === 'free' ? 'Бесплатно' : r.tier === 'paid' ? 'Платно' : '—')); cell(tr,format(r.calls)); cell(tr,format(r.successful) + ' / ' + format(r.failed)); const usageCell = cell(tr,format(r.tokens_in) + ' / ' + format(r.tokens_cached) + ' / ' + format(r.tokens_out)); if (r.no_usage) usageCell.append(make('small','',r.no_usage + ' без usage')); cell(tr,money(r.cost_usd)); $('usage-rows').append(tr); }
  if (!rows.length) { const tr = document.createElement('tr'); const td = cell(tr,'За этот период вызовов нет','empty'); td.colSpan = 8; $('usage-rows').append(tr); }
  $('key-count').textContent = format(keys.length) + ' ключей'; $('key-rows').replaceChildren();
  for (const k of keys) { const tr = document.createElement('tr'); const name = cell(tr,''); name.append(make('strong','',k.label),make('small','',k.key_id)); const user = cell(tr,k.user_id); user.append(make('small','',k.email)); const status = cell(tr,''); status.append(make('span','pill ' + k.status,k.revoked_at ? 'Отозван' : k.status === 'active' ? 'Активен' : 'Пауза')); cell(tr,date(k.last_used_at)); cell(tr,date(k.created_at)); const actions = cell(tr,''); if (!k.revoked_at) { for (const [action,label] of [[k.status === 'active' ? 'suspend' : 'resume',k.status === 'active' ? 'Приостановить' : 'Включить'],['revoke','Отозвать']]) { const b = make('button','action' + (action === 'revoke' ? ' danger' : ''),label); b.addEventListener('click',async () => { if (action === 'revoke' && !confirm('Отозвать ключ «' + k.label + '» навсегда?')) return; try { await request('/admin/api/keys/' + k.key_id + '/' + action,{method:'POST'}); await load(); } catch(e) { error('Не удалось изменить статус ключа: ' + e.message); } }); actions.append(b); } } $('key-rows').append(tr); }
  if (!keys.length) { const tr = document.createElement('tr'); const td = cell(tr,'Ключей пока нет','empty'); td.colSpan = 6; $('key-rows').append(tr); }
}
$('usage-key').addEventListener('change', e => { selectedKey = e.target.value; load(); });
const issueEmail = document.createElement('label'); issueEmail.textContent = 'Email нового пользователя'; const issueEmailInput = document.createElement('input'); issueEmailInput.name = 'email'; issueEmailInput.type = 'email'; issueEmailInput.placeholder = 'нужен только при первом ключе'; issueEmail.append(issueEmailInput); $('issue-form').insertBefore(issueEmail, $('issue-form').querySelector('label:nth-child(2)'));
$('refresh').addEventListener('click',load);
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
// The form element is passed in and captured before the first await: event.currentTarget is
// null once the browser finishes dispatching, so reading it after an await throws.
async function submitCredentialForm(form) {
  const data = new FormData(form);
  const provider = form.dataset.provider;
  try {
    await request('/admin/api/provider-credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, label: String(data.get('label') || '').trim(), token: String(data.get('token') || '').trim() }) });
    form.reset();
    error('');
    await loadCredentials();
  } catch (err) { error('Не удалось добавить токен: ' + err.message); }
}
async function submitIssueForm(form) {
  const data = new FormData(form);
  try {
    const issued = await request('/admin/api/issue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_id:data.get('user_id'),email:data.get('email'),label:data.get('label')})});
    $('key-value').textContent = issued.token; $('new-key').showModal(); form.reset(); await load();
  } catch (err) { error('Не удалось создать ключ: ' + err.message); }
}
for (const form of document.querySelectorAll('.cred-form')) form.addEventListener('submit', e => { e.preventDefault(); submitCredentialForm(form); });
$('issue-form').addEventListener('submit', e => { e.preventDefault(); submitIssueForm(e.currentTarget); });
$('copy-key').addEventListener('click',() => navigator.clipboard.writeText($('key-value').textContent));
$('close-key').addEventListener('click',() => { $('new-key').close(); $('key-value').textContent = ''; });
showTab('usage');
load();`;

export const adminUi = {
  async fetch(request, apiFetch) {
    const url = new URL(request.url);
    const path = url.pathname.slice('/admin'.length) || '/';
    const callLadder = (target, token, method, body) => ladder(request, apiFetch, target, token, method, body);
    if (request.method === 'GET' && path === '/') return new Response(PAGE, { headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    if (request.method === 'GET' && path === '/style.css') return new Response(CSS, { headers: { ...NO_STORE, 'content-type': 'text/css; charset=utf-8' } });
    if (request.method === 'GET' && path === '/app.js') return new Response(APP, { headers: { ...NO_STORE, 'content-type': 'text/javascript; charset=utf-8' } });
    if (request.method === 'POST' && path === '/connect') {
      if (!sameOrigin(request)) return text('Неверный источник', 403);
      const body = await request.formData().catch(() => null);
      const token = String(body?.get('key') || '').trim();
      if (!token || token.length > 256) return redirect('/admin?error=invalid');
      const check = await callLadder('/v1/admin/keys', token);
      if (check.status !== 200) return redirect('/admin?error=access');
      return redirect('/admin', COOKIE + '=' + encodeURIComponent(token) + '; Path=/admin; HttpOnly; Secure; SameSite=Strict');
    }
    if (request.method === 'POST' && path === '/disconnect') {
      if (!sameOrigin(request)) return text('Неверный источник', 403);
      return redirect('/admin', COOKIE + '=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    }
    if (path.startsWith('/api/')) {
      const token = cookie(request);
      if (!token) return json({ error: 'Подключите ключ администратора' }, 401);
      if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'Неверный источник' }, 403);
      if (request.method === 'GET' && path === '/api/analytics') {
        const hours = Math.min(168, Math.max(1, Math.floor(Number(url.searchParams.get('hours')) || 24)));
        return callLadder('/v1/analytics?hours=' + hours, token);
      }
      if (request.method === 'GET' && path === '/api/usage') {
        const period = url.searchParams.get('period') || '1h';
        const keyId = url.searchParams.get('key_id');
        if (!PERIODS.has(period) || (keyId !== null && !/^[0-9a-f]{16}$/.test(keyId))) return json({ error: 'Неверный фильтр' }, 400);
        return callLadder('/v1/admin/key-usage?period=' + period + (keyId ? '&key_id=' + keyId : ''), token);
      }
      if (request.method === 'GET' && path === '/api/keys') return callLadder('/v1/admin/keys', token);
      if (request.method === 'GET' && path === '/api/users') return callLadder('/v1/admin/users', token);
      if (request.method === 'GET' && path === '/api/provider-credentials') return callLadder('/v1/admin/provider-credentials', token);
      if (request.method === 'POST' && path === '/api/provider-credentials') {
        const body = await request.json().catch(() => null);
        const provider = String(body?.provider || '');
        const label = String(body?.label || '').trim();
        const token2 = String(body?.token || '').trim();
        if (!provider || !label || label.length > 80 || !token2 || token2.length > 512) {
          return json({ error: 'Неверные данные токена' }, 400);
        }
        return callLadder('/v1/admin/provider-credentials', token, 'POST', { provider, label, token: token2 });
      }
      const credential = /^\/api\/provider-credentials\/([0-9]{1,18})\/disable$/.exec(path);
      if (request.method === 'POST' && credential) return callLadder('/v1/admin/provider-credentials/' + credential[1] + '/disable', token, 'POST');
      const status = /^\/api\/keys\/([0-9a-f]{16})\/(suspend|resume|revoke)$/.exec(path);
      if (request.method === 'POST' && status && ACTIONS.has(status[2])) return callLadder('/v1/admin/keys/' + status[1] + '/' + status[2], token, 'POST');
      if (request.method === 'POST' && path === '/api/issue') {
        const body = await request.json().catch(() => null);
        const userId = String(body?.user_id || '');
        const email = String(body?.email || '').trim();
        const label = String(body?.label || '').trim();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId) || !label || label.length > 80) return json({ error: 'Неверные данные ключа' }, 400);
        const issued = await callLadder('/v1/admin/users/' + userId + '/keys', token, 'POST', { label });
        if (issued.status !== 404) return issued;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
          return json({ error: 'Пользователь не найден. Укажите email, чтобы создать аккаунт и первый ключ.' }, 400);
        }
        return callLadder('/v1/admin/users', token, 'POST', { user_id: userId, email, label });
      }
    }
    return text('Не найдено', 404);
  },
};
