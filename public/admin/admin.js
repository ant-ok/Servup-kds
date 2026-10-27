'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v) => Number(v ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const dur = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const dt = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.add('hidden'), 3000);
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

// ---- login -------------------------------------------------------------------
function showLogin() { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); }
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
  if (!res.ok) { $('loginError').textContent = 'Неверный пароль'; return; }
  $('login').classList.add('hidden');
  boot();
};
$('logout').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); showLogin(); };

// ---- tabs --------------------------------------------------------------------
let tab = 'reports';
for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  };
}
const views = {};
const render = run(() => views[tab]());

// ---- period picker shared by reports -----------------------------------------
// Business day: before 06:00 still counts as the previous day.
const bizToday = () => { const d = new Date(Date.now() - 6 * 3600e3); return d.toLocaleDateString('sv-SE'); };
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toLocaleDateString('sv-SE'); };
const period = { from: bizToday(), to: bizToday(), employee: '' };
function periodBar(onChange) {
  const el = document.createElement('div');
  el.className = 'toolbar';
  el.innerHTML = `
    <input type="date" id="pFrom" value="${period.from}"> — <input type="date" id="pTo" value="${period.to}">
    <button class="light small" data-p="0">Сегодня</button><button class="light small" data-p="1">Вчера</button>
    <button class="light small" data-p="7">7 дней</button><button class="light small" data-p="month">Этот месяц</button>
    <button class="light small" data-p="prevmonth">Прошлый месяц</button>`;
  el.querySelector('#pFrom').onchange = (e) => { period.from = e.target.value; onChange(); };
  el.querySelector('#pTo').onchange = (e) => { period.to = e.target.value; onChange(); };
  for (const b of el.querySelectorAll('[data-p]')) {
    b.onclick = () => {
      const t = bizToday(); const p = b.dataset.p;
      if (p === '0') { period.from = period.to = t; }
      else if (p === '1') { period.from = period.to = shift(t, -1); }
      else if (p === '7') { period.from = shift(t, -6); period.to = t; }
      else if (p === 'month') { period.from = `${t.slice(0, 8)}01`; period.to = t; }
      else { const first = `${t.slice(0, 8)}01`; period.to = shift(first, -1); period.from = `${period.to.slice(0, 8)}01`; }
      onChange();
    };
  }
  return el;
}
const qs = (extra = {}) => new URLSearchParams({ from: period.from, to: period.to, ...extra }).toString();

function table(cols, rows, { onRow, foot } = {}) {
  const head = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.title}</th>`).join('');
  const body = rows.map((r, i) => `<tr data-i="${i}" class="${onRow ? 'click' : ''}">${cols.map((c) =>
    `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key])}</td>`).join('')}</tr>`).join('');
  const footer = foot ? `<tfoot><tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${esc(foot[c.key] ?? '')}</td>`).join('')}</tr></tfoot>` : '';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.innerHTML = rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footer}</table>` : '<p class="muted">Нет данных за период</p>';
  if (onRow) wrap.querySelectorAll('tbody tr').forEach((tr) => { tr.onclick = () => onRow(rows[tr.dataset.i]); });
  return wrap;
}
function card(title, actionsHtml = '') {
  const c = document.createElement('section');
  c.className = 'card';
  c.innerHTML = `<h2><span>${title}</span><span>${actionsHtml}</span></h2>`;
  return c;
}
const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
const csvLink = (kind, extra) => `<a href="/api/admin/reports/${kind}?${qs({ ...extra, format: 'csv' })}"><button class="light small">Скачать Excel (CSV)</button></a>`;

// ---- reports -----------------------------------------------------------------
views.reports = async () => {
  const view = $('view');
  view.innerHTML = '';
  view.appendChild(periodBar(render));
  const [bart, sell, prods] = await Promise.all([
    api(`/reports/bartenders?${qs()}`), api(`/reports/sellers?${qs()}`), api(`/reports/products?${qs()}`),
  ]);

  const c1 = card('Бармены — кто приготовил', csvLink('bartenders'));
  c1.appendChild(table([
    { key: 'name', title: 'Бармен' },
    { key: 'portions', title: 'Порций', num: true },
    { key: 'earned', title: 'Начислено, ₽', num: true, fmt: money },
    { key: 'checks', title: 'Чеков', num: true },
    { key: 'avg_make_sec', title: 'Ср. приготовление', num: true, fmt: dur },
    { key: 'avg_total_sec', title: 'Ср. ожидание гостя', num: true, fmt: dur },
    { key: 'without_rate', title: 'Без ставки', num: true },
    { key: 'made_then_removed', title: 'Сделано→удалено', num: true },
  ], bart, {
    onRow: (r) => { period.employee = r.id; showDetails(r.name); },
    foot: { name: 'Итого', portions: sum(bart, 'portions'), earned: money(sum(bart, 'earned')), checks: '' },
  }));
  if (bart.some((r) => Number(r.without_rate) > 0)) {
    c1.insertAdjacentHTML('beforeend', '<p class="muted">Есть порции без ставки — задайте ставки во вкладке «Ставки». Новые ставки действуют только на будущие порции.</p>');
  }
  view.appendChild(c1);

  const c2 = card('Продажи — кто пробил и продал', csvLink('sellers'));
  c2.appendChild(table([
    { key: 'name', title: 'Сотрудник' },
    { key: 'checks', title: 'Закрыто чеков', num: true },
    { key: 'payed', title: 'Оплачено, ₽', num: true, fmt: money },
    { key: 'avg_check', title: 'Средний чек, ₽', num: true, fmt: money },
    { key: 'bar_portions', title: 'Барных порций', num: true },
  ], sell, { foot: { name: 'Итого', checks: sum(sell, 'checks'), payed: money(sum(sell, 'payed')), bar_portions: sum(sell, 'bar_portions') } }));
  c2.insertAdjacentHTML('beforeend', '<p class="muted">Данные из закрытых чеков Poster. Для прошлых периодов до запуска KDS загрузите историю во вкладке «Состояние».</p>');
  view.appendChild(c2);

  const c3 = card('Позиции', csvLink('products'));
  c3.appendChild(table([
    { key: 'name', title: 'Позиция' }, { key: 'portions', title: 'Порций', num: true },
    { key: 'avg_total_sec', title: 'Ср. время', num: true, fmt: dur }, { key: 'rate', title: 'Ставка', num: true, fmt: money },
  ], prods));
  view.appendChild(c3);

  const c4 = card('Все порции', csvLink('details'));
  c4.querySelector('h2 span').innerHTML = 'Все порции <button class="light small" id="loadDetails">Показать</button>';
  view.appendChild(c4);
  c4.querySelector('#loadDetails').onclick = () => { period.employee = ''; showDetails(); };
};

let employeesCache = [];
async function showDetails(name) {
  const rows = await api(`/reports/details?${qs(period.employee ? { employee_id: period.employee } : {})}`);
  employeesCache = await api('/employees');
  const view = $('view');
  view.innerHTML = '';
  view.appendChild(periodBar(() => showDetails(name)));
  const c = card(`Порции${name ? ` — ${esc(name)}` : ''}`,
    `<button class="light small" id="back">← К отчётам</button> ${csvLink('details', period.employee ? { employee_id: period.employee } : {})}`);
  const statusText = (r) => (r.status === 'cancelled' ? (r.made_then_removed ? 'сделано→удалено' : 'отменено') : r.status === 'ready' ? 'готово' : 'в работе');
  c.appendChild(table([
    { key: 'created_at', title: 'Заказ', fmt: dt }, { key: 'table_name', title: 'Стол' }, { key: 'check_id', title: 'Чек' },
    { key: 'name', title: 'Позиция', fmt: (v, r) => (r.modifiers ? `${v} (${r.modifiers})` : v) },
    { key: 'sold_by', title: 'Продал' }, { key: 'taken_by', title: 'Взял' }, { key: 'made_by', title: 'Сделал' },
    { key: 'total_sec', title: 'Время', num: true, fmt: dur }, { key: 'rate', title: 'Ставка', num: true, fmt: (v) => (v == null ? '—' : money(v)) },
    { key: 'status', title: 'Статус', fmt: (v, r) => statusText(r) },
    { key: 'id', title: '', html: (r) => (r.made_by ? `<button class="light small" data-fix="${r.id}">Исправить</button>` : '') },
  ], rows));
  view.appendChild(c);
  c.querySelector('#back').onclick = () => { period.employee = ''; render(); };
  c.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); fixUnit(Number(b.dataset.fix), () => showDetails(name)); }; });
}

const fixUnit = run(async (unitId, done) => {
  const list = employeesCache.filter((e) => e.is_bartender && e.active);
  const choice = prompt(`Кто на самом деле приготовил? Введите номер:\n${list.map((e, i) => `${i + 1}. ${e.name}`).join('\n')}`);
  const emp = list[Number(choice) - 1];
  if (!emp) return;
  const reason = prompt('Причина исправления (попадёт в журнал):');
  if (!reason) return;
  await api(`/units/${unitId}/reassign`, { method: 'POST', body: { employee_id: emp.id, reason } });
  toast('Исправлено, запись добавлена в журнал');
  done();
});

// ---- anomalies -----------------------------------------------------------------
views.anomalies = async () => {
  const view = $('view');
  view.innerHTML = '';
  view.appendChild(periodBar(render));
  const a = await api(`/reports/anomalies?${qs()}`);
  const c1 = card(`Приготовлено, но удалено из чека — ${a.removed.length}`);
  c1.insertAdjacentHTML('beforeend', '<p class="muted">Напиток сделан, а потом позицию убрали из чека. Частая причина потерь: проверьте каждый случай.</p>');
  c1.appendChild(table([
    { key: 'ready_at', title: 'Сделано', fmt: dt }, { key: 'cancelled_at', title: 'Удалено', fmt: dt }, { key: 'name', title: 'Позиция' },
    { key: 'made_by', title: 'Сделал' }, { key: 'sold_by', title: 'Официант' }, { key: 'table_name', title: 'Стол' }, { key: 'check_id', title: 'Чек' },
  ], a.removed));
  view.appendChild(c1);
  const c2 = card(`Висят больше 30 минут — ${a.unfinished.length}`);
  c2.appendChild(table([
    { key: 'created_at', title: 'Заказано', fmt: dt }, { key: 'name', title: 'Позиция' }, { key: 'taken_by', title: 'Взял' },
    { key: 'table_name', title: 'Стол' }, { key: 'check_id', title: 'Чек' },
  ], a.unfinished));
  view.appendChild(c2);
  const c3 = card(`Перехваты — ${a.intercepted.length}`);
  c3.insertAdjacentHTML('beforeend', '<p class="muted">Позицию взял один бармен, а готовой отметил другой.</p>');
  c3.appendChild(table([
    { key: 'at', title: 'Когда', fmt: dt }, { key: 'name', title: 'Позиция' }, { key: 'from_name', title: 'Взял' }, { key: 'by_name', title: 'Отметил' },
  ], a.intercepted));
  view.appendChild(c3);
  const c4 = card(`Ручные исправления — ${a.corrections.length}`);
  c4.appendChild(table([
    { key: 'at', title: 'Когда', fmt: dt }, { key: 'unit_id', title: 'Порция' }, { key: 'details', title: 'Причина', fmt: (v) => v?.reason },
  ], a.corrections));
  view.appendChild(c4);
};

// ---- employees -------------------------------------------------------------------
views.employees = async () => {
  const list = await api('/employees');
  const view = $('view');
  view.innerHTML = '';
  const c = card('Сотрудники', '<button class="small" id="addEmp">+ Бармен вне Poster</button>');
  c.insertAdjacentHTML('beforeend', '<p class="muted">Сотрудники подтягиваются из Poster. Отметьте барменов и выдайте каждому PIN для входа на экране KDS.</p>');
  c.appendChild(table([
    { key: 'name', title: 'Имя' }, { key: 'role_name', title: 'Роль в Poster', fmt: (v, r) => v ?? (r.poster_user_id ? '' : 'добавлен вручную') },
    { key: 'is_bartender', title: 'Бармен', html: (r) => `<input type="checkbox" data-bt="${r.id}" ${r.is_bartender ? 'checked' : ''}>` },
    { key: 'has_pin', title: 'PIN', html: (r) => `${r.has_pin ? '<span class="pill ok">задан</span>' : '<span class="pill">нет</span>'} <button class="light small" data-pin="${r.id}">Задать</button>` },
    { key: 'active', title: 'Активен', html: (r) => `<input type="checkbox" data-act="${r.id}" ${r.active ? 'checked' : ''}>` },
  ], list));
  view.appendChild(c);
  c.querySelector('#addEmp').onclick = run(async () => {
    const name = prompt('Имя бармена');
    if (name) { await api('/employees', { method: 'POST', body: { name } }); render(); }
  });
  c.querySelectorAll('[data-bt]').forEach((el) => { el.onchange = run(() => api(`/employees/${el.dataset.bt}`, { method: 'PATCH', body: { is_bartender: el.checked } })); });
  c.querySelectorAll('[data-act]').forEach((el) => { el.onchange = run(() => api(`/employees/${el.dataset.act}`, { method: 'PATCH', body: { active: el.checked } })); });
  c.querySelectorAll('[data-pin]').forEach((el) => {
    el.onclick = run(async () => {
      const pin = prompt('Новый PIN (4–8 цифр). Пусто — удалить PIN.');
      if (pin === null) return;
      await api(`/employees/${el.dataset.pin}`, { method: 'PATCH', body: { pin } });
      toast('PIN сохранён');
      render();
    });
  });
};

// ---- rates --------------------------------------------------------------------------
views.rates = async () => {
  const list = await api('/products');
  const view = $('view');
  view.innerHTML = '';
  const c = card('Сдельные ставки за приготовление');
  c.insertAdjacentHTML('beforeend', '<p class="muted">Сколько получает бармен за одну приготовленную порцию. Ставка фиксируется в момент отметки «готово»: если её изменить, прошлые начисления не пересчитаются.</p>');
  c.appendChild(table([
    { key: 'category_name', title: 'Категория' }, { key: 'name', title: 'Позиция' }, { key: 'workshop_name', title: 'Цех' },
    { key: 'rate', title: 'Ставка, ₽', html: (r) => `<input type="number" min="0" step="1" style="width:100px" data-rate="${r.id}" value="${r.rate ?? ''}" placeholder="—">` },
  ], list));
  view.appendChild(c);
  c.querySelectorAll('[data-rate]').forEach((el) => {
    el.onchange = run(async () => { await api(`/rates/${el.dataset.rate}`, { method: 'PUT', body: { rate: Number(el.value || 0) } }); toast('Ставка сохранена'); });
  });
};

// ---- devices ---------------------------------------------------------------------------
views.devices = async () => {
  const list = await api('/devices');
  const view = $('view');
  view.innerHTML = '';
  const c = card('Экраны KDS', '<button class="small" id="addDev">+ Подключить экран</button>');
  c.insertAdjacentHTML('beforeend', '<div id="newDev"></div>');
  c.appendChild(table([
    { key: 'name', title: 'Название' }, { key: 'last_seen_at', title: 'Последняя связь', fmt: dt },
    { key: 'active', title: '', html: (r) => (r.active ? `<button class="danger small" data-off="${r.id}">Отключить</button>` : '<span class="pill">отключён</span>') },
  ], list));
  view.appendChild(c);
  c.querySelector('#addDev').onclick = run(async () => {
    const name = prompt('Название экрана', 'Бар — планшет 1');
    if (!name) return;
    const d = await api('/devices', { method: 'POST', body: { name } });
    const link = `${location.origin}/kds/#pair=${d.token}`;
    c.querySelector('#newDev').innerHTML = `<p>Откройте эту ссылку <b>на самом устройстве</b> (один раз, ссылка больше не покажется):</p>
      <p><code>${esc(link)}</code> <button class="light small" id="copy">Копировать</button></p>`;
    c.querySelector('#copy').onclick = () => navigator.clipboard?.writeText(link).then(() => toast('Скопировано'));
  });
  c.querySelectorAll('[data-off]').forEach((b) => {
    b.onclick = run(async () => { if (confirm('Отключить экран?')) { await api(`/devices/${b.dataset.off}`, { method: 'DELETE' }); render(); } });
  });
};

// ---- settings ------------------------------------------------------------------------------
views.settings = async () => {
  const [s, workshops] = await Promise.all([api('/settings'), api('/workshops')]);
  const view = $('view');
  view.innerHTML = '';
  const c = card('Настройки');
  const selected = new Set((s.bar_workshop_ids ?? []).map(Number));
  c.insertAdjacentHTML('beforeend', `
    <div class="grid2">
      <div><b>Цеха, которые идут на бар-KDS</b><br>
        ${workshops.map((w) => `<label class="inline"><input type="checkbox" data-ws="${w.poster_workshop_id}" ${selected.has(w.poster_workshop_id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('') || '<span class="muted">Цеха ещё не загружены из Poster</span>'}
        <p class="muted">Если ничего не выбрано, на экран идут все позиции.</p></div>
      <div class="kv">
        <span>Жёлтый через, мин</span><input type="number" id="warn" value="${s.warn_minutes}">
        <span>Красный через, мин</span><input type="number" id="crit" value="${s.critical_minutes}">
        <span>Готовые видны, сек</span><input type="number" id="vis" value="${s.ready_visible_seconds}">
        <span>Начало рабочего дня, час</span><input type="number" id="dsh" min="0" max="12" value="${s.day_start_hour}">
      </div>
    </div>
    <p><label class="inline"><input type="checkbox" id="credit" ${s.credit_made_then_removed !== false ? 'checked' : ''}>
      Начислять бармену, если напиток сделан, а потом удалён из чека</label></p>
    <button id="save">Сохранить</button>`);
  view.appendChild(c);
  c.querySelector('#save').onclick = run(async () => {
    await api('/settings', { method: 'PUT', body: {
      bar_workshop_ids: [...c.querySelectorAll('[data-ws]:checked')].map((el) => Number(el.dataset.ws)),
      warn_minutes: Number(c.querySelector('#warn').value), critical_minutes: Number(c.querySelector('#crit').value),
      ready_visible_seconds: Number(c.querySelector('#vis').value), day_start_hour: Number(c.querySelector('#dsh').value),
      credit_made_then_removed: c.querySelector('#credit').checked,
    } });
    toast('Сохранено');
    checkBanner();
  });
};

// ---- status -----------------------------------------------------------------------------------
views.status = async () => {
  const [st, hooks, auditRows] = await Promise.all([api('/status'), api('/webhooks'), api('/audit')]);
  const h = st.health;
  const view = $('view');
  view.innerHTML = '';
  const c = card('Связь с Poster', '<button class="light small" id="syncCat">Обновить меню и сотрудников</button>');
  c.insertAdjacentHTML('beforeend', `<div class="kv">
    <span>Состояние</span><span>${h.ok ? '<span class="pill ok">работает</span>' : '<span class="pill bad">проблема</span>'}</span>
    <span>Опрос открытых чеков</span><span>${dt(h.lastPollOkAt)}</span>
    <span>Полная сверка</span><span>${dt(h.lastFullOkAt)}</span>
    <span>Меню и сотрудники</span><span>${dt(h.lastCatalogAt)}</span>
    <span>Последний вебхук</span><span>${dt(h.lastWebhookAt)} (за сутки: ${st.counts.webhooks_24h}, без подписи: ${st.counts.webhooks_unverified_24h})</span>
    <span>Последняя ошибка</span><span>${h.lastError ? `${esc(h.lastError)} — ${dt(h.lastErrorAt)}` : '—'}</span>
    <span>Товаров в меню</span><span>${st.counts.products}</span>
    <span>Открытых порций</span><span>${st.counts.open_units}</span></div>
    <p class="muted">Адрес для вебхуков в Poster: <code>${location.origin}/webhooks/poster</code></p>`);
  view.appendChild(c);
  c.querySelector('#syncCat').onclick = run(async () => { await api('/sync/catalog', { method: 'POST' }); toast('Обновлено'); render(); });

  const b = card('Загрузить историю продаж из Poster');
  b.insertAdjacentHTML('beforeend', `<p class="muted">Подтягивает закрытые чеки за прошлые дни для отчёта «Продажи». На экран бара они не попадают.</p>
    <div class="toolbar"><input type="date" id="bfFrom"> — <input type="date" id="bfTo"><button id="bfGo">Загрузить</button></div>`);
  view.appendChild(b);
  b.querySelector('#bfGo').onclick = run(async () => {
    const r = await api('/sync/backfill', { method: 'POST', body: { from: b.querySelector('#bfFrom').value, to: b.querySelector('#bfTo').value } });
    toast(`Загружено чеков: ${r.checks}`);
  });

  const a = card('Журнал действий (последние 300)');
  a.appendChild(table([
    { key: 'at', title: 'Когда', fmt: dt }, { key: 'actor', title: 'Кто' }, { key: 'employee_name', title: 'Сотрудник' },
    { key: 'action', title: 'Действие' }, { key: 'unit_name', title: 'Позиция' }, { key: 'transaction_id', title: 'Чек' },
    { key: 'device_name', title: 'Экран' },
  ], auditRows));
  view.appendChild(a);

  const w = card('Последние вебхуки от Poster');
  w.appendChild(table([
    { key: 'received_at', title: 'Когда', fmt: dt }, { key: 'verified', title: 'Подпись', html: (r) => (r.verified ? '<span class="pill ok">ok</span>' : '<span class="pill bad">нет</span>') },
    { key: 'payload', title: 'Данные', fmt: (v) => JSON.stringify(v).slice(0, 160) },
  ], hooks));
  view.appendChild(w);
};

// ---- warnings banner -----------------------------------------------------------------------------
async function checkBanner() {
  const st = await api('/status');
  const msgs = [];
  if (!st.posterConfigured) msgs.push('Не задан POSTER_TOKEN: заказы из Poster не поступают.');
  else if (!st.health.ok) msgs.push(`Нет связи с Poster${st.health.lastError ? `: ${st.health.lastError}` : ''}.`);
  if (!st.barWorkshops?.length) msgs.push('Не выбран цех бара: на экран идут все позиции, включая кухню (Настройки).');
  if (Number(st.counts.bartenders) === 0) msgs.push('Нет ни одного бармена: отметьте их во вкладке «Сотрудники».');
  if (Number(st.counts.bartenders_without_pin) > 0) msgs.push(`Барменов без PIN: ${st.counts.bartenders_without_pin}.`);
  $('banner').innerHTML = msgs.map(esc).join('<br>');
  $('banner').classList.toggle('hidden', !msgs.length);
  $('banner').classList.toggle('bad', !st.health.ok);
}

async function boot() {
  try { await checkBanner(); } catch { return; }
  $('app').classList.remove('hidden');
  render();
  setInterval(() => checkBanner().catch(() => {}), 30000);
}
boot();
