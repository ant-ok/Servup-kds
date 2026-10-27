// KDS inside the Poster register (Poster POS platform).
//
// Adds two buttons to the terminal:
//   • in the order window — "Готовность": how far along this order is, by station;
//   • in "Функции"        — "KDS": the station screen itself, for a bartender at the register.
// And when a check is closed, tells the KDS server at once, so the order shows
// up on the screens without waiting for Poster's webhook or the next poll.
//
// Uses only what Poster's own examples use: Poster.interface.showApplicationIconAt,
// Poster.interface.popup / closePopup, Poster.on(...), Poster.orders.getActive,
// Poster.settings. Rendered into #app-container like the official boilerplate.
(function () {
  'use strict';

  var BUILD_URL = '__KDS_URL__'; // replaced by pos-app/build.mjs
  var P = window.Poster;
  if (!P) return;

  // ---- storage: one connection per Poster account ------------------------
  var settings = P.settings || {};
  var key = 'kds_pos:' + (settings.accountUrl || 'default');
  var memory = {};
  function load() {
    try { return JSON.parse(window.localStorage.getItem(key)) || {}; } catch (e) { return memory[key] || {}; }
  }
  function save(v) {
    memory[key] = v;
    try { window.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* in-memory only */ }
  }
  var conn = load(); // { url, token, name }
  var kdsUrl = function () { return (conn.url || (BUILD_URL.indexOf('__') === 0 ? '' : BUILD_URL)).replace(/\/+$/, ''); };

  // ---- HTTP to the KDS server (device token, no cookies) ------------------
  function request(method, path, body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    return fetch(kdsUrl() + path, {
      method: method,
      headers: { 'content-type': 'application/json', 'x-device-token': conn.token || '' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = data.code;
          throw err;
        }
        return data;
      });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  // ---- rendering ---------------------------------------------------------------
  var css = [
    '.kdsp{font:15px/1.35 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1b1f24;padding:4px 2px}',
    '.kdsp h2{font-size:20px;margin:0 0 4px}.kdsp .muted{color:#6b7380;font-size:13px}',
    '.kdsp .st{margin:10px 0;padding:10px 12px;border:1px solid #e3e6eb;border-radius:10px}',
    '.kdsp .row{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '.kdsp .bar{height:8px;background:#eef0f3;border-radius:6px;overflow:hidden;margin-top:6px}',
    '.kdsp .bar i{display:block;height:100%;background:#16a34a}',
    '.kdsp .big{font-size:28px;font-weight:700}.kdsp .ok{color:#16a34a}.kdsp .wait{color:#b45309}',
    '.kdsp ul{list-style:none;margin:8px 0 0;padding:0}.kdsp li{padding:4px 0;border-top:1px solid #f1f2f4;display:flex;justify-content:space-between;gap:8px}',
    '.kdsp li small{color:#6b7380}.kdsp .s-ready{color:#16a34a}.kdsp .s-taken{color:#7c3aed}.kdsp .s-new{color:#b45309}',
    '.kdsp input{font:inherit;font-size:28px;letter-spacing:8px;text-align:center;width:100%;padding:8px;border:1px solid #d6dae0;border-radius:8px;box-sizing:border-box}',
    '.kdsp input.url{font-size:14px;letter-spacing:0;text-align:left}',
    '.kdsp button{font:inherit;padding:10px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}',
    '.kdsp button.link{background:none;color:#6b7380;padding:4px}.kdsp .err{color:#dc2626;min-height:18px}',
    '.kdsp iframe{width:100%;border:0;border-radius:8px;background:#111418}',
  ].join('');

  function root() {
    var el = document.getElementById('app-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-container';
      document.body.appendChild(el);
    }
    if (!document.getElementById('kdsp-style')) {
      var st = document.createElement('style');
      st.id = 'kdsp-style';
      st.textContent = css;
      document.head.appendChild(st);
    }
    return el;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  var STATUS = { ready: 'готово', taken: 'готовят', new: 'ждёт' };

  // ---- state of the open window ---------------------------------------------------
  var timer = null;
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  P.on('afterPopupClosed', stop);

  // ---- pairing -------------------------------------------------------------------------
  function showPairing(then) {
    stop();
    var el = root();
    el.innerHTML = '<form class="kdsp" id="kdsp-pair">'
      + '<h2>Подключение к KDS</h2>'
      + '<p class="muted">В админке KDS откройте «Экраны и кассы» → «+ Касса Poster» и введите код:</p>'
      + '<input id="kdsp-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">'
      + '<p class="muted">Адрес KDS</p><input class="url" id="kdsp-url" value="' + esc(kdsUrl()) + '" placeholder="https://kds.example.com">'
      + '<p class="err" id="kdsp-err"></p><button type="submit">Подключить</button></form>';
    P.interface.popup({ width: 420, height: 420, title: 'KDS' });
    document.getElementById('kdsp-pair').onsubmit = function (e) {
      e.preventDefault();
      var url = document.getElementById('kdsp-url').value.trim().replace(/\/+$/, '');
      conn = { url: url, token: '' };
      request('POST', '/api/pair', { code: document.getElementById('kdsp-code').value, tablet: settings.spotTabletId })
        .then(function (data) {
          conn = { url: url, token: data.token, name: data.device && data.device.name };
          save(conn);
          then();
        })
        .catch(function (err) { document.getElementById('kdsp-err').textContent = err.message; });
    };
  }

  function handleAuthError(err, retry) {
    if (err.status === 401 && err.code === 'device') {
      conn = { url: conn.url };
      save(conn);
      showPairing(retry);
      return true;
    }
    return false;
  }

  // ---- order readiness ------------------------------------------------------------------
  function orderHints(order) {
    order = order || {};
    var ids = [order.serverId, order.transactionId, order.transaction_id, order.id].filter(function (x) { return x != null && x !== ''; });
    var table = order.tableName || (order.table && order.table.name) || order.table_name || null;
    return { ids: ids, table: table };
  }

  function renderStatus(data, order) {
    var el = root();
    if (!data.found) {
      el.innerHTML = '<div class="kdsp"><h2>Заказ ещё не на кухне</h2>'
        + '<p class="muted">KDS пока не видит этот чек. Обычно он появляется через несколько секунд после пробития'
        + ' (или после «Отправить в цех», если так настроено).</p></div>';
      return;
    }
    var head = data.served ? '<span class="big ok">Отдано' + (data.servedBy ? ': ' + esc(data.servedBy) : '') + '</span>'
      : data.allReady ? '<span class="big ok">Всё готово — можно забирать</span>'
        : '<span class="big wait">Готово ' + data.ready + ' из ' + data.total + '</span>';
    var stations = data.stations.map(function (s) {
      var pct = s.total ? Math.round((s.ready / s.total) * 100) : 0;
      return '<div class="st"><div class="row"><b>' + esc(s.name) + '</b><span>' + s.ready + '/' + s.total
        + (s.taken ? ' · готовят ' + s.taken : '') + (s.waiting ? ' · ждут ' + s.waiting : '') + '</span></div>'
        + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
    var units = data.units.map(function (u) {
      var who = u.status === 'ready' ? u.readyBy : u.status === 'taken' ? u.takenBy : '';
      return '<li><span>' + esc(u.name) + (u.modifiers ? ' <small>' + esc(u.modifiers) + '</small>' : '') + '</span>'
        + '<span class="s-' + u.status + '">' + STATUS[u.status] + (who ? ' · ' + esc(who) : '') + '</span></li>';
    }).join('');
    el.innerHTML = '<div class="kdsp">'
      + '<div class="row"><h2>' + (data.check.table ? 'Стол ' + esc(data.check.table) : 'Чек ' + esc(data.check.id)) + '</h2>'
      + '<span class="muted">' + mmss(data.waitingSec) + ' с момента заказа</span></div>'
      + head + stations + '<ul>' + units + '</ul>'
      + '<p class="muted">Обновляется автоматически</p></div>';
  }

  function showOrderStatus() {
    stop();
    root().innerHTML = '<div class="kdsp"><p class="muted">Загрузка…</p></div>';
    P.interface.popup({ width: 460, height: 560, title: 'Готовность заказа' });
    P.orders.getActive().then(function (res) {
      var order = res && res.order;
      var hints = orderHints(order);
      // Nudge the server: re-read this check from Poster right now.
      if (hints.ids.length) request('POST', '/api/pos/event', { type: 'opened', ids: hints.ids }).catch(function () {});
      var refresh = function () {
        var q = '?ids=' + encodeURIComponent(hints.ids.join(',')) + (hints.table ? '&table=' + encodeURIComponent(hints.table) : '')
          + (settings.spotTabletId != null ? '&tablet=' + encodeURIComponent(settings.spotTabletId) : '');
        return request('GET', '/api/pos/order-status' + q)
          .then(function (data) { renderStatus(data, order); })
          .catch(function (err) {
            if (handleAuthError(err, showOrderStatus)) return;
            root().innerHTML = '<div class="kdsp"><h2>Нет связи с KDS</h2><p class="muted">' + esc(err.message) + '</p></div>';
          });
      };
      refresh();
      timer = setInterval(refresh, 3000);
    });
  }

  // ---- the station screen inside the register ---------------------------------------------
  function showBoard() {
    stop();
    var h = Math.max(420, Math.min(800, (window.innerHeight || 800) - 120));
    root().innerHTML = '<div class="kdsp"><iframe id="kdsp-frame" style="height:' + (h - 60) + 'px" allow="autoplay"'
      + ' src="' + esc(kdsUrl()) + '/kds/?embed=1#pair=' + encodeURIComponent(conn.token) + '"></iframe>'
      + '<div class="row"><span class="muted">' + esc(conn.name || '') + '</span>'
      + '<button class="link" id="kdsp-unpair">Отключить эту кассу от KDS</button></div></div>';
    P.interface.popup({ width: 980, height: h, title: 'KDS' });
    document.getElementById('kdsp-unpair').onclick = function () {
      if (!window.confirm('Отключить эту кассу от KDS?')) return;
      conn = { url: conn.url };
      save(conn);
      P.interface.closePopup();
    };
  }

  // ---- wiring ---------------------------------------------------------------------------------
  P.interface.showApplicationIconAt({ order: 'Готовность', functions: 'KDS' });

  P.on('applicationIconClicked', function (data) {
    var place = data && data.place;
    var open = place === 'order' ? showOrderStatus : showBoard;
    if (!conn.token || !kdsUrl()) return showPairing(open);
    open();
  });

  // A closed check is the moment an order must reach the bar in quick service.
  P.on('afterOrderClose', function (data) {
    if (!conn.token) return;
    var hints = orderHints(data && (data.order || data));
    request('POST', '/api/pos/event', { type: 'closed', ids: hints.ids }).catch(function () {});
  });

  window.__kdsPos = { version: 1, connection: function () { return conn; } }; // for support and tests
}());
