/* ============================================================
 * fixtures/app.js — 夹具管理模块
 * 状态流转：stocked(在库) → checked_out(已出库) → stocked(已回库)
 * 业务特点：同一夹具可重复出库、回库，需追踪每次流转
 * ============================================================ */
(function () {
  'use strict';

  // 夹具状态映射
  const FIXTURE_STATUS = {
    stocked: { label: '在库', cls: 'ok' },
    checked_out: { label: '已出库', cls: 'warn' },
    repair: { label: '维修中', cls: 'danger' },
    retired: { label: '已报废', cls: 'muted' }
  };

  // 夹具流水类型映射
  const FIX_TX_TYPE = {
    out: { label: '出库', icon: '📤' },
    return: { label: '回库', icon: '📥' },
    in: { label: '入库', icon: '📦' },
    repair: { label: '维修', icon: '🔧' },
    retire: { label: '报废', icon: '🗑️' }
  };

  /* ============================================================
   * 夹具状态工具函数
   * ============================================================ */
  function fixtureStatusIcon(s) {
    const map = {
      stocked: '🟢',
      checked_out: '🟡',
      repair: '🔴',
      retired: '⚫'
    };
    return map[s] || '⚪';
  }

  function fixtureStatusBadge(s) {
    const cfg = FIXTURE_STATUS[s] || { label: s, cls: '' };
    return `<span class="status-badge status-${cfg.cls}">${cfg.label}</span>`;
  }

  /* ============================================================
   * 渲染夹具列表
   * ============================================================ */
  function renderFixtureList(container, fixtures, selectedId = 0) {
    if (!fixtures.length) {
      container.innerHTML = '<div class="empty-tip">暂无夹具记录</div>';
      return;
    }

    const html = fixtures.map((f) => {
      const isSelected = f.id === selectedId;
      const status = FIXTURE_STATUS[f.status] || { label: f.status, cls: '' };
      return `
        <div class="fixture-card ${isSelected ? 'selected' : ''}" data-id="${f.id}" onclick="fixtureSelect(${f.id})">
          <div class="fixture-card-header">
            <span class="fixture-code">${esc(f.code)}</span>
            ${fixtureStatusBadge(f.status)}
          </div>
          <div class="fixture-card-body">
            <div class="fixture-name">${esc(f.name)}</div>
            <div class="fixture-spec">${esc(f.spec || '-')}</div>
            <div class="fixture-meta">
              <span>出库 ${f.totalOutCount || 0} 次</span>
              <span>回库 ${f.totalReturnCount || 0} 次</span>
            </div>
          </div>
          <div class="fixture-card-footer">
            ${f.status === 'stocked' || f.status === 'returned'
              ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureOut(${f.id})">出库</button>`
              : ''}
            ${f.status === 'checked_out'
              ? `<button class="btn sm" onclick="event.stopPropagation(); fixtureReturn(${f.id})">回库</button>`
              : ''}
            ${f.status !== 'retired'
              ? `<button class="btn sm btn-danger" onclick="event.stopPropagation(); fixtureRetire(${f.id})">报废</button>`
              : ''}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `<div class="fixture-grid">${html}</div>`;
  }

  /* ============================================================
   * 渲染夹具流水记录
   * ============================================================ */
  function renderFixTransactions(container, txs, filterFixtureId = null) {
    if (!txs.length) {
      container.innerHTML = '<div class="empty-tip">暂无流水记录</div>';
      return;
    }

    const filtered = filterFixtureId
      ? txs.filter((t) => t.fixtureId === filterFixtureId)
      : txs;

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-tip">无匹配记录</div>';
      return;
    }

    const html = filtered.map((t) => {
      const typeCfg = FIX_TX_TYPE[t.type] || { label: t.type, icon: '📋' };
      const fromStatus = FIXTURE_STATUS[t.fromStatus] || { label: t.fromStatus, cls: '' };
      const toStatus = FIXTURE_STATUS[t.toStatus] || { label: t.toStatus, cls: '' };
      return `
        <div class="tx-row">
          <div class="tx-type">${typeCfg.icon} ${typeCfg.label}</div>
          <div class="tx-fixture">${esc(t.fixtureCode)} ${esc(t.fixtureName)}</div>
          <div class="tx-status">${fromStatus.label} → ${toStatus.label}</div>
          <div class="tx-operator">${esc(t.operator || '-')}</div>
          <div class="tx-party">${esc(t.counterparty || '-')}</div>
          <div class="tx-time">${fmtTime(t.time)}</div>
          <div class="tx-remark">${esc(t.remark || '-')}</div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  }

  /* ============================================================
   * 夹具选择（用于出库/回库前的选择）
   * ============================================================ */
  window.fixtureSelect = async function (id) {
    state.fixSelectedId = id;
    // 高亮选中
    $$('.fixture-card').forEach((c) => c.classList.toggle('selected', c.dataset.id == id));
  };

  /* ============================================================
   * 夹具出库
   * ============================================================ */
  window.fixtureOut = async function (id) {
    const fixture = state.fixtures.find((f) => f.id === id);
    if (!fixture) { toast('夹具不存在', 'err'); return; }
    if (fixture.status !== 'stocked' && fixture.status !== 'returned') {
      toast('夹具当前状态不允许出库', 'err');
      return;
    }

    // 打开出库表单
    const html = `
      <div class="form-group">
        <label>经办人</label>
        <input type="text" id="fix_out_op" placeholder="经办人（拼音联想）" autocomplete="off">
      </div>
      <div class="form-group">
        <label>领用人</label>
        <input type="text" id="fix_out_party" placeholder="领用人/使用部门">
      </div>
      <div class="form-group">
        <label>出库时间</label>
        <input type="datetime-local" id="fix_out_time" value="${nowInput()}">
      </div>
      <div class="form-group">
        <label>备注</label>
        <input type="text" id="fix_out_remark" placeholder="可选备注">
      </div>
      <div class="form-actions">
        <button class="btn" onclick="submitFixtureOut(${id})">确认出库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`出库 — ${fixture.code} ${fixture.name}`, html);

    // 绑定经办人联想
    const opEl = document.getElementById('fix_out_op');
    if (opEl) bindLiveFilter('fix_out_op', () => {});
  };

  window.submitFixtureOut = async function (id) {
    const fixture = state.fixtures.find((f) => f.id === id);
    if (!fixture) { toast('夹具不存在', 'err'); return; }

    const operator = $('#fix_out_op').value.trim();
    const counterparty = $('#fix_out_party').value.trim();
    const time = inputToMs($('#fix_out_time').value);
    const remark = $('#fix_out_remark').value.trim();

    if (!operator) { toast('请填写经办人', 'err'); return; }

    try {
      await DB.fixtureAddTransaction({
        fixtureId: id,
        type: 'out',
        operator,
        counterparty,
        time,
        remark
      });
      closeModal();
      await reloadFixtures();
      renderFixtures();
      toast('出库成功', 'ok');
    } catch (e) {
      toast('出库失败：' + e.message, 'err');
    }
  };

  /* ============================================================
   * 夹具回库
   * ============================================================ */
  window.fixtureReturn = async function (id) {
    const fixture = state.fixtures.find((f) => f.id === id);
    if (!fixture) { toast('夹具不存在', 'err'); return; }
    if (fixture.status !== 'checked_out') {
      toast('夹具未处于已出库状态', 'err');
      return;
    }

    const html = `
      <div class="form-group">
        <label>经办人</label>
        <input type="text" id="fix_ret_op" placeholder="经办人" value="">
      </div>
      <div class="form-group">
        <label>回库时间</label>
        <input type="datetime-local" id="fix_ret_time" value="${nowInput()}">
      </div>
      <div class="form-group">
        <label>备注</label>
        <input type="text" id="fix_ret_remark" placeholder="可选备注">
      </div>
      <div class="form-actions">
        <button class="btn" onclick="submitFixtureReturn(${id})">确认回库</button>
        <button class="btn ghost" onclick="closeModal()">取消</button>
      </div>
    `;
    openModal(`回库 — ${fixture.code} ${fixture.name}`, html);
  };

  window.submitFixtureReturn = async function (id) {
    const fixture = state.fixtures.find((f) => f.id === id);
    if (!fixture) { toast('夹具不存在', 'err'); return; }

    const operator = $('#fix_ret_op').value.trim();
    const time = inputToMs($('#fix_ret_time').value);
    const remark = $('#fix_ret_remark').value.trim();

    if (!operator) { toast('请填写经办人', 'err'); return; }

    try {
      await DB.fixtureAddTransaction({
        fixtureId: id,
        type: 'return',
        operator,
        counterparty: '',
        time,
        remark
      });
      closeModal();
      await reloadFixtures();
      renderFixtures();
      toast('回库成功', 'ok');
    } catch (e) {
      toast('回库失败：' + e.message, 'err');
    }
  };

  /* ============================================================
   * 夹具报废
   * ============================================================ */
  window.fixtureRetire = async function (id) {
    const fixture = state.fixtures.find((f) => f.id === id);
    if (!fixture) { toast('夹具不存在', 'err'); return; }

    if (!confirm(`确认报废夹具 ${fixture.code} ${fixture.name}？\n报废后不可恢复。`)) return;

    try {
      await DB.fixtureAddTransaction({
        fixtureId: id,
        type: 'retire',
        operator: '',
        counterparty: '',
        time: Date.now(),
        remark: '报废'
      });
      await reloadFixtures();
      renderFixtures();
      toast('夹具已报废', 'ok');
    } catch (e) {
      toast('报废失败：' + e.message, 'err');
    }
  };

  /* ============================================================
   * 渲染夹具管理页面
   * ============================================================ */
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
        <div class="search-bar">
          <input type="text" id="fix_search" placeholder="搜索编号/名称/规格..." oninput="fixtureSearch()">
        </div>
        <div id="fixture_list"></div>
      </div>
      <div class="panel">
        <div class="panel-title">流水记录</div>
        <div id="fix_tx_list"></div>
      </div>
    `;

    // 渲染列表和流水
    renderFixtureList($('#fixture_list'), state.fixtures, state.fixSelectedId || 0);
    renderFixTransactions($('#fix_tx_list'), state.fixTransactions);
  };

  /* ============================================================
   * 夹具搜索
   * ============================================================ */
  window.fixtureSearch = function () {
    const q = ($('#fix_search') || {}).value.trim().toLowerCase();
    if (!q) {
      renderFixtureList($('#fixture_list'), state.fixtures, state.fixSelectedId || 0);
      return;
    }
    const filtered = state.fixtures.filter((f) =>
      f.code.includes(q) ||
      (f.name || '').toLowerCase().includes(q) ||
      (f.spec || '').toLowerCase().includes(q)
    );
    renderFixtureList($('#fixture_list'), filtered, state.fixSelectedId || 0);
  };

  /* ============================================================
   * 新建夹具
   * ============================================================ */
  window.fixtureNew = function () {
    const html = `
      <div class="form-group">
        <label>编号</label>
        <input type="text" id="fix_new_code" placeholder="4位数字编号（如 2001）" maxlength="4">
      </div>
      <div class="form-group">
        <label>名称</label>
        <input type="text" id="fix_new_name" placeholder="夹具名称">
      </div>
      <div class="form-group">
        <label>规格型号</label>
        <input type="text" id="fix_new_spec" placeholder="规格型号">
      </div>
      <div class="form-group">
        <label>分类</label>
        <input type="text" id="fix_new_cat" placeholder="分类（如 冲压/焊接/装配）">
      </div>
      <div class="form-group">
        <label>库位</label>
        <input type="text" id="fix_new_loc" placeholder="存放位置（可选）">
      </div>
      <div class="form-group">
        <label>备注</label>
        <input type="text" id="fix_new_remark" placeholder="可选备注">
      </div>
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

    if (!code || !/^\d{4}$/.test(code)) {
      toast('编号为4位纯数字（如 2001）', 'err');
      return;
    }
    if (!name) {
      toast('请填写夹具名称', 'err');
      return;
    }

    try {
      await DB.fixtureAdd({
        code,
        name,
        spec,
        category,
        location,
        remark,
        status: 'stocked',
        totalOutCount: 0,
        totalReturnCount: 0,
        repairCount: 0
      });
      closeModal();
      await reloadFixtures();
      renderFixtures();
      toast('夹具建档成功', 'ok');
    } catch (e) {
      toast('建档失败：' + e.message, 'err');
    }
  };

  /* ============================================================
   * 导出夹具CSV
   * ============================================================ */
  window.fixtureExportCSV = function () {
    const headers = ['编号', '名称', '规格', '分类', '库位', '状态', '累计出库', '累计回库', '维修次数', '备注'];
    const rows = state.fixtures.map((f) => [
      f.code,
      f.name,
      f.spec || '',
      f.category || '',
      f.location || '',
      FIXTURE_STATUS[f.status]?.label || f.status,
      f.totalOutCount || 0,
      f.totalReturnCount || 0,
      f.repairCount || 0,
      f.remark || ''
    ]);
    const csv = toCSV(headers, rows);
    download('夹具清单_' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  };

  /* ============================================================
   * 数据加载
   * ============================================================ */
  async function reloadFixtures() {
    state.fixtures = await DB.fixtureGetAll();
    state.fixTransactions = await DB.fixtureGetTransactions();
  }

  /* ============================================================
   * 初始化夹具模块
   * ============================================================ */
  async function initFixtures() {
    await reloadFixtures();
    // 注册到视图系统
    VIEW_TITLES.fixtures = '夹具管理';
    RENDERERS.fixtures = renderFixtures;
  }

  // 暴露给全局
  window.initFixtures = initFixtures;
  window.reloadFixtures = reloadFixtures;
  window.fixtureStatusIcon = fixtureStatusIcon;
  window.fixtureStatusBadge = fixtureStatusBadge;

})();
