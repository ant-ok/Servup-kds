'use strict';
// Bar KDS screen. Plain JS, no build step: runs on any tablet, phone or TV browser.

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- device pairing: admin gives a link /kds/#pair=TOKEN ----------------
const pair = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pair) { store.set('kds_device', pair); history.replaceState(null, '', location.pathname); }
const deviceToken = store.get('kds_device', null);

const state = {
  tickets: [],
  serverOffset: 0,          // server clock - local clock
  settings: { warnMinutes: 5, criticalMinutes: 10, undoWindowSec: 300 },
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
      state.serverOffset = new Date(data.serverTime) - Date.now();
      state.health = data.health;
      const fresh = data.tickets.filter((t) => !t.bumped_at && !state.seen.has(t.id));
      if (state.seen.size && fresh.length) beep();
      data.tickets.forEach((t) => state.seen.add(t.id));
      state.tickets = data.tickets;
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
    b.className = `chip${s.id === state.current ? ' active' : ''}`;
    b.textContent = s.name;
    b.onclick = () => { state.current = s.id; saveStaff(); renderStaff(); };
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
function enqueue(action, unitIds, extra = {}) {
  const who = currentStaff();
  state.queue.push({ op_id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, token: who.token, staffId: who.id,
    action, unit_ids: unitIds, ...extra });
  store.set('kds_queue', state.queue);
  render();
  flush();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (state.queue.length) {
      const op = state.queue[0];
      try {
        const { staffId, ...body } = op;
        await api('/action', body);
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

const pendingUnits = () => new Set(state.queue.flatMap((q) => q.unit_ids));

async function onUnitTap(u) {
  if (u.status === 'cancelled') return;
  const me = await ensureStaff();
  if (!me) return;
  if (u.status === 'new') return enqueue('take', [u.id]);
  if (u.status === 'taken' && u.taken_by === me.id) return enqueue('ready', [u.id]);
  if (u.status === 'taken') {
    if (await confirmBox(`Взял ${u.taken_by_name}. Отметить готовым от имени «${me.name}»?`)) enqueue('ready', [u.id]);
    return;
  }
  if (u.status === 'ready' && u.ready_by === me.id) {
    const age = (Date.now() + state.serverOffset - new Date(u.ready_at)) / 1000;
    if (age > state.settings.undoWindowSec) return toast('Время на отмену вышло — обратитесь к администратору');
    if (await confirmBox(`Вернуть «${u.name}» в работу?`)) enqueue('undo', [u.id]);
  }
}

async function onAllReady(t) {
  const me = await ensureStaff();
  if (!me) return;
  const ids = t.units.filter((u) => u.status === 'new' || u.status === 'taken').map((u) => u.id);
  const foreign = t.units.filter((u) => u.status === 'taken' && u.taken_by !== me.id);
  if (foreign.length && !(await confirmBox(`Часть позиций взял ${foreign[0].taken_by_name}. Отметить всё от имени «${me.name}»?`))) return;
  if (ids.length) enqueue('ready', ids);
}

// ---- rendering ------------------------------------------------------------------
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  renderStatus();
  const board = $('board');
  const pend = pendingUnits();
  const me = state.current;
  const active = state.tickets.filter((t) => !t.bumped_at);
  const done = state.tickets.filter((t) => t.bumped_at);

  board.innerHTML = '';
  for (const t of active) {
    const open = t.units.filter((u) => u.status === 'new' || u.status === 'taken');
    const allCancelled = !open.length && t.units.every((u) => u.status === 'cancelled');
    const card = document.createElement('article');
    card.className = 'ticket';
    card.dataset.created = t.created_at;
    if (!open.length) card.classList.add('cancelled');
    card.innerHTML = `
      <div class="t-head">
        <div class="t-row"><span class="table">${t.table_name ? `Стол ${esc(t.table_name)}` : 'Без стола'}${t.round > 1 ? '<span class="badge">ДОЗАКАЗ</span>' : ''}</span>
          <span class="timer"></span></div>
        <div class="meta">Чек ${t.transaction_id} · ${esc(t.waiter_name || '—')}${t.tablet_id ? ` · касса ${t.tablet_id}` : ''}${t.hall_name ? ` · ${esc(t.hall_name)}` : ''}${t.guests ? ` · гостей ${t.guests}` : ''}${t.check_status === 2 ? ' · оплачен' : ''}</div>
      </div>
      ${t.comment ? `<div class="comment">${esc(t.comment)}</div>` : ''}
      <ul class="units"></ul>
      <div class="t-actions"></div>`;
    const ul = card.querySelector('.units');
    for (const u of t.units) {
      const li = document.createElement('li');
      li.className = `unit ${u.status}${u.taken_by === me ? ' mine' : ''}${pend.has(u.id) ? ' pending' : ''}`;
      const who = u.status === 'ready' ? `готово: ${u.ready_by_name}` : u.status === 'taken' ? `взял: ${u.taken_by_name}`
        : u.status === 'cancelled' ? 'ОТМЕНА' : '';
      const qty = Number(u.qty) !== 1 ? ` × ${u.qty}` : '';
      li.innerHTML = `<span class="box"></span><span class="name">${esc(u.name)}${qty}${u.modifiers ? `<span class="mod">${esc(u.modifiers)}</span>` : ''}</span><span class="who">${esc(who)}</span>`;
      li.onclick = () => onUnitTap(u);
      ul.appendChild(li);
    }
    const actions = card.querySelector('.t-actions');
    if (open.length) {
      const b = document.createElement('button');
      b.textContent = open.length > 1 ? `Всё готово (${open.length})` : 'Готово';
      b.onclick = () => onAllReady(t);
      actions.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.className = 'dismiss';
      b.textContent = allCancelled ? 'Заказ отменён — убрать' : 'Убрать';
      b.onclick = () => api(`/tickets/${t.id}/dismiss`, {}).then(loadBoard).catch((e) => toast(e.message));
      actions.appendChild(b);
    }
    board.appendChild(card);
  }

  const strip = $('doneStrip');
  strip.innerHTML = '';
  for (const t of done.slice(-8).reverse()) {
    const d = document.createElement('button');
    d.className = 'done';
    const names = [...new Set(t.units.filter((u) => u.ready_by_name).map((u) => u.ready_by_name))].join(', ');
    d.innerHTML = `<b>✓</b> ${t.table_name ? `Стол ${esc(t.table_name)}` : `Чек ${t.transaction_id}`} · ${esc(names)}`;
    d.onclick = async () => {
      const mine = t.units.filter((u) => u.status === 'ready' && u.ready_by === state.current);
      if (!mine.length) return toast('Здесь нет ваших отметок', 'info');
      if (await confirmBox(`Вернуть заказ «${t.table_name ?? t.transaction_id}» в работу?`)) enqueue('undo', mine.map((u) => u.id));
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
}
setInterval(tick, 1000);

// ---- start-up ------------------------------------------------------------------
function showUnpaired() {
  $('start').classList.remove('hidden');
  $('startMsg').innerHTML = 'Экран не подключён.<br>В админке откройте «Устройства», создайте экран и откройте его ссылку на этом устройстве.';
  $('startBtn').classList.add('hidden');
}

async function start() {
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no sound */ }
  document.documentElement.requestFullscreen?.().catch(() => {});
  navigator.wakeLock?.request('screen').catch(() => {});
  $('start').classList.add('hidden');
  state.started = true;

  try { Object.assign(state.settings, (await api('/me')).settings); } catch (err) { if (err.code === 'device') return showUnpaired(); }

  const socket = io({ auth: { deviceToken }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => { state.online = true; loadBoard(); flush(); });
  socket.on('disconnect', () => { state.online = false; renderStatus(); });
  socket.on('board', loadBoard);
  socket.on('health', (h) => { state.health = h; renderStatus(); });
  socket.on('connect_error', (e) => { if (e.message === 'device') showUnpaired(); });

  // Safety net in case a push is missed.
  setInterval(loadBoard, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadBoard(); navigator.wakeLock?.request('screen').catch(() => {}); }
  });
  loadBoard();
}

buildPinPad();
renderStaff();
$('addStaff').onclick = () => askPin();
$('startBtn').onclick = start;
if (!deviceToken) showUnpaired();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
