/* ============================================================
 * mobile.js — PDA 移动端页面逻辑
 * 只与 mobile-server.js 的 /api/* 交互，不直接接触数据文件。
 * 扫码场景：PDA 扫描引擎以「键盘输出」方式把编号打进 #scan 并回车，
 *          因此 #scan 始终自动聚焦，回车即检索。
 * ============================================================ */
(function () {
  'use strict';

  var TOKEN_KEY = 'spmsMobileToken';
  var state = { token: '', type: 'out', part: null, staffs: [] };

  var $ = function (id) { return document.getElementById(id); };

  var toastTimer = null;
  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function hint(msg, cls) {
    var el = $('scanHint');
    el.textContent = msg || '扫码枪扫一下自动检索，回车也可查询';
    el.className = 'scan-hint' + (cls ? ' ' + cls : '');
  }

  /* ---------------- 网络 ---------------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (state.token) headers['x-spms-token'] = state.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: '服务返回异常（HTTP ' + res.status + '）' };
      }).then(function (j) { j._status = res.status; return j; });
    }).catch(function () {
      throw new Error('无法连接电脑端服务，请确认在同一网络且电脑端程序已运行');
    });
  }

  function requireLogin(msg) {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    showLogin(msg || '');
  }

  /* ---------------- 登录 ---------------- */
  function showLogin(msg) {
    $('login').style.display = 'flex';
    $('app').hidden = true;
    $('loginErr').textContent = msg || '';
    setTimeout(function () { $('pin').focus(); }, 150);
  }
  function hideLogin() {
    $('login').style.display = 'none';
    $('app').hidden = false;
    setTimeout(function () { $('scan').focus(); }, 100);
  }
  function doLogin() {
    var pin = $('pin').value.trim();
    if (!/^\d{4}$/.test(pin)) { $('loginErr').textContent = '请输入 4 位数字 PIN'; return; }
    $('loginBtn').disabled = true;
    api('/api/login', { method: 'POST', body: { pin: pin } }).then(function (j) {
      $('loginBtn').disabled = false;
      if (!j.ok) { $('loginErr').textContent = j.error || '登录失败'; return; }
      state.token = j.token;
      localStorage.setItem(TOKEN_KEY, j.token);
      $('pin').value = '';
      hideLogin();
      boot();
    }).catch(function (e) {
      $('loginBtn').disabled = false;
      $('loginErr').textContent = e.message;
    });
  }

  /* ---------------- 连接状态 ---------------- */
  function ping() {
    return api('/api/ping').then(function (j) {
      var c = $('conn');
      if (j && j.ok) {
        c.textContent = '● 已连接';
        c.className = 'conn';
        if (j.version) $('loginVer').textContent = 'v' + j.version;
      }
      return j;
    }).catch(function () {
      var c = $('conn');
      c.textContent = '● 已断开';
      c.className = 'conn off';
    });
  }

  /* ---------------- 备件卡片 ---------------- */
  function showPart(p) {
    state.part = p;
    $('pName').textContent = p.name || '—';
    $('pCode').textContent = p.code || '—';
    $('pSpec').textContent = [p.spec, p.location ? '库位 ' + p.location : ''].filter(Boolean).join(' · ') || '—';
    $('pStock').textContent = p.stock;
    $('pStock').className = 'metric-value' + (Number(p.stock) <= 0 ? ' low' : '');
    $('pSafe').textContent = p.safeStock;
    $('card').hidden = false;
    $('empty').hidden = true;
    $('results').hidden = true;
    $('submit').disabled = false;
    hint('✓ 已选中：' + p.name + (p.location ? ' ｜ 库位 ' + p.location : ''), 'ok');
  }
  function clearPart() {
    state.part = null;
    $('card').hidden = true;
    $('empty').hidden = false;
    $('results').hidden = true;
    $('submit').disabled = true;
  }

  function showResults(list) {
    var box = $('results');
    box.innerHTML = '<div class="results-title">匹配到 ' + list.length + ' 个备品，请点选</div>' +
      list.map(function (p, i) {
        return '<div class="result-item" data-i="' + i + '">' +
          '<div class="result-main"><div class="result-name">' + esc(p.name) + '</div>' +
          '<div class="result-sub">' + esc(p.code) + (p.spec ? ' · ' + esc(p.spec) : '') + (p.location ? ' · ' + esc(p.location) : '') + '</div></div>' +
          '<div class="result-stock">' + p.stock + '</div></div>';
      }).join('');
    box.hidden = false;
    $('card').hidden = true;
    $('empty').hidden = true;
    Array.prototype.forEach.call(box.querySelectorAll('.result-item'), function (el) {
      el.onclick = function () {
        var p = list[Number(el.getAttribute('data-i'))];
        if (p) showPart(p);
      };
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 检索 ---------------- */
  var searchTimer = null;
  function search() {
    var kw = $('scan').value.trim();
    if (!kw) { clearPart(); hint('', ''); return; }
    api('/api/search?kw=' + encodeURIComponent(kw)).then(function (j) {
      if (j._status === 401) return requireLogin();
      if (!j.ok) { hint(j.error || '检索失败', 'err'); return; }
      if (!j.list.length) { clearPart(); hint('未找到匹配「' + kw + '」的备品', 'err'); return; }
      if (j.list.length === 1) { showPart(j.list[0]); return; }
      showResults(j.list);
      hint('匹配到 ' + j.list.length + ' 个备品，请点选', '');
    }).catch(function (e) { hint(e.message, 'err'); });
  }

  /* ---------------- 提交 ---------------- */
  function submit() {
    if (!state.part) { toast('请先扫码或检索备品', 'err'); return; }
    var qty = parseFloat($('qty').value);
    resolveOpField();                       /* 输的是工号则换成姓名，输入框与流水保持一致 */
    var op = $('operator').value.trim();
    if (!(qty > 0)) { toast('数量必须大于 0', 'err'); $('qty').focus(); return; }
    if (!op) { toast(state.type === 'out' ? '请填写领用人' : '请填写经办人', 'err'); $('operator').focus(); return; }

    var btn = $('submit');
    btn.disabled = true;
    api('/api/tx', {
      method: 'POST',
      body: {
        type: state.type,
        code: state.part.code,
        quantity: qty,
        operator: op,
        remark: $('remark').value.trim()
      }
    }).then(function (j) {
      btn.disabled = false;
      if (j._status === 401) return requireLogin();
      if (!j.ok) {
        toast(j.error || '提交失败', 'err');
        btn.disabled = false;
        return;
      }
      toast((state.type === 'out' ? '出库成功' : '入库成功') + '：' + j.part.name + ' × ' + qty, 'ok');
      resetForNext();
      loadRecent();
      loadOperators();
    }).catch(function (e) {
      btn.disabled = false;
      toast(e.message, 'err');
    });
  }

  function resetForNext() {
    $('scan').value = '';
    $('qty').value = '1';
    $('remark').value = '';
    clearPart();
    hint('', '');
    setTimeout(function () { $('scan').focus(); }, 50);
  }

  /* ---------------- 初始数据 ---------------- */
  function loadOperators() {
    Promise.all([api('/api/operators'), api('/api/staffs')]).then(function (rs) {
      var ops = (rs[0] && rs[0].ok && Array.isArray(rs[0].list)) ? rs[0].list : [];
      var sf = (rs[1] && rs[1].ok && Array.isArray(rs[1].list)) ? rs[1].list : [];
      state.staffs = sf;
      var seen = {};
      var opts = [];
      /* 档案：姓名与工号都能作为候选（输工号 → 选中后由 resolveOpField 换成姓名） */
      sf.forEach(function (s) {
        if (!s || !s.name) return;
        var key = String(s.name).toLowerCase();
        if (!seen[key]) { seen[key] = 1; opts.push('<option value="' + esc(s.name) + '"></option>'); }
        if (s.no) opts.push('<option value="' + esc(s.no) + '"></option>');
      });
      ops.forEach(function (n) {
        if (!n) return;
        var key = String(n).toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        opts.push('<option value="' + esc(n) + '"></option>');
      });
      $('opList').innerHTML = opts.join('');
    }).catch(function () { /* 忽略 */ });
  }

  /* 按工号查档案（忽略大小写与空格） */
  function findStaffByNo(v) {
    var q = String(v || '').trim().replace(/\s+/g, '').toUpperCase();
    if (!q) return null;
    for (var i = 0; i < state.staffs.length; i++) {
      var no = String(state.staffs[i].no || '').trim().replace(/\s+/g, '').toUpperCase();
      if (no && no === q) return state.staffs[i];
    }
    return null;
  }
  function findStaffByName(v) {
    var q = String(v || '').trim().toLowerCase();
    if (!q) return null;
    for (var i = 0; i < state.staffs.length; i++) {
      if (String(state.staffs[i].name || '').toLowerCase() === q) return state.staffs[i];
    }
    return null;
  }
  /* 输入框里的工号 → 换成姓名（下方显示工号徽标）；输姓名则只补工号提示 */
  function resolveOpField() {
    var el = $('operator');
    var box = $('opHint');
    if (!el || !box) return;
    var v = el.value.trim();
    if (!v) { box.hidden = true; return; }
    var hit = findStaffByNo(v);
    if (hit) {
      el.value = hit.name;
      box.textContent = '工号 ' + hit.no + ' · ' + hit.name;
      box.hidden = false;
      return;
    }
    var byName = findStaffByName(v);
    if (byName && byName.no) {
      box.textContent = '工号 ' + byName.no;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  function loadRecent() {
    api('/api/recent?limit=6').then(function (j) {
      if (!j.ok) return;
      var box = $('recentList');
      if (!j.list.length) { box.innerHTML = '<div class="recent-item">暂无记录</div>'; return; }
      box.innerHTML = j.list.map(function (t) {
        var isOut = t.type === 'out';
        return '<div class="recent-item"><div><div>' + esc(t.partName) + ' · ' + esc(t.partCode) + '</div>' +
          '<div class="rt-sub">' + fmt(t.time) + ' · ' + esc(t.operatorLabel || t.operator || '-') + '</div></div>' +
          '<div class="rt-qty ' + (isOut ? 'rt-out' : 'rt-in') + '">' + (isOut ? '−' : '+') + t.quantity + '</div></div>';
      }).join('');
    }).catch(function () { /* 忽略 */ });
  }

  function fmt(ms) {
    if (!ms) return '';
    var d = new Date(Number(ms));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- 视图 ---------------- */
  function setType(type) {
    state.type = type;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-type') === type);
    });
    $('opLabel').textContent = type === 'out' ? '领用人 *' : '经办人 *';
    $('submit').textContent = type === 'out' ? '确认出库' : '确认入库';
    $('operator').placeholder = type === 'out' ? '领用人姓名或工号' : '经办人姓名或工号';
    setTimeout(function () { $('scan').focus(); }, 50);
  }

  function boot() {
    setType(state.type);
    loadOperators();
    loadRecent();
    ping();
    setInterval(function () {
      if (document.visibilityState === 'visible') ping();
    }, 30000);
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('loginBtn').onclick = doLogin;
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

    /* 输入法(IME)保护：PDA 的 Android 浏览器若激活中文输入法，扫码枪键入的
     * 内容会先进组合输入状态，此时 input.value 为空 / 不完整，600ms 防抖触发
     * 检索时会拿到空关键字 → 界面静默恢复「等待扫码…」，看起来像「扫不出」。
     * 组合期间跳过检索，组合结束（扫码内容真正上屏）后立即检索一次。 */
    var composing = false;
    $('scan').addEventListener('compositionstart', function () { composing = true; });
    $('scan').addEventListener('compositionend', function () {
      composing = false;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 80);
    });
    $('scan').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); search(); }
    });
    $('scan').addEventListener('input', function () {
      if (composing) return;
      clearTimeout(searchTimer);
      var v = $('scan').value.trim();
      if (!v) { clearPart(); hint('', ''); return; }
      searchTimer = setTimeout(search, 600);
    });

    /* 失焦自愈：#scan 失焦后扫码枪键入会直接打到页面上（界面停在「等待扫码…」
     * 毫无反应，重进页面才能恢复）。焦点落在其它输入控件时不抢焦点；落空则拉回。 */
    $('scan').addEventListener('blur', function () {
      setTimeout(function () {
        var ae = document.activeElement;
        if (ae && (ae.id === 'scan' || ae.id === 'operator' || ae.id === 'qty' ||
                   ae.id === 'remark' || ae.id === 'pin')) return;
        try { $('scan').focus(); } catch (err) { /* 忽略 */ }
      }, 300);
    });

    /* 全局扫码兜底（v3.0.7）：熄屏再点亮等场景下焦点恢复不可靠（实测 v3.0.6 的
     * 失焦自愈 + visibilitychange 聚焦仍会漏），扫码枪键入会散落在页面上。
     * 扫码枪是高速键入（键间隔 <30ms），人工打字做不到——在 document 级捕获
     * 「高速连续可打印字符 + 回车」特征序列，无论焦点在哪都组装出来按扫码处理。 */
    var scanBuf = '', scanLastT = 0;
    document.addEventListener('keydown', function (e) {
      if ($('app').hidden) return;                       /* 未登录不处理 */
      var t = e.target;
      if (t === $('scan')) return;                       /* 焦点在扫码框走原有 input 流 */
      if (t && t !== document.body && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      var now = Date.now();
      if (now - scanLastT > 200) scanBuf = '';           /* 键间隔过大：重新累计 */
      scanLastT = now;
      if (e.key === 'Enter') {
        if (scanBuf.length >= 4) {
          var code = scanBuf;
          scanBuf = '';
          $('scan').value = code;                        /* 回填扫码框，界面可见可追溯 */
          clearTimeout(searchTimer);
          search();
          e.preventDefault();
        } else {
          scanBuf = '';
        }
        return;
      }
      if (e.key && e.key.length === 1) scanBuf += e.key; /* 只累计可打印字符 */
    });

    /* 周期焦点保活：亮屏/解锁后浏览器焦点时序不可靠（visibilitychange 单次 focus
     * 可能被系统夺回），每 2.5s 巡检一次——焦点不在任何输入控件时拉回扫码框。 */
    setInterval(function () {
      if (document.visibilityState !== 'visible' || $('app').hidden) return;
      var ae = document.activeElement;
      if (ae && (ae === $('scan') || ae.id === 'operator' || ae.id === 'qty' ||
                 ae.id === 'remark' || ae.id === 'pin')) return;
      try { $('scan').focus(); } catch (err) { /* 忽略 */ }
    }, 2500);

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.onclick = function () { setType(b.getAttribute('data-type')); };
    });

    $('operator').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    /* 焦点离开时把工号换成姓名（扫工牌/手输工号都能落到人名上） */
    $('operator').addEventListener('blur', resolveOpField);
    $('operator').addEventListener('change', resolveOpField);

    $('qtyMinus').onclick = function () {
      var v = parseFloat($('qty').value) || 0;
      $('qty').value = String(Math.max(1, v - 1));
    };
    $('qtyPlus').onclick = function () {
      var v = parseFloat($('qty').value) || 0;
      $('qty').value = String(v + 1);
    };

    $('submit').onclick = submit;

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !$('app').hidden) {
        ping();
        /* 从后台回到前台时把扫码框拉回焦点，避免第一次扫码没反应 */
        setTimeout(function () { try { $('scan').focus(); } catch (err) { /* 忽略 */ } }, 200);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    bind();
    state.token = localStorage.getItem(TOKEN_KEY) || '';
    ping().then(function (j) {
      if (!j || !j.ok) { showLogin(''); return; }
      if (!state.token) { showLogin(''); return; }
      // 用轻量接口验证令牌是否仍有效
      return api('/api/operators').then(function (r) {
        if (r._status === 401) { showLogin('登录已失效，请重新输入 PIN'); return; }
        hideLogin();
        boot();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
