'use strict';
// Bar KDS screen. Plain JS, no build step: runs on any tablet, phone or TV browser.

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- device pairing: admin gives a link /kds/#pair=TOKEN ----------------
const pair = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pair) { store.set('kds_device', pair); history.replaceState(null, '', location.pathname + location.search); }
const deviceToken = store.get('kds_device', null);
// ?embed=1: shown inside the Poster register — no fullscreen, starts at once.
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.classList.add('embed');

const state = {
  tickets: [],
  summaryOpen: store.get('kds_summary', false),
  summaryTab: 'items',
  summary: null,
  filterKey: null,
  station: { name: '', kind: 'prep', group_items: false },
  serverOffset: 0,          // server clock - local clock
  settings: { warnMinutes: 5, criticalMinutes: 10, undoWindowSec: 300, makerTitle: 'Сотрудник' },
  staff: store.get('kds_staff', []),        // [{ id, name, token }]
  current: store.get('kds_current', null),  // employee id
  queue: store.get('kds_queue', []),        // actions not yet confirmed by the server
  seen: new Set(),
  online: false,
  health: null,
  started: false,
};

// ---- API ----------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(`/api/kds${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-device-token': deviceToken ?? '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ---- sound: short beep on a new ticket ----------------------------------
let audio;
function beep() {
  if (!audio) return;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.25, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.4);
}

// ---- board loading --------------------------------------------------------
let loading = null;
async function loadBoard() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const data = await api('/board');
      // A new version was deployed: reload. Unsent taps survive in localStorage.
      if (data.version) {
        if (state.version && data.version !== state.version && !state.queue.length) return location.reload();
        state.version ??= data.version;
      }
      state.lastBoardOkAt = Date.now();
      state.serverOffset = new Date(data.serverTime) - Date.now();
      state.health = data.health;
      const fresh = data.tickets.filter((t) => !t.done && !state.seen.has(t.id));
      if (state.seen.size && fresh.length) beep();
      data.tickets.forEach((t) => state.seen.add(t.id));
      state.tickets = data.tickets;
      state.station = data.station;
      state.quickService = data.quickService === true;
      if (state.summaryOpen) loadSummary();
      state.online = true;
      render();
    } catch (err) {
      state.online = false;
      if (err.code === 'device') return showUnpaired();
      renderStatus();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---- staff on shift ---------------------------------------------------------
const currentStaff = () => state.staff.find((s) => s.id === state.current) ?? null;
function saveStaff() { store.set('kds_staff', state.staff); store.set('kds_current', state.current); }
function dropStaff(id) {
  state.staff = state.staff.filter((s) => s.id !== id);
  if (state.current === id) state.current = state.staff[0]?.id ?? null;
  saveStaff();
  renderStaff();
}

function renderStaff() {
  const el = $('staff');
  el.innerHTML = '';
  for (const s of state.staff) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = s.name;
    b.onclick = () => toast('Чтобы завершить смену, удерживайте имя', 'info');
    let hold;
    b.onpointerdown = () => { hold = setTimeout(async () => {
      if (await confirmBox(`Завершить смену: ${s.name}?`)) {
        api('/logout', { token: s.token }).catch(() => {});
        dropStaff(s.id);
      }
    }, 800); };
    b.onpointerup = b.onpointerleave = () => clearTimeout(hold);
    el.appendChild(b);
  }
}

let pinResolve;
function askPin() {
  return new Promise((resolve) => {
    pinResolve = resolve;
    pinValue = '';
    $('pinError').textContent = '';
    drawPin();
    $('pinpad').classList.remove('hidden');
  });
}
let pinValue = '';
function drawPin() { $('pinDots').innerHTML = '<span></span>'.repeat(pinValue.length); }
function buildPinPad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
  for (const k of keys) {
    const b = document.createElement('button');
    b.textContent = k;
    b.onclick = async () => {
      if (k === '⌫') pinValue = pinValue.slice(0, -1);
      else if (k === 'OK') return submitPin();
      else if (pinValue.length < 8) pinValue += k;
      drawPin();
    };
    $('pinGrid').appendChild(b);
  }
  $('pinCancel').onclick = () => { $('pinpad').classList.add('hidden'); pinResolve?.(null); };
}
async function submitPin() {
  if (pinValue.length < 4) return;
  try {
    const s = await api('/login', { pin: pinValue });
    state.staff = [...state.staff.filter((x) => x.id !== s.employee.id), { id: s.employee.id, name: s.employee.name, token: s.token }];
    state.current = s.employee.id;
    saveStaff();
    renderStaff();
    $('pinpad').classList.add('hidden');
    pinResolve?.(s.employee.id);
  } catch (err) {
    pinValue = '';
    drawPin();
    $('pinError').textContent = err.message;
  }
}

async function ensureStaff() {
  if (currentStaff()) return currentStaff();
  await askPin();
  return currentStaff();
}

// Who is doing this? Nobody on shift: PIN. The person the portion belongs to is
// on shift here, or only one person is: no question. Otherwise pick a name.
async function pickStaff(title, preferId = null) {
  if (!state.staff.length) { await askPin(); return currentStaff(); }
  const preferred = state.staff.find((s) => s.id === preferId);
  if (preferred) return preferred;
  if (state.staff.length === 1) return state.staff[0];
  return new Promise((resolve) => {
    $('pickTitle').textContent = title;
    const grid = $('pickGrid');
    grid.innerHTML = '';
    const done = (v) => { $('picker').classList.add('hidden'); resolve(v); };
    for (const s of state.staff) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="av">${esc(s.name.slice(0, 1))}</span>${esc(s.name)}`;
      b.onclick = () => done(s);
      grid.appendChild(b);
    }
    $('pickOther').onclick = async () => { $('picker').classList.add('hidden'); await askPin(); resolve(currentStaff()); };
    $('pickCancel').onclick = () => done(null);
    $('picker').classList.remove('hidden');
  });
}

// ---- confirm dialog -----------------------------------------------------------
function confirmBox(text) {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    $('confirm').classList.remove('hidden');
    const done = (v) => { $('confirm').classList.add('hidden'); resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

// ---- actions: queued with an op id, applied once even if retried ------------
function enqueueOp(path, body, who = currentStaff()) {
  state.queue.push({ path, staffId: who.id,
    body: { op_id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, token: who.token, ...body } });
  store.set('kds_queue', state.queue);
  render();
  flush();
}
const enqueue = (action, unitIds, who) => enqueueOp('/action', { action, unit_ids: unitIds }, who);

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (state.queue.length) {
      const op = state.queue[0];
      try {
        await api(op.path ?? '/action', op.body ?? op);
      } catch (err) {
        if (!err.status || err.status >= 500) { state.online = false; renderStatus(); break; } // network: keep and retry
        if (err.status === 401) dropStaff(op.staffId);
        toast(err.message);
      }
      state.queue.shift();
      store.set('kds_queue', state.queue);
    }
  } finally {
    flushing = false;
    loadBoard();
  }
}
setInterval(() => state.queue.length && flush(), 3000);

const pendingUnits = () => new Set(state.queue.flatMap((q) => q.body?.unit_ids ?? []));
const isOpen = (u) => u.status === 'new' || u.status === 'taken';

// A row is one portion, or on kitchens with grouping on, several identical
// portions in the same state ("Бургер ×4"). A tap acts on the whole row.
async function onRowTap(group) {
  const u = group[0];
  const ids = group.map((x) => x.id);
  const what = `«${u.name}»${group.length > 1 ? ` ×${group.length}` : ''}`;
  if (u.status === 'cancelled') return;
  if (u.status === 'new') {
    const who = await pickStaff(`Кто берёт ${what}?`);
    if (who) enqueue('take', ids, who);
    return;
  }
  if (u.status === 'taken') {
    // Ready goes to whoever took it; asked only if they've left this screen.
    const who = await pickStaff(`Кто приготовил ${what}?`, u.taken_by);
    if (!who) return;
    if (who.id !== u.taken_by && !(await confirmBox(`Взял ${u.taken_by_name}. Отметить готовым от имени «${who.name}»?`))) return;
    enqueue('ready', ids, who);
    return;
  }
  if (u.status === 'ready') {
    const who = state.staff.find((s) => s.id === u.ready_by);
    if (!who) return toast(`Отметку поставил(а) ${u.ready_by_name}: вернуть в работу может только он(а)`, 'info');
    const age = (Date.now() + state.serverOffset - new Date(u.ready_at)) / 1000;
    if (age > state.settings.undoWindowSec) return toast('Время на отмену вышло — обратитесь к администратору');
    if (await confirmBox(`Вернуть ${what} в работу?`)) enqueue('undo', ids, who);
  }
}

// Taken portions go to whoever took them (if they're on shift here);
// everything else to the person picked once for the whole card.
async function onAllReady(t) {
  const open = t.units.filter(isOpen);
  const byTaker = new Map();
  const rest = [];
  for (const u of open) {
    const taker = u.status === 'taken' && state.staff.find((s) => s.id === u.taken_by);
    if (taker) byTaker.set(taker, [...(byTaker.get(taker) ?? []), u.id]);
    else rest.push(u.id);
  }
  if (rest.length) {
    const who = await pickStaff(rest.length === open.length ? 'Кто приготовил?' : `Кто приготовил остальные (${rest.length})?`);
    if (!who) return;
    byTaker.set(who, [...(byTaker.get(who) ?? []), ...rest]);
  }
  for (const [who, ids] of byTaker) enqueue('ready', ids, who);
}

async function onServe(t) {
  const waiting = t.units.filter((u) => u.status !== 'ready' && u.status !== 'cancelled');
  if (waiting.length && !(await confirmBox(`Ещё не готово: ${waiting.map((u) => u.name).join(', ')}. Всё равно отметить «отдано»?`))) return;
  const who = await pickStaff(`Кто отдаёт ${ticketTitle(t)}?`);
  if (who) enqueueOp(`/tickets/${t.id}/serve`, {}, who);
}

// ---- side summary: how much to make in total ------------------------------------
async function loadSummary() {
  try {
    state.summary = await api('/summary');
    renderSummary();
  } catch { /* the board shows connection state */ }
}

function renderSummary() {
  $('summary').classList.toggle('hidden', !state.summaryOpen);
  $('summaryBtn').classList.toggle('active', state.summaryOpen);
  if (!state.summaryOpen || !state.summary) return;
  const s = state.summary;
  document.querySelectorAll('[data-st]').forEach((b) => b.classList.toggle('active', b.dataset.st === state.summaryTab));
  $('sumTotal').textContent = s.total ? `Всего к приготовлению: ${s.total}` : 'Всё приготовлено';
  const body = $('sumBody');
  body.innerHTML = '';
  if (state.summaryTab === 'items') {
    for (const i of s.items) {
      const b = document.createElement('button');
      b.className = `sum-row${state.filterKey === i.item_key ? ' active' : ''}`;
      b.innerHTML = `<span class="n">${i.portions}</span><span class="t">${esc(i.name)}${i.modifiers ? `<small>${esc(i.modifiers)}</small>` : ''}${i.taken ? `<em>в работе: ${i.taken}</em>` : ''}</span>`;
      // Tap: highlight the orders that contain this item.
      b.onclick = () => { state.filterKey = state.filterKey === i.item_key ? null : i.item_key; render(); renderSummary(); };
      body.appendChild(b);
    }
  } else {
    for (const i of s.ingredients) {
      const row = document.createElement('div');
      row.className = 'sum-row';
      row.innerHTML = `<span class="n" style="min-width:90px;font-size:20px">${Number(i.amount).toLocaleString('ru-RU')} ${esc(i.unit)}</span><span class="t">${esc(i.name)}</span>`;
      body.appendChild(row);
    }
    if (!s.ingredients.length) body.innerHTML = '<p class="sum-note">Нет данных техкарт для открытых позиций.</p>';
    if (s.withoutRecipe.length) body.insertAdjacentHTML('beforeend', `<p class="sum-note">Без техкарты в Poster: ${s.withoutRecipe.map(esc).join(', ')}</p>`);
  }
}

function toggleSummary(open = !state.summaryOpen) {
  state.summaryOpen = open;
  store.set('kds_summary', open);
  if (!open) state.filterKey = null;
  renderSummary();
  render();
  if (open) loadSummary();
}

// ---- recipe ----------------------------------------------------------------------
async function openRecipe(productId, portions) {
  try {
    const r = await api(`/recipe/${productId}`);
    $('recipeName').textContent = portions > 1 ? `${r.name} × ${portions}` : r.name;
    const photo = $('recipePhoto');
    photo.classList.toggle('hidden', !r.photo);
    if (r.photo) { photo.src = r.photo; photo.onerror = () => photo.classList.add('hidden'); }
    const rows = r.ingredients.map((i) => {
      const amount = Math.round(i.netto * portions * 100) / 100;
      return `<tr><td>${esc(i.name)}</td><td class="amt">${amount.toLocaleString('ru-RU')} ${esc(i.unit)}</td></tr>`;
    }).join('');
    $('recipeBody').innerHTML = `
      ${rows ? `<table>${rows}</table>` : '<p class="recipe-meta">В Poster нет техкарты для этой позиции.</p>'}
      ${r.description ? `<p class="recipe-meta">Технология (из Poster)</p><div class="recipe-note">${esc(r.description)}</div>` : ''}
      ${r.note ? `<p class="recipe-meta">Заметка заведения</p><div class="recipe-note">${esc(r.note)}</div>` : ''}
      ${r.normSeconds ? `<p class="recipe-meta">Норма приготовления: ${fmt(r.normSeconds)}</p>` : ''}`;
    $('recipe').classList.remove('hidden');
  } catch (err) {
    toast(err.message);
  }
}

// ---- rendering ------------------------------------------------------------------
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Comments that must not be missed.
const ALERT = /аллерг|allerg|непереносим|без глютен|без лактоз|орех/i;

function groupUnits(list) {
  if (!state.station.group_items) return list.map((u) => [u]);
  const groups = new Map();
  for (const u of list) {
    const k = [u.item_key, u.status, u.taken_by, u.ready_by, u.qty].join('|');
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  return [...groups.values()];
}

function unitRow(group, { expo }) {
  const u = group[0];
  const pend = pendingUnits();
  const li = document.createElement('li');
  li.className = `unit ${u.status}${u.taken_by === state.current ? ' mine' : ''}${group.some((x) => pend.has(x.id)) ? ' pending' : ''}`;
  const who = u.status === 'ready' ? `готово: ${u.ready_by_name}` : u.status === 'taken' ? `взял: ${u.taken_by_name}`
    : u.status === 'cancelled' ? 'ОТМЕНА' : (expo ? 'ждёт' : '');
  const qty = Number(u.qty) !== 1 ? ` × ${u.qty}` : '';
  const count = group.length > 1 ? `<span class="count">×${group.length}</span>` : '';
  const station = expo && u.station_name ? `<span class="station">${esc(u.station_name)}</span>` : '';
  const mod = u.modifiers ? `<span class="mod${/^\s*(без|-)/i.test(u.modifiers) ? ' minus' : ''}">${esc(u.modifiers)}</span>` : '';
  // Per-portion timer from "taken" against the norm for this product.
  const timer = u.status === 'taken' && u.taken_at
    ? `<span class="rtimer" data-taken="${esc(u.taken_at)}" data-norm="${u.norm_seconds ?? ''}"></span>` : '';
  if (state.filterKey && u.item_key === state.filterKey) li.classList.add('hl');
  const meta = `${who ? `<span class="who">${esc(who)}</span>` : ''}${timer}${station}`;
  li.innerHTML = `<span class="box"></span><span class="name">${count}<span class="nm">${esc(u.name)}${qty}</span>${mod}${meta ? `<span class="umeta">${meta}</span>` : ''}</span><button class="info" title="Рецептура" aria-label="Рецептура">i</button>`;
  li.querySelector('.info').onclick = (e) => { e.stopPropagation(); openRecipe(u.product_id, group.length * Number(u.qty || 1)); };
  if (!expo) li.onclick = () => onRowTap(group);
  return li;
}

const SERVICE = { 1: 'В зале', 2: 'С собой', 3: 'Доставка' };
// Delivery-service badge in its brand colour; dark or light text by brightness.
function aggBadge(a) {
  if (!a || !/^#[0-9a-f]{6}$/i.test(a.color)) return '';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(a.color.slice(i, i + 2), 16));
  const ink = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0A0D12' : '#FFFFFF';
  return `<span class="badge agg" style="background:${a.color};border-color:${a.color};color:${ink}">${esc(a.name)}</span>`;
}
const orderNo = (t) => String(Number(t.transaction_id) % 1000).padStart(3, '0');
function ticketTitle(t) {
  if (state.quickService) return `№ ${orderNo(t)}`;
  return t.table_name ? `Стол ${t.table_name}` : `Чек ${t.transaction_id}`;
}

function render() {
  renderStatus();
  const expo = state.station.kind === 'expo';
  $('stationName').textContent = state.station.name;
  const board = $('board');
  const active = state.tickets.filter((t) => !t.done);
  const done = state.tickets.filter((t) => t.done);

  board.innerHTML = '';
  for (const t of active) {
    const open = t.units.filter(isOpen);
    const live = t.units.filter((u) => u.status !== 'cancelled');
    const readyCnt = live.filter((u) => u.status === 'ready').length;
    const card = document.createElement('article');
    card.className = 'ticket';
    card.dataset.created = t.created_at;
    if (expo && live.length && readyCnt === live.length) card.classList.add('all-ready');
    if (state.filterKey && !t.units.some((u) => u.item_key === state.filterKey && isOpen(u))) card.classList.add('dim');
    else if (!open.length && !expo) card.classList.add('cancelled');
    card.innerHTML = `
      <div class="t-head">
        <div class="t-row"><span class="table">${esc(ticketTitle(t))}${t.round > 1 ? '<span class="badge">ДОЗАКАЗ</span>' : ''}${aggBadge(t.aggregator)}${state.quickService && SERVICE[t.service_mode] && !t.aggregator ? `<span class="badge svc s${t.service_mode}">${SERVICE[t.service_mode]}</span>` : ''}</span>
          <span class="timer"></span></div>
        <div class="meta">${state.quickService && t.table_name ? `стол ${esc(t.table_name)} · ` : ''}Чек ${t.transaction_id} · ${esc(t.waiter_name || '—')}${t.tablet_id ? ` · касса ${t.tablet_id}` : ''}${t.hall_name ? ` · ${esc(t.hall_name)}` : ''}${!state.quickService && t.guests ? ` · гостей ${t.guests}` : ''}${!state.quickService && t.check_status === 2 ? ' · оплачен' : ''}${expo ? ` · готово ${readyCnt}/${live.length}` : ''}</div>
      </div>
      ${t.comment ? `<div class="comment${ALERT.test(t.comment) ? ' alert' : ''}">${ALERT.test(t.comment) ? '⚠ ' : ''}${esc(t.comment)}</div>` : ''}
      <ul class="units"></ul>
      <div class="t-actions"></div>`;
    const ul = card.querySelector('.units');
    for (const g of groupUnits(expo ? live : t.units)) ul.appendChild(unitRow(g, { expo }));

    const actions = card.querySelector('.t-actions');
    const b = document.createElement('button');
    if (expo) {
      b.textContent = 'Отдано';
      b.className = readyCnt === live.length ? '' : 'secondary';
      b.onclick = () => onServe(t);
    } else if (open.length) {
      b.textContent = open.length > 1 ? `Всё готово (${open.length})` : 'Готово';
      b.onclick = () => onAllReady(t);
    } else {
      b.className = 'dismiss';
      b.textContent = live.length ? 'Позиции отменены — убрать' : 'Заказ отменён — убрать';
      b.onclick = () => api(`/tickets/${t.id}/dismiss`, {}).then(loadBoard).catch((e) => toast(e.message));
    }
    actions.appendChild(b);
    board.appendChild(card);
  }

  const strip = $('doneStrip');
  strip.innerHTML = '';
  for (const t of done.slice(-8).reverse()) {
    const d = document.createElement('button');
    d.className = 'done';
    const names = expo ? (t.served_by_name ?? '')
      : [...new Set(t.units.filter((u) => u.ready_by_name).map((u) => u.ready_by_name))].join(', ');
    d.innerHTML = `<b>✓</b> ${esc(ticketTitle(t))}${t.aggregator ? ` · ${esc(t.aggregator.name)}` : ''} · ${esc(names)}`;
    d.onclick = async () => {
      if (expo) {
        const who = await pickStaff(`Кто возвращает ${ticketTitle(t)} на раздачу?`, t.served_by);
        if (who && await confirmBox(`Вернуть заказ ${ticketTitle(t)} на раздачу?`)) enqueueOp(`/tickets/${t.id}/serve`, { undo: true }, who);
        return;
      }
      // Undo only your own marks: everyone on shift here gets theirs back.
      const marks = new Map();
      for (const u of t.units.filter((x) => x.status === 'ready')) {
        const who = state.staff.find((s) => s.id === u.ready_by);
        if (who) marks.set(who, [...(marks.get(who) ?? []), u.id]);
      }
      if (!marks.size) return toast('Отметки здесь поставили не те, кто сейчас на смене', 'info');
      if (await confirmBox(`Вернуть заказ ${ticketTitle(t)} в работу?`)) for (const [who, ids] of marks) enqueue('undo', ids, who);
    };
    strip.appendChild(d);
  }
  $('empty').classList.toggle('hidden', active.length > 0);
  tick();
}

function renderStatus() {
  const el = $('status');
  const h = state.health;
  let text; let ok = false;
  if (!state.online) text = 'Нет связи с сервером';
  else if (!h?.ok) text = h?.lastError ? 'Нет связи с Poster' : 'Ожидание синхронизации…';
  else { ok = true; text = 'Poster: онлайн'; }
  if (state.queue.length) text += ` · не отправлено: ${state.queue.length}`;
  el.className = `status ${ok && !state.queue.length ? 'ok' : 'bad'}`;
  $('statusText').textContent = text;
}

function tick() {
  const now = Date.now() + state.serverOffset;
  $('clock').textContent = new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  for (const card of document.querySelectorAll('.ticket')) {
    const sec = (now - new Date(card.dataset.created)) / 1000;
    card.querySelector('.timer').textContent = fmt(sec);
    card.classList.toggle('warn', sec >= state.settings.warnMinutes * 60 && sec < state.settings.criticalMinutes * 60);
    card.classList.toggle('crit', sec >= state.settings.criticalMinutes * 60);
  }
  for (const el of document.querySelectorAll('.rtimer')) {
    const sec = (now - new Date(el.dataset.taken)) / 1000;
    const norm = Number(el.dataset.norm);
    el.textContent = norm ? `${fmt(sec)} / ${fmt(norm)}` : fmt(sec);
    el.classList.toggle('over', !!norm && sec > norm);
  }
}
setInterval(tick, 1000);

// ---- start-up ------------------------------------------------------------------
// Not connected yet: type the 6-digit code from the admin panel (Экраны).
function showUnpaired() {
  $('start').classList.remove('hidden');
  $('startMsg').innerHTML = 'Экран не подключён.<br>Введите код из админки (раздел «Экраны»):';
  $('startBtn').classList.add('hidden');
  $('pairForm').classList.remove('hidden');
  $('pairCode').focus();
}

async function pairWithCode(e) {
  e.preventDefault();
  $('pairError').textContent = '';
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: $('pairCode').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    store.set('kds_device', data.token);
    location.reload();
  } catch (err) {
    $('pairError').textContent = err.message;
  }
}

async function start() {
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no sound */ }
  if (!EMBED) document.documentElement.requestFullscreen?.().catch(() => {});
  navigator.wakeLock?.request('screen').catch(() => {});
  $('start').classList.add('hidden');
  state.started = true;

  try { Object.assign(state.settings, (await api('/me')).settings); } catch (err) { if (err.code === 'device') return showUnpaired(); }
  $('addStaff').textContent = `+ ${state.settings.makerTitle}`;
  renderSummary();

  const socket = io({ auth: { deviceToken }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => { state.online = true; loadBoard(); flush(); });
  socket.on('disconnect', () => { state.online = false; renderStatus(); });
  socket.on('board', loadBoard);
  socket.on('health', (h) => { state.health = h; renderStatus(); });
  socket.on('connect_error', (e) => { if (e.message === 'device') showUnpaired(); });

  // Safety net in case a push is missed.
  setInterval(loadBoard, 15000);
  // Watchdog: a screen that hasn't managed to refresh for 90 s while the
  // network is up reloads itself (at most once every 5 minutes).
  setInterval(() => {
    const stale = Date.now() - (state.lastBoardOkAt ?? Date.now()) > 90000;
    let last = 0;
    try { last = Number(sessionStorage.getItem('kds_reloaded_at') ?? 0); } catch { /* private mode */ }
    if (stale && navigator.onLine !== false && Date.now() - last > 300000) {
      try { sessionStorage.setItem('kds_reloaded_at', String(Date.now())); } catch { /* ignore */ }
      location.reload();
    }
  }, 15000);
  state.lastBoardOkAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadBoard(); navigator.wakeLock?.request('screen').catch(() => {}); }
  });
  loadBoard();
}

buildPinPad();
renderStaff();
$('summaryBtn').onclick = () => toggleSummary();
$('summaryClose').onclick = () => toggleSummary(false);
document.querySelectorAll('[data-st]').forEach((b) => { b.onclick = () => { state.summaryTab = b.dataset.st; renderSummary(); }; });
$('recipeClose').onclick = () => $('recipe').classList.add('hidden');
$('recipe').onclick = (e) => { if (e.target.id === 'recipe') $('recipe').classList.add('hidden'); };
$('addStaff').onclick = () => askPin();
$('startBtn').onclick = start;
$('pairForm').onsubmit = pairWithCode;
if (!deviceToken) showUnpaired();
else if (EMBED) start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
