'use strict';
/* ============================================================
 * mobile-server.js — PDA 移动端局域网服务
 *
 * 定位：让安卓 PDA 浏览器直接扫码办理出入库，无需安装 App。
 * 运行在 Electron 主进程内，直接调用 store.js —— 与桌面窗口共用
 * 同一进程、同一份 spms-data.json，因此不存在数据同步问题。
 *
 * 接口（全部 JSON，除静态页）：
 *   GET  /                 移动端页面
 *   GET  /api/ping         服务与版本信息（无需令牌）
 *   POST /api/login        { pin } → { token }
 *   GET  /api/part?code=   按编号精确匹配（忽略 SPMS1| 前缀与分隔符）
 *   GET  /api/search?kw=   关键字模糊检索（编号/名称/规格/库位）
 *   GET  /api/operators    历史经办人名单
 *   GET  /api/staffs       员工档案（工号 ↔ 姓名）
 *   GET  /api/recent?limit=最近流水
 *   POST /api/tx           提交出入库 { type, code, quantity, operator, counterparty, remark, time }
 *                          operator 可传工号，服务端解析为「姓名 + 工号」入库
 *
 * 安全：仅局域网可达 + 4 位 PIN 换取的临时令牌（12 小时有效）。
 * 写操作全部是主进程同步调用，不存在并发写坏 JSON 的窗口。
 *
 * v3.0.5 新增：电脑网页版（desktop.html）—— 浏览器加载整套桌面前端，
 *   /api/invoke 把桌面的 db-* channel 分发到同一份 store.js，显示/数据与 exe 一致；
 *   PDA 与电脑网页版 PIN 拆分（meta.mobilePin / meta.desktopPin），令牌带 scope 隔离，
 *   PDA 令牌只能出入库、desktop 令牌才有完整数据管理网关。电脑 PIN 未设置时
 *   回退到 PDA PIN（升级平滑）。PDA 端路由（/、/api/part 等）完全不变。
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const ScanCore = require('./js/scan-core');
const StaffCore = require('./js/staff-core');

const PIN_META_KEY = 'mobilePin';            // PDA 端 PIN（历史键，保持不变）
const DESKTOP_PIN_META_KEY = 'desktopPin';   // 电脑网页版 PIN（v3.0.5 拆分）
const DEFAULT_PIN = '1234';
const TOKEN_TTL = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

/* 令牌权限范围（v3.0.5）：pda 只能出入库，desktop 才有完整数据管理网关 */
const SCOPE_PDA = 'pda';
const SCOPE_DESKTOP = 'desktop';
/* 接口按 scope 隔离：pda 令牌碰不到管理网关，desktop 令牌不能冒用 PDA 出入库 */
const DESKTOP_ONLY_APIS = new Set([
  '/api/invoke', '/api/read-spreadsheet', '/api/data-revision',
  '/api/desktop-status', '/api/sys-info', '/api/mobile-set-pin', '/api/mobile-restart'
]);
const PDA_ONLY_APIS = new Set([
  '/api/part', '/api/search', '/api/operators', '/api/staffs', '/api/recent', '/api/tx'
]);

const STATIC_FILES = {
  /* PDA 端（保持原样） */
  '/': { file: 'mobile.html', type: 'text/html; charset=utf-8' },
  '/mobile.html': { file: 'mobile.html', type: 'text/html; charset=utf-8' },
  '/css/mobile.css': { file: 'css/mobile.css', type: 'text/css; charset=utf-8' },
  '/js/scan-core.js': { file: 'js/scan-core.js', type: 'application/javascript; charset=utf-8' },
  '/js/mobile.js': { file: 'js/mobile.js', type: 'application/javascript; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json; charset=utf-8' },
  '/icons/icon.svg': { file: 'icons/icon.svg', type: 'image/svg+xml; charset=utf-8' },
  /* 电脑网页版（v3.0.5）—— 与 exe 共用整套前端资源 */
  '/desktop.html': { file: 'desktop.html', type: 'text/html; charset=utf-8' },
  '/pc': { file: 'desktop.html', type: 'text/html; charset=utf-8' },
  '/css/style.css': { file: 'css/style.css', type: 'text/css; charset=utf-8' },
  '/js/desktop-api.js': { file: 'js/desktop-api.js', type: 'application/javascript; charset=utf-8' },
  '/js/app.js': { file: 'js/app.js', type: 'application/javascript; charset=utf-8' },
  '/js/db.js': { file: 'js/db.js', type: 'application/javascript; charset=utf-8' },
  '/js/pinyin-match.js': { file: 'js/pinyin-match.js', type: 'application/javascript; charset=utf-8' },
  '/js/staff-core.js': { file: 'js/staff-core.js', type: 'application/javascript; charset=utf-8' },
  '/js/vendor/qrcode-generator.js': { file: 'js/vendor/qrcode-generator.js', type: 'application/javascript; charset=utf-8' },
  '/js/vendor/jsQR.js': { file: 'js/vendor/jsQR.js', type: 'application/javascript; charset=utf-8' }
};

let server = null;
let cfg = { port: 8765, onChange: null, version: '', dataDir: '' };
let lastError = '';
let dataRevision = 0; // 数据版本号：任何写操作后 +1，网页版轮询此值触发刷新
const tokens = new Map(); // token → { exp: 过期时间戳, scope: 'pda' | 'desktop' }

/* ---------------- PIN / 令牌 ---------------- */
/* scope 省略时默认 pda，兼容旧调用（PDA 端 / 历史 API） */
function pinMetaKey(scope) {
  return scope === SCOPE_DESKTOP ? DESKTOP_PIN_META_KEY : PIN_META_KEY;
}
function getPin(scope) {
  const p = store.getMeta(pinMetaKey(scope));
  /* 电脑 PIN 未单独设置过时，回退到 PDA PIN（升级平滑：老用户升级后两端 PIN 一致） */
  if (scope === SCOPE_DESKTOP && !p) {
    const legacy = store.getMeta(PIN_META_KEY);
    return legacy ? String(legacy) : DEFAULT_PIN;
  }
  return p ? String(p) : DEFAULT_PIN;
}
function setPin(pin, scope) {
  const v = String(pin == null ? '' : pin).trim();
  if (!/^\d{4}$/.test(v)) throw new Error('PIN 必须是 4 位数字');
  store.setMeta(pinMetaKey(scope), v);
  return v;
}
function issueToken(scope) {
  const now = Date.now();
  tokens.forEach((rec, tk) => { if (rec.exp <= now) tokens.delete(tk); });
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { exp: now + TOKEN_TTL, scope: scope === SCOPE_DESKTOP ? SCOPE_DESKTOP : SCOPE_PDA });
  return token;
}
function tokenValid(token) {
  if (!token) return false;
  const rec = tokens.get(token);
  if (!rec) return false;
  if (rec.exp <= Date.now()) { tokens.delete(token); return false; }
  return true;
}
function tokenScope(token) {
  const rec = tokens.get(token);
  return rec ? rec.scope : null;
}
function requireScope(res, token, scope) {
  if (tokenScope(token) !== scope) {
    json(res, 403, { ok: false, error: scope === SCOPE_DESKTOP ? '此操作仅限电脑网页版' : '此操作仅限 PDA 端' });
    return false;
  }
  return true;
}

/* ---------------- 本机地址 ---------------- */
function localIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((it) => {
      if (!it || it.family !== 'IPv4' || it.internal) return;
      out.push({ address: it.address, name: name });
    });
  });
  // 常见内网段优先（192.168.x → 10.x → 172.16-31.x），虚拟网卡置后
  const score = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

/* ---------------- 响应工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}
function sendFile(res, relFile, type) {
  const full = path.join(__dirname, relFile);
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('未找到 ' + relFile);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* ---------------- 业务 ---------------- */
function publicPart(p) {
  return {
    id: p.id, code: p.code, name: p.name, spec: p.spec || '',
    location: p.location || '', category: p.category || '', unit: p.unit || '',
    stock: Number(p.stock) || 0, safeStock: Number(p.safeStock) || 0
  };
}
function rememberOperator(name) {
  try {
    const list = store.getMeta('operators');
    const arr = Array.isArray(list) ? list.slice() : [];
    if (arr.indexOf(name) < 0) {
      arr.push(name);
      store.setMeta('operators', arr);
    }
  } catch (e) { /* 名单缓存失败不影响主流程 */ }
}
function handleTx(body) {
  const type = String(body.type || '');
  if (type !== 'in' && type !== 'out') throw Object.assign(new Error('type 必须是 in 或 out'), { status: 400 });

  const rawCode = String(body.code || '').trim();
  if (!rawCode) throw Object.assign(new Error('请提供备品编号'), { status: 400 });
  const parts = store.getAll('parts');
  const part = ScanCore.findPart(parts, rawCode);
  if (!part) throw Object.assign(new Error('未找到编号为 ' + rawCode + ' 的备品'), { status: 404 });

  const qty = Number(body.quantity);
  if (!isFinite(qty) || qty <= 0) throw Object.assign(new Error('数量必须大于 0'), { status: 400 });

  const rawOp = String(body.operator || '').trim();
  if (!rawOp) throw Object.assign(new Error(type === 'out' ? '请填写领用人' : '请填写经办人'), { status: 400 });
  /* 允许直接传工号：解析成「姓名 + 工号」，姓名仍写 operator 保持报表兼容 */
  let staffs = [];
  try { staffs = store.getMeta('staffs'); } catch (e) { staffs = []; }
  const who = StaffCore.resolveOperator(Array.isArray(staffs) ? staffs : [], rawOp);
  const operator = who.name || rawOp;

  if (type === 'out' && Number(part.stock) < qty) {
    throw Object.assign(new Error('库存不足：当前库存 ' + part.stock + '，需 ' + qty), { status: 409 });
  }

  const txId = store.addTransaction({
    type: type,
    partId: part.id,
    quantity: qty,
    operator: operator,
    operatorNo: who.no || '',
    counterparty: String(body.counterparty || '').trim(),
    time: Number(body.time) > 0 ? Number(body.time) : Date.now(),
    remark: String(body.remark || '').trim()
  });
  rememberOperator(operator);
  const fresh = store.get('parts', part.id) || part;
  return { txId: txId, operator: operator, operatorNo: who.no || '', part: publicPart(fresh) };
}

/* ============================================================
 * 电脑网页版：IPC channel → store.js 分发器（v3.0.5）
 * 与 main.js 的 handlers 一一对应，保证浏览器端与 exe 口径完全一致。
 * Electron 专属能力返回 __unsupported，由 desktop-api.js 的降级处理。
 * ============================================================ */
const WRITE_CHANNELS = new Set([
  'db-add', 'db-put', 'db-del', 'db-clear', 'db-setMeta',
  'db-addTransaction', 'db-addPart', 'db-updatePart', 'db-saveLocationAudit'
]);
function unsupported(what) { return { __unsupported: true, error: '网页版不支持' + what + '，请在客户端使用' }; }
function invokeStore(channel, p) {
  /* payload 原样透传：db-getAll/db-count/db-getMeta/db-clear/db-open 的 payload 是标量，
   * 其余 channel 的 payload 是对象。不能统一转 {}，否则标量参数全丢（曾致测试失败）。 */
  if (p == null) p = {};
  switch (channel) {
    /* 通用数据层（与 main.js handlers 逐条对应） */
    case 'db-open': return store.open();
    case 'db-getAll': return store.getAll(p);
    case 'db-get': return store.get(p.name, p.id);
    case 'db-add': return store.add(p.name, p.item);
    case 'db-put': return store.put(p.name, p.item);
    case 'db-del': return store.del(p.name, p.id);
    case 'db-clear': return store.clear(p);
    case 'db-count': return store.count(p);
    case 'db-getByIndex': return store.getByIndex(p.name, p.index, p.value);
    case 'db-getByRange': return store.getByRange(p.name, p.index, p.range);
    case 'db-addTransaction': return store.addTransaction(p);
    case 'db-addPart': return store.addPart(p);
    case 'db-updatePart': return store.updatePart(p);
    case 'db-getMeta': return store.getMeta(p);
    case 'db-setMeta': return store.setMeta(p.key, p.value);
    case 'db-getLocationAudits': return store.getLocationAudits();
    case 'db-saveLocationAudit': return store.saveLocationAudit(p);
    /* Electron 专属：浏览器已有降级 */
    case 'pick-spreadsheet': return unsupported('系统文件选择框');
    case 'print-labels': return unsupported('系统打印（请用浏览器打印）');
    case 'sys-open-data-dir': return unsupported('打开本地目录');
    case 'sys-port-check': case 'sys-open-port': return unsupported('端口防火墙设置（请在客户端操作）');
    default: throw new Error('未知的数据通道：' + channel);
  }
}

/* ---------------- 路由 ---------------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  if (req.method === 'GET' && STATIC_FILES[pathname]) {
    const s = STATIC_FILES[pathname];
    sendFile(res, s.file, s.type);
    return;
  }

  if (!pathname.startsWith('/api/')) { json(res, 404, { ok: false, error: '未知路径' }); return; }

  /* 无需令牌的接口 */
  if (pathname === '/api/ping') {
    json(res, 200, { ok: true, app: 'SPMS Mobile', version: cfg.version, requiresPin: true });
    return;
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
    const scope = body.scope === SCOPE_DESKTOP ? SCOPE_DESKTOP : SCOPE_PDA;
    const pin = String(body.pin || '').trim();
    if (pin !== getPin(scope)) { json(res, 401, { ok: false, error: 'PIN 不正确' }); return; }
    json(res, 200, { ok: true, token: issueToken(scope), scope: scope, version: cfg.version });
    return;
  }

  /* 其余接口校验令牌 */
  const token = req.headers['x-spms-token'] || u.searchParams.get('token') || '';
  if (!tokenValid(token)) { json(res, 401, { ok: false, error: '登录已失效，请重新输入 PIN' }); return; }
  /* v3.0.5 scope 隔离：按令牌来源限制可用接口，PDA PIN 泄露也碰不到数据管理 */
  if (DESKTOP_ONLY_APIS.has(pathname) && !requireScope(res, token, SCOPE_DESKTOP)) return;
  if (PDA_ONLY_APIS.has(pathname) && !requireScope(res, token, SCOPE_PDA)) return;

  try {
    /* ============================================================
     * 电脑网页版通用数据网关（v3.0.5）
     * 浏览器 desktop-api.js 的 invoke(channel,payload) → 这里 → 同一份 store.js。
     * channel 与 main.js 的 handlers 一一对应；Electron 专属能力由浏览器端降级。
     * ============================================================ */
    if (pathname === '/api/invoke' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      const channel = String(body.channel || '');
      const p = body.payload;
      let result;
      try {
        result = invokeStore(channel, p);
      } catch (e) {
        json(res, 400, { ok: false, error: (e && e.message) || String(e) }); return;
      }
      if (result && result.__unsupported) {
        json(res, 501, { ok: false, error: result.error }); return;
      }
      /* 写操作后广播数据版本变更（供网页版轮询刷新 + 桌面窗口 data-changed） */
      if (WRITE_CHANNELS.has(channel)) {
        dataRevision++;
        if (typeof cfg.onChange === 'function') {
          try { cfg.onChange({ source: 'desktop', channel: channel }); } catch (e) { /* 不影响结果 */ }
        }
      }
      json(res, 200, { ok: true, result: result === undefined ? null : result });
      return;
    }

    /* 数据版本号（网页版轮询判断是否有别端写入，触发自动刷新） */
    if (pathname === '/api/data-revision' && req.method === 'GET') {
      json(res, 200, { ok: true, revision: dataRevision });
      return;
    }

    /* 网页版系统设置：服务状态 / 本机信息 / 改 PIN / 重启服务 */
    if (pathname === '/api/desktop-status' && req.method === 'GET') {
      const st = status();
      json(res, 200, {
        ok: true, running: st.running, port: st.port, ip: st.ip, lan: st.lan, url: st.url,
        pin: st.pin,            // PDA PIN（兼容旧字段）
        pdaPin: st.pdaPin,      // PDA PIN（v3.0.5 明确命名）
        desktopPin: st.desktopPin, // 电脑网页版 PIN
        version: st.version
      });
      return;
    }
    if (pathname === '/api/sys-info' && req.method === 'GET') {
      const dir = cfg.dataDir || __dirname;
      const dataFile = path.join(dir, 'spms-data.json');
      let size = 0; try { size = fs.statSync(dataFile).size; } catch (e) {}
      json(res, 200, { ok: true, version: cfg.version, dataDir: dir, dataFile: dataFile, exists: !!size, size: size, web: true });
      return;
    }
    if (pathname === '/api/mobile-set-pin' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      /* scope 省略时默认 pda（兼容旧调用）；系统设置页改电脑 PIN 时显式传 desktop */
      const scope = body.scope === SCOPE_DESKTOP ? SCOPE_DESKTOP : SCOPE_PDA;
      try { setPin(body.pin, scope); json(res, 200, { ok: true, scope: scope, status: status() }); }
      catch (err) { json(res, 400, { ok: false, error: err.message, status: status() }); }
      return;
    }
    if (pathname === '/api/mobile-restart' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      json(res, 200, { ok: true, status: restart(body.port) });
      return;
    }
    if (pathname === '/api/part' && req.method === 'GET') {
      const code = u.searchParams.get('code') || '';
      const part = ScanCore.findPart(store.getAll('parts'), code);
      if (!part) { json(res, 404, { ok: false, error: '未找到该编号的备品' }); return; }
      json(res, 200, { ok: true, part: publicPart(part) });
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const kw = (u.searchParams.get('kw') || '').trim();
      if (!kw) { json(res, 400, { ok: false, error: '请输入关键字' }); return; }
      const all = store.getAll('parts');
      const low = kw.toLowerCase();
      const hit = ScanCore.findPart(all, kw);
      const list = hit ? [hit] : all.filter((p) => {
        return String(p.code || '').toLowerCase().indexOf(low) >= 0
          || String(p.name || '').toLowerCase().indexOf(low) >= 0
          || String(p.spec || '').toLowerCase().indexOf(low) >= 0
          || String(p.location || '').toLowerCase().indexOf(low) >= 0;
      });
      json(res, 200, { ok: true, list: list.slice(0, 20).map(publicPart) });
      return;
    }

    if (pathname === '/api/operators' && req.method === 'GET') {
      const list = store.getMeta('operators');
      json(res, 200, { ok: true, list: Array.isArray(list) ? list : [] });
      return;
    }

    /* 员工档案（工号 ↔ 姓名）：移动端据此把工号解析成姓名 */
    if (pathname === '/api/staffs' && req.method === 'GET') {
      let sf = [];
      try { sf = store.getMeta('staffs'); } catch (e) { sf = []; }
      json(res, 200, { ok: true, list: StaffCore.sanitize(Array.isArray(sf) ? sf : []) });
      return;
    }

    if (pathname === '/api/recent' && req.method === 'GET') {
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit')) || 10));
      const all = store.getAll('transactions').slice();
      all.sort((a, b) => (b.time || 0) - (a.time || 0));
      json(res, 200, {
        ok: true,
        list: all.slice(0, limit).map((t) => ({
          id: t.id, type: t.type, partCode: t.partCode, partName: t.partName,
          quantity: t.quantity, operator: t.operator || '', operatorNo: t.operatorNo || '',
          operatorLabel: StaffCore.opLabel(t), counterparty: t.counterparty || '',
          time: t.time, remark: t.remark || ''
        }))
      });
      return;
    }

    if (pathname === '/api/tx' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
      let result;
      try {
        result = handleTx(body);
      } catch (e) {
        json(res, e.status || 500, { ok: false, error: e.message });
        return;
      }
      if (typeof cfg.onChange === 'function') {
        try { cfg.onChange({ source: 'mobile', type: body.type }); } catch (e) { /* 通知失败不影响结果 */ }
      }
      json(res, 200, { ok: true, txId: result.txId, operator: result.operator, operatorNo: result.operatorNo, part: result.part });
      return;
    }

    json(res, 404, { ok: false, error: '未知接口' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message || '服务内部错误' });
  }
}

/* ---------------- 生命周期 ---------------- */
function start(opts) {
  opts = opts || {};
  if (server) return status();
  if (opts.port != null) {
    const p = Number(opts.port);
    if (isFinite(p) && p >= 0 && p <= 65535) cfg.port = p;
  }
  if (opts.version) cfg.version = opts.version;
  if (opts.dataDir) cfg.dataDir = opts.dataDir;
  if (typeof opts.onChange === 'function') cfg.onChange = opts.onChange;
  if (typeof opts.onListening === 'function') cfg.onListening = opts.onListening;

  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { json(res, 500, { ok: false, error: e.message || String(e) }); } catch (e2) { /* ignore */ }
    });
  });
  server.on('error', (e) => {
    lastError = e.code === 'EADDRINUSE'
      ? ('端口 ' + cfg.port + ' 已被占用，请在「关于」面板更换端口')
      : (e.message || String(e));
    server = null;
  });
  server.listen(cfg.port, () => {
    lastError = '';
    if (typeof cfg.onListening === 'function') {
      try { cfg.onListening(status()); } catch (e) { /* ignore */ }
    }
  });
  return status();
}

function stop() {
  if (!server) return status();
  try { server.close(); } catch (e) { /* ignore */ }
  server = null;
  return status();
}

function restart(port) {
  stop();
  tokens.clear();
  return start({ port: port });
}

function status() {
  const ips = localIPs();
  const ip = ips.length ? ips[0].address : '127.0.0.1';
  let actualPort = cfg.port;
  try { if (server && server.address()) actualPort = server.address().port; } catch (e) { /* ignore */ }
  return {
    running: !!(server && server.listening),
    port: actualPort,
    ip: ip,
    ips: ips.map((x) => x.address),
    /* 系统设置页用：带网卡名的地址清单，装 PDA 时逐台粘贴，避免填成 127.0.0.1 或虚拟网卡 */
    lan: ips.map((x) => ({ address: x.address, name: x.name, url: 'http://' + x.address + ':' + actualPort })),
    url: 'http://' + ip + ':' + actualPort,
    pin: getPin(SCOPE_PDA),        // PDA PIN（兼容旧字段）
    pdaPin: getPin(SCOPE_PDA),     // PDA PIN（v3.0.5 明确命名）
    desktopPin: getPin(SCOPE_DESKTOP), // 电脑网页版 PIN（未设置时回退 PDA PIN）
    error: lastError,
    version: cfg.version
  };
}

/* 对外 getPin/setPin 保持旧签名（默认 pda），新增 scope 参数供系统设置页改电脑 PIN */
module.exports = { start, stop, restart, status, getPin, setPin, localIPs, DEFAULT_PIN };
