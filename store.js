'use strict';
/* ============================================================
 * store.js — 主进程数据层（Node fs，本地 JSON 文件）
 * 由 main.js 在启动时调用 setDataDir(userData/spms) 指定目录。
 * 所有读写落在 spms-data.json；可被 Node 直接单元测试（无需 Electron）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let DATA_DIR = null;
let data = { parts: [], transactions: [], meta: {} };
let loaded = false;
let seq = 1;

function setDataDir(dir) {
  DATA_DIR = dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function file() { return path.join(DATA_DIR, 'spms-data.json'); }

function load() {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const j = JSON.parse(raw);
    data = { parts: j.parts || [], transactions: j.transactions || [], meta: j.meta || {}, locationAudits: j.locationAudits || [], fixtures: j.fixtures || [], fixTransactions: j.fixTransactions || [] };
    let maxId = 0;
    data.parts.concat(data.transactions).forEach((x) => { if (x && x.id > maxId) maxId = x.id; });
    if (j.locationAudits && j.locationAudits.length) {
      j.locationAudits.forEach((a) => { if (a && a.id > maxId) maxId = a.id; });
    }
    if (j.fixtures && j.fixtures.length) {
      j.fixtures.forEach((f) => { if (f && f.id > maxId) maxId = f.id; });
    }
    if (j.fixTransactions && j.fixTransactions.length) {
      j.fixTransactions.forEach((t) => { if (t && t.id > maxId) maxId = t.id; });
    }
    seq = maxId + 1;
    if (migrateCodes()) save(); // 一次性迁移旧编号 → 4 位纯数字并落盘
    if (migrateLocations()) save(); // 一次性迁移库位 → 连续编号（v2.28）
  } catch (e) {
    data = { parts: [], transactions: [], meta: {}, locationAudits: [], fixtures: [], fixTransactions: [] };
  }
  loaded = true;
}

function save() {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2), 'utf8');
}

function nextId() { return seq++; }

/* 合法备品编号：4 位纯数字（如 1001） */
function isValidCode(c) { return typeof c === 'string' && /^\d{4}$/.test(c); }

/* ============================================================
 * 一次性编号迁移（v2.14→v2.15 调整）：将历史非 4 位纯数字编号统一重排为
 * 1001 起递增的 4 位数字编号。规则：
 *  - 已合法的 4 位数字编号保留不动；
 *  - 其余按「备品 id（建档顺序）」稳定排序后顺序分配 1001, 1002 …
 *    跳过已被占用的 4 位数字，保证唯一、无重复、无随机跳号；
 *  - 同步更新 transactions.partCode 显示字段（partId 关联不变，流水不丢）；
 *  - 幂等：全部已是 4 位时直接返回 false，不写盘。
 * ============================================================ */
function migrateCodes() {
  if (!data.parts || !data.parts.length) return false;
  if (!data.parts.some((p) => !isValidCode(p.code))) return false;
  const used = new Set();
  data.parts.forEach((p) => { if (isValidCode(p.code)) used.add(p.code); });
  let next = 1001;
  const ordered = data.parts.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  ordered.forEach((p) => {
    if (isValidCode(p.code)) return;
    while (used.has(String(next))) next++;
    const nw = String(next);
    used.add(nw);
    p.code = nw;
    next++;
  });
  if (data.transactions && data.transactions.length) {
    /* 以 partId 关联为准，将流水显示编号同步为对应备品的新 6 位号
     * （比「按旧 partCode 字符串映射」更健壮：可纠正历史 partCode 与备品表不一致的脏数据） */
    const idToCode = {};
    data.parts.forEach((p) => { idToCode[p.id] = p.code; });
    data.transactions.forEach((t) => {
      if (t.partId != null && idToCode[t.partId] != null) t.partCode = idToCode[t.partId];
    });
  }
  return true;
}

/* ============================================================
 * 一次性库位重编号迁移（v2.28）：将历史混杂的库位编码
 * （如 1-1-1 / 1-2-1上 / A1-02-03 等）统一重排为「连续编号」方案：
 *  - 取所有非空库位去重，按自然序（数字按数值、区分大小写无关）排序；
 *  - 依次分配 001, 002, 003 … 零填充连续编号，宽度 = max(3, 位数(库位数))；
 *  - 更新每个备品的 location 字段为新编号；空白 location 视为「（未分配）」桶，不参与编号、置于末尾；
 *  - 以 meta.locRenumberV1 标记实现幂等：已迁移则跳过，避免每次启动重排；
 *  - 数据落盘前先由调用方 save()，迁移成功后返回 true。
 * 说明：编号顺序由原编码的自然序决定，重编号后所有库位即按 001→NNN 连续排列。
 * ============================================================ */
function migrateLocations() {
  if (!data.parts || !data.parts.length) { if (data.meta) data.meta.locRenumberV1 = true; return true; }
  if (data.meta && data.meta.locRenumberV1) return false; // 已迁移，跳过
  const set = new Set();
  const locs = [];
  data.parts.forEach((p) => {
    const k = (p.location || '').trim();
    if (k && !set.has(k)) { set.add(k); locs.push(k); }
  });
  if (!locs.length) { if (data.meta) data.meta.locRenumberV1 = true; return true; }
  locs.sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  const width = Math.max(3, String(locs.length).length);
  const map = {};
  locs.forEach((old, i) => { map[old] = String(i + 1).padStart(width, '0'); });
  data.parts.forEach((p) => {
    const k = (p.location || '').trim();
    if (k && map[k]) p.location = map[k];
  });
  if (data.meta) data.meta.locRenumberV1 = true;
  return true;
}

function open() { load(); return { ok: true }; }
function getAll(name) { load(); return name === 'meta' ? data.meta : (data[name] || []); }
function get(name, id) {
  load();
  if (name === 'meta') return data.meta[id] != null ? data.meta[id] : null;
  return (data[name] || []).find((x) => x.id === id) || null;
}
function add(name, item) {
  load();
  if (name === 'meta') { data.meta[item.key] = item.value; save(); return item.key; }
  if (name === 'parts' && item.code != null && data.parts.some((p) => p.code === item.code)) {
    const e = new Error('编号已存在'); e.name = 'ConstraintError'; throw e;
  }
  item.id = nextId();
  data[name].push(item);
  save();
  return item.id;
}
function put(name, item) {
  load();
  if (name === 'meta') { data.meta[item.key] = item.value; save(); return item.key; }
  const arr = data[name];
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  save();
  return item.id;
}
function del(name, id) {
  load();
  if (name === 'meta') { delete data.meta[id]; save(); return; }
  data[name] = data[name].filter((x) => x.id !== id);
  save();
}
function clear(name) { load(); if (name === 'meta') data.meta = {}; else if (name === 'locationAudits') data.locationAudits = []; else if (name === 'fixtures') data.fixtures = []; else if (name === 'fixTransactions') data.fixTransactions = []; else data[name] = []; save(); }
function count(name) { load(); if (name === 'meta') return Object.keys(data.meta).length; return (data[name] || []).length; }
function getByIndex(name, index, value) { load(); if (name === 'meta') return []; return (data[name] || []).filter((x) => x[index] === value); }
function getByRange(name, index, range) {
  load();
  const lo = range && range.lower != null ? range.lower : -Infinity;
  const hi = range && range.upper != null ? range.upper : Infinity;
  return (data[name] || []).filter((x) => x[index] >= lo && x[index] <= hi);
}
function addTransaction(tx) {
  load();
  const i = data.parts.findIndex((p) => p.id === tx.partId);
  if (i < 0) throw new Error('备品不存在');
  const part = data.parts[i];
  if (tx.type === 'out' && part.stock < tx.quantity) throw new Error('库存不足');
  part.stock = tx.type === 'in' ? part.stock + tx.quantity : part.stock - tx.quantity;
  part.updatedAt = Date.now();
  const record = {
    id: nextId(), type: tx.type, partId: part.id, partCode: part.code, partName: part.name,
    quantity: tx.quantity, operator: tx.operator || '', counterparty: tx.counterparty || '',
    time: tx.time, remark: tx.remark || '', createdAt: Date.now()
  };
  data.transactions.push(record);
  save();
  return record.id;
}
function addPart(part) {
  load();
  if (part.code != null && data.parts.some((p) => p.code === part.code)) {
    const e = new Error('编号已存在'); e.name = 'ConstraintError'; throw e;
  }
  part.createdAt = Date.now();
  part.updatedAt = Date.now();
  if (part.stock == null) part.stock = 0;
  if (part.safeStock == null) part.safeStock = 0;
  part.id = nextId();
  data.parts.push(part);
  save();
  return part.id;
}
function updatePart(part) {
  load();
  const i = data.parts.findIndex((p) => p.id === part.id);
  if (i < 0) throw new Error('备品不存在');
  part.updatedAt = Date.now();
  data.parts[i] = part;
  save();
  return part.id;
}
function getMeta(key) { load(); return data.meta[key] != null ? data.meta[key] : null; }
function setMeta(key, value) { load(); data.meta[key] = value; save(); }

/* 库位盘点记录 */
function getLocationAudits() { load(); return data.locationAudits || []; }
function saveLocationAudit(audit) {
  load();
  if (!data.locationAudits) data.locationAudits = [];
  audit.id = nextId();
  audit.createdAt = Date.now();
  data.locationAudits.push(audit);
  save();
  return audit.id;
}

module.exports = {
  setDataDir, open, getAll, get, add, put, del, clear, count,
  getByIndex, getByRange, addTransaction, addPart, updatePart, getMeta, setMeta,
  getLocationAudits, saveLocationAudit, migrateLocations,
  // 夹具管理
  addFixture: addFixture,
  updateFixture: updateFixture,
  delFixture: delFixture,
  getFixtures: () => getAll('fixtures'),
  getFixTransactions: () => getAll('fixTransactions'),
  addFixTransaction: addFixTransaction
};

/* ============================================================
 * 夹具管理数据操作
 * ============================================================ */
function addFixture(fixture) {
  load();
  if (fixture.code && data.fixtures.some((f) => f.code === fixture.code)) {
    const e = new Error('编号已存在'); e.name = 'ConstraintError'; throw e;
  }
  fixture.id = nextId();
  fixture.qrToken = 'SPMS1|' + fixture.code;
  fixture.status = 'stocked';
  fixture.totalOutCount = 0;
  fixture.totalReturnCount = 0;
  fixture.repairCount = 0;
  fixture.createdAt = Date.now();
  fixture.updatedAt = Date.now();
  data.fixtures.push(fixture);
  save();
  return fixture.id;
}

function updateFixture(fixture) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === fixture.id);
  if (i < 0) throw new Error('夹具不存在');
  fixture.updatedAt = Date.now();
  data.fixtures[i] = fixture;
  save();
  return fixture.id;
}

function delFixture(id) {
  load();
  data.fixtures = data.fixtures.filter((f) => f.id !== id);
  save();
}

function addFixTransaction(tx) {
  load();
  const i = data.fixtures.findIndex((f) => f.id === tx.fixtureId);
  if (i < 0) throw new Error('夹具不存在');
  const fixture = data.fixtures[i];
  
  // 状态校验
  if (tx.type === 'out' && fixture.status !== 'stocked' && fixture.status !== 'returned') {
    throw new Error('夹具当前状态不允许出库');
  }
  if (tx.type === 'return' && fixture.status !== 'checked_out') {
    throw new Error('夹具未处于已出库状态');
  }
  
  const fromStatus = fixture.status;
  let toStatus = fixture.status;
  
  // 更新状态
  if (tx.type === 'out') {
    toStatus = 'checked_out';
    fixture.totalOutCount = (fixture.totalOutCount || 0) + 1;
  } else if (tx.type === 'return') {
    toStatus = 'stocked';
    fixture.totalReturnCount = (fixture.totalReturnCount || 0) + 1;
  } else if (tx.type === 'repair') {
    toStatus = 'repair';
    fixture.repairCount = (fixture.repairCount || 0) + 1;
  } else if (tx.type === 'retire') {
    toStatus = 'retired';
  }
  
  fixture.status = toStatus;
  fixture.updatedAt = Date.now();
  
  // 创建流水记录
  const record = {
    id: nextId(),
    fixtureId: fixture.id,
    fixtureCode: fixture.code,
    fixtureName: fixture.name,
    type: tx.type,
    operator: tx.operator || '',
    counterparty: tx.counterparty || '',
    time: tx.time,
    remark: tx.remark || '',
    fromStatus: fromStatus,
    toStatus: toStatus,
    createdAt: Date.now()
  };
  
  data.fixTransactions.push(record);
  save();
  return record.id;
}
