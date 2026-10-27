'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function toast(msg) { $('toast').textContent = msg; $('toast').classList.remove('hidden'); setTimeout(() => $('toast').classList.add('hidden'), 3000); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/platform${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/login', { method: 'POST', body: { password: $('password').value } }); $('login').classList.add('hidden'); load(); }
  catch { $('loginError').textContent = 'Неверный пароль'; }
};

$('createForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try { await api('/accounts', { method: 'POST', body }); e.target.reset(); toast('Заведение создано'); load(); } catch (err) { toast(err.message); }
};

async function load() {
  const list = await api('/accounts');
  $('app').classList.remove('hidden');
  $('list').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Заведение</th><th>Poster</th><th>Синхронизация</th>
    <th class="num">Экранов</th><th>Экран был онлайн</th><th class="num">Порций за сутки</th><th></th></tr></thead><tbody>
    ${list.map((a) => `<tr><td>${a.id}</td><td>${esc(a.name)}</td><td>${esc(a.poster_account ?? '—')}</td>
      <td>${!a.active ? '<span class="pill">отключено</span>' : !a.connected ? '<span class="pill bad">нет токена</span>'
        : a.health.ok ? '<span class="pill ok">работает</span>' : `<span class="pill bad" title="${esc(a.health.lastError)}">ошибка</span>`}</td>
      <td class="num">${a.devices}</td><td>${dt(a.last_screen_at)}</td><td class="num">${a.portions_24h}</td>
      <td><button class="light small" data-open="${a.id}">Админка</button>
          <button class="light small" data-token="${a.id}">Токен</button>
          <button class="${a.active ? 'danger' : 'light'} small" data-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Отключить' : 'Включить'}</button></td></tr>`).join('')}
    </tbody></table></div>`;
  document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = async () => { await api(`/accounts/${b.dataset.open}/impersonate`, { method: 'POST' }); window.open('/admin/', '_blank'); }; });
  document.querySelectorAll('[data-token]').forEach((b) => {
    b.onclick = async () => { const token = prompt('Новый токен API Poster'); if (token) { await api(`/accounts/${b.dataset.token}`, { method: 'PATCH', body: { token } }); load(); } };
  });
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => { await api(`/accounts/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== 'true' } }); load(); };
  });
}
load().catch(() => {});
setInterval(() => load().catch(() => {}), 30000);
