/* ============================================================
 * app.js — 备件仓库管理系统 主逻辑
 * 依赖 db.js（IndexedDB 数据层）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* 健壮数值解析：兼容「以零开头（01）」「全角数字（０１）」「带空格/千分位逗号」等格式，
     始终返回安全数字，绝不会因输入格式导致 NaN / 崩溃。 */
  const num = (v, fallback = 0) => {
    if (v == null) return fallback;
    let s = String(v);
    s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角→半角
    s = s.replace(/[　\s,，]/g, ''); // 去空格 / 全角空格 / 千分位逗号
    if (s === '' || s === '-' || s === '+' || s === '.' || s === '-.' || s === '+.') return fallback;
    const n = parseFloat(s);
    return (isNaN(n) || !isFinite(n)) ? fallback : n;
  };
  const pad = (n) => String(n).padStart(2, '0');

  function nowInput() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function inputToMs(v) { return v ? new Date(v).getTime() : Date.now(); }
  function msToInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /* 重渲染时保留输入框焦点与光标位置（避免搜索框每输入一字就失焦） */
  function withFocusPreserved(fn) {
    const a = document.activeElement;
    const id = a && a.id;
    const pos = (a && a.selectionStart != null) ? a.selectionStart : null;
    fn();
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        if (pos != null && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (e) {} }
      }
    }
  }

  /* IME 安全实时筛选：输入框本身【绝不重建】，只刷新独立的结果容器；
     中文输入法组合（composition）进行中跳过刷新，组合结束后再刷新，
     彻底避免「每按一键重复出现两个英文字母 / 中文无法上屏」的问题。 */
  function bindLiveFilter(id, resultsFn) {
    const el = document.getElementById(id);
    if (!el) return;
    let composing = false;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; resultsFn(); });
    el.addEventListener('input', () => { if (composing) return; resultsFn(); });
  }

  let toastTimer = null;
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* 全局错误兜底：任何未捕获错误都显式展示在页面上，避免“白屏无提示”让人误以为程序坏了 */
  function showFatal(msg) {
    const c = $('#content');
    if (!c) return;
    if (!c.textContent.trim()) {
      c.innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">页面运行出错</div>
        <p>${esc(msg)}</p>
        <p class="muted">若是双击打开的本地文件，请用最新版 Chrome/Edge 打开；若仍异常，可改用本地服务器（见 README 说明）。</p>
      </div>`;
    } else {
      toast('出错：' + msg, 'err');
    }
  }
  window.addEventListener('error', (e) => {
    if (e && e.target && e.target !== window) return; // 资源加载错误（图片/脚本 404）忽略，避免误报
    showFatal((e && e.message) || '未知脚本错误');
  });
  window.addEventListener('unhandledrejection', (e) => {
    showFatal((e && e.reason && (e.reason.message || e.reason)) || '未处理的异步错误');
  });

  /* ---------------- 全局状态 ---------------- */
  const state = { view: 'dashboard', parts: [], transactions: [], locFilter: '', scanResolve: null, qrPart: null, operators: [], customCategories: [], customUnits: [], stSelectedId: 0, qySelectedId: 0, qyQuery: '', locationAudits: [], fixtures: [], fixTransactions: [], fixSelectedId: 0 };

  /* ---------------- 数据加载 ---------------- */
  async function reloadAll() {
    state.parts = await DB.getAll('parts');
    state.transactions = await DB.getAll('transactions');
    state.fixtures = await DB.fixtureGetAll();
    state.fixTransactions = await DB.fixtureGetTransactions();
  }

  /* ---------------- 库存状态 ---------------- */
  function stockStatus(p) {
    if (p.stock <= 0) return { cls: 'danger', text: '缺货' };
    if (p.safeStock > 0 && p.stock < p.safeStock) return { cls: 'warn', text: '预警' };
    return { cls: 'ok', text: '正常' };
  }

  /* 自然排序（按编号/名称升序，数字按数值而非字符序，如 A-2 < A-10） */
  function natCompare(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  }
  /* 库位列表排序：真实库位编号升序，「（未分配）」始终置于末尾，便于浏览查找 */
  function locSort(keys) {
    const UNASSIGNED = '（未分配）';
    return keys.sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return natCompare(a, b);
    });
  }

  /* ============================================================
   * 模态框
   * ============================================================ */
  function openModal(title, bodyHtml) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modalOverlay').hidden = false;
  }
  function closeModal() { if (typeof stopScanCam === 'function') stopScanCam(); $('#modalOverlay').hidden = true; $('#modalBody').innerHTML = ''; state.scanResolve = null; }

  /* ============================================================
   * CSV 解析 / 生成 / 下载
   * ============================================================ */
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(headers, rows) {
    const lines = [headers.map(csvCell).join(',')];
    rows.forEach((r) => lines.push(r.map(csvCell).join(',')));
    return '﻿' + lines.join('\r\n');
  }
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  /* ============================================================
   * 视图切换
   * ============================================================ */
  const VIEW_TITLES = {
    dashboard: '仪表盘', parts: '备品管理', inbound: '入库管理', outbound: '出库管理',
    query: '备件查询', location: '库位管理', records: '记录查询', data: '数据备份与恢复',
    fixtures: '夹具管理'
  };
  const RENDERERS = {
    dashboard: renderDashboard, parts: renderParts, inbound: renderInbound,
    outbound: renderOutbound, query: renderQuery, location: renderLocation,
    records: renderRecords, data: renderData, fixtures: renderFixtures
  };

  function showView(name) {
    state.view = name;
    $('#viewTitle').textContent = VIEW_TITLES[name] || '';
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#content').scrollTop = 0;
    renderTopStats();
    (RENDERERS[name] || renderDashboard)();
  }

  function renderTopStats() {
    const warn = state.parts.filter((p) => p.safeStock > 0 && p.stock < p.safeStock).length;
    const out = state.parts.filter((p) => p.stock <= 0).length;
    const fixOut = state.fixtures.filter((f) => f.status === 'checked_out').length;
    $('#topStats').innerHTML =
      `备品种类 <b>${state.parts.length}</b> ｜ 预警 <b style="color:${warn ? 'var(--warn)' : ''}">${warn}</b> ｜ 缺货 <b style="color:${out ? 'var(--danger)' : ''}">${out}</b> ｜ 夹具在库 <b>${state.fixtures.filter((f) => f.status === 'stocked').length}</b> ｜ 夹具已出库 <b style="color:var(--warn)">${fixOut}</b>`;
  }

  /* ============================================================
   * 仪表盘
   * ============================================================ */
  function renderDashboard() {
    const warnList = state.parts
      .filter((p) => p.safeStock > 0 && p.stock < p.safeStock)
      .sort((a, b) => (b.safeStock - b.stock) - (a.safeStock - a.stock));
    const today = todayStart();
    const todayTx = state.transactions.filter((t) => t.time >= today).length;
    const warnCount = warnList.length;
    const outCount = state.parts.filter((p) => p.stock <= 0).length;
    const recent = state.transactions.slice().sort((a, b) => b.time - a.time).slice(0, 10);

    const be = DB.currentBackend();
    const backendLabel = be === 'idb' ? 'IndexedDB（本地数据库）'
      : be === 'ls' ? 'localStorage（浏览器本地）'
      : be === 'electron-file' ? '本地文件（JSON）'
      : '未就绪';
    const html = `
      <div class="store-bar">🗄️ 数据存储方式：<b>${backendLabel}</b>　<span class="muted">数据存于本机，定期在「数据备份」导出 JSON 备份。</span></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">备品种类</div><div class="value">${state.parts.length}</div></div>
        <div class="stat-card ${warnCount ? 'warn' : ''}"><div class="label">库存预警</div><div class="value">${warnCount}</div></div>
        <div class="stat-card ${outCount ? 'danger' : ''}"><div class="label">缺货</div><div class="value">${outCount}</div></div>
        <div class="stat-card"><div class="label">今日出入库</div><div class="value">${todayTx}</div></div>
      </div>
      <div class="panel">
        <div class="panel-title">库存预警（低于安全库存）</div>
        ${warnList.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>名称</th><th>规格</th><th>当前库存</th><th>安全库存</th><th>缺口</th><th>状态</th></tr></thead>
          <tbody>
            ${warnList.slice(0, 12).map((p) => {
              const st = stockStatus(p);
              return `<tr>
                <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.spec)}</td>
                <td>${p.stock}</td><td>${p.safeStock}</td><td>${Math.max(0, p.safeStock - p.stock)}</td>
                <td><span class="badge ${st.cls}">${st.text}</span></td></tr>`;
            }).join('')}
          </tbody>
        </table></div>` : '<div class="empty">暂无预警项，库存状况良好 🎉</div>'}
      </div>
      <div class="panel">
        <div class="panel-title">最近流水</div>
        ${recent.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>类型</th><th>编号</th><th>名称</th><th>数量</th><th>经办人</th><th>时间</th></tr></thead>
          <tbody>
            ${recent.map((t) => `<tr>
              <td><span class="badge ${t.type === 'in' ? 'ok' : 'muted'}">${t.type === 'in' ? '入库' : '出库'}</span></td>
              <td>${esc(t.partCode)}</td><td>${esc(t.partName)}</td><td>${t.quantity}</td>
              <td>${esc(t.operator)}</td><td>${fmtTime(t.time)}</td></tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="empty">暂无出入库记录</div>'}
      </div>`;
    $('#content').innerHTML = html;
  }

  /* ============================================================
   * 备品管理
   * ============================================================ */
  function renderParts() {
    const cats = [...new Set(state.parts.map((p) => p.category).filter(Boolean))].sort();
    const catOpts = `<option value="">全部分类</option>` + cats.map((c) => `<option>${esc(c)}</option>`).join('');

    const html = `
      <div class="tip">提示：可通过「下载模板」获取 CSV，填好约 600 种备品后「导入 CSV」批量录入；也可逐条「新增备品」。</div>
      <div class="filter-bar">
        <div class="field"><label>搜索（名称/编号/规格/分类）</label><input id="partSearch" placeholder="输入关键字" autocomplete="off"></div>
        <div class="field"><label>分类</label><select id="partCat">${catOpts}</select></div>
        <div class="spacer"></div>
        <button class="btn" onclick="openPartModal()">＋ 新增备品</button>
        <button class="btn ghost" onclick="batchPrintLabels()">🏷 批量打印标签</button>
        <button class="btn ghost" onclick="downloadPartTemplate()">下载模板</button>
        <button class="btn ghost" onclick="importPartsClick()">导入 CSV</button>
        <button class="btn ghost" onclick="exportParts()">导出 CSV</button>
        <input type="file" id="partFile" accept=".csv,text/csv" hidden onchange="importPartsFile(this)">
      </div>
      <div id="partResults"></div>`;
    $('#content').innerHTML = html;
    $('#partCat').addEventListener('change', renderPartsResults);
    bindLiveFilter('partSearch', renderPartsResults);
    renderPartsResults();
  }

  function renderPartsResults() {
    const q = ($('#partSearch')?.value || '').trim().toLowerCase();
    const cat = ($('#partCat')?.value || '');
    let list = state.parts.slice();
    if (q) list = list.filter((p) => (p.name + p.code + p.spec + p.category).toLowerCase().includes(q));
    if (cat) list = list.filter((p) => p.category === cat);
    list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const html = `
      <div class="panel" style="margin-bottom:0">
        <div class="table-wrap"><table>
          <thead><tr>
            <th>编号</th><th>名称</th><th>规格</th><th>分类</th><th>单位</th>
            <th>库位</th><th>安全库存</th><th>当前库存</th><th>状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            ${list.length ? list.map((p) => {
              const st = stockStatus(p);
              return `<tr>
                <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.spec)}</td>
                <td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td>${esc(p.location)}</td>
                <td>${p.safeStock}</td><td><b>${p.stock}</b></td>
                <td><span class="badge ${st.cls}">${st.text}</span></td>
                <td class="btn-row">
                  <button class="btn sm ghost" onclick="openPartModal(${p.id})">编辑</button>
                  <button class="btn sm ghost" onclick="openPartQR(${p.id})">二维码</button>
                  <button class="btn sm danger" onclick="deletePart(${p.id})">删除</button>
                </td></tr>`;
            }).join('') : `<tr><td colspan="10" class="empty">暂无备品，点击「新增备品」或「导入 CSV」开始</td></tr>`}
          </tbody>
        </table></div>
        <div class="small muted mt">共 ${list.length} 条</div>
      </div>`;
    $('#partResults').innerHTML = html;
  }

  /* ============================================================
   * 组合下拉框（自定义可持久化）
   *   - 预设选项 + 持久化自定义选项 + “自定义…”入口
   *   - 选择“自定义…”后弹出输入框，确认即加入选项列表并写入本地存储（刷新保留）
   *   - 选项过多时弹层列表限高 + 滚动条（#4）
   * ============================================================ */
  const CATEGORY_PRESETS = ['电气', '机械', '液压'];
  const UNIT_PRESETS = ['个', '件', '米'];
  const COMBO_META = { f_category: 'customCategories', f_unit: 'customUnits' };

  function comboPresets(name) { return name === 'f_unit' ? UNIT_PRESETS : CATEGORY_PRESETS; }
  function comboCustomArr(name) { const k = COMBO_META[name]; return (k && state[k] && Array.isArray(state[k])) ? state[k] : []; }

  /* 组合控件 HTML：渲染 触发按钮 + 弹层（选项列表 + 自定义输入行 + “自定义…”入口）+ 隐藏字段
     hidden 字段 id 保持为 name（如 f_category），submitPart 无需改动 */
  function comboHtml(name, currentValue, presets, fieldName) {
    const all = presets.concat(comboCustomArr(name));
    const cur = currentValue || '';
    const extra = (cur && all.indexOf(cur) === -1) ? [cur] : [];   // 编辑回显：历史自定义值不在列表中时补一项
    const opts = all.concat(extra);
    const placeholder = '-- 请选择' + fieldName + ' --';
    const optionsHtml = opts.map(v =>
      `<div class="combo-option${v === cur ? ' selected' : ''}" data-val="${esc(v)}" onclick="comboSelect('${name}', this)">${esc(v)}</div>`
    ).join('');
    return `
      <div class="combo" id="combo_${name}">
        <div class="combo-trigger" id="${name}_trigger" onclick="comboToggle('${name}')" tabindex="0">
          <span class="combo-value${cur ? '' : ' placeholder'}" id="${name}_text">${esc(cur || placeholder)}</span>
          <span class="combo-arrow">▾</span>
        </div>
        <div class="combo-popup" id="${name}_popup" hidden>
          <div class="combo-list" id="${name}_list">${optionsHtml}</div>
          <div class="combo-custom" id="${name}_customwrap" hidden>
            <input id="${name}_new" placeholder="输入新${esc(fieldName)}" onkeydown="if(event.key==='Enter')comboAddCustom('${name}')">
            <button type="button" class="btn sm" onclick="comboAddCustom('${name}')">确定</button>
            <button type="button" class="btn ghost sm" onclick="comboCancelCustom('${name}')">取消</button>
          </div>
          <div class="combo-add-entry" onclick="comboOpenCustom('${name}')">＋ 自定义…</div>
        </div>
        <input type="hidden" id="${name}" value="${esc(cur)}">
      </div>`;
  }

  /* 重渲染选项列表（用于新增自定义项后，将新值高亮选中） */
  function renderComboList(name, selectedVal) {
    const presets = comboPresets(name);
    const arr = comboCustomArr(name).slice();
    const hidden = document.getElementById(name);
    const cur = hidden ? hidden.value : '';
    if (cur && presets.indexOf(cur) === -1 && arr.indexOf(cur) === -1 && cur !== selectedVal) arr.unshift(cur);
    const opts = presets.concat(arr);
    const list = document.getElementById(name + '_list');
    if (!list) return;
    list.innerHTML = opts.map(v =>
      `<div class="combo-option${v === selectedVal ? ' selected' : ''}" data-val="${esc(v)}" onclick="comboSelect('${name}', this)">${esc(v)}</div>`
    ).join('');
  }

  /* 展开/收起弹层，并按可用空间自动决定向下或向上展开（避免被模态框裁切） */
  window.comboToggle = function (name) {
    const popup = document.getElementById(name + '_popup');
    const combo = document.getElementById('combo_' + name);
    if (!popup) return;
    if (popup.hidden) {
      closeAllCombos(name);
      popup.hidden = false;
      if (combo) combo.classList.add('open');
      positionComboPopup(name);
      const cw = document.getElementById(name + '_customwrap');
      if (cw) cw.hidden = true;
    } else {
      popup.hidden = true;
      if (combo) combo.classList.remove('open');
    }
  };

  function positionComboPopup(name) {
    const trigger = document.getElementById(name + '_trigger');
    const popup = document.getElementById(name + '_popup');
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const estH = Math.min(260, popup.scrollHeight || 260);
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < estH + 12) { popup.style.top = 'auto'; popup.style.bottom = 'calc(100% + 4px)'; }
    else { popup.style.top = 'calc(100% + 4px)'; popup.style.bottom = 'auto'; }
  }

  /* 关闭所有下拉弹层（except 指定的除外） */
  window.closeAllCombos = function (except) {
    ['f_category', 'f_unit'].forEach((n) => {
      if (n === except) return;
      const p = document.getElementById(n + '_popup');
      const c = document.getElementById('combo_' + n);
      if (p && !p.hidden) p.hidden = true;
      if (c) c.classList.remove('open');
    });
  };

  /* 选择一个选项：写入隐藏字段、更新显示、关闭弹层 */
  window.comboSelect = function (name, el) {
    const val = el.getAttribute('data-val');
    const hidden = document.getElementById(name);
    if (hidden) hidden.value = val;
    const text = document.getElementById(name + '_text');
    if (text) { text.textContent = val; text.classList.remove('placeholder'); }
    const list = document.getElementById(name + '_list');
    if (list) Array.from(list.children).forEach((c) => c.classList.remove('selected'));
    el.classList.add('selected');
    const popup = document.getElementById(name + '_popup');
    if (popup) popup.hidden = true;
    const combo = document.getElementById('combo_' + name);
    if (combo) combo.classList.remove('open');
  };

  /* 展开自定义输入行 */
  window.comboOpenCustom = function (name) {
    const cw = document.getElementById(name + '_customwrap');
    if (cw) {
      cw.hidden = false;
      const inp = document.getElementById(name + '_new');
      if (inp) { inp.value = ''; inp.focus(); }
    }
  };

  /* 收起自定义输入行 */
  window.comboCancelCustom = function (name) {
    const cw = document.getElementById(name + '_customwrap');
    if (cw) { cw.hidden = true; const inp = document.getElementById(name + '_new'); if (inp) inp.value = ''; }
  };

  /* 确认新增自定义项：校验 → 写入 state 并持久化 → 重渲染列表并选中 */
  window.comboAddCustom = async function (name) {
    const inp = document.getElementById(name + '_new');
    const val = inp ? inp.value.trim() : '';
    const fieldLabel = name === 'f_unit' ? '单位' : '分类';
    if (!val) { toast('请输入自定义' + fieldLabel, 'err'); if (inp) inp.focus(); return; }
    const presets = comboPresets(name);
    if (presets.indexOf(val) !== -1) { toast('该' + fieldLabel + '已在预设中', 'err'); if (inp) inp.focus(); return; }
    if (comboCustomArr(name).indexOf(val) !== -1) { toast('该' + fieldLabel + '已添加', 'err'); if (inp) inp.focus(); return; }
    const k = COMBO_META[name];
    if (!state[k]) state[k] = [];
    state[k].push(val);
    try { await DB.setMeta(k, state[k]); }
    catch (e) { toast('保存失败：' + (e && e.message || e), 'err'); return; }
    renderComboList(name, val);
    const hidden = document.getElementById(name);
    if (hidden) hidden.value = val;
    const text = document.getElementById(name + '_text');
    if (text) { text.textContent = val; text.classList.remove('placeholder'); }
    const cw = document.getElementById(name + '_customwrap');
    if (cw) cw.hidden = true;
    const popup = document.getElementById(name + '_popup');
    if (popup && !popup.hidden) positionComboPopup(name);
    toast('已添加并保存：' + val, 'ok');
  };

  function partFormHtml(p) {
    p = p || {};
    /* 编号：系统自动按 1001 起顺序分配、只读；新增时预填下一个号并支持「重新分配」 */
    const codeField = p.id
      ? `<input id="f_code" value="${esc(p.code || '')}" readonly>`
      : `<div class="input-with-btn">
            <input id="f_code" value="${esc(nextPartCode())}" readonly placeholder="系统自动分配 4 位编号，如 1001">
            <button type="button" class="btn ghost sm" onclick="generatePartCode()" title="重新分配下一个编号">↻ 重新分配</button>
          </div>`;
    return `
      <div class="field-grid">
        <div class="field">
          <label>编号 *（系统自动分配）</label>
          ${codeField}
        </div>
        <div class="field"><label>名称 *</label><input id="f_name" value="${esc(p.name || '')}"></div>
        <div class="field"><label>规格</label><input id="f_spec" value="${esc(p.spec || '')}"></div>
        <div class="field">
          <label>分类</label>
          ${comboHtml('f_category', p.category || '', CATEGORY_PRESETS, '分类')}
        </div>
        <div class="field">
          <label>单位</label>
          ${comboHtml('f_unit', p.unit || '', UNIT_PRESETS, '单位')}
        </div>
        <div class="field"><label>库位</label><input id="f_location" value="${esc(p.location || '')}" placeholder="如 A-01-03"></div>
        <div class="field"><label>安全库存</label><input id="f_safe" type="number" min="0" value="${p.safeStock != null ? p.safeStock : 0}"></div>
        <div class="field"><label>当前库存${p.id ? '（直接修改不生成流水）' : ''}</label><input id="f_stock" type="number" min="0" value="${p.stock != null ? p.stock : 0}"></div>
      </div>
      <div class="field"><label>备注或用途</label><textarea id="f_remark" rows="2">${esc(p.remark || '')}</textarea></div>
      <div class="btn-row mt">
        <button class="btn" onclick="submitPart(${p.id || null})">保存</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>`;
  }

  window.openPartModal = function (id) {
    const p = id ? state.parts.find((x) => x.id === id) : null;
    openModal(id ? '编辑备品' : '新增备品', partFormHtml(p));
  };

  /* 关于 / About 面板（滚动布局 + 全部历史版本变更记录） */
  function aboutHtml() {
    return `
      <div class="about-panel">
        <div class="about-scroll">
          <h3 class="about-h">变更日记</h3>
          <h4 class="about-ver">v2.32</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览改为十列网格（三行可视）</strong>：库位卡片网格由 12 列等宽改为 <b>10 列等宽</b>布局（grid-template-columns: repeat(10,1fr)），其余保持三行可视、内容区域可上下滑动垂直浏览全部库位（共 115 个），卡片随容器宽度自适应缩放、按行列规则整齐排列；卡片仍仅显示库位编号（如 A1-03-02），悬停可查看件数与预警信息；点选库位后纵向滚动位置保持不变。</li>
            <li>版本号升级至 <strong>2.32</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.31</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览改为十二列网格（三行可视）</strong>：库位卡片网格由三列改为 <b>12 列等宽</b>布局（grid-template-columns: repeat(12,1fr)），并固定为 <b>三行可视</b>、内容区域可上下滑动垂直浏览全部库位（共 115 个），卡片随容器宽度自适应缩放、按行列规则整齐排列；卡片仍仅显示库位编号（如 A1-03-02），悬停可查看件数与预警信息；点选库位后纵向滚动位置保持不变。</li>
            <li>版本号升级至 <strong>2.31</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.30</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览改为三列网格 + 垂直滚动</strong>：库位卡片由横向滑动条改为三列等宽网格（repeat(3,1fr)），内容区域可上下滑动垂直浏览全部库位，布局紧凑、滑动流畅并适配不同屏宽；卡片仅显示库位编号（如 A1-03-02），移除了下方件数/预警小数字以保持界面简洁（悬停仍可查看件数与预警信息）；点选库位后纵向滚动位置保持不变。</li>
            <li>版本号升级至 <strong>2.30</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.29</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览改为上下分屏 + 横向滑动小卡片</strong>：库位卡片尺寸缩小至约原 1/4（约 60×46px），上方库位区改为单行横向滑动浏览（scroll-snap，每行可容纳更多库位），下方展示所选库位对应的具体物品列表；点选库位后上方横向位置保持不变，整体紧凑且操作流畅。连续编号 001–NNN 与库存预警徽章均保留。</li>
            <li>版本号升级至 <strong>2.29</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.28</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览改为连续编号卡片网格</strong>：库位总览由表格改为统一尺寸方框（卡片）网格，每行固定 8 个、等宽等高、排满自动换行；所有库位按新的连续编号方案（001 起递增）重新排序与展示，卡片显示编号 / 备品件数 / 库存预警，点击筛选、当前库位高亮；原混杂编码（如 1-1-1、1-2-1上、A1-02-03）已统一迁移为 001–NNN 连续编号（数据自动迁移，旧货架标签需按映射表重打）。</li>
            <li>版本号升级至 <strong>2.28</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.27</h4>
          <ul class="about-list">
            <li><strong>【优化】库位总览布局与排序</strong>：库位总览由换行过滤按钮改为统一表格（库位 / 备品件数 / 库存预警 / 操作），按库位编号自然升序排列（数字按数值序，如 A-2 &lt; A-10），「（未分配）」置于末尾；行可点击筛选、当前库位高亮，布局对齐整齐、便于快速浏览查找。</li>
            <li>版本号升级至 <strong>2.27</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.26</h4>
          <ul class="about-list">
            <li><strong>【优化】「清除已选内容」按钮视觉样式</strong>：由白色 Ghost 样式改为页面统一的主色蓝（与其他 .btn 主按钮一致）——蓝色背景、白色文字、相同圆角/字号/内边距，悬停时统一加深为主色深色，避免风格突兀。</li>
            <li>版本号升级至 <strong>2.26</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.25</h4>
          <ul class="about-list">
            <li><strong>【新增】入库/出库「清除已选内容」按钮</strong>：选中备品后，编号/名称/规格/库位四栏均被回填；若仅改其中一栏再检索，其余三栏残留值会作为 AND 过滤条件锁死结果（旧 code/库位仍匹配原备品），导致无法按新条件刷新列表。新增「清除已选内容」按钮，一键清空四栏与检索结果、重置提示，便于基于新检索条件重新查询。</li>
            <li>版本号升级至 <strong>2.25</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.24</h4>
          <ul class="about-list">
            <li><strong>【修复】入库/出库「选择」按钮报错 + 编号自动填充</strong>：结果列表行的「选择」按钮原调用未定义的 <code>in_pick/out_pick</code>，点击即抛 <code>ReferenceError</code> 且字段不回填；改为调用已挂载的 <code>inbound_pick/outbound_pick</code>。同时修复手动填写编号时因聚焦字段被刻意跳过导致编号不规整回填的问题，命中唯一备品时始终回填规范编号。</li>
            <li>版本号升级至 <strong>2.24</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.23</h4>
          <ul class="about-list">
            <li><strong>【修复】备件查询结果点击展开异常</strong>：详情由原「嵌套在结果表 tbody 内（tr 内再嵌 table）」改为「结果表下方的独立容器」渲染，规避 Chromium 在 display 切换时内层表格布局不刷新的错位/塌陷问题，点击任意结果行可稳定展开明细。</li>
            <li><strong>【移除】库位管理「手动库位盘点」</strong>：移除打印清单入口（「📋 手工盘点」CSV 导出保留）；导出时的「盘点人」改为点击导出时录入（预填上次记忆值），取消则中止导出。</li>
            <li>版本号升级至 <strong>2.23</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.22</h4>
          <ul class="about-list">
            <li><strong>【优化】库位管理「手工盘点」导出</strong>：由「按库位聚合」改为「按备品逐项明细」导出；列含编号 / 名称 / 规格 / 分类 / 单位 / 库位 / 安全库存 / 当前库存 / 状态 / 盘点人（盘点人由导出时录入）。</li>
            <li>版本号升级至 <strong>2.22</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.21</h4>
          <ul class="about-list">
            <li><strong>【移除】备件查询「扫码盘点」</strong>：删除备件查询页顶部的「📷 扫码盘点」按钮及对应函数；备件明细内的「🧮 盘点此备件」手动盘点入口保留。</li>
            <li><strong>【新增】库位管理「手工盘点」导出</strong>：库位管理新增「📋 手工盘点」按钮，实现逻辑与备件查询「导出 CSV」一致，点击将库位聚合数据（库位号 / 件数 / 盘点人）导出为 CSV 文件。</li>
            <li>版本号升级至 <strong>2.21</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.20</h4>
          <ul class="about-list">
            <li><strong>【功能更名 + 打印清单】手动库位盘点</strong>：「库位管理」中「库位盘点」更名为「手动库位盘点」，点击直达打印清单页；按库位列出「已完成 / 库位号 / 件数 / 盘点人」四列，勾选框标记已盘点，一键生成 A4 纸质盘点表（含签字栏）。</li>
            <li>版本号升级至 <strong>2.20</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.19</h4>
          <ul class="about-list">
            <li><strong>【功能新增】库位盘点</strong>：在「库位管理」模块新增「库位盘点」入口，进入盘点表填写盘点人与盘点日期，逐项勾选确认并输入实际数量，系统自动计算差异（正差异绿色 / 负差异红色）；提交后保存记录，支持打印生成含盘点人 / 复核人签名空位的标准盘点表。</li>
            <li>版本号升级至 <strong>2.19</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.18</h4>
          <ul class="about-list">
            <li><strong>【功能升级】入库/出库「四栏互查」检索</strong>：登记入库、登记出库均新增「名称」「规格」检索栏，与「备品编号」「库位号」构成四栏互查——任一栏输入/扫码即检索，命中唯一备品自动回填其余三栏，多命中在「检索结果」列表点选回填。</li>
            <li><strong>「检索结果」列表替代「最近入库/出库记录」</strong>：原固定流水面板改为直接以检索结果列表展示（含编号/名称/规格/库位/库存/状态 + 选择），检索为空时给出提示；提交按任意已填检索栏解析目标备品。</li>
            <li><strong>【缺陷修复】备品建档闪退（以零开头编号兼容）</strong>：<code>num()</code> 数值解析全面加固，兼容以零开头（<code>01</code>）、全角数字、空格、千分位逗号等格式，始终返回安全数字，杜绝输入格式导致的 <code>NaN</code>/崩溃；安全库存、库存、出入库数量均走该健壮解析。</li>
            <li>出库管理交互与数据逻辑同步与入库保持一致。</li>
            <li>版本号升级至 <strong>2.18</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.17</h4>
          <ul class="about-list">
            <li><strong>【缺陷修复】记录查询兼容扫描枪二维码前缀</strong>：记录查询的「备品名称/编号」搜索框，现在会先剥离二维码前缀 <code>SPMS1|</code> / <code>SPMS|</code> 再进行匹配；即使扫描枪把完整二维码内容（如 <code>spms1|1045</code>）键盘模拟进输入框，也能正确检索到编号为 <code>1045</code> 的流水记录，跨设备行为统一。</li>
            <li>为该搜索框增加 📷 扫码按钮，与入库/出库/备件查询的扫码体验保持一致。</li>
            <li>版本号升级至 <strong>2.17</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.16</h4>
          <ul class="about-list">
            <li><strong>【功能新增】打印选项与预览</strong>：批量打印标签 / 单个标签打印新增<strong>打印设置面板</strong>——可选<strong>纸张尺寸</strong>（A4 / A5 / 小票纸 58mm / 小票纸 80mm / 标签纸 100×150mm / 自定义宽高）、<strong>水平对齐</strong>（左 / 居中 / 右）、<strong>垂直对齐</strong>（顶部 / 居中 / 底部）、<strong>页边距</strong>（上下左右 mm）与份数；设置通过 <code>localStorage</code> 记忆，下次打开自动恢复。</li>
            <li><strong>打印预览</strong>：弹窗内按所选纸张比例与对齐方式<strong>实时模拟</strong>打印效果（WYSIWYG），所见即所得，避免小纸张上内容偏位。</li>
            <li><strong>底层改造</strong>：打印改由主进程 <code>webContents.print()</code> 接管，按纸张尺寸（微米）精确送印，配合 <code>@media print</code> 的 flex 居中布局，确保<strong>不同纸张规格下内容正确居中</strong>（解决此前小纸张无法居中的问题）。</li>
            <li>版本号升级至 <strong>2.16</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.15</h4>
          <ul class="about-list">
            <li><strong>【调整】备件编号位数调整</strong>：在 v2.14「编号统一管理方案」基础上，将编号格式由 <strong>6 位纯数字（100001 起）</strong> 调整为 <strong>4 位纯数字（1001 起）</strong>，其余设定（自动顺序分配、只读预填、一次性迁移、扫码/二维码兼容、CSV 导入适配）保持不变。已迁移的 6 位号在首次打开时自动重排为 4 位号（1001…），流水显示编号同步更新，历史不丢。</li>
            <li>版本号升级至 <strong>2.15</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.14</h4>
          <ul class="about-list">
            <li><strong>【功能升级】备件编号统一管理方案</strong>：所有备品编号统一为<strong>纯数字</strong>格式，彻底解决扫描枪因编号含字母/连字符/长度不一导致的识别与匹配问题，标签也更简洁可读。</li>
            <li><strong>自动顺序分配</strong>：新建备品时系统按<strong>顺序递增</strong>自动分配编号（当前最大号 +1），保证<strong>唯一、无重复、无随机跳号</strong>；建档编号框改为<strong>只读预填</strong>，仅保留「↻ 重新分配」按钮取下一个号。</li>
            <li><strong>一次性数据迁移</strong>：首次打开存量数据时，历史非纯数字编号（如 <code>BJ-001</code>、<code>SP20240101-001</code>）被自动重排为顺序数字号（按建档顺序稳定映射）；<strong>流水记录的显示编号同步更新，partId 关联不变，历史不丢</strong>。迁移幂等，重跑无害。</li>
            <li><strong>CSV 导入适配</strong>：导入模板与数据中的编号若非合法/唯一数字，自动分配下一个号。</li>
            <li><strong>扫码 / 二维码兼容</strong>：二维码内容仍为 <code>SPMS1|&lt;编号&gt;</code>，扫描枪读取后剥离前缀即得数字编号，匹配更稳定；标签显示同步更新。<em>注意：旧版已打印的标签编码的是旧编号，升级后需用「批量打印」重新打印。</em></li>
            <li>版本号升级至 <strong>2.14</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.13</h4>
          <ul class="about-list">
            <li><strong>【Bug 修复】备品编号连字符 / 大小写差异导致查不到</strong>：扫描枪或手动录入的编号若与库中编号存在分隔符差异（如扫描得到 <code>BJ003</code> 而库中为 <code>BJ-003</code>），此前严格相等匹配会失败。新增 <code>normalizeCode()</code> 归一化函数（剥离二维码前缀 + 忽略大小写 + 忽略连字符“-”/下划线“_”/空格），并在<strong>全部编号匹配入口</strong>（登记入库 / 出库 <code>resolvePartByCode / resolveOutByCode</code>、备件查询搜索 <code>qySearchList</code>、扫码快速盘点 <code>scanStocktake</code>、入库/出库提交 <code>submitInbound / submitOutbound</code>）使用归一化匹配；匹配后回填库中的<strong>规范编号</strong>（保留连字符）。已打印的旧二维码 / 标签无需重打。</li>
            <li><strong>边界处理</strong>：匹配结果 0 个 → 提示「未找到（已忽略连字符/大小写差异）」；匹配到多个 → 自动选首个规范编号并提示「匹配到 N 个，已选 X」；备件查询页天然列出所有命中（含数量提示）。</li>
            <li><strong>顺带修复</strong>：登记入库 <code>submitInbound</code> 原漏写 <code>partId</code>（应为 <code>part.id</code>），导致入库流水未正确关联备品；本次一并修正。</li>
            <li>版本号升级至 <strong>2.13</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.12</h4>
          <ul class="about-list">
            <li><strong>【Bug 修复】全场景扫码定位备品</strong>：将二维码前缀归一化覆盖到<strong>全部</strong>编号输入入口——登记入库 / 登记出库（扫码枪键入 + 拍照）、<strong>备件查询（扫描枪键入搜索框 / 📷 扫码带入）</strong>、<strong>扫码快速盘点</strong>、建档编号框，统一经 <code>parseQRToken</code> 剥离 <code>SPMS1|&lt;code&gt;</code>（兼容历史 <code>SPMS|&lt;code&gt;</code>）后匹配 / 回写。修复「备件查询」与「扫码盘点」此前同样会因前缀未剥离而查不到备品的问题。</li>
            <li>版本命名规范调整：<strong>不再使用 2.11.1 这类三位补丁号</strong>，统一采用两位版本号（本次 2.12，后续直接递增末位：2.13、2.14 …）。</li>
          </ul>
          <h4 class="about-ver">v2.11</h4>
          <ul class="about-list">
            <li><strong>分发模型改为「版本化文件夹」</strong>：对外分发包由无版本号的 <code>win-unpacked</code> 目录，更名为<strong>「备件仓库系统v2.11」</strong>文件夹；今后升级只需<strong>重命名该文件夹</strong>（如 v2.12、v2.13）并更新其内部内容（exe / 数据），版本号以文件夹名为准。程序运行靠 <code>process.execPath</code> 定位数据目录，重命名不影响正常运行。</li>
            <li>版本号升级至 <strong>2.11</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.10</h4>
          <ul class="about-list">
            <li><strong>「库存管理」「备件盘点」合并至「备件查询」统一页</strong>：以备件查询为核心入口，搜索（编号 / 名称 / 规格 / 库位 / 分类）+ <strong>分类下拉</strong> + <strong>库存状态下拉（全部 / 正常 / 预警 / 缺货）</strong>同屏；结果表直接展示<strong>当前库存 / 安全库存 / 状态 / 最近动态</strong>，点行展开明细并可<strong>一键盘点</strong>（明细内「🧮 盘点此备件」或顶部「📷 扫码盘点」），页底保留「最近盘点记录」；保留原搜索 / 筛选 / 导出 CSV。盘点提交后库存与备件信息实时同步。</li>
            <li>版本号升级至 <strong>2.10</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.9</h4>
          <ul class="about-list">
            <li><strong>修复搜索框中文输入法（IME）冲突</strong>：备品管理 / 库存管理 / 记录查询的搜索框改为「输入框常驻、仅刷新结果区」模式，并监听 <code>compositionstart / compositionend</code>，中文组合输入期间不打断、不重建输入框，彻底解决「输入中文时无法上屏、每按一键重复出现两个英文字母」的问题；同时对经办人拼音联想、盘点备品搜索的候选下拉增加组合中守卫，确保中文、英文输入均正常。</li>
            <li>版本号升级至 <strong>2.9</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.8</h4>
          <ul class="about-list">
            <li><strong>备件查询改为「结果列表」模式</strong>：输入关键字（编号 / 名称 / 规格 / 库位 / 分类）<strong>实时列出所有匹配备件</strong>，不再进入候选下拉逐条选择；点击任意一行可<strong>展开明细</strong>（库存 + 库位 + 最近流水），更适合「电磁阀」等多匹配场景的批量核对。</li>
            <li>版本号升级至 <strong>2.8</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.7</h4>
          <ul class="about-list">
            <li>侧边栏「<strong>盘点</strong>」更名为「<strong>备件盘点</strong>」，明确其作用对象为备件库存校正，与出入库并列。</li>
            <li><strong>备件盘点</strong>重构：备品选择由下拉框改为<strong>输入框 + 📷 扫码按钮</strong>（与入库 / 出库风格一致），并支持按<strong>备件号 / 名称 / 规格 / 库位 / 分类</strong>多字段模糊搜索候选下拉；支持扫描枪扫码；经办人沿用拼音模糊联想。</li>
            <li>新增<strong>「备件查询」</strong>独立功能（左侧导航）：以备件为入口的<strong>只读</strong>检索，通过候选下拉选择单条备件查看明细（编号 / 名称 / 规格 / 分类 / 单位 / 库位 / 安全库存 / 当前库存 / 状态 / 累计出入库次数 / 最近动态 / 备注 + 最近 15 条流水），与「备品管理」「库存管理」「记录查询」形成清晰分工。</li>
            <li>版本号升级至 <strong>2.7</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.6</h4>
          <ul class="about-list">
            <li><strong>经办人输入增强</strong>：入库「经办人」、出库「领用人」输入框支持<strong>拼音模糊查找 + 下拉选择</strong>——输入文字（中文或拼音全拼 / 首字母）后自动合并匹配结果，以下拉列表展示并<strong>支持滚动浏览</strong>，点击即填入；新输入的姓名自动记忆，下次可直接联想。</li>
            <li>出库字段调整：「经办人」更名为<strong>「领用人」</strong>，并<strong>移除「领用人 / 用途」</strong>字段（出库记录不再单独记录用途说明）。</li>
            <li>版本号升级至 <strong>2.6</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.5</h4>
          <ul class="about-list">
            <li>「登记出库」的<strong>备品选择</strong>由下拉框改为<strong>输入框</strong>，支持<strong>扫描枪直接扫码</strong>输入备品编号，与入库一致。</li>
            <li>出库新增<strong>库位号反查</strong>：输入库位号自动填写对应出库备品编号（同库位多种备品时列出候选供点选）。</li>
            <li><strong>库位号支持扫码枪扫码录入</strong>：入库与出库的库位号旁均新增 📷 扫码按钮，除手动输入外可快速扫码。</li>
            <li>数据库文件（spms-data.json）<strong>改存于程序所在目录</strong>，程序与数据可整体复制 / 移动，不再依赖系统固定路径。</li>
            <li>「关于 / About」面板改为<strong>滚动条布局</strong>，并收录<strong>全部历史版本的变更记录</strong>（v2.0 → v2.5）。</li>
            <li>版本号升级至 <strong>2.5</strong>。</li>
          </ul>
          <h4 class="about-ver">v2.4</h4>
          <ul class="about-list muted">
            <li>「登记入库」备品选择由下拉框改为输入框，支持扫描枪直接扫码；输入后实时解析并正向联动库位。</li>
            <li>入库新增库位号反查（输入库位自动填写备品编号，多备品列候选点选）。</li>
            <li>全界面「备注」统一更名为「备注或用途」。</li>
          </ul>
          <h4 class="about-ver">v2.3</h4>
          <ul class="about-list muted">
            <li>「分类 / 单位」下拉框升级为可持久化自定义组合控件（自定义项刷新后保留）。</li>
            <li>下拉选项过多时弹层限高 + 滚动条。</li>
            <li>新增「关于 / About」按钮（变更日记 + 鸣谢）。</li>
          </ul>
          <h4 class="about-ver">v2.2</h4>
          <ul class="about-list muted">
            <li>「分类 / 单位」改为下拉选择 + 自定义输入（电气 / 机械 / 液压；个 / 件 / 米）。</li>
            <li>「备注」字段名改为「备注或用途」。</li>
          </ul>
          <h4 class="about-ver">v2.1</h4>
          <ul class="about-list muted">
            <li>新增备品「🎲 随机生成编号」按钮（SP + 年月日 + 三位序号，自动递增唯一）。</li>
          </ul>
          <h4 class="about-ver">v2.0</h4>
          <ul class="about-list muted">
            <li>全新 Electron 桌面壳，本地 JSON 文件存储，启动无需额外运行环境。</li>
            <li>双模式数据层（Electron 走 IPC；浏览器打开回退 IndexedDB / localStorage）。</li>
            <li>备品 / 入库 / 出库 / 库存 / 库位 / 盘点 / 记录查询 七大模块 + 数据备份（CSV、JSON）。</li>
            <li>二维码能力（编码仅含编号，支持批量打印标签）。</li>
          </ul>
          <p class="about-note muted">v1.0 为早期网页原型版（1.0/ 目录），后续演进出本桌面程序。</p>
        </div>
        <h3 class="about-h">鸣谢</h3>
        <p class="about-thanks">感谢以下同事提供的宝贵意见：<br><strong>薛添才、朱近、林长平、林捷</strong></p>
        <p class="about-version muted">当前版本：v${DB.APP_VERSION} · 数据文件：程序所在目录 spms-data.json · 本地存储 · 无需联网</p>
      </div>`;
  }
  window.openAbout = function () { openModal('关于 / About', aboutHtml()); };

  /* 取下一个可用的 4 位纯数字编号：当前最大 4 位数字 +1，最小 1001（顺序分配，无随机跳号） */
  function nextPartCode() {
    let max = 1000;
    state.parts.forEach((p) => {
      const m = /^(\d{4})$/.exec(p.code || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return String(max + 1);
  }
  /* 重新分配下一个编号（写入只读输入框） */
  window.generatePartCode = function () {
    const el = document.getElementById('f_code');
    if (!el) return;
    el.value = nextPartCode();
    el.focus();
    toast('已分配编号：' + el.value, 'ok');
  };

  window.submitPart = async function (id) {
    /* 编号：系统自动分配（只读框预填），空则自动取下一个；建档时若误扫入二维码内容（SPMS1|xx）先剥离前缀 */
    let code = parseQRToken($('#f_code').value || '').trim();
    const name = $('#f_name').value.trim();
    if (!name) { toast('名称为必填项', 'err'); return; }
    if (!code) code = nextPartCode();                 // 自动分配下一个 4 位号
    if (!/^\d{4}$/.test(code)) { toast('编号必须为 4 位纯数字（系统自动分配）', 'err'); return; }
    let dup = state.parts.find((x) => x.code === code && x.id !== id);
    if (dup) {                                        // 极端并发冲突：重新分配下一个
      code = nextPartCode();
      dup = state.parts.find((x) => x.code === code && x.id !== id);
      if (dup) { toast('编号冲突，请稍后重试', 'err'); return; }
    }

    const part = {
      code, name,
      spec: $('#f_spec').value.trim(),
      category: $('#f_category').value.trim(),
      unit: $('#f_unit').value.trim(),
      location: $('#f_location').value.trim(),
      safeStock: Math.max(0, num($('#f_safe').value)),
      stock: Math.max(0, num($('#f_stock').value)),
      remark: $('#f_remark').value.trim()
    };
    try {
      if (id) { part.id = id; await DB.updatePart(part); }
      else { await DB.addPart(part); }
      await reloadAll();
      closeModal();
      renderParts();
      toast('已保存', 'ok');
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  };

  window.deletePart = async function (id) {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`确认删除备品「${p.name}（${p.code}）」？\n该操作不会删除其历史流水记录。`)) return;
    try {
      await DB.del('parts', id);
      await reloadAll();
      renderParts();
      toast('已删除', 'ok');
    } catch (e) { toast('删除失败：' + e.message, 'err'); }
  };

  /* ---- 备品 CSV 导入/导出 ---- */
  const PART_HEADERS = ['编号', '名称', '规格', '分类', '单位', '库位', '安全库存', '当前库存', '备注或用途'];
  const PART_MAP = { '编号': 'code', '名称': 'name', '规格': 'spec', '分类': 'category', '单位': 'unit', '库位': 'location', '安全库存': 'safeStock', '当前库存': 'stock', '备注或用途': 'remark' };

  window.downloadPartTemplate = function () {
    const sample = [
      ['1001', '深沟球轴承', '6204-2RS', '机械', '个', 'A-01-01', '20', '150', '常用易损件'],
      ['1002', '交流接触器', 'CJX2-2510', '电气', '个', 'B-02-03', '10', '60', '']
    ];
    download('备品导入模板.csv', toCSV(PART_HEADERS, sample), 'text/csv;charset=utf-8');
  };

  window.importPartsClick = function () { $('#partFile').click(); };

  window.importPartsFile = async function (input) {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length < 2) { toast('文件中没有数据行', 'err'); return; }
      const header = rows[0].map((h) => h.trim());
      const idx = {};
      header.forEach((h, i) => { const k = PART_MAP[h] || (h === '备注' ? 'remark' : null); if (k) idx[k] = i; });
      if (idx.code == null || idx.name == null) { toast('模板缺少「编号/名称」列', 'err'); return; }

      const existing = await DB.getAll('parts');
      const occupied = new Set(existing.map((p) => p.code)); // 已占用编号，防重复
      let added = 0, updated = 0, skipped = 0;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const name = (row[idx.name] || '').trim();
        if (!name) { skipped++; continue; }
        /* 编号强制 4 位纯数字：CSV 中若不是合法/唯一 4 位号，则自动分配下一个 */
        let code = (row[idx.code] || '').trim();
        if (!/^\d{4}$/.test(code) || occupied.has(code)) {
          let n = 1001;
          while (occupied.has(String(n))) n++;
          code = String(n);
        }
        occupied.add(code);
        const part = {
          code, name,
          spec: (row[idx.spec] || '').trim(),
          category: (row[idx.category] || '').trim(),
          unit: (row[idx.unit] || '').trim(),
          location: (row[idx.location] || '').trim(),
          safeStock: Math.max(0, num(row[idx.safeStock])),
          stock: Math.max(0, num(row[idx.stock])),
          remark: (row[idx.remark] || '').trim()
        };
        try {
          const ex = existing.find((p) => p.code === code);
          if (ex) {
            part.id = ex.id;
            await DB.updatePart(part);
            updated++;
          } else {
            await DB.addPart(part);
            added++;
          }
        } catch (err) {
          skipped++;
          console.warn('导入跳过行', r, err && err.message);
        }
      }
      await reloadAll();
      renderParts();
      toast(`导入完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}`, 'ok');
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
    input.value = '';
  };

  window.exportParts = function () {
    const rows = state.parts.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)))
      .map((p) => [p.code, p.name, p.spec, p.category, p.unit, p.location, p.safeStock, p.stock, p.remark]);
    download('备品清单_' + stamp() + '.csv', toCSV(PART_HEADERS, rows), 'text/csv;charset=utf-8');
    toast('已导出', 'ok');
  };

  /* ============================================================
   * 入库管理
   * ============================================================ */
  function renderInbound() {
    const html = `
      <div class="panel">
        <div class="panel-title">登记入库</div>
        <div class="tip">在「编号 / 名称 / 规格 / 库位」任一栏输入或扫码即可检索，命中唯一备品将自动回填其余字段；多命中请在下方结果列表点选。</div>
        <div class="field-grid">
          <div class="field">
            <label>备品编号 *（支持扫描枪直接扫码）</label>
            <div class="input-with-btn">
              <input id="in_code" placeholder="扫描或输入备品编号，如 1001" autocomplete="off"
                oninput="applyInboundSearch()" onkeydown="if(event.key==='Enter'){event.preventDefault();applyInboundSearch()}">
              <button type="button" class="btn ghost sm" onclick="scanInboundCode()" title="扫码识别备品编号">📷</button>
            </div>
          </div>
          <div class="field">
            <label>名称（可检索并自动回填）</label>
            <input id="in_name" placeholder="输入或扫码名称关键字" autocomplete="off" oninput="applyInboundSearch()">
          </div>
          <div class="field">
            <label>规格（可检索并自动回填）</label>
            <input id="in_spec" placeholder="输入规格关键字" autocomplete="off" oninput="applyInboundSearch()">
          </div>
          <div class="field">
            <label>库位号（反查并自动填写备品编号）</label>
            <div class="input-with-btn">
              <input id="in_loc" placeholder="如 A-01-03（可扫码枪或手动输入）" autocomplete="off" oninput="applyInboundSearch()">
              <button type="button" class="btn ghost sm" onclick="scanInboundLoc()" title="扫码识别库位号">📷</button>
            </div>
          </div>
          <div class="field"><label>入库数量 *</label><input id="in_qty" type="number" min="0.0001" step="any" placeholder="如 50"></div>
          <div class="field op-field"><label>经办人 *</label><input id="in_op" placeholder="录入人（支持拼音模糊查找）" autocomplete="off" oninput="operatorSuggest(this)" onfocus="operatorSuggest(this)"><div class="op-ac" id="in_op_ac" style="display:none"></div></div>
          <div class="field"><label>供应商</label><input id="in_sup" placeholder="供货单位"></div>
          <div class="field"><label>入库时间</label><input id="in_time" type="datetime-local" value="${nowInput()}"></div>
          <div class="field"><label>备注或用途</label><input id="in_remark"></div>
        </div>
        <div id="in_hint" class="field-hint"></div>
        <button class="btn" onclick="submitInbound()">提交入库（自动增加库存）</button>
      </div>
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title row">
          <span>检索结果</span>
          <span class="spacer"></span>
          <button type="button" class="btn sm" onclick="clearInboundSelection()" title="清空已选备品与检索字段，重新查询">清除已选内容</button>
        </div>
        <div id="in_results"><div class="empty">在「编号 / 名称 / 规格 / 库位」任一栏输入即可检索，命中后自动回填其余字段</div></div>
      </div>`;
    $('#content').innerHTML = html;
    if (!state.parts.length) toast('请先添加备品再登记入库', 'err');
  }

  window.submitInbound = async function () {
    const part = resolveInOutPart('in');
    if (!part) { toast('请先在检索栏选择/输入正确的备品（编号 / 名称 / 规格 / 库位 任一即可，多匹配时请点选列表项）', 'err'); return; }
    const qty = num($('#in_qty').value);
    const op = $('#in_op').value.trim();
    if (qty <= 0) { toast('入库数量必须大于 0', 'err'); return; }
    if (!op) { toast('请填写经办人', 'err'); return; }
    rememberOperator(op);
    try {
      await DB.addTransaction({
        type: 'in', partId: part.id, quantity: qty, operator: op,
        counterparty: $('#in_sup').value.trim(),
        time: inputToMs($('#in_time').value),
        remark: $('#in_remark').value.trim()
      });
      await reloadAll();
      renderInbound();
      renderTopStats();
      toast('入库成功，库存已更新', 'ok');
    } catch (e) { toast('入库失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 经办人 / 领用人 输入联想（拼音模糊匹配 + 下拉选择）
   * ============================================================ */
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function operatorMatch(name, q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;        // 中文 / 直接子串匹配
    const pm = window.PinyinMatch;
    if (pm && typeof pm.match === 'function') {              // 拼音（全拼 / 首字母）模糊匹配
      try { if (pm.match(name, q) !== false) return true; } catch (e) {}
    }
    return false;
  }
  window.operatorSuggest = function (input) {
    const id = input.id;
    const box = document.getElementById(id + '_ac');
    if (!box) return;
    if (input.isComposing) return; // 中文输入法组合中不打断、不闪候选
    const q = input.value;
    const all = state.operators || [];
    const matches = (q.trim() ? all.filter((n) => operatorMatch(n, q)) : all).slice(0, 50);
    if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = matches.map((n) => `<div class="op-ac-item" data-name="${escAttr(n)}">${esc(n)}</div>`).join('');
    box.onclick = (e) => { const it = e.target.closest('.op-ac-item'); if (it) operatorPick(it.getAttribute('data-name'), id); };
    box.style.display = 'block';
  };
  window.operatorPick = function (name, inputId) {
    const inp = document.getElementById(inputId);
    if (inp) inp.value = name;
    const box = document.getElementById(inputId + '_ac');
    if (box) box.style.display = 'none';
    if (inp) inp.focus();
  };
  window.closeOpAc = function () {
    document.querySelectorAll('.op-ac').forEach((b) => { b.style.display = 'none'; });
  };
  async function rememberOperator(name) {
    name = (name || '').trim();
    if (!name) return;
    if (!state.operators.includes(name)) {
      state.operators.push(name);
      try { await DB.setMeta('operators', state.operators); } catch (e) {}
    }
  }

  /* ============================================================
   * 出库管理
   * ============================================================ */
  function renderOutbound() {
    const html = `
      <div class="panel">
        <div class="panel-title">登记出库</div>
        <div class="tip">在「编号 / 名称 / 规格 / 库位」任一栏输入或扫码即可检索，命中唯一备品将自动回填其余字段；多命中请在下方结果列表点选。</div>
        <div class="field-grid">
          <div class="field">
            <label>备品编号 *（支持扫描枪直接扫码）</label>
            <div class="input-with-btn">
              <input id="out_code" placeholder="扫描或输入备品编号，如 1001" autocomplete="off"
                oninput="applyOutboundSearch()" onkeydown="if(event.key==='Enter'){event.preventDefault();applyOutboundSearch()}">
              <button type="button" class="btn ghost sm" onclick="scanOutboundCode()" title="扫码识别备品编号">📷</button>
            </div>
          </div>
          <div class="field">
            <label>名称（可检索并自动回填）</label>
            <input id="out_name" placeholder="输入或扫码名称关键字" autocomplete="off" oninput="applyOutboundSearch()">
          </div>
          <div class="field">
            <label>规格（可检索并自动回填）</label>
            <input id="out_spec" placeholder="输入规格关键字" autocomplete="off" oninput="applyOutboundSearch()">
          </div>
          <div class="field">
            <label>库位号（反查并自动填写备品编号）</label>
            <div class="input-with-btn">
              <input id="out_loc" placeholder="如 A-01-03（可扫码枪或手动输入）" autocomplete="off" oninput="applyOutboundSearch()">
              <button type="button" class="btn ghost sm" onclick="scanOutboundLoc()" title="扫码识别库位号">📷</button>
            </div>
          </div>
          <div class="field"><label>出库数量 *</label><input id="out_qty" type="number" min="0.0001" step="any" placeholder="如 5"></div>
          <div class="field op-field"><label>领用人 *</label><input id="out_op" placeholder="领用人（支持拼音模糊查找）" autocomplete="off" oninput="operatorSuggest(this)" onfocus="operatorSuggest(this)"><div class="op-ac" id="out_op_ac" style="display:none"></div></div>
          <div class="field"><label>出库时间</label><input id="out_time" type="datetime-local" value="${nowInput()}"></div>
          <div class="field"><label>备注或用途</label><input id="out_remark"></div>
        </div>
        <div id="out_hint" class="field-hint"></div>
        <button class="btn" onclick="submitOutbound()">提交出库（自动扣减库存）</button>
      </div>
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title row">
          <span>检索结果</span>
          <span class="spacer"></span>
          <button type="button" class="btn sm" onclick="clearOutboundSelection()" title="清空已选备品与检索字段，重新查询">清除已选内容</button>
        </div>
        <div id="out_results"><div class="empty">在「编号 / 名称 / 规格 / 库位」任一栏输入即可检索，命中后自动回填其余字段</div></div>
      </div>`;
    $('#content').innerHTML = html;
    if (!state.parts.length) toast('请先添加备品再登记出库', 'err');
  }

  window.submitOutbound = async function () {
    const part = resolveInOutPart('out');
    if (!part) { toast('请先在检索栏选择/输入正确的备品（编号 / 名称 / 规格 / 库位 任一即可，多匹配时请点选列表项）', 'err'); return; }
    const qty = num($('#out_qty').value);
    const op = $('#out_op').value.trim();
    if (qty <= 0) { toast('出库数量必须大于 0', 'err'); return; }
    if (!op) { toast('请填写领用人', 'err'); return; }
    if (part.stock < qty) { toast(`库存不足：当前 ${part.stock}，需 ${qty}`, 'err'); return; }
    rememberOperator(op);
    try {
      await DB.addTransaction({
        type: 'out', partId: part.id, quantity: qty, operator: op,
        counterparty: '',
        time: inputToMs($('#out_time').value),
        remark: $('#out_remark').value.trim()
      });
      await reloadAll();
      renderOutbound();
      renderTopStats();
      toast('出库成功，库存已扣减', 'ok');
    } catch (e) { toast('出库失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 库存管理：已合并至「备件查询」统一页（renderQuery）
   *   - 库存查看 / 安全库存 / 状态 / 预警筛选 → renderQuery 结果表 + 库存状态下拉
   *   - 库存预警导出 → exportQueryCSV
   *   - 库存盘点 → openStocktakeModal（明细内「🧮 盘点此备件」/ 顶部「📷 扫码盘点」）
   * ============================================================ */

  /* ============================================================
   * 库位管理
   * ============================================================ */
  function renderLocation() {
    const locs = {};
    state.parts.forEach((p) => { const k = p.location || '（未分配）'; locs[k] = (locs[k] || 0) + 1; });
    const locKeys = locSort(Object.keys(locs));
    const filter = state.locFilter;
    let list = state.parts.slice();
    if (filter) list = list.filter((p) => (p.location || '（未分配）') === filter);
    list.sort((a, b) => String(a.code).localeCompare(String(b.code)));

  // 重渲染前保留纵向滚动位置，避免点选后跳回开头
    let prevScroll = 0;
    const prevGrid = document.querySelector('.loc-grid10');
    if (prevGrid) prevScroll = prevGrid.scrollTop;

    const cards = locKeys.length ? locKeys.map((k) => {
      const cnt = locs[k];
      const warn = state.parts.filter((p) => (p.location || '（未分配）') === k && (p.stock <= 0 || (p.safeStock > 0 && p.stock < p.safeStock))).length;
      const active = k === filter;
      const isUn = k === '（未分配）';
      const tip = `库位 ${k}：${cnt} 件${warn ? '，' + warn + ' 项库存预警' : ''}`;
      return `<button type="button" class="loc-card ${active ? 'active' : ''} ${isUn ? 'unassigned' : ''}" onclick="selectLocation('${esc(k)}')" title="${esc(tip)}">
        <span class="loc-card-no">${esc(k)}</span>
      </button>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1; padding:30px">暂无库位信息</div>`;

    const html = `
      <div class="loc-split">
        <div class="panel loc-top">
          <div class="panel-title">库位总览（10 列网格 · 三行可视 · 上下滑动浏览，点击查看明细）</div>
          <div class="loc-grid10">${cards}</div>
          <div class="loc-top-bar">
            ${filter ? `<button class="btn sm ghost" onclick="selectLocation('')">清除筛选</button><span class="ml">当前库位：<b>${esc(filter)}</b>（${list.length} 项）</span>` : '<span class="muted">未选择库位，下方显示全部备品</span>'}
            <span class="spacer"></span>
            <button class="btn ghost" onclick="exportLocationCSV()">📋 手工盘点（导出 CSV）</button>
          </div>
          <div class="tip mt">点击库位卡片可在下方查看该库位对应的备品明细；在「备品管理」中编辑备品可修改其库位。</div>
        </div>
        <div class="panel loc-bottom" style="margin-bottom:0">
          <div class="panel-title">${filter ? '库位「' + esc(filter) + '」下备品' : '全部备品'}（${list.length} 项）</div>
          <div class="table-wrap"><table>
            <thead><tr><th>编号</th><th>名称</th><th>规格</th><th>分类</th><th>单位</th><th>库位</th><th>当前库存</th><th>状态</th></tr></thead>
            <tbody>
              ${list.length ? list.map((p) => {
                const st = stockStatus(p);
                return `<tr>
                  <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.spec)}</td>
                  <td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td>${esc(p.location)}</td>
                  <td><b>${p.stock}</b></td><td><span class="badge ${st.cls}">${st.text}</span></td></tr>`;
              }).join('') : `<tr><td colspan="8" class="empty">无备品</td></tr>`}
            </tbody>
          </table></div>
        </div>
      </div>`;
    $('#content').innerHTML = html;
    const grid = document.querySelector('.loc-grid10');
    if (grid) grid.scrollTop = prevScroll;
  }

  window.selectLocation = function (loc) { state.locFilter = loc; renderLocation(); };

  /* ============================================================
   * 手动库位盘点（打印清单）
   * ============================================================ */
  let auditState = { mode: 'normal', locFilter: '', checked: {}, operator: '', date: '' };

  async function renderManualAudit() {
    const locs = {};
    state.parts.forEach((p) => { const k = p.location || '（未分配）'; locs[k] = (locs[k] || 0) + 1; });
    const locKeys = locSort(Object.keys(locs));
    const doneCount = Object.values(auditState.checked).filter(Boolean).length;

    const html = `
      <div class="panel">
        <div class="panel-title">📋 手动库位盘点</div>
        <div class="filter-bar">
          <div class="field"><label>盘点人</label><input id="auditOp" placeholder="输入盘点人姓名" value="${esc(auditState.operator)}" oninput="refreshAuditOp(this.value)"></div>
          <div class="field"><label>盘点日期</label><input id="auditDate" type="date" value="${auditState.date || new Date().toISOString().slice(0,10)}"></div>
          <div class="spacer"></div>
          <button class="btn" onclick="printManualAudit()">🖨 打印盘点清单</button>
          <button class="btn ghost" onclick="renderLocation()">返回库位管理</button>
        </div>
        <div class="tip mt">勾选「已完成」标记该库位已盘点；点击「打印盘点清单」生成纸质盘点表（含签字栏）。</div>
      </div>
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title">盘点清单（按库位）</div>
        <div class="table-wrap"><table class="audit-table">
          <thead><tr><th style="width:56px">已完成</th><th>库位号</th><th style="width:80px">件数</th><th>盘点人</th></tr></thead>
          <tbody id="auditBody">
            ${locKeys.map((k) => {
              const done = auditState.checked[k];
              return `<tr data-loc="${esc(k)}">
                <td style="text-align:center"><input type="checkbox" ${done ? 'checked' : ''} onchange="toggleManualCheck('${esc(k)}', this.checked)"></td>
                <td><b>${esc(k)}</b></td>
                <td style="text-align:center">${locs[k]}</td>
                <td class="audit-op-cell">${esc(auditState.operator) || '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
        <div class="muted mt">共 <b>${locKeys.length}</b> 个库位，已标记 <b id="auditDone">${doneCount}</b> 个。</div>
      </div>`;
    $('#content').innerHTML = html;
  }

  window.refreshAuditOp = function (v) {
    auditState.operator = v;
    document.querySelectorAll('#auditBody .audit-op-cell').forEach((td) => { td.textContent = v || '—'; });
  };

  window.toggleManualCheck = function (loc, checked) {
    auditState.checked[loc] = checked;
    const done = Object.values(auditState.checked).filter(Boolean).length;
    const el = document.getElementById('auditDone');
    if (el) el.textContent = done;
  };

  function printManualAudit() {
    const op = ($('#auditOp')?.value || '').trim();
    const date = ($('#auditDate')?.value || new Date().toISOString().slice(0,10));
    auditState.operator = op;
    auditState.date = date;

    const locs = {};
    state.parts.forEach((p) => { const k = p.location || '（未分配）'; locs[k] = (locs[k] || 0) + 1; });
    const locKeys = locSort(Object.keys(locs));

    const rows = locKeys.map((k) => {
      const done = auditState.checked[k];
      return `<tr>
        <td class="cb">${done ? '☑' : '□'}</td>
        <td>${esc(k)}</td>
        <td class="num">${locs[k]}</td>
        <td class="sign">${op ? esc(op) : '<span class="signline"></span>'}</td>
      </tr>`;
    }).join('');

    const printHtml = `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>手动库位盘点表</title>
      <style>
        @page { size: A4; margin: 16mm; }
        * { box-sizing: border-box; }
        body { font-family: "Microsoft YaHei", "SimHei", sans-serif; font-size: 13px; color: #000; margin: 0; }
        h1 { text-align: center; font-size: 20px; margin: 0 0 6px; letter-spacing: 2px; }
        .sub { text-align: center; color: #333; margin-bottom: 16px; font-size: 13px; }
        .sub b { border-bottom: 1px solid #333; padding: 0 8px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #333; padding: 8px 10px; text-align: left; }
        th { background: #e8e8e8; font-weight: bold; text-align: center; }
        td.cb { text-align: center; font-size: 17px; width: 56px; }
        td.num { text-align: center; width: 80px; }
        td.sign { width: 170px; }
        .signline { display: inline-block; width: 130px; border-bottom: 1px solid #333; }
        .foot { margin-top: 40px; display: flex; justify-content: space-between; font-size: 13px; }
        .foot span { border-top: 1px solid #333; padding-top: 4px; min-width: 150px; text-align: center; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style></head>
      <body>
        <h1>手动库位盘点表</h1>
        <div class="sub">盘点人：<b>${esc(op) || '＿＿＿＿'}</b>　|　盘点日期：<b>${esc(date)}</b></div>
        <table>
          <thead><tr><th>已完成</th><th>库位号</th><th>件数</th><th>盘点人签字</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="foot">
          <span>制表人：</span>
          <span>复核人：</span>
          <span>日期：</span>
        </div>
        <script>window.onload = function () { setTimeout(function () { window.print(); }, 300); };</script>
      </body></html>`;

    const printWindow = window.open('', '_blank');
    if (!printWindow) { toast('打印窗口被浏览器拦截，请允许弹出窗口', 'err'); return; }
    printWindow.document.open();
    printWindow.document.write(printHtml);
    printWindow.document.close();
  }

  /* 库位「手工盘点」导出：按备品逐项明细导出（与库位管理视图一致），便于纸质逐项核对并登记盘点人。
   * 盘点人改为导出时录入（原由「手动库位盘点」打印界面填写，该入口已移除），预填上次记忆值，取消则中止导出。 */
  window.exportLocationCSV = function () {
    const filter = state.locFilter;
    let list = state.parts.slice();
    if (filter) list = list.filter((p) => (p.location || '（未分配）') === filter);
    list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    let op = window.prompt('请输入盘点人（将写入导出表格的「盘点人」列）：', (auditState && auditState.operator) || '');
    if (op === null) return; // 用户取消
    op = op.trim();
    const rows = list.map((p) => [p.code, p.name, p.spec, p.category, p.unit, p.location, p.safeStock, p.stock, stockStatus(p).text, op]);
    download('手工盘点_' + stamp() + '.csv', toCSV(['编号', '名称', '规格', '分类', '单位', '库位', '安全库存', '当前库存', '状态', '盘点人'], rows), 'text/csv;charset=utf-8');
    toast('已导出 ' + list.length + ' 项', 'ok');
  };

  /* ============================================================
   * 记录查询（筛选 + 导出）
   * ============================================================ */
  function queryRecords() {
    const type = $('#r_type')?.value || 'all';
    /* 扫描枪键盘键入可能把完整二维码内容 SPMS1|<code> / SPMS|<code> 直接打到搜索框，
     * 先剥离前缀再匹配，确保跨设备行为一致。 */
    const name = parseQRToken($('#r_name')?.value || '').trim().toLowerCase();
    const op = ($('#r_op')?.value || '').trim().toLowerCase();
    const start = $('#r_start')?.value ? inputToMs($('#r_start').value) : null;
    const end = $('#r_end')?.value ? inputToMs($('#r_end').value) + 86400000 - 1 : null;

    let list = state.transactions.slice();
    if (type !== 'all') list = list.filter((t) => t.type === type);
    if (name) list = list.filter((t) => (t.partName + t.partCode).toLowerCase().includes(name));
    if (op) list = list.filter((t) => t.operator.toLowerCase().includes(op));
    if (start != null) list = list.filter((t) => t.time >= start);
    if (end != null) list = list.filter((t) => t.time <= end);
    list.sort((a, b) => b.time - a.time);
    return list;
  }

  function renderRecords() {
    const html = `
      <div class="filter-bar">
        <div class="field"><label>类型</label><select id="r_type">
          <option value="all">全部</option><option value="in">仅入库</option><option value="out">仅出库</option><option value="check">仅盘点</option></select></div>
        <div class="field"><label>备品名称/编号</label>
          <div class="input-with-btn">
            <input id="r_name" placeholder="关键字（可扫码枪或手动输入）" autocomplete="off">
            <button type="button" class="btn ghost sm" onclick="scanForCode('r_name', renderRecordsResults)" title="扫码识别备品编号">📷</button>
          </div>
        </div>
        <div class="field"><label>经办人</label><input id="r_op" placeholder="经办人" autocomplete="off"></div>
        <div class="field"><label>开始日期</label><input id="r_start" type="date"></div>
        <div class="field"><label>结束日期</label><input id="r_end" type="date"></div>
        <div class="spacer"></div>
        <button class="btn ghost" onclick="renderRecords()">查询</button>
        <button class="btn ghost" onclick="exportRecords()">导出 CSV</button>
      </div>
      <div id="recResults"></div>`;
    $('#content').innerHTML = html;
    ['r_type', 'r_start', 'r_end'].forEach((id) => { const el = $('#' + id); if (el) el.addEventListener('change', renderRecordsResults); });
    bindLiveFilter('r_name', renderRecordsResults);
    bindLiveFilter('r_op', renderRecordsResults);
    renderRecordsResults();
  }

  function renderRecordsResults() {
    const list = queryRecords();
    const html = `
      <div class="panel" style="margin-bottom:0">
        <div class="table-wrap"><table>
          <thead><tr><th>类型</th><th>编号</th><th>名称</th><th>数量</th><th>单位</th><th>经办人</th><th>对方（供应商/领用人）</th><th>时间</th><th>备注或用途</th></tr></thead>
          <tbody>
            ${list.length ? list.map((t) => {
              const part = state.parts.find((p) => p.id === t.partId);
              const badge = t.type === 'in' ? '<span class="badge ok">入库</span>'
                : t.type === 'out' ? '<span class="badge muted">出库</span>'
                : '<span class="badge warn">盘点</span>';
              return `<tr>
                <td>${badge}</td>
                <td>${esc(t.partCode)}</td><td>${esc(t.partName)}</td>
                <td>${t.type === 'in' ? '+' : '-'}${t.quantity}</td>
                <td>${esc(part ? part.unit : '')}</td>
                <td>${esc(t.operator)}</td><td>${esc(t.counterparty)}</td>
                <td>${fmtTime(t.time)}</td><td>${esc(t.remark)}</td></tr>`;
            }).join('') : `<tr><td colspan="9" class="empty">无匹配记录</td></tr>`}
          </tbody>
        </table></div>
        <div class="small muted mt">共 ${list.length} 条</div>
      </div>`;
    $('#recResults').innerHTML = html;
  }

  window.exportRecords = function () {
    const list = queryRecords();
    const rows = list.map((t) => {
      const part = state.parts.find((p) => p.id === t.partId);
      return [t.type === 'in' ? '入库' : '出库', t.partCode, t.partName, t.quantity, part ? part.unit : '', t.operator, t.counterparty, fmtTime(t.time), t.remark];
    });
    download('出入库记录_' + stamp() + '.csv', toCSV(['类型', '编号', '名称', '数量', '单位', '经办人', '对方', '时间', '备注或用途'], rows), 'text/csv;charset=utf-8');
    toast('已导出 ' + list.length + ' 条', 'ok');
  };

  /* ============================================================
   * 数据备份 / 恢复
   * ============================================================ */
  function renderData() {
    const html = `
      <div class="panel">
        <div class="panel-title">数据备份与恢复</div>
        <p class="muted">本系统数据保存在当前浏览器本地（IndexedDB）。更换电脑或清理浏览器会丢失数据，请定期备份。</p>
        <div class="btn-row mt">
          <button class="btn" onclick="backupData()">⬇ 导出全部数据（JSON 备份）</button>
          <button class="btn ghost" onclick="restoreClick()">⬆ 导入备份恢复</button>
          <input type="file" id="restoreFile" accept=".json,application/json" hidden onchange="restoreData(this)">
        </div>
      </div>
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title" style="color:var(--danger)">危险操作</div>
        <p class="muted">清空将删除全部备品与流水记录，且不可恢复（除非先备份）。</p>
        <button class="btn danger" onclick="clearAllData()">清空所有数据</button>
      </div>`;
    $('#content').innerHTML = html;
  }

  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  window.backupData = async function () {
    const data = { version: 1, exportedAt: Date.now(), parts: state.parts, transactions: state.transactions };
    download('备件系统备份_' + stamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('备份已导出', 'ok');
  };

  window.restoreClick = function () { $('#restoreFile').click(); };

  window.restoreData = async function (input) {
    const file = input.files[0];
    if (!file) return;
    if (!confirm('恢复将覆盖当前所有数据，确定继续？建议先备份当前数据。')) { input.value = ''; return; }
    try {
      const data = JSON.parse(await file.text());
      if (!data.parts || !data.transactions) throw new Error('文件格式不正确');
      await DB.clear('transactions');
      await DB.clear('parts');
      for (const p of data.parts) await DB.put('parts', p);
      for (const t of data.transactions) await DB.put('transactions', t);
      await reloadAll();
      renderTopStats();
      toast('恢复完成，共 ' + data.parts.length + ' 备品 / ' + data.transactions.length + ' 流水', 'ok');
    } catch (e) { toast('恢复失败：' + e.message, 'err'); }
    input.value = '';
  };

  window.clearAllData = async function () {
    if (!confirm('确认清空全部备品与流水记录？此操作不可恢复！')) return;
    try {
      await DB.clear('transactions');
      await DB.clear('parts');
      await reloadAll();
      renderTopStats();
      showView(state.view);
      toast('已清空全部数据', 'ok');
    } catch (e) { toast('清空失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 二维码 + 扫码 + 盘点
   * ============================================================ */
  const QR_PREFIX = 'SPMS1|';
  function makeQRToken(part) { return QR_PREFIX + (part && part.code ? part.code : ''); }
  /* 从任意来源（扫码枪键盘键入 / openScan 原始值 / 手动输入）归一化为纯净备品编号。
   * 支持：规范 SPMS1|<code>、历史/误输入 SPMS|<code>；裸编号原样返回。 */
  function parseQRToken(str) {
    if (str == null) return '';
    str = String(str).trim();
    if (!str) return '';
    if (str.startsWith(QR_PREFIX)) return str.slice(QR_PREFIX.length).trim();
    const m = /^SPMS\|(.+)$/.exec(str);
    if (m) return m[1].trim();
    return str;
  }
  /* 备品编号归一化：用于「匹配 / 检索」时容错，避免严格相等因格式差异失败。
   * 步骤：① 剥离二维码前缀 SPMS1| / SPMS|（parseQRToken）；② 忽略大小写；
   *       ③ 忽略分隔符差异（连字符“-”、下划线“_”、空格），使 “BJ003” 与 “BJ-003” / “bj_003” 可互匹配。
   * 注意：仅用于“匹配/检索”，建档保存仍用 parseQRToken（保留用户定义的连字符）。 */
  function normalizeCode(raw) {
    let s = parseQRToken(raw == null ? '' : String(raw));
    s = s.trim().toLowerCase();
    s = s.replace(/[\s\-_]+/g, '');
    return s;
  }
  function drawQR(canvas, text, opts) {
    opts = opts || {};
    const qr = qrcode(opts.type || 0, opts.ec || 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const scale = opts.scale || 6, margin = (opts.margin == null ? 4 : opts.margin);
    const size = (count + margin * 2) * scale;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
    return size;
  }

  /* ---- 单条二维码 ---- */
  window.openPartQR = function (id) {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    state.qrPart = p;
    const token = makeQRToken(p);
    openModal('备品二维码 · ' + p.code, `
      <div class="qr-block">
        <canvas id="qrCanvas" class="qr-canvas"></canvas>
        <div class="qr-info">
          <div><b>编号：</b>${esc(p.code)}</div>
          <div><b>名称：</b>${esc(p.name)}</div>
          <div><b>规格：</b>${esc(p.spec)}</div>
          <div><b>库位：</b>${esc(p.location || '（未分配）')}</div>
          <div class="muted small">二维码内容：${esc(token)}</div>
        </div>
      </div>
      <div class="btn-row mt">
        <button class="btn" onclick="downloadPartQR()">下载 PNG</button>
        <button class="btn" onclick="printSingleLabel()">🖨 打印</button>
        <button class="btn ghost" onclick="closeModal()">关闭</button>
      </div>`);
    drawQR($('#qrCanvas'), token, { scale: 6, margin: 4 });
  };
  window.downloadPartQR = function () {
    const c = $('#qrCanvas'); if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = '二维码_' + (state.qrPart ? state.qrPart.code : 'part') + '.png';
    a.click();
  };
  /* ===================== 打印：纸张尺寸 / 对齐 / 边距 / 预览 ===================== */
  const PAPER_PRESETS = {
    A4:           { name: 'A4', w: 210, h: 297, m: 5 },
    A5:           { name: 'A5', w: 148, h: 210, m: 5 },
    receipt58:    { label: '小票纸 58mm',      w: 58,  h: 100, m: 0 },
    receipt80:    { label: '小票纸 80mm',      w: 80,  h: 100, m: 0 },
    label100x150: { label: '标签纸 100×150mm', w: 100, h: 150, m: 0 },
    custom:       { label: '自定义尺寸…',       w: 0,   h: 0,   m: 0 }
  };
  function defaultPrintSettings() {
    return { paper: 'A4', wmm: 210, hmm: 297, ha: 'center', va: 'center', mt: 5, mr: 5, mb: 5, ml: 5, copies: 1 };
  }
  function loadPrintSettings() {
    try { const s = JSON.parse(localStorage.getItem('spms-print-settings') || 'null'); if (s && s.paper) return s; } catch (e) {}
    return defaultPrintSettings();
  }
  function savePrintSettings(s) { try { localStorage.setItem('spms-print-settings', JSON.stringify(s)); } catch (e) {} }
  const mapH = (a) => (a === 'left' ? 'flex-start' : a === 'right' ? 'flex-end' : 'center');
  const mapV = (a) => (a === 'top' ? 'flex-start' : a === 'bottom' ? 'flex-end' : 'center');

  function labelCardHTML(p) {
    const token = makeQRToken(p);
    return `<div class="label-card">
      <canvas class="label-qr" data-token="${esc(token)}"></canvas>
      <div class="label-text">
        <div class="lc-code">${esc(p.code)}</div>
        <div class="lc-name">${esc(p.name)}</div>
        <div class="lc-spec">${esc(p.spec || '')}</div>
        <div class="lc-loc">库位：${esc(p.location || '—')}</div>
      </div></div>`;
  }
  function renderLabels(container, list) {
    container.innerHTML = list.map(labelCardHTML).join('');
    container.querySelectorAll('.label-qr').forEach((cv) => drawQR(cv, cv.dataset.token, { scale: 4, margin: 3 }));
  }
  let printList = [];
  function applyPrintVars(s) {
    const area = $('#printArea');
    area.style.setProperty('--ph', mapH(s.ha));
    area.style.setProperty('--pv', mapV(s.va));
    area.style.setProperty('--pm', `${s.mt}mm ${s.mr}mm ${s.mb}mm ${s.ml}mm`);
  }
  function resolvePageSize(s) {
    const p = PAPER_PRESETS[s.paper];
    if (p && p.name) return p.name;                       // 标准尺寸名（A4/A5）直接传名
    const w = s.paper === 'custom' ? (Number(s.wmm) || 0) : (p ? p.w : 0);
    const h = s.paper === 'custom' ? (Number(s.hmm) || 0) : (p ? p.h : 0);
    const wm = Math.max(10, w) * 1000;                     // 兜底最小 10mm，避免非法页
    const hm = Math.max(10, h) * 1000;
    return { width: Math.round(wm), height: Math.round(hm) }; // 微米
  }
  window.ppOnPaperChange = function () {
    const k = $('#ppPaper').value;
    const p = PAPER_PRESETS[k];
    $('#ppCustom').style.display = k === 'custom' ? 'inline-flex' : 'none';
    if (p && p.w) { $('#ppCW').value = p.w; $('#ppCH').value = p.h; }
    const m = (p && p.m != null) ? p.m : 0;
    $('#ppMT').value = m; $('#ppMR').value = m; $('#ppMB').value = m; $('#ppML').value = m;
    renderPreview();
  };
  function readPrintUI() {
    const k = $('#ppPaper').value;
    const p = PAPER_PRESETS[k] || {};
    return {
      paper: k,
      wmm: k === 'custom' ? (Number($('#ppCW').value) || 0) : (p.w || 0),
      hmm: k === 'custom' ? (Number($('#ppCH').value) || 0) : (p.h || 0),
      ha: $('#ppHa').value,
      va: $('#ppVa').value,
      mt: Number($('#ppMT').value) || 0,
      mr: Number($('#ppMR').value) || 0,
      mb: Number($('#ppMB').value) || 0,
      ml: Number($('#ppML').value) || 0,
      copies: Math.max(1, Number($('#ppCopies').value) || 1)
    };
  }
  function renderPreview() {
    const page = $('#ppPage'); if (!page) return;
    const s = readPrintUI();
    savePrintSettings(s);
    applyPrintVars(s);
    const PXPM = 96 / 25.4;                 // 每毫米对应像素（96dpi）
    const pw = Math.max(1, s.wmm) * PXPM;
    const ph = Math.max(1, s.hmm) * PXPM;
    const scale = Math.min(1, 360 / pw);    // 适配预览舞台宽度
    page.style.width = pw + 'px';
    page.style.height = ph + 'px';
    page.style.transform = 'scale(' + scale + ')';
    page.style.padding = `${s.mt}mm ${s.mr}mm ${s.mb}mm ${s.ml}mm`;
    page.style.justifyContent = mapH(s.ha);
    page.style.alignItems = mapV(s.va);
    page.style.alignContent = mapV(s.va);
    const fit = $('#ppFit');
    fit.style.width = (pw * scale) + 'px';
    fit.style.height = (ph * scale) + 'px';
    renderLabels(page, printList);
    const lbl = $('#ppPaperLabel'); if (lbl) lbl.textContent = `${s.wmm} × ${s.hmm} mm`;
  }
  function buildPrintModal(title, list) {
    printList = list;
    const s = loadPrintSettings();
    const paperOpts = Object.keys(PAPER_PRESETS).map((k) => {
      const p = PAPER_PRESETS[k];
      const t = p.label || p.name || k;
      return `<option value="${k}"${k === s.paper ? ' selected' : ''}>${esc(t)}</option>`;
    }).join('');
    openModal(title, `
      <div class="print-cfg">
        <div class="pc-row">
          <label>纸张尺寸</label>
          <select id="ppPaper" onchange="ppOnPaperChange()">${paperOpts}</select>
          <span id="ppCustom" class="pp-custom" style="display:${s.paper === 'custom' ? 'inline-flex' : 'none'}">
            <input id="ppCW" type="number" min="10" step="1" value="${s.wmm}" style="width:64px"> mm ×
            <input id="ppCH" type="number" min="10" step="1" value="${s.hmm}" style="width:64px"> mm
          </span>
        </div>
        <div class="pc-row">
          <label>水平对齐</label>
          <select id="ppHa">
            <option value="left"${s.ha === 'left' ? ' selected' : ''}>左对齐</option>
            <option value="center"${s.ha === 'center' ? ' selected' : ''}>水平居中</option>
            <option value="right"${s.ha === 'right' ? ' selected' : ''}>右对齐</option>
          </select>
          <label style="margin-left:14px">垂直对齐</label>
          <select id="ppVa">
            <option value="top"${s.va === 'top' ? ' selected' : ''}>顶部</option>
            <option value="center"${s.va === 'center' ? ' selected' : ''}>垂直居中</option>
            <option value="bottom"${s.va === 'bottom' ? ' selected' : ''}>底部</option>
          </select>
        </div>
        <div class="pc-row">
          <label>页边距(mm)</label>
          <span class="pp-margins">上<input id="ppMT" type="number" min="0" step="1" value="${s.mt}" style="width:52px"> 右<input id="ppMR" type="number" min="0" step="1" value="${s.mr}" style="width:52px"> 下<input id="ppMB" type="number" min="0" step="1" value="${s.mb}" style="width:52px"> 左<input id="ppML" type="number" min="0" step="1" value="${s.ml}" style="width:52px"></span>
          <label style="margin-left:14px">份数</label>
          <input id="ppCopies" type="number" min="1" step="1" value="${s.copies}" style="width:52px">
        </div>
      </div>
      <div class="print-preview-title">打印预览（<span id="ppPaperLabel"></span>，按所选纸张比例与对齐实时模拟）</div>
      <div class="pp-stage"><div class="pp-fit" id="ppFit"><div class="pp-page" id="ppPage"></div></div></div>
      <div class="btn-row mt">
        <button class="btn" onclick="ppDoPrint()">🖨 打印</button>
        <button class="btn ghost" onclick="closeModal()">关闭</button>
      </div>`);
    ['ppHa', 'ppVa', 'ppMT', 'ppMR', 'ppMB', 'ppML', 'ppCopies', 'ppCW', 'ppCH'].forEach((id) => {
      const el = $('#' + id); if (el) el.addEventListener('change', renderPreview);
    });
    renderPreview();
  }
  function fallbackPrint() { window.print(); }
  window.ppDoPrint = function () {
    const s = readPrintUI();
    if (!printList || !printList.length) { toast('没有可打印的标签'); return; }
    savePrintSettings(s);
    applyPrintVars(s);
    renderLabels($('#printArea'), printList);   // 确保 #printArea 含最新标签与二维码
    const opts = { pageSize: resolvePageSize(s), copies: s.copies };
    const done = (r) => {
      if (r && r.ok) toast('已发送打印任务');
      else if (r && (r.reason === 'cancelled' || ('' + (r.error || '')).indexOf('cancel') >= 0)) { /* 用户取消，不提示 */ }
      else toast('打印失败：' + ((r && (r.error || r.reason)) || '未知错误'));
    };
    if (window.api && window.api.printLabels) {
      Promise.resolve(window.api.printLabels(opts)).then(done).catch(() => fallbackPrint());
    } else { fallbackPrint(); }
  };
  window.printSingleLabel = function () {
    const p = state.qrPart; if (!p) return;
    buildPrintModal('打印标签 · ' + p.code, [p]);
  };
  /* ---- 批量打印标签 ---- */
  window.batchPrintLabels = function () {
    const list = state.parts.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
    if (!list.length) { toast('暂无备品，请先录入'); return; }
    buildPrintModal('批量打印标签（共 ' + list.length + ' 张）', list);
  };

  /* ---- 扫码组件（入库/出库/盘点共用） ---- */
  let scanStream = null, scanCamRAF = null;
  window.openScan = function (onResolved, opts) {
    opts = opts || {};
    state.scanResolve = onResolved;
    const secure = !!window.isSecureContext;
    openModal(opts.title || '扫码识别备品', `
      <div class="scan-tabs">
        <button class="btn sm" id="tabUpload" onclick="scanTab('upload')">📷 上传图片识别</button>
        ${secure
          ? '<button class="btn sm ghost" id="tabCam" onclick="scanTab(\'cam\')">🎥 摄像头扫码</button>'
          : '<span class="muted small">（摄像头需在 http://localhost 或 https 下打开才可用，当前可用「上传图片识别」）</span>'}
      </div>
      <div id="scanUpload">
        <input type="file" id="scanFile" accept="image/*" hidden onchange="scanFromFile(this)">
        <button class="btn" onclick="$('#scanFile').click()">选择二维码图片</button>
        <div id="scanResult" class="mt"></div>
      </div>
      <div id="scanCam" hidden>
        <video id="scanVideo" playsinline style="width:100%;background:#000;border-radius:8px"></video>
        <div id="scanCamMsg" class="muted small mt">将二维码对准摄像头…</div>
        <button class="btn ghost mt" onclick="stopScanCam()">停止摄像头</button>
      </div>
      <div class="tip mt">图片/摄像头识别失败时，可手动输入编号兜底：
        <input id="scanManual" placeholder="如 BJ-001" style="width:150px;display:inline-block;margin:0 6px">
        <button class="btn sm" onclick="scanManualResolve()">确定</button>
      </div>`);
    if (secure) startScanCam(); else scanTab('upload');
  };
  window.scanTab = function (which) {
    $('#scanUpload').hidden = which !== 'upload';
    const cam = $('#scanCam'); if (cam) cam.hidden = which !== 'cam';
    if (which === 'cam') startScanCam(); else stopScanCam();
  };
  window.scanFromFile = async function (input) {
    const file = input.files[0]; if (!file) return;
    const res = await decodeQRFromFile(file);
    handleScanResult(res);
  };
  function decodeQRFromFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas');
          const max = 1200; let w = img.width, h = img.height;
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
          let res = null;
          try { res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h); } catch (e) { res = null; }
          resolve(res);
        };
        img.onerror = () => resolve(null);
        img.src = reader.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
  function handleScanResult(res) {
    const box = $('#scanResult');
    if (!res || !res.data) { if (box) box.innerHTML = '<span class="badge danger">未识别到二维码，请换清晰照片或手动输入</span>'; return; }
    const raw = parseQRToken(res.data);
    if (box) box.innerHTML = `<span class="badge ok">已识别：${esc(raw)}</span>`;
    if (state.scanResolve) state.scanResolve(raw);
    setTimeout(closeModal, 700);
  }
  window.scanManualResolve = function () {
    const v = ($('#scanManual') && $('#scanManual').value || '').trim();
    if (!v) { toast('请输入编号', 'err'); return; }
    /* 手动输入也可能误填 / 粘贴二维码内容（含 SPMS1| 前缀），统一归一化后再派发 */
    if (state.scanResolve) state.scanResolve(parseQRToken(v));
    closeModal();
  };
  /* 扫码把备品编号写入指定输入框（入库/出库通用），识别后调用 onResolved 做后续联动 */
  window.scanForCode = function (inputId, onResolved) {
    openScan((raw) => {
      raw = parseQRToken(raw); // 防御性归一化（摄像头/拍照已剥，手动输入未剥）
      const inp = document.getElementById(inputId);
      if (inp) inp.value = raw;
      if (typeof onResolved === 'function') onResolved(raw);
      toast('已识别：' + raw, 'ok');
    }, { title: '扫码识别备品编号' });
  };
  /* 通用扫码填入：把扫码/识别到的文本直接写入指定输入框，并触发 onResolved 联动（用于库位号） */
  window.scanForText = function (inputId, onResolved) {
    openScan((raw) => {
      raw = parseQRToken(raw); // 防御性归一化，库位号无前缀时原样返回
      const inp = document.getElementById(inputId);
      if (inp) inp.value = raw;
      if (typeof onResolved === 'function') onResolved(raw);
      toast('已识别：' + raw, 'ok');
    }, { title: '扫码输入' });
  };

  /* ============================================================
   * 入库 / 出库 统一检索：编号 / 名称 / 规格 / 库位 四栏互查
   *   - 任一栏输入/扫码即检索；命中唯一备品时自动回填其余三栏
   *   - 多命中时以「检索结果」列表展示，点击行即确认并回填
   *   - 同时替换原「最近入库 / 出库记录」面板
   * ============================================================ */
  function matchPartsByFields(q) {
    return state.parts.filter((p) => {
      if (q.code && normalizeCode(p.code) !== normalizeCode(q.code)) return false;
      if (q.name && !p.name.toLowerCase().includes(q.name.toLowerCase())) return false;
      if (q.spec && !p.spec.toLowerCase().includes(q.spec.toLowerCase())) return false;
      if (q.loc && (p.location || '') !== q.loc) return false;
      return true;
    });
  }
  function fillPartFields(prefix, p) {
    const codeEl = document.getElementById(prefix + '_code');
    const nameEl = document.getElementById(prefix + '_name');
    const specEl = document.getElementById(prefix + '_spec');
    const locEl = document.getElementById(prefix + '_loc');
    const active = document.activeElement;          // 其余字段跳过聚焦态，避免光标跳动 / 输入被打断
    if (codeEl) codeEl.value = p.code;              // 编号始终规整回填（命中即唯一，不会打断输入）
    if (nameEl && active !== nameEl) nameEl.value = p.name;
    if (specEl && active !== specEl) specEl.value = p.spec;
    if (locEl && active !== locEl) locEl.value = p.location || '';
  }
  function renderPartResultList(resEl, list, prefix) {
    if (!resEl) return;
    if (!list.length) { resEl.innerHTML = '<div class="empty">⚠ 未找到匹配的备品，请检查输入或先在「备品管理」建档</div>'; return; }
    resEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>编号</th><th>名称</th><th>规格</th><th>库位</th><th>当前库存</th><th>状态</th><th>选择</th></tr></thead>
      <tbody>
        ${list.map((p) => {
          const st = stockStatus(p);
          const pickFn = prefix === 'in' ? 'inbound_pick' : 'outbound_pick';
          return `<tr class="res-row" onclick="${pickFn}('${esc(p.code)}')">
            <td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.spec)}</td><td>${esc(p.location)}</td>
            <td><b>${p.stock}</b></td><td><span class="badge ${st.cls}">${st.text}</span></td>
            <td><button class="btn sm" type="button">选择</button></td></tr>`;
        }).join('')}
      </tbody></table></div>`;
  }
  function applyInOutSearch(prefix) {
    const codeEl = document.getElementById(prefix + '_code');
    const nameEl = document.getElementById(prefix + '_name');
    const specEl = document.getElementById(prefix + '_spec');
    const locEl = document.getElementById(prefix + '_loc');
    const resEl = document.getElementById(prefix + '_results');
    const hint = document.getElementById(prefix + '_hint');
    if (!codeEl || !resEl) return;
    const q = {
      code: (codeEl.value || '').trim(),
      name: nameEl ? nameEl.value.trim() : '',
      spec: specEl ? specEl.value.trim() : '',
      loc: locEl ? locEl.value.trim() : ''
    };
    const anyFilled = q.code || q.name || q.spec || q.loc;
    if (!anyFilled) {
      resEl.innerHTML = '<div class="empty">在「编号 / 名称 / 规格 / 库位」任一栏输入即可检索，命中后自动回填其余字段</div>';
      if (hint) { hint.textContent = ''; hint.className = 'field-hint'; }
      return;
    }
    const matches = matchPartsByFields(q);
    if (matches.length === 0) {
      if (hint) { hint.textContent = '⚠ 未找到匹配的备品（已忽略大小写/连字符差异），请检查输入或先在「备品管理」建档'; hint.className = 'field-hint warn'; }
      renderPartResultList(resEl, [], prefix);
      return;
    }
    if (matches.length === 1) {
      const p = matches[0];
      fillPartFields(prefix, p);
      if (hint) { hint.textContent = '✓ 已匹配并回填：' + p.name + (p.location ? ' ｜ 库位：' + p.location : ''); hint.className = 'field-hint ok'; }
    } else {
      if (hint) { hint.textContent = '🔎 匹配到 ' + matches.length + ' 个备品，请点击列表中的一项以确认'; hint.className = 'field-hint'; }
    }
    renderPartResultList(resEl, matches, prefix);
  }
  window.applyInboundSearch = function () { applyInOutSearch('in'); };
  window.applyOutboundSearch = function () { applyInOutSearch('out'); };
  window.inbound_pick = function (code) { inOutPick('in', code); };
  window.outbound_pick = function (code) { inOutPick('out', code); };
  function inOutPick(prefix, code) {
    const p = state.parts.find((x) => x.code === code);
    if (!p) return;
    fillPartFields(prefix, p);
    const hint = document.getElementById(prefix + '_hint');
    if (hint) { hint.textContent = '✓ 已选择：' + p.name + (p.location ? ' ｜ 库位：' + p.location : ''); hint.className = 'field-hint ok'; }
    const resEl = document.getElementById(prefix + '_results');
    if (resEl) renderPartResultList(resEl, [p], prefix);
  }
  // 一键清空已选备品与已填写的检索字段，使界面回到可重新查询的初始状态。
  // 根因：选中备品后 code/name/spec/loc 四栏均被回填，若仅改其中一栏再检索，
  // 其余三栏的残留值会作为 AND 过滤条件锁死结果（旧 code/库位仍匹配原备品），导致无法按新条件刷新列表。
  function clearInOutSelection(prefix) {
    ['code', 'name', 'spec', 'loc'].forEach((f) => {
      const el = document.getElementById(prefix + '_' + f);
      if (el) el.value = '';
    });
    const resEl = document.getElementById(prefix + '_results');
    if (resEl) resEl.innerHTML = '<div class="empty">在「编号 / 名称 / 规格 / 库位」任一栏输入即可检索，命中后自动回填其余字段</div>';
    const hint = document.getElementById(prefix + '_hint');
    if (hint) { hint.textContent = ''; hint.className = 'field-hint'; }
    const codeEl = document.getElementById(prefix + '_code');
    if (codeEl) codeEl.focus();
  }
  window.clearInboundSelection = function () { clearInOutSelection('in'); };
  window.clearOutboundSelection = function () { clearInOutSelection('out'); };
  function resolveInOutPart(prefix) {
    const code = normalizeCode((document.getElementById(prefix + '_code').value || '').trim());
    if (code) { const m = state.parts.filter((p) => normalizeCode(p.code) === code); if (m.length) return m[0]; }
    const name = (document.getElementById(prefix + '_name').value || '').trim().toLowerCase();
    const spec = (document.getElementById(prefix + '_spec').value || '').trim().toLowerCase();
    const loc = (document.getElementById(prefix + '_loc').value || '').trim();
    let cand = state.parts.slice();
    if (name) cand = cand.filter((p) => p.name.toLowerCase().includes(name));
    if (spec) cand = cand.filter((p) => p.spec.toLowerCase().includes(spec));
    if (loc) cand = cand.filter((p) => (p.location || '') === loc);
    return cand.length === 1 ? cand[0] : null;
  }
  window.scanInboundCode = function () { scanForCode('in_code', () => applyInboundSearch('in')); };
  window.scanInboundLoc = function () { scanForText('in_loc', () => applyInboundSearch('in')); };
  window.scanOutboundCode = function () { scanForCode('out_code', () => applyOutboundSearch('out')); };
  window.scanOutboundLoc = function () { scanForText('out_loc', () => applyOutboundSearch('out')); };

  function startScanCam() {
    const video = $('#scanVideo'); if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const m = $('#scanCamMsg'); if (m) m.textContent = '当前环境不支持摄像头'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((stream) => {
      scanStream = stream; video.srcObject = stream; video.play();
      scanCamLoop(video);
    }).catch((e) => { const m = $('#scanCamMsg'); if (m) m.textContent = '无法开启摄像头：' + e.message + '（可用上传图片方式）'; });
  }
  function scanCamLoop(video) {
    if (!scanStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const cv = document.createElement('canvas');
      cv.width = video.videoWidth; cv.height = video.videoHeight;
      const ctx = cv.getContext('2d'); ctx.drawImage(video, 0, 0, cv.width, cv.height);
      let res = null;
      try { res = jsQR(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height); } catch (e) { res = null; }
      if (res && res.data) { handleScanResult(res); return; }
    }
    scanCamRAF = requestAnimationFrame(() => scanCamLoop(video));
  }
  function stopScanCam() {
    if (scanCamRAF) cancelAnimationFrame(scanCamRAF); scanCamRAF = null;
    if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  }
  window.stopScanCam = stopScanCam;

  /* ---- 盘点记录列表（盘点入口已合并至「备件查询」统一页，由 openStocktakeModal 触发） ---- */
  function renderStocktakeList(targetId) {
    const tb = $('#' + (targetId || 'stList')); if (!tb) return;
    const list = state.transactions.filter((t) => t.type === 'check').sort((a, b) => b.time - a.time).slice(0, 50);
    tb.innerHTML = list.length ? list.map((t) => {
      const diff = num(t.counterparty);
      const actual = t.quantity;
      const sys = actual - diff;
      const st = diff === 0 ? 'ok' : 'warn';
      return `<tr>
        <td>${esc(t.partCode)}</td><td>${esc(t.partName)}</td>
        <td>${sys}</td><td><b>${actual}</b></td>
        <td><span class="badge ${st}">${diff >= 0 ? '+' : ''}${diff}</span></td>
        <td>${esc(t.operator)}</td><td>${fmtTime(t.time)}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">暂无盘点记录</td></tr>';
  }

  /* ============================================================
   * 备件查询（v2.7 新增）
   *   - 与"备品管理"（增删改/批量操作）、"库存管理"（按库存只读视图）、
   *     "记录查询"（流水筛选）形成清晰分工：
   *     备件查询 = 以"备件"为入口的一站式只读检索，集中展示「该备件是
   *     什么 + 现在有多少 + 放在哪 + 最近怎么动的」，适合临时核对场景。
   *   - 输入框支持按编号 / 名称 / 规格 / 库位 / 分类 模糊搜索 + 候选下拉。
   * ============================================================ */
  /* 备件查询：输入关键字实时列出【所有】匹配备件（结果表格，不进入下拉选择）
   * 支持按 编号 / 名称 / 规格 / 库位 / 分类 多字段模糊搜索 */
  function qySearchList(q) {
    q = (q || '').trim().toLowerCase();
    const qn = normalizeCode(q); // 去前缀 + 连字符/空格/下划线，用于编号容错匹配
    const all = state.parts.slice();
    if (!qn) return all;
    return all.filter((p) => {
      /* ① 编号归一化匹配：BJ003 可命中 BJ-003（连字符/大小写/空格差异容错） */
      if (normalizeCode(p.code).includes(qn)) return true;
      /* ② 名称/规格/库位/分类按原始值包含匹配（保持原有语义） */
      const hay = (p.code + ' ' + p.name + ' ' + (p.spec || '') + ' ' + (p.location || '') + ' ' + (p.category || '')).toLowerCase();
      return hay.includes(q);
    });
  }
  /* 实时查询：渲染匹配备件的结果列表（每行可展开明细） */
  window.qyRun = function () {
    const box = $('#qyResult'); if (!box) return;
    const qInp = $('#qy_q');
    /* 扫描枪键盘键入会把完整二维码内容（SPMS1|xx / SPMS|xx）直接打到搜索框，
     * 需先归一化剥离前缀再做检索；若有前缀则回写输入框为纯净编号，避免显示乱码。 */
    let q = (qInp && qInp.value) || '';
    const qNorm = parseQRToken(q);
    if (qInp && q.trim() !== qNorm) qInp.value = qNorm;
    q = qNorm;
    const cat = ($('#qyCat') && $('#qyCat').value) || '';
    const stt = ($('#qyStatus') && $('#qyStatus').value) || '';
    state.qyQuery = q; state.qyCat = cat; state.qyStatus = stt;
    let list = qySearchList(q);
    if (cat) list = list.filter((p) => (p.category || '') === cat);
    if (stt === 'warn') list = list.filter((p) => p.safeStock > 0 && p.stock < p.safeStock);
    else if (stt === 'out') list = list.filter((p) => p.stock <= 0);
    else if (stt === 'ok') list = list.filter((p) => !(p.stock <= 0) && !(p.safeStock > 0 && p.stock < p.safeStock));
    list = list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const hint = $('#qy_q_hint');
    if (hint) hint.textContent = (q.trim() || cat || stt)
      ? `共匹配 ${list.length} 个备件（关键字 / 分类 / 库存状态 组合筛选）`
      : `未输入筛选条件，显示全部 ${list.length} 个备件`;
    if (!list.length) {
      box.innerHTML = `<div class="panel" style="margin-bottom:0"><div class="empty">未找到匹配的备件，请调整关键字 / 分类 / 库存状态。</div></div>`;
      return;
    }
    const rows = list.map((p) => {
      const st = stockStatus(p);
      const txs = state.transactions.filter((t) => t.partId === p.id);
      const lastTx = txs.slice().sort((a, b) => b.time - a.time)[0];
      return `<tr class="qy-row-click" onclick="qySelect(${p.id})">
        <td>${esc(p.code)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.spec || '—')}</td>
        <td>${esc(p.category || '—')}</td>
        <td>${esc(p.location || '—')}</td>
        <td><b>${p.stock}</b></td>
        <td>${p.safeStock || 0}</td>
        <td><span class="badge ${st.cls}">${st.text}</span></td>
        <td class="muted small">${lastTx ? fmtTime(lastTx.time) : '—'}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title">查询结果（${list.length}）</div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>名称</th><th>规格</th><th>分类</th><th>库位</th><th>当前库存</th><th>安全库存</th><th>状态</th><th>最近动态</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div id="qyDetailBox" class="panel" style="display:none"></div>`;
  };
  /* 点击结果行：在结果表下方的独立容器中展开/收起该备件明细。
   * 注意：原实现把明细嵌在结果表的 <tbody> 内（tr 内再嵌 table），
   * 在 display:none↔显示 切换时 Chromium 内层表格布局常不刷新，导致记录表错位/塌陷；
   * 改为独立容器后彻底规避嵌套表格渲染怪癖。 */
  window.qySelect = function (id) {
    const box = $('#qyDetailBox');
    if (!box) return;
    if (box.dataset.openId === String(id) && box.style.display !== 'none') {
      box.style.display = 'none'; box.dataset.openId = ''; return;
    }
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    box.innerHTML = qyDetailInner(p);
    box.style.display = 'block';
    box.dataset.openId = String(id);
    if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  window.qyClear = function () {
    const inp = $('#qy_q'); if (inp) { inp.value = ''; inp.focus(); }
    window.qyRun();
  };
  window.scanForQyQ = function () {
    openScan((raw) => {
      raw = parseQRToken(raw); // 归一化（手动输入未剥前缀）
      const inp = $('#qy_q');
      if (inp) inp.value = raw;
      window.qyRun();
      toast('已带入编号：' + raw, 'ok');
    }, { title: '扫码识别备品编号' });
  };
  /* 单个备件明细（库存 + 库位 + 最近流水），用于结果列表展开 */
  function qyDetailInner(p) {
    const st = stockStatus(p);
    const txs = state.transactions.filter((t) => t.partId === p.id);
    const inTotal = txs.filter((t) => t.type === 'in').reduce((s, t) => s + num(t.quantity), 0);
    const outTotal = txs.filter((t) => t.type === 'out').reduce((s, t) => s + num(t.quantity), 0);
    const checkCount = txs.filter((t) => t.type === 'check').length;
    const inCnt = txs.filter((t) => t.type === 'in').length;
    const outCnt = txs.filter((t) => t.type === 'out').length;
    const lastTx = txs.slice().sort((a, b) => b.time - a.time)[0];
    const recent = txs.slice().sort((a, b) => b.time - a.time).slice(0, 15);
    const recentRows = recent.length ? recent.map((t) => {
      const badge = t.type === 'in' ? '<span class="badge ok">入库</span>'
        : t.type === 'out' ? '<span class="badge muted">出库</span>'
        : '<span class="badge warn">盘点</span>';
      const diff = t.type === 'check' ? num(t.counterparty) : 0;
      const sys = t.type === 'check' ? t.quantity - diff : '';
      return `<tr>
        <td>${badge}</td>
        <td>${t.type === 'check' ? sys : (t.type === 'in' ? '+' : '-') + t.quantity}</td>
        <td>${esc(t.operator)}</td>
        <td>${t.type === 'in' ? esc(t.counterparty) : ''}</td>
        <td>${fmtTime(t.time)}</td>
        <td>${esc(t.remark)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">该备件暂无出入库 / 盘点记录</td></tr>';
    return `
      <div class="qy-detail">
        <div class="qy-info">
          <div class="qy-row"><div class="qy-key">编号</div><div class="qy-val"><b>${esc(p.code)}</b></div></div>
          <div class="qy-row"><div class="qy-key">名称</div><div class="qy-val">${esc(p.name)}</div></div>
          <div class="qy-row"><div class="qy-key">规格</div><div class="qy-val">${esc(p.spec || '—')}</div></div>
          <div class="qy-row"><div class="qy-key">分类</div><div class="qy-val">${esc(p.category || '—')}</div></div>
          <div class="qy-row"><div class="qy-key">单位</div><div class="qy-val">${esc(p.unit || '—')}</div></div>
          <div class="qy-row"><div class="qy-key">库位</div><div class="qy-val">${esc(p.location || '（未分配）')}</div></div>
          <div class="qy-row"><div class="qy-key">安全库存</div><div class="qy-val">${p.safeStock || 0}</div></div>
          <div class="qy-row"><div class="qy-key">当前库存</div><div class="qy-val"><b>${p.stock}</b> <span class="badge ${st.cls}">${st.text}</span></div></div>
          <div class="qy-row"><div class="qy-key">累计入库</div><div class="qy-val">${inTotal}（${inCnt} 次）</div></div>
          <div class="qy-row"><div class="qy-key">累计出库</div><div class="qy-val">${outTotal}（${outCnt} 次）</div></div>
          <div class="qy-row"><div class="qy-key">盘点次数</div><div class="qy-val">${checkCount}</div></div>
          <div class="qy-row"><div class="qy-key">最近动态</div><div class="qy-val muted small">${lastTx ? fmtTime(lastTx.time) + ' · ' + (lastTx.type === 'in' ? '入库' : lastTx.type === 'out' ? '出库' : '盘点') : '—'}</div></div>
          <div class="qy-row qy-row-wide"><div class="qy-key">备注或用途</div><div class="qy-val">${esc(p.remark || '—')}</div></div>
        </div>
        <div class="btn-row mt">
          <button class="btn ghost" onclick="openPartQR(${p.id})">查看二维码</button>
          <button class="btn ghost" onclick="openStocktakeModal(${p.id})">🧮 盘点此备件</button>
        </div>
        <div class="mt">
          <div class="panel-title sm">最近出入库 / 盘点记录（最多 15 条）</div>
          <div class="table-wrap"><table>
            <thead><tr><th>类型</th><th>数量</th><th>经办人</th><th>对方</th><th>时间</th><th>备注或用途</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  function renderQuery() {
    const cats = Array.from(new Set(state.parts.map((p) => p.category).filter(Boolean))).sort();
    const catOpts = ['<option value="">全部分类</option>']
      .concat(cats.map((c) => `<option value="${escAttr(c)}">${esc(c)}</option>`)).join('');
    const html = `
      <div class="panel">
        <div class="panel-title">备件查询 · 库存统一管理（按编号 / 名称 / 规格 / 库位 / 分类 模糊搜索）</div>
        <div class="tip">说明：本页为<strong>备件与库存的统一入口</strong>，集中展示「备件是什么 + 现在有多少 + 放在哪 + 是否预警 + 最近怎么动的」，点任意一行可展开明细并<strong>直接盘点</strong>；如需编辑基础信息请到「备品管理」。</div>
        <div class="filter-bar">
          <div class="field" style="flex:2 1 320px;min-width:280px">
            <label>输入关键字或扫码</label>
            <div class="input-with-btn">
              <input id="qy_q" placeholder="扫描或输入关键字，如 电磁阀 / 1001 / A-01-03" autocomplete="off">
              <button type="button" class="btn ghost sm" onclick="scanForQyQ()" title="扫码识别备品">📷</button>
              <button type="button" class="btn ghost sm" onclick="qyClear()" title="清除">清除</button>
            </div>
          </div>
          <div class="field"><label>分类</label><select id="qyCat">${catOpts}</select></div>
          <div class="field"><label>库存状态</label><select id="qyStatus">
            <option value="">全部</option>
            <option value="ok">正常</option>
            <option value="warn">预警（低于安全库存）</option>
            <option value="out">缺货（库存为 0）</option>
          </select></div>
          <div class="spacer"></div>
          <div class="field" style="align-self:flex-end"><button class="btn ghost" onclick="exportQueryCSV()">导出 CSV</button></div>
        </div>
        <div id="qy_q_hint" class="field-hint"></div>
      </div>
      <div id="qyResult"><!-- 动态渲染匹配列表 --></div>
      <div class="panel" style="margin-bottom:0">
        <div class="panel-title">最近盘点记录</div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>名称</th><th>系统库存</th><th>实盘</th><th>差异</th><th>经办人</th><th>时间</th></tr></thead>
          <tbody id="qyCheckList"></tbody>
        </table></div>
      </div>`;
    $('#content').innerHTML = html;
    // 恢复筛选状态（盘点提交后重渲染时保留）
    if (state.qyQuery) $('#qy_q').value = state.qyQuery;
    if (state.qyCat) $('#qyCat').value = state.qyCat;
    if (state.qyStatus) $('#qyStatus').value = state.qyStatus;
    $('#qyCat').addEventListener('change', window.qyRun);
    $('#qyStatus').addEventListener('change', window.qyRun);
    bindLiveFilter('qy_q', window.qyRun);   // IME 安全：输入框常驻，仅刷新结果区
    window.qyRun();
    renderStocktakeList('qyCheckList');
  }

  /* 统一导出：按当前筛选条件导出备件清单 */
  window.exportQueryCSV = function () {
    const q = state.qyQuery || ''; const cat = state.qyCat || ''; const stt = state.qyStatus || '';
    let list = qySearchList(q);
    if (cat) list = list.filter((p) => (p.category || '') === cat);
    if (stt === 'warn') list = list.filter((p) => p.safeStock > 0 && p.stock < p.safeStock);
    else if (stt === 'out') list = list.filter((p) => p.stock <= 0);
    else if (stt === 'ok') list = list.filter((p) => !(p.stock <= 0) && !(p.safeStock > 0 && p.stock < p.safeStock));
    list = list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const rows = list.map((p) => [p.code, p.name, p.spec, p.category, p.unit, p.location, p.safeStock, p.stock, stockStatus(p).text]);
    download('备件清单_' + stamp() + '.csv', toCSV(['编号', '名称', '规格', '分类', '单位', '库位', '安全库存', '当前库存', '状态'], rows), 'text/csv;charset=utf-8');
    toast('已导出', 'ok');
  };

  /* 盘点弹窗：从「备件查询」任意备件明细发起，校正库存并留存 check 流水 */
  window.openStocktakeModal = function (id) {
    const p = state.parts.find((x) => x.id === id); if (!p) return;
    const body = `
      <div class="panel" style="box-shadow:none;margin:0">
        <div class="panel-title">盘点备件：${esc(p.name)}（${esc(p.code)}）</div>
        <div class="field-grid">
          <div class="field"><label>系统库存</label><input id="stk_sys" disabled value="${p.stock}"></div>
          <div class="field"><label>实盘数量 *</label><input id="stk_actual" type="number" min="0" step="any" placeholder="输入实际盘点数量"></div>
          <div class="field op-field"><label>经办人 *</label><input id="stk_op" placeholder="盘点人（支持拼音模糊查找）" autocomplete="off" oninput="operatorSuggest(this)" onfocus="operatorSuggest(this)"><div class="op-ac" id="stk_op_ac" style="display:none"></div></div>
          <div class="field" style="grid-column:1 / -1"><label>备注或用途</label><input id="stk_remark" placeholder="如：A 货架第一层盘亏"></div>
        </div>
        <div class="btn-row mt">
          <button class="btn" onclick="submitStocktakeModal(${p.id})">确认盘点（校正库存并留痕）</button>
          <button class="btn ghost" onclick="closeModal()">取消</button>
        </div>
      </div>`;
    openModal('库存盘点', body);
    const inp = $('#stk_actual'); if (inp) inp.focus();
  };

  window.submitStocktakeModal = async function (id) {
    const p = state.parts.find((x) => x.id === id);
    if (!p) { toast('备品不存在', 'err'); return; }
    const actual = num($('#stk_actual') && $('#stk_actual').value);
    const op = ($('#stk_op') && $('#stk_op').value || '').trim();
    if (actual < 0) { toast('实盘数量不能为负', 'err'); return; }
    if (!op) { toast('请填写经办人', 'err'); return; }
    const diff = actual - p.stock;
    if (!confirm(`备品「${p.name}（${p.code}）」\n系统库存：${p.stock}\n实盘数量：${actual}\n差异：${diff >= 0 ? '+' : ''}${diff}\n\n确认按实盘校正库存？`)) return;
    rememberOperator(op);
    try {
      p.stock = actual; p.updatedAt = Date.now();
      await DB.updatePart(p);
      const record = {
        type: 'check', partId: p.id, partCode: p.code, partName: p.name,
        quantity: actual, operator: op, counterparty: String(diff),
        time: Date.now(), remark: ($('#stk_remark') && $('#stk_remark').value || '').trim(),
        createdAt: Date.now()
      };
      await DB.add('transactions', record);
      closeModal();
      await reloadAll();
      renderQuery();          // 重新渲染统一页：库存与备件信息同步一致
      renderTopStats();
      toast('盘点完成，库存已校正', 'ok');
    } catch (e) { toast('盘点失败：' + e.message, 'err'); }
  };

  /* ============================================================
   * 初始化
   * ============================================================ */
  async function init() {
    try {
      await DB.open();
      await reloadAll();
      // 加载持久化的自定义分类 / 单位（写入本地存储，刷新保留）
      try { const cc = await DB.getMeta('customCategories'); state.customCategories = Array.isArray(cc) ? cc : []; } catch (e) { state.customCategories = []; }
      try { const cu = await DB.getMeta('customUnits'); state.customUnits = Array.isArray(cu) ? cu : []; } catch (e) { state.customUnits = []; }
      // 加载经办人 / 领用人名单：持久化自定义 + 历史交易中出现过的，合并去重
      try {
        const saved = await DB.getMeta('operators');
        const txOps = state.transactions.map((t) => t.operator).filter(Boolean);
        state.operators = Array.from(new Set([...(Array.isArray(saved) ? saved : []), ...txOps])).filter(Boolean);
      } catch (e) { state.operators = []; }
    } catch (e) {
      $('#content').innerHTML = `<div class="panel">
        <div class="panel-title" style="color:var(--danger)">无法启动：本地存储不可用</div>
        <p>${esc(e.message)}</p>
        <p class="muted">建议：使用最新版 Chrome / Edge / Firefox 打开；若仍不行，可在该文件夹下启动一个本地服务器（如
        <code>python -m http.server</code>）后通过 http:// 访问。</p>
      </div>`;
      toast('初始化失败：' + e.message, 'err');
      return;
    }
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    const foot = $('.sidebar-foot .foot-version');
    if (foot) foot.textContent = 'v' + DB.APP_VERSION + ' · ' + (DB.currentBackend() === 'idb' ? 'IndexedDB（本地数据库）' : DB.currentBackend() === 'ls' ? 'localStorage（浏览器本地）' : '本地文件（JSON）');
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOverlay').addEventListener('click', (e) => { if (e.target === $('#modalOverlay')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.combo')) closeAllCombos();
      if (!e.target.closest('.op-field')) closeOpAc();
    });
    showView('dashboard');
  }

  // 暴露给内联 onclick 的少量函数
  window.renderManualAudit = renderManualAudit;
  window.closeModal = closeModal;
  window.renderRecords = renderRecords;
  window.renderRecordsResults = renderRecordsResults;

  /* ============================================================
   * 夹具管理模块
   * ============================================================ */
  const FIX_STATUS = {
    stocked: { label: '在库', cls: 'ok' },
    checked_out: { label: '已出库', cls: 'warn' },
    repair: { label: '维修中', cls: 'danger' },
    retired: { label: '已报废', cls: 'muted' }
  };
  const FIX_TX_TYPE = {
    out: { label: '出库', icon: '📤' },
    return: { label: '回库', icon: '📥' },
    in: { label: '入库', icon: '📦' },
    repair: { label: '维修', icon: '🔧' },
    retire: { label: '报废', icon: '🗑️' }
  };

  window.fixtureSelect = async function (id) {
    state.fixSelectedId = id;
    $$('.fixture-card').forEach((c) => c.classList.toggle('selected', c.dataset.id == id));
  };

  window.fixtureOut = async function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status !== 'stocked' && f.status !== 'returned') { toast('夹具当前状态不允许出库', 'err'); return; }
    const html = `
      <div class="form-group"><label>经办人</label><input type="text" id="fix_out_op" placeholder="经办人（拼音联想）"></div>
      <div class="form-group"><label>领用人</label><input type="text" id="fix_out_party" placeholder="领用人/使用部门"></div>
      <div class="form-group"><label>出库时间</label><input type="datetime-local" id="fix_out_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_out_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn" onclick="submitFixtureOut(${id})">确认出库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`出库 — ${f.code} ${f.name}`, html);
  };

  window.submitFixtureOut = async function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    const operator = ($('#fix_out_op') || {}).value.trim();
    const counterparty = ($('#fix_out_party') || {}).value.trim();
    const time = inputToMs($('#fix_out_time').value);
    const remark = ($('#fix_out_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'out', operator, counterparty, time, remark });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('出库成功', 'ok');
    } catch (e) { toast('出库失败：' + e.message, 'err'); }
  };

  window.fixtureReturn = async function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (f.status !== 'checked_out') { toast('夹具未处于已出库状态', 'err'); return; }
    const html = `
      <div class="form-group"><label>经办人</label><input type="text" id="fix_ret_op" placeholder="经办人" value=""></div>
      <div class="form-group"><label>回库时间</label><input type="datetime-local" id="fix_ret_time" value="${nowInput()}"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_ret_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn" onclick="submitFixtureReturn(${id})">确认回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`回库 — ${f.code} ${f.name}`, html);
  };

  window.submitFixtureReturn = async function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    const operator = ($('#fix_ret_op') || {}).value.trim();
    const time = inputToMs($('#fix_ret_time').value);
    const remark = ($('#fix_ret_remark') || {}).value.trim();
    if (!operator) { toast('请填写经办人', 'err'); return; }
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'return', operator, counterparty: '', time, remark });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('回库成功', 'ok');
    } catch (e) { toast('回库失败：' + e.message, 'err'); }
  };

  window.fixtureRetire = async function (id) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) { toast('夹具不存在', 'err'); return; }
    if (!confirm(`确认报废夹具 ${f.code} ${f.name}？报废后不可恢复。`)) return;
    try {
      await DB.fixtureAddTransaction({ fixtureId: id, type: 'retire', operator: '', counterparty: '', time: Date.now(), remark: '报废' });
      await reloadAll();
      renderFixtures();
      toast('夹具已报废', 'ok');
    } catch (e) { toast('报废失败：' + e.message, 'err'); }
  };

  window.fixtureNew = function () {
    const html = `
      <div class="form-group"><label>编号</label><input type="text" id="fix_new_code" placeholder="4位数字编号（如 2001）" maxlength="4"></div>
      <div class="form-group"><label>名称</label><input type="text" id="fix_new_name" placeholder="夹具名称"></div>
      <div class="form-group"><label>规格型号</label><input type="text" id="fix_new_spec" placeholder="规格型号"></div>
      <div class="form-group"><label>分类</label><input type="text" id="fix_new_cat" placeholder="分类（如 冲压/焊接/装配）"></div>
      <div class="form-group"><label>库位</label><input type="text" id="fix_new_loc" placeholder="存放位置（可选）"></div>
      <div class="form-group"><label>备注</label><input type="text" id="fix_new_remark" placeholder="可选备注"></div>
      <div class="form-actions">
        <button class="btn" onclick="submitFixtureNew()">建档</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal('新建夹具', html);
  };

  window.submitFixtureNew = async function () {
    const code = ($('#fix_new_code') || {}).value.trim();
    const name = ($('#fix_new_name') || {}).value.trim();
    const spec = ($('#fix_new_spec') || {}).value.trim();
    const category = ($('#fix_new_cat') || {}).value.trim();
    const location = ($('#fix_new_loc') || {}).value.trim();
    const remark = ($('#fix_new_remark') || {}).value.trim();
    if (!code || !/^\d{4}$/.test(code)) { toast('编号为4位纯数字（如 2001）', 'err'); return; }
    if (!name) { toast('请填写夹具名称', 'err'); return; }
    try {
      await DB.fixtureAdd({ code, name, spec, category, location, remark, status: 'stocked', totalOutCount: 0, totalReturnCount: 0, repairCount: 0 });
      closeModal();
      await reloadAll();
      renderFixtures();
      toast('夹具建档成功', 'ok');
    } catch (e) { toast('建档失败：' + e.message, 'err'); }
  };

  window.fixtureSearch = function () {
    const q = ($('#fix_search') || {}).value.trim().toLowerCase();
    const list = $('#fixture_list');
    if (!list) return;
    const filtered = q ? state.fixtures.filter((f) => f.code.includes(q) || (f.name || '').toLowerCase().includes(q) || (f.spec || '').toLowerCase().includes(q)) : state.fixtures;
    renderFixtureCards(list, filtered, state.fixSelectedId || 0);
  };

  window.fixtureExportCSV = function () {
    const headers = ['编号', '名称', '规格', '分类', '库位', '状态', '累计出库', '累计回库', '维修次数', '备注'];
    const rows = state.fixtures.map((f) => [f.code, f.name, f.spec || '', f.category || '', f.location || '', (FIX_STATUS[f.status] || {}).label || f.status, f.totalOutCount || 0, f.totalReturnCount || 0, f.repairCount || 0, f.remark || '']);
    const csv = toCSV(headers, rows);
    download('夹具清单_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  };

  function renderFixtureCards(container, fixtures, selectedId = 0) {
    if (!fixtures.length) { container.innerHTML = '<div class="empty-tip">暂无夹具记录</div>'; return; }
    const html = fixtures.map((f) => {
      const isSelected = f.id === selectedId;
      const status = FIX_STATUS[f.status] || { label: f.status, cls: '' };
      return `
        <div class="fixture-card ${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
          <div class="fixture-card-header">
            <span class="fixture-code">${esc(f.code)}</span>
            <span class="status-badge status-${status.cls}">${status.label}</span>
          </div>
          <div class="fixture-card-body">
            <div class="fixture-name">${esc(f.name)}</div>
            <div class="fixture-spec">${esc(f.spec || '-')}</div>
            <div class="fixture-meta"><span>出库 ${f.totalOutCount || 0} 次</span><span>回库 ${f.totalReturnCount || 0} 次</span></div>
          </div>
          <div class="fixture-card-footer">
            ${f.status === 'stocked' || f.status === 'returned' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button>` : ''}
            ${f.status === 'checked_out' ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>` : ''}
            ${f.status !== 'retired' ? `<button class="btn sm btn-danger" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
    container.innerHTML = `<div class="fixture-grid">${html}</div>`;
  }

  function renderFixTransactions(container, txs, filterId = null) {
    if (!txs.length) { container.innerHTML = '<div class="empty-tip">暂无流水记录</div>'; return; }
    const filtered = filterId ? txs.filter((t) => t.fixtureId === filterId) : txs;
    if (!filtered.length) { container.innerHTML = '<div class="empty-tip">无匹配记录</div>'; return; }
    const html = filtered.map((t) => {
      const tc = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
      const fs = FIX_STATUS[t.fromStatus] || { label: t.fromStatus };
      const ts = FIX_STATUS[t.toStatus] || { label: t.toStatus };
      return `
        <div class="tx-row">
          <div class="tx-type">${tc.icon} ${tc.label}</div>
          <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
          <div class="tx-status">${fs.label} → ${ts.label}</div>
          <div class="tx-operator">${esc(t.operator || '-')}</div>
          <div class="tx-party">${esc(t.counterparty || '-')}</div>
          <div class="tx-time">${fmtTime(t.time)}</div>
          <div class="tx-remark">${esc(t.remark || '-')}</div>
        </div>
      `;
    }).join('');
    container.innerHTML = html;
  }

  window.renderFixtures = function () {
    const container = $('#content');
    if (!container) return;
    const inStock = state.fixtures.filter((f) => f.status === 'stocked').length;
    const outStock = state.fixtures.filter((f) => f.status === 'checked_out').length;
    const repair = state.fixtures.filter((f) => f.status === 'repair').length;
    const retired = state.fixtures.filter((f) => f.status === 'retired').length;
    container.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          夹具管理
          <span class="panel-actions">
            <button class="btn sm" onclick="fixtureNew()">➕ 新建夹具</button>
            <button class="btn sm" onclick="fixtureExportCSV()">📊 导出CSV</button>
          </span>
        </div>
        <div class="stats-bar">
          <div class="stat-item"><span class="stat-label">总计</span><span class="stat-value">${state.fixtures.length}</span></div>
          <div class="stat-item"><span class="stat-label">在库</span><span class="stat-value stat-ok">${inStock}</span></div>
          <div class="stat-item"><span class="stat-label">已出库</span><span class="stat-value stat-warn">${outStock}</span></div>
          <div class="stat-item"><span class="stat-label">维修中</span><span class="stat-value stat-danger">${repair}</span></div>
          <div class="stat-item"><span class="stat-label">已报废</span><span class="stat-value stat-muted">${retired}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">夹具列表</div>
        <div class="search-bar"><input type="text" id="fix_search" placeholder="搜索编号/名称/规格..." oninput="fixtureSearch()"></div>
        <div id="fixture_list"></div>
      </div>
      <div class="panel">
        <div class="panel-title">流水记录</div>
        <div id="fix_tx_list"></div>
      </div>
    `;
    renderFixtureCards($('#fixture_list'), state.fixtures, state.fixSelectedId || 0);
    renderFixTransactions($('#fix_tx_list'), state.fixTransactions, state.fixSelectedId || null);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
