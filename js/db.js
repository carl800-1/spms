/* ============================================================
 * db.js v2.0 — 双模式数据层
 *  - Electron 模式：经 preload 注入的 window.api 调用主进程 fs
 *    （本地 JSON 文件存储，数据持久可靠，与浏览器无关）
 *  - 浏览器模式：直接以浏览器打开 2.0/index.html 时，回退 1.0 的
 *    IndexedDB / localStorage 逻辑（便于在没有 Electron 时也调试）
 * 对外接口（DB.open / getAll / get / add / put / del / clear / count /
 *  getByIndex / getByRange / addTransaction / addPart / updatePart /
 *  getMeta / setMeta / currentBackend / APP_VERSION）保持不变，
 * 新增夹具管理接口（fixtureAdd / fixtureUpdate / fixtureDel /
 * fixtureGetAll / fixtureAddTransaction / fixtureGetTransactions），
 * app.js 无需修改。
 * ============================================================ */
const DB = (function () {
  const APP_VERSION = '2.33';
  // Electron 运行时，preload.js 会通过 contextBridge 注入 window.api
  const electronApi = (typeof window !== 'undefined' && window.api) ? window.api : null;

  /* ============================================================
   * Electron 模式：所有读写经 IPC 落到主进程的本地 JSON 文件
   * ============================================================ */
  if (electronApi) {
    const invoke = (channel, payload) => electronApi.invoke(channel, payload);
    return {
      APP_VERSION,
      open: () => invoke('db-open'),
      getAll: (name) => invoke('db-getAll', name),
      get: (name, id) => invoke('db-get', { name, id }),
      add: (name, item) => invoke('db-add', { name, item }),
      put: (name, item) => invoke('db-put', { name, item }),
      del: (name, id) => invoke('db-del', { name, id }),
      clear: (name) => invoke('db-clear', name),
      count: (name) => invoke('db-count', name),
      getByIndex: (name, index, value) => invoke('db-getByIndex', { name, index, value }),
      getByRange: (name, index, range) => invoke('db-getByRange', { name, index, range }),
      addTransaction: (data) => invoke('db-addTransaction', data),
      addPart: (part) => invoke('db-addPart', part),
      updatePart: (part) => invoke('db-updatePart', part),
      getMeta: (key) => invoke('db-getMeta', key),
      setMeta: (key, value) => invoke('db-setMeta', { key, value }),
      // 夹具管理
      fixtureAdd: (fixture) => invoke('fixture-add', fixture),
      fixtureUpdate: (fixture) => invoke('fixture-update', fixture),
      fixtureDel: (id) => invoke('fixture-del', id),
      fixtureGetAll: () => invoke('fixture-getAll'),
      fixtureAddTransaction: (tx) => invoke('fixture-addTransaction', tx),
      fixtureGetTransactions: () => invoke('fixture-getTransactions'),
      currentBackend: () => 'electron-file'
    };
  }

  /* ============================================================
   * 浏览器模式（保留 1.0 逻辑）：IndexedDB 优先，localStorage 降级
   * ============================================================ */
  const IDB_NAME = 'spms_db';
  const IDB_VERSION = 1;
  let backend = null;          // 'idb' | 'ls'
  let idbDB = null;

  function idbSupported() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch (e) { return false; }
  }
  function lsSupported() {
    try { const k = '__spms_probe__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  }

  async function open() {
    if (idbSupported()) {
      try {
        await new Promise((resolve, reject) => {
          const req = indexedDB.open(IDB_NAME, IDB_VERSION);
          req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('parts')) {
              const s = d.createObjectStore('parts', { keyPath: 'id', autoIncrement: true });
              s.createIndex('code', 'code', { unique: true });
              s.createIndex('name', 'name', { unique: false });
              s.createIndex('category', 'category', { unique: false });
              s.createIndex('location', 'location', { unique: false });
            }
            if (!d.objectStoreNames.contains('transactions')) {
              const t = d.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
              t.createIndex('type', 'type', { unique: false });
              t.createIndex('partId', 'partId', { unique: false });
              t.createIndex('time', 'time', { unique: false });
              t.createIndex('operator', 'operator', { unique: false });
            }
            if (!d.objectStoreNames.contains('meta')) {
              d.createObjectStore('meta', { keyPath: 'key' });
            }
            if (!d.objectStoreNames.contains('locationAudits')) {
              d.createObjectStore('locationAudits', { keyPath: 'id', autoIncrement: true });
            }
          };
          req.onsuccess = (e) => { idbDB = e.target.result; resolve(); };
          req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        });
        backend = 'idb';
        return;
      } catch (e) {
        console.warn('IndexedDB 不可用，降级到 localStorage：', e && e.message);
      }
    }
    if (lsSupported()) { backend = 'ls'; return; }
    throw new Error('当前浏览器既不支持 IndexedDB 也不支持 localStorage，无法保存数据。请更换现代浏览器，或通过本地服务器打开。');
  }

  function reqToPromise(request) {
    return new Promise((res, rej) => {
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    });
  }
  function idbStore(name, mode) { return idbDB.transaction(name, mode).objectStore(name); }

  /* ---------------- localStorage 后端 ---------------- */
  const LS_PARTS = 'spms_parts';
  const LS_TX = 'spms_transactions';
  const LS_META = 'spms_meta';
  const LS_SEQ = 'spms_seq';
  const lsName = (n) => (n === 'parts' ? LS_PARTS : n === 'transactions' ? LS_TX : n);
  function lsRead(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function lsWrite(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function lsAll(name) { return lsRead(lsName(name), []); }
  function lsSave(name, arr) { lsWrite(lsName(name), arr); }
  function lsSeq() { let s = lsRead(LS_SEQ, 0) + 1; lsWrite(LS_SEQ, s); return s; }
  function lsAssignId(item) {
    if (item.id != null) {
      if (item.id >= lsRead(LS_SEQ, 0)) lsWrite(LS_SEQ, item.id + 1);
      return item.id;
    }
    item.id = lsSeq();
    return item.id;
  }
  function lsGet(name, id) { return lsAll(name).find((x) => x.id === id); }
  function lsAdd(name, item) {
    const arr = lsAll(name);
    if (name === 'parts' && item.code != null && arr.some((x) => x.code === item.code)) {
      const err = new Error('编号已存在'); err.name = 'ConstraintError'; throw err;
    }
    lsAssignId(item);
    arr.push(item);
    lsSave(name, arr);
    return item.id;
  }
  function lsPut(name, item) {
    const arr = lsAll(name);
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item; else arr.push(item);
    lsSave(name, arr);
    return item.id;
  }
  function lsDel(name, id) { lsSave(name, lsAll(name).filter((x) => x.id !== id)); }
  function lsClear(name) { lsSave(name, []); }
  function lsCount(name) { return lsAll(name).length; }
  function lsByIndex(name, index, value) { return lsAll(name).filter((x) => x[index] === value); }
  function lsByRange(name, index, range) {
    const lo = range && range.lower != null ? range.lower : -Infinity;
    const hi = range && range.upper != null ? range.upper : Infinity;
    return lsAll(name).filter((x) => x[index] >= lo && x[index] <= hi);
  }
  function lsAddTransaction(data) {
    const parts = lsAll('parts');
    const i = parts.findIndex((p) => p.id === data.partId);
    if (i < 0) throw new Error('备品不存在');
    const part = parts[i];
    if (data.type === 'out' && part.stock < data.quantity) throw new Error('库存不足');
    part.stock = data.type === 'in' ? part.stock + data.quantity : part.stock - data.quantity;
    part.updatedAt = Date.now();
    parts[i] = part; lsSave('parts', parts);
    const record = {
      type: data.type, partId: part.id, partCode: part.code, partName: part.name,
      quantity: data.quantity, operator: data.operator || '', counterparty: data.counterparty || '',
      time: data.time, remark: data.remark || '', createdAt: Date.now()
    };
    lsAdd('transactions', record);
  }
  function lsGetMeta(key) { const m = lsRead(LS_META, {}); return m[key] != null ? m[key] : null; }
  function lsSetMeta(key, value) { const m = lsRead(LS_META, {}); m[key] = value; lsWrite(LS_META, m); }

  /* ---------------- IndexedDB 后端 ---------------- */
  function idbAddTransaction(data) {
    return new Promise((resolve, reject) => {
      const t = idbDB.transaction(['transactions', 'parts'], 'readwrite');
      const ts = t.objectStore('transactions');
      const ps = t.objectStore('parts');
      let done = false;
      const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
      t.oncomplete = () => finish(resolve);
      t.onerror = () => finish(reject, t.error);
      t.onabort = () => finish(reject, t.error || new Error('事务被中止'));
      const getReq = ps.get(data.partId);
      getReq.onsuccess = () => {
        const part = getReq.result;
        if (!part) { t.abort(); return; }
        if (data.type === 'out' && part.stock < data.quantity) { t.abort(); return; }
        part.stock = data.type === 'in' ? part.stock + data.quantity : part.stock - data.quantity;
        part.updatedAt = Date.now();
        ps.put(part);
        const record = {
          type: data.type, partId: part.id, partCode: part.code, partName: part.name,
          quantity: data.quantity, operator: data.operator || '', counterparty: data.counterparty || '',
          time: data.time, remark: data.remark || '', createdAt: Date.now()
        };
        ts.add(record);
      };
      getReq.onerror = () => t.abort();
    });
  }

  /* ---------------- 统一对外接口（按 backend 分发） ---------------- */
  const getAll = (name) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readonly').getAll())
    : Promise.resolve(lsAll(name));
  const get = (name, id) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readonly').get(id))
    : Promise.resolve(lsGet(name, id));
  const add = (name, item) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readwrite').add(item))
    : Promise.resolve(lsAdd(name, item));
  const put = (name, item) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readwrite').put(item))
    : Promise.resolve(lsPut(name, item));
  const del = (name, id) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readwrite').delete(id))
    : Promise.resolve(lsDel(name, id));
  const clear = (name) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readwrite').clear())
    : Promise.resolve(lsClear(name));
  const count = (name) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readonly').count())
    : Promise.resolve(lsCount(name));
  const getByIndex = (name, index, value) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readonly').index(index).getAll(value))
    : Promise.resolve(lsByIndex(name, index, value));
  const getByRange = (name, index, range) => backend === 'idb'
    ? reqToPromise(idbStore(name, 'readonly').index(index).getAll(range))
    : Promise.resolve(lsByRange(name, index, range));
  const addTransaction = (data) => backend === 'idb'
    ? idbAddTransaction(data)
    : Promise.resolve().then(() => lsAddTransaction(data));
  const getMeta = (key) => backend === 'idb'
    ? get('meta', key).then((r) => (r ? r.value : null))
    : Promise.resolve(lsGetMeta(key));
  const setMeta = (key, value) => backend === 'idb'
    ? put('meta', { key, value })
    : Promise.resolve(lsSetMeta(key, value));

  /* 库位盘点记录 */
  const getLocationAudits = () => backend === 'idb'
    ? reqToPromise(idbStore('locationAudits', 'readonly').getAll())
    : Promise.resolve(lsRead('spms_location_audits', []));
  const saveLocationAudit = (audit) => backend === 'idb'
    ? reqToPromise(idbStore('locationAudits', 'readwrite').add(audit))
    : Promise.resolve(lsAdd('locationAudits', audit));

  /* 夹具管理 */
  const LS_FIXTURES = 'spms_fixtures';
  const LS_FIX_TX = 'spms_fix_transactions';
  function lsFixtures() { return lsRead(LS_FIXTURES, []); }
  function lsFixTransactions() { return lsRead(LS_FIX_TX, []); }
  const fixtureAdd = (fixture) => lsAdd(LS_FIXTURES, fixture);
  const fixtureUpdate = (fixture) => lsPut(LS_FIXTURES, fixture);
  const fixtureDel = (id) => lsDel(LS_FIXTURES, id);
  const fixtureGetAll = () => Promise.resolve(lsFixtures());
  const fixtureGetTransactions = () => Promise.resolve(lsFixTransactions());
  const fixtureAddTransaction = (tx) => {
    const fixtures = lsFixtures();
    const i = fixtures.findIndex((f) => f.id === tx.fixtureId);
    if (i < 0) throw new Error('夹具不存在');
    const fixture = fixtures[i];
    if (tx.type === 'out' && fixture.status !== 'stocked' && fixture.status !== 'returned') {
      throw new Error('夹具当前状态不允许出库');
    }
    if (tx.type === 'return' && fixture.status !== 'checked_out') {
      throw new Error('夹具未处于已出库状态');
    }
    const fromStatus = fixture.status;
    let toStatus = fixture.status;
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
    const record = {
      id: lsSeq(),
      fixtureId: fixture.id,
      fixtureCode: fixture.code,
      fixtureName: fixture.name,
      type: tx.type,
      operator: tx.operator || '',
      counterparty: tx.counterparty || '',
      time: tx.time,
      remark: tx.remark || '',
      fromStatus, toStatus,
      createdAt: Date.now()
    };
    lsSave(LS_FIXTURES, fixtures);
    lsAdd(LS_FIX_TX, record);
  };

  async function addPart(part) {
    part.createdAt = Date.now();
    part.updatedAt = Date.now();
    if (part.stock == null) part.stock = 0;
    if (part.safeStock == null) part.safeStock = 0;
    return add('parts', part);
  }
  async function updatePart(part) {
    part.updatedAt = Date.now();
    return put('parts', part);
  }

  return {
    APP_VERSION,
    open, getAll, get, add, put, del, clear, count,
    getByIndex, getByRange, addTransaction, addPart, updatePart,
    getMeta, setMeta,
    getLocationAudits, saveLocationAudit,
    fixtureAdd, fixtureUpdate, fixtureDel, fixtureGetAll, fixtureAddTransaction, fixtureGetTransactions,
    currentBackend: () => backend
  };
})();
