/* ============================================================
 * desktop-api.js — 电脑网页版（浏览器）的 window.api 兼容层（v3.0.5）
 *
 * 目的：让整套桌面前端（index.html + app.js + db.js + style.css）能在
 *   普通浏览器里原样运行，显示/交互/数据与 exe 完全一致。
 *
 * 原理：exe 里 window.api 由 preload.js 注入，invoke(channel,payload) 走 IPC →
 *   main.js handlers → store.js。浏览器里本文件在 db.js 之前加载，构造一个
 *   等价的 window.api，把 invoke 转发到 HTTP 服务（mobile-server.js）的
 *   /api/invoke，由服务端调用同一份 store.js —— 同一进程、同一份 spms-data.json。
 *
 * 因此 db.js 的「双后端」探测到 window.api 存在，自动走「主进程后端」分支，
 * app.js 无需任何改动。PDA 端（mobile.html / mobile.js）不加载本文件，不受影响。
 *
 * 认证：与 PDA 拆分的独立 PIN + 令牌（12h，scope=desktop）。令牌存 sessionStorage，
 *   未登录时显示登录遮罩，登录后 init 才真正拉数据。
 * ============================================================ */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  window.desktopWeb = true; // 供 app.js 区分网页版与客户端（如 PIN 保存走 HTTP 还是 IPC）

  var TOKEN_KEY = 'spms_desktop_token';
  var TOKEN_HEADER = 'x-spms-token';

  function token() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  /* 统一请求：带令牌，JSON */
  function request(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json';
    if (token()) options.headers[TOKEN_HEADER] = token();
    return fetch(url, options).then(function (r) {
      return r.text().then(function (txt) {
        var data;
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { throw new Error('服务返回格式错误：' + txt.slice(0, 80)); }
        if (r.status === 401) {
          showLogin('登录已失效，请重新输入 PIN');
          var err = new Error(data.error || '登录已失效'); err.code = 401; throw err;
        }
        if (r.status === 403) {
          var e3 = new Error((data && data.error) || '权限不足'); e3.code = 403; throw e3;
        }
        if (!r.ok || (data && data.ok === false && data.__throw !== false)) {
          var e2 = new Error((data && data.error) || ('请求失败（' + r.status + '）'));
          e2.payload = data; throw e2;
        }
        return data;
      });
    });
  }

  /* invoke(channel,payload) —— 与 preload.js 完全同签名，返回 Promise */
  function invoke(channel, payload) {
    return request('/api/invoke', {
      method: 'POST',
      body: JSON.stringify({ channel: channel, payload: payload === undefined ? null : payload })
    }).then(function (r) {
      /* 服务端统一包 { ok:true, result }；解包成 handler 的原始返回值 */
      return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
    });
  }

  /* ---------------- 登录遮罩 ---------------- */
  var loginEl = null;
  function showLogin(msg) {
    if (loginEl && document.body.contains(loginEl)) {
      if (msg) { var m = loginEl.querySelector('.desk-login-msg'); if (m) m.textContent = msg; }
      loginEl.hidden = false; return;
    }
    loginEl = document.createElement('div');
    loginEl.className = 'desk-login';
    loginEl.innerHTML =
      '<div class="desk-login-card">' +
        '<div class="desk-login-logo">📦</div>' +
        '<h2>备件仓库管理系统 · 网页版</h2>' +
        '<p class="desk-login-sub">请输入电脑网页版访问 PIN（系统设置中查看，与 PDA 不同）</p>' +
        '<p class="desk-login-msg" style="color:#dc2626;min-height:20px;margin:0"></p>' +
        '<input id="deskPin" type="password" inputmode="numeric" maxlength="4" placeholder="4 位 PIN" ' +
        'style="width:100%;font-size:18px;text-align:center;letter-spacing:6px;padding:10px;margin:6px 0 14px;box-sizing:border-box" />' +
        '<button id="deskLoginBtn" class="btn primary" style="width:100%;padding:12px;font-size:16px">登 录</button>' +
        '<p class="desk-login-tip" style="color:#94a3b8;font-size:12px;margin-top:14px">局域网内使用，数据与本程序客户端实时同步</p>' +
      '</div>';
    if (msg) loginEl.querySelector('.desk-login-msg').textContent = msg;
    document.body.appendChild(loginEl);
    var doLogin = function () {
      var pin = (loginEl.querySelector('#deskPin').value || '').trim();
      var btn = loginEl.querySelector('#deskLoginBtn');
      if (!/^\d{4}$/.test(pin)) { loginEl.querySelector('.desk-login-msg').textContent = '请输入 4 位数字 PIN'; return; }
      btn.disabled = true; btn.textContent = '登录中…';
      fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin, scope: 'desktop' })
      }).then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
        .then(function (x) {
          if (x.r.ok && x.d.ok && x.d.token) {
            setToken(x.d.token);
            if (loginEl) loginEl.hidden = true;
            location.reload();
          } else {
            loginEl.querySelector('.desk-login-msg').textContent = (x.d && x.d.error) || 'PIN 不正确';
            btn.disabled = false; btn.textContent = '登 录';
          }
        })
        .catch(function (e) {
          loginEl.querySelector('.desk-login-msg').textContent = '无法连接服务：' + e.message;
          btn.disabled = false; btn.textContent = '登 录';
        });
    };
    loginEl.querySelector('#deskLoginBtn').addEventListener('click', doLogin);
    loginEl.querySelector('#deskPin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    loginEl.querySelector('#deskPin').focus();
  }

  /* 页面加载即探测令牌：无令牌 → 显示登录遮罩 */
  if (!token()) {
    (function wait() {
      if (document.body) showLogin('');
      else setTimeout(wait, 20);
    })();
  }

  /* ---------------- 打印（浏览器 window.print 降级） ---------------- */
  function printLabels(opts) {
    try { window.print(); } catch (e) {}
    return Promise.resolve({ ok: true, fallback: true });
  }

  /* ---------------- 系统设置相关（网页版有限支持） ---------------- */
  function mobileStatus() {
    return request('/api/desktop-status', { method: 'GET' });
  }
  function sysInfo() {
    return request('/api/sys-info', { method: 'GET' });
  }
  function mobileSetPin(pin) {
    /* 网页版系统设置里改的是电脑 PIN（scope=desktop），与 PDA PIN 互不影响 */
    return request('/api/mobile-set-pin', { method: 'POST', body: JSON.stringify({ pin: pin, scope: 'desktop' }) });
  }
  function mobileRestart(port) {
    return request('/api/mobile-restart', { method: 'POST', body: JSON.stringify({ port: port }) });
  }
  function openDataDir() {
    if (typeof window.toast === 'function') window.toast('网页版无法打开本地目录，请在客户端操作', 'warn');
    return Promise.resolve({ ok: false, error: '浏览器不支持' });
  }
  function sysPortCheck() {
    return Promise.resolve({ ok: true, allowed: false, error: '网页版不支持端口防火墙设置，请在客户端操作' });
  }
  function sysOpenPort() {
    return Promise.resolve({ ok: false, allowed: false, error: '网页版不支持端口防火墙设置，请在客户端操作' });
  }

  /* ---------------- 数据变更订阅（轮询数据版本号） ---------------- */
  var dataChangedSubs = [];
  var lastRev = null;
  function pollDataChanged() {
    if (!token()) return;
    request('/api/data-revision', { method: 'GET' }).then(function (r) {
      var rev = r && r.revision;
      if (lastRev === null) lastRev = rev;
      else if (rev !== lastRev) {
        lastRev = rev;
        dataChangedSubs.forEach(function (cb) { try { cb(); } catch (e) {} });
      }
    }).catch(function () {});
  }
  setInterval(pollDataChanged, 4000);
  function onDataChanged(cb) {
    if (typeof cb === 'function') dataChangedSubs.push(cb);
    return function () {
      var i = dataChangedSubs.indexOf(cb);
      if (i >= 0) dataChangedSubs.splice(i, 1);
    };
  }

  /* ---------------- 组装 window.api（与 preload.js 同形状） ---------------- */
  window.api = {
    version: (window.__SPMS_VERSION__ || ''),
    invoke: invoke,
    printLabels: printLabels,
    mobileStatus: mobileStatus,
    mobileSetPin: mobileSetPin,
    mobileRestart: mobileRestart,
    sysInfo: sysInfo,
    openDataDir: openDataDir,
    sysPortCheck: sysPortCheck,
    sysOpenPort: sysOpenPort,
    onDataChanged: onDataChanged
    /* 具名的 getLocationAudits/saveLocationAudit 在 preload 里是独立方法，
     * 但 app.js 通过 DB→invoke 调用（db-getLocationAudits 等），此处无需重复。 */
  };
})();
