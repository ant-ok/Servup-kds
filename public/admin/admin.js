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
function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  fetch('/api/admin/oauth').then((r) => r.json()).then((o) => $('posterLogin').classList.toggle('hidden', !o.enabled)).catch(() => {});
}
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: $('account').value, password: $('password').value }) });
  if (!res.ok) { $('loginError').textContent = 'Неверное заведение или пароль'; return; }
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
const period = { from: bizToday(), to: bizToday(), employee: '', station: '' };
let stationsCache = [];
const prepStations = () => stationsCache.filter((s) => s.kind === 'prep');
function periodBar(onChange) {
  const el = document.createElement('div');
  el.className = 'toolbar';
  el.innerHTML = `
    <input type="date" id="pFrom" value="${period.from}"> — <input type="date" id="pTo" value="${period.to}">
    <button class="light small" data-p="0">Сегодня</button><button class="light small" data-p="1">Вчера</button>
    <button class="light small" data-p="7">7 дней</button><button class="light small" data-p="month">Этот месяц</button>
    <button class="light small" data-p="prevmonth">Прошлый месяц</button>
    ${prepStations().length > 1 ? `<select id="pStation"><option value="">Все станции</option>${prepStations().map((st) =>
      `<option value="${st.id}" ${String(st.id) === String(period.station) ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select>` : ''}`;
  el.querySelector('#pStation')?.addEventListener('change', (e) => { period.station = e.target.value; onChange(); });
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
const qs = (extra = {}) => new URLSearchParams({ from: period.from, to: period.to, ...(period.station ? { station_id: period.station } : {}), ...extra }).toString();

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
  const [bart, sell, prods, stats, runs] = await Promise.all([
    api(`/reports/makers?${qs()}`), api(`/reports/sellers?${qs()}`), api(`/reports/products?${qs()}`),
    api(`/reports/stations?${qs()}`), api(`/reports/runners?${qs()}`),
  ]);

  const c1 = card('Кто приготовил', csvLink('makers'));
  c1.appendChild(table([
    { key: 'name', title: 'Сотрудник' },
    ...(prepStations().length > 1 ? [{ key: 'stations', title: 'Станции' }] : []),
    { key: 'portions', title: 'Порций', num: true },
    { key: 'earned', title: 'Начислено, ₽', num: true, fmt: money },
    { key: 'checks', title: 'Чеков', num: true },
    { key: 'avg_make_sec', title: 'Ср. приготовление', num: true, fmt: dur },
    { key: 'avg_total_sec', title: 'Ср. ожидание гостя', num: true, fmt: dur },
    { key: 'within_norm_pct', title: 'В норму', num: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
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

  if (stats.length > 1 || runs.length) {
    const cs = card('Станции', csvLink('stations'));
    cs.appendChild(table([
      { key: 'name', title: 'Станция' }, { key: 'portions', title: 'Порций', num: true },
      { key: 'avg_total_sec', title: 'Ср. время', num: true, fmt: dur }, { key: 'p90_total_sec', title: '90% быстрее', num: true, fmt: dur },
      { key: 'earned', title: 'Начислено, ₽', num: true, fmt: money }, { key: 'people', title: 'Сотрудников', num: true },
    ], stats));
    view.appendChild(cs);
  }
  if (runs.length) {
    const cr = card('Раздача — кто отдал заказы', csvLink('runners'));
    cr.appendChild(table([
      { key: 'name', title: 'Сотрудник' }, { key: 'tickets', title: 'Отдано заказов', num: true },
      { key: 'avg_wait_sec', title: 'Ср. ожидание на раздаче', num: true, fmt: dur },
      { key: 'avg_total_sec', title: 'Ср. от заказа до выдачи', num: true, fmt: dur },
    ], runs));
    view.appendChild(cr);
  }

  const c2 = card('Продажи — кто пробил и продал', csvLink('sellers'));
  c2.appendChild(table([
    { key: 'name', title: 'Сотрудник' },
    { key: 'checks', title: 'Закрыто чеков', num: true },
    { key: 'payed', title: 'Оплачено, ₽', num: true, fmt: money },
    { key: 'avg_check', title: 'Средний чек, ₽', num: true, fmt: money },
    { key: 'kds_portions', title: 'Порций через KDS', num: true },
  ], sell, { foot: { name: 'Итого', checks: sum(sell, 'checks'), payed: money(sum(sell, 'payed')), kds_portions: sum(sell, 'kds_portions') } }));
  c2.insertAdjacentHTML('beforeend', '<p class="muted">Данные из закрытых чеков Poster. Для прошлых периодов до запуска KDS загрузите историю во вкладке «Состояние».</p>');
  view.appendChild(c2);

  const c3 = card('Позиции', csvLink('products'));
  c3.appendChild(table([
    { key: 'name', title: 'Позиция' }, { key: 'station', title: 'Станция' }, { key: 'portions', title: 'Порций', num: true },
    { key: 'avg_make_sec', title: 'Ср. приготовление', num: true, fmt: dur }, { key: 'norm_sec', title: 'Норма', num: true, fmt: dur },
    { key: 'within_norm_pct', title: 'В норму', num: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
    { key: 'rate', title: 'Ставка', num: true, fmt: money },
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
    { key: 'station', title: 'Станция' }, { key: 'sold_by', title: 'Продал' }, { key: 'taken_by', title: 'Взял' },
    { key: 'made_by', title: 'Сделал' }, { key: 'served_by', title: 'Отдал' }, { key: 'total_sec', title: 'Время', num: true, fmt: dur }, { key: 'rate', title: 'Ставка', num: true, fmt: (v) => (v == null ? '—' : money(v)) },
    { key: 'status', title: 'Статус', fmt: (v, r) => statusText(r) },
    { key: 'id', title: '', html: (r) => (r.made_by ? `<button class="light small" data-fix="${r.id}">Исправить</button>` : '') },
  ], rows));
  view.appendChild(c);
  c.querySelector('#back').onclick = () => { period.employee = ''; render(); };
  c.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); fixUnit(Number(b.dataset.fix), () => showDetails(name)); }; });
}

const fixUnit = run(async (unitId, done) => {
  const list = employeesCache.filter((e) => e.kds_access && e.active);
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
  c1.insertAdjacentHTML('beforeend', '<p class="muted">Позицию приготовили, а потом убрали из чека. Частая причина потерь: проверьте каждый случай.</p>');
  c1.appendChild(table([
    { key: 'ready_at', title: 'Сделано', fmt: dt }, { key: 'cancelled_at', title: 'Удалено', fmt: dt }, { key: 'name', title: 'Позиция' },
    { key: 'station', title: 'Станция' },
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
  c3.insertAdjacentHTML('beforeend', '<p class="muted">Позицию взял один сотрудник, а готовой отметил другой.</p>');
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
  const c = card('Сотрудники', '<button class="small" id="addEmp">+ Сотрудник вне Poster</button>');
  c.insertAdjacentHTML('beforeend', '<p class="muted">Сотрудники подтягиваются из Poster. Отметьте тех, кто работает на экранах (повара, бармены, раздача), и выдайте каждому PIN.</p>');
  c.appendChild(table([
    { key: 'name', title: 'Имя' }, { key: 'role_name', title: 'Роль в Poster', fmt: (v, r) => v ?? (r.poster_user_id ? '' : 'добавлен вручную') },
    { key: 'kds_access', title: 'Работает на KDS', html: (r) => `<input type="checkbox" data-bt="${r.id}" ${r.kds_access ? 'checked' : ''}>` },
    { key: 'has_pin', title: 'PIN', html: (r) => `${r.has_pin ? '<span class="pill ok">задан</span>' : '<span class="pill">нет</span>'} <button class="light small" data-pin="${r.id}">Задать</button>` },
    { key: 'active', title: 'Активен', html: (r) => `<input type="checkbox" data-act="${r.id}" ${r.active ? 'checked' : ''}>` },
  ], list));
  view.appendChild(c);
  c.querySelector('#addEmp').onclick = run(async () => {
    const name = prompt('Имя сотрудника');
    if (name) { await api('/employees', { method: 'POST', body: { name } }); render(); }
  });
  c.querySelectorAll('[data-bt]').forEach((el) => { el.onchange = run(() => api(`/employees/${el.dataset.bt}`, { method: 'PATCH', body: { kds_access: el.checked } })); });
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
  const stName = new Map(stationsCache.map((st) => [st.id, st.name]));
  list.forEach((p) => { p.station_name = stName.get(p.station_id); });
  const view = $('view');
  view.innerHTML = '';
  const c = card('Позиции: ставки, нормы времени, рецептура',
    '<button class="light small" id="suggest">Заполнить нормы по факту</button>');
  c.insertAdjacentHTML('beforeend', `<p class="muted"><b>Ставка</b> — сколько получает сотрудник за порцию; фиксируется в момент отметки «готово».
    <b>Норма</b> — сколько секунд от «взял» до «готово»; на экране таймер краснеет, если дольше. «Заполнить по факту» берёт время,
    за которое делали 75% порций за последние 30 дней. <b>Техкарта</b> подтягивается из Poster; заметка — ваши подсказки по приготовлению и подаче.</p>`);
  c.appendChild(table([
    { key: 'station_name', title: 'Станция' }, { key: 'category_name', title: 'Категория' }, { key: 'name', title: 'Позиция' },
    { key: 'rate', title: 'Ставка, ₽', html: (r) => `<input type="number" min="0" step="1" style="width:90px" data-rate="${r.id}" value="${r.rate ?? ''}" placeholder="—">` },
    { key: 'norm_seconds', title: 'Норма, сек', html: (r) => `<input type="number" min="1" step="5" style="width:90px" data-norm="${r.id}" value="${r.norm_seconds ?? ''}" placeholder="—">` },
    { key: 'median_sec', title: 'Факт (медиана)', num: true, fmt: (v, r) => (v == null ? '—' : `${dur(v)} (${r.samples})`) },
    { key: 'ingredients', title: 'Техкарта', html: (r) => `<button class="light small" data-recipe="${r.id}">${r.ingredients ? `${r.ingredients} ингр.` : 'открыть'}</button>` },
    { key: 'recipe_note', title: 'Заметка', html: (r) => `<button class="light small" data-note="${r.id}" title="${esc(r.recipe_note ?? '')}">${r.recipe_note ? 'изменить' : '+ добавить'}</button>` },
  ], list));
  view.appendChild(c);
  c.querySelectorAll('[data-rate]').forEach((el) => {
    el.onchange = run(async () => { await api(`/rates/${el.dataset.rate}`, { method: 'PUT', body: { rate: Number(el.value || 0) } }); toast('Ставка сохранена'); });
  });
  c.querySelectorAll('[data-norm]').forEach((el) => {
    el.onchange = run(async () => { await api(`/products/${el.dataset.norm}/info`, { method: 'PUT', body: { norm_seconds: el.value ? Number(el.value) : null } }); toast('Норма сохранена'); });
  });
  c.querySelectorAll('[data-note]').forEach((b) => {
    b.onclick = run(async () => {
      const current = list.find((p) => String(p.id) === b.dataset.note)?.recipe_note ?? '';
      const note = prompt('Заметка к рецептуре (видна на экране по кнопке «i»)', current);
      if (note === null) return;
      await api(`/products/${b.dataset.note}/info`, { method: 'PUT', body: { recipe_note: note.trim() || null } });
      render();
    });
  });
  c.querySelectorAll('[data-recipe]').forEach((b) => {
    b.onclick = run(async () => {
      const r = await api(`/products/${b.dataset.recipe}/recipe`);
      alert(r.ingredients.length ? `${r.name}:\n${r.ingredients.map((i) => `• ${i.name} — ${i.netto} ${i.unit}`).join('\n')}` : `${r.name}: в Poster нет техкарты`);
    });
  });
  c.querySelector('#suggest').onclick = run(async () => {
    const r = await api('/products/norms/suggest', { method: 'POST', body: {} });
    toast(r.updated ? `Нормы заполнены: ${r.updated}` : 'Мало данных: нужно хотя бы 5 приготовленных порций за 30 дней');
    render();
  });
};

// ---- devices ---------------------------------------------------------------------------
views.devices = async () => {
  const list = await api('/devices');
  const view = $('view');
  view.innerHTML = '';
  const c = card('Экраны KDS', '<button class="small" id="addDev">+ Подключить экран</button>');
  const stOptions = (sel) => `<option value="">Все станции</option>${stationsCache.map((st) =>
    `<option value="${st.id}" ${st.id === sel ? 'selected' : ''}>${esc(st.name)}${st.kind === 'expo' ? ' (раздача)' : ''}</option>`).join('')}`;
  c.insertAdjacentHTML('beforeend', `<p class="muted">Новый экран будет показывать: <select id="newStation">${stOptions(stationsCache[0]?.id)}</select></p><div id="newDev"></div>`);
  c.appendChild(table([
    { key: 'name', title: 'Название' },
    { key: 'station_id', title: 'Показывает', html: (r) => `<select data-dst="${r.id}">${stOptions(r.station_id)}</select>` },
    { key: 'last_seen_at', title: 'Последняя связь', fmt: dt },
    { key: 'active', title: '', html: (r) => (r.active ? `<button class="danger small" data-off="${r.id}">Отключить</button>` : '<span class="pill">отключён</span>') },
  ], list));
  view.appendChild(c);
  c.querySelector('#addDev').onclick = run(async () => {
    const name = prompt('Название экрана', `${stationsCache[0]?.name ?? 'Экран'} — планшет`);
    if (!name) return;
    const d = await api('/devices', { method: 'POST', body: { name, station_id: c.querySelector('#newStation').value || null } });
    const link = `${location.origin}/kds/#pair=${d.token}`;
    c.querySelector('#newDev').innerHTML = `<p>Откройте эту ссылку <b>на самом устройстве</b> (один раз, ссылка больше не покажется):</p>
      <p><code>${esc(link)}</code> <button class="light small" id="copy">Копировать</button></p>`;
    c.querySelector('#copy').onclick = () => navigator.clipboard?.writeText(link).then(() => toast('Скопировано'));
  });
  c.querySelectorAll('[data-dst]').forEach((el) => {
    el.onchange = run(async () => { await api(`/devices/${el.dataset.dst}`, { method: 'PATCH', body: { station_id: el.value || null } }); toast('Сохранено'); });
  });
  c.querySelectorAll('[data-off]').forEach((b) => {
    b.onclick = run(async () => { if (confirm('Отключить экран?')) { await api(`/devices/${b.dataset.off}`, { method: 'DELETE' }); render(); } });
  });
};

// ---- settings ------------------------------------------------------------------------------
views.settings = async () => {
  const [st, acc] = await Promise.all([api('/settings'), api('/account')]);
  const view = $('view');
  view.innerHTML = '';
  const c = card('Настройки');
  c.insertAdjacentHTML('beforeend', `
    <div class="kv">
      <span>Название заведения</span><input id="accName" value="${esc(acc.name)}">
      <span>Как экран называет сотрудников</span><input id="maker" value="${esc(st.maker_title ?? 'Сотрудник')}" placeholder="Бармен / Повар / Сотрудник">
      <span>Жёлтый через, мин</span><input type="number" id="warn" value="${st.warn_minutes}">
      <span>Красный через, мин</span><input type="number" id="crit" value="${st.critical_minutes}">
      <span>Готовые видны, сек</span><input type="number" id="vis" value="${st.ready_visible_seconds}">
      <span>Начало рабочего дня, час</span><input type="number" id="dsh" min="0" max="12" value="${st.day_start_hour}">
      <span>Новый пароль админки</span><input type="password" id="pwd" placeholder="не менять" autocomplete="new-password">
    </div>
    <p><label class="inline"><input type="checkbox" id="credit" ${st.credit_made_then_removed !== false ? 'checked' : ''}>
      Начислять сотруднику, если позиция приготовлена, а потом удалена из чека</label></p>
    <p class="muted">Вход в админку: заведение <code>${esc(acc.poster_account ?? acc.id)}</code> и пароль${acc.poster_account ? ', или «Войти через Poster»' : ''}.</p>
    <button id="save">Сохранить</button>`);
  view.appendChild(c);
  c.querySelector('#save').onclick = run(async () => {
    await api('/settings', { method: 'PUT', body: {
      warn_minutes: Number(c.querySelector('#warn').value), critical_minutes: Number(c.querySelector('#crit').value),
      ready_visible_seconds: Number(c.querySelector('#vis').value), day_start_hour: Number(c.querySelector('#dsh').value),
      credit_made_then_removed: c.querySelector('#credit').checked, maker_title: c.querySelector('#maker').value.trim() || 'Сотрудник',
    } });
    const pwd = c.querySelector('#pwd').value;
    await api('/account', { method: 'PATCH', body: { name: c.querySelector('#accName').value.trim(), ...(pwd ? { password: pwd } : {}) } });
    toast('Сохранено');
    checkBanner();
  });
};

// ---- stations ------------------------------------------------------------------------------
views.stations = async () => {
  const [list, workshops] = await Promise.all([api('/stations'), api('/workshops')]);
  stationsCache = list;
  const view = $('view');
  view.innerHTML = '';
  const c = card('Станции', '<button class="small" id="addSt">+ Станция</button> <button class="light small" id="addExpo">+ Раздача</button>');
  c.insertAdjacentHTML('beforeend', `<p class="muted">Станция — место, где готовят: бар, горячий цех, холодный цех, кондитерская.
    Каждая позиция из Poster попадает на станцию по своему цеху. Если цеха не отмечены, система сопоставляет по названию
    («Кухня» ↔ «Кухня горячая»), а станция без совпадений забирает все остальные цеха.
    <b>Раздача</b> видит заказ целиком и отмечает, кто его отдал.</p>`);
  for (const stn of list) {
    const box = document.createElement('div');
    box.className = 'card';
    const routed = workshops.filter((w) => w.station_id === stn.id).map((w) => w.name);
    box.innerHTML = stn.kind === 'expo'
      ? `<h2><span>${esc(stn.name)} <span class="pill">раздача</span></span><button class="danger small" data-del="${stn.id}">Удалить</button></h2>
         <p class="muted">Показывает все заказы до отметки «Отдано».</p>`
      : `<h2><span>${esc(stn.name)}</span><span><button class="light small" data-ren="${stn.id}">Переименовать</button>
           <button class="danger small" data-del="${stn.id}">Удалить</button></span></h2>
         <div class="grid2"><div><b>Цеха Poster</b><br>${workshops.map((w) => `<label class="inline"><input type="checkbox" data-ws="${stn.id}:${w.id}"
           ${stn.workshop_ids.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('') || '<span class="muted">Цеха ещё не загружены из Poster</span>'}</div>
         <div><b>Сейчас сюда идут:</b> ${routed.length ? routed.map(esc).join(', ') : '<span class="muted">ничего</span>'}
           <p><label class="inline"><input type="checkbox" data-grp="${stn.id}" ${stn.group_items ? 'checked' : ''}>
           Группировать одинаковые позиции («Бургер ×4»)</label></p></div></div>`;
    c.appendChild(box);
  }
  view.appendChild(c);
  const add = (kind) => run(async () => {
    const name = prompt('Название', kind === 'expo' ? 'Раздача' : 'Горячий цех');
    if (name) { await api('/stations', { method: 'POST', body: { name, kind } }); render(); }
  });
  c.querySelector('#addSt').onclick = add('prep');
  c.querySelector('#addExpo').onclick = add('expo');
  c.querySelectorAll('[data-ws]').forEach((el) => {
    el.onchange = run(async () => {
      const id = Number(el.dataset.ws.split(':')[0]);
      const ids = [...c.querySelectorAll(`[data-ws^="${id}:"]:checked`)].map((x) => Number(x.dataset.ws.split(':')[1]));
      await api(`/stations/${id}`, { method: 'PATCH', body: { workshop_ids: ids } });
      render();
    });
  });
  c.querySelectorAll('[data-grp]').forEach((el) => {
    el.onchange = run(() => api(`/stations/${el.dataset.grp}`, { method: 'PATCH', body: { group_items: el.checked } }));
  });
  c.querySelectorAll('[data-ren]').forEach((b) => {
    b.onclick = run(async () => {
      const name = prompt('Новое название');
      if (name) { await api(`/stations/${b.dataset.ren}`, { method: 'PATCH', body: { name } }); render(); }
    });
  });
  c.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = run(async () => {
      if (confirm('Удалить станцию? Экраны этой станции переключатся на «Все станции».')) { await api(`/stations/${b.dataset.del}`, { method: 'DELETE' }); render(); }
    });
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
    <p class="muted">Адрес для вебхуков в Poster: <code>${esc(st.webhookUrl)}</code></p>`);
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
  document.title = `${st.account.name} — KDS`;
  $('venueName').textContent = st.account.name;
  const msgs = [];
  if (!st.posterConnected) msgs.push('Poster не подключён: заказы не поступают. Подключите через Poster или попросите поддержку указать токен.');
  else if (!st.health.ok) msgs.push(`Нет связи с Poster${st.health.lastError ? `: ${st.health.lastError}` : ''}.`);
  if (st.unroutedWorkshops?.length) msgs.push(`Цеха без экрана: ${st.unroutedWorkshops.join(', ')}. Их позиции никуда не попадут (вкладка «Станции»).`);
  if (Number(st.counts.kds_staff) === 0) msgs.push('Нет сотрудников с доступом к KDS: отметьте их во вкладке «Сотрудники».');
  if (Number(st.counts.kds_staff_without_pin) > 0) msgs.push(`Сотрудников без PIN: ${st.counts.kds_staff_without_pin}.`);
  if (!st.hasPassword) msgs.push('Не задан пароль админки (Настройки), вход пока только через Poster.');
  $('banner').innerHTML = msgs.map(esc).join('<br>');
  $('banner').classList.toggle('hidden', !msgs.length);
  $('banner').classList.toggle('bad', !st.health.ok);
}

async function boot() {
  try { await checkBanner(); stationsCache = await api('/stations'); } catch { return; }
  $('app').classList.remove('hidden');
  render();
  setInterval(() => checkBanner().catch(() => {}), 30000);
}
boot();
