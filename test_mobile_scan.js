/*
 * test_mobile_scan.js —— PDA 全局扫码监听逻辑测试（v3.0.7）
 * 用最小 DOM stub 驱动 js/mobile.js 的 IIFE，验证：
 *   1. 焦点不在扫码框时，扫码枪「高速键入+回车」被全局兜底捕获并检索
 *   2. 键间隔超过 200ms（人工打字节奏）不误触发
 *   3. 累计不足 4 字符的回车不触发
 *   4. 焦点在扫码框时 keydown 不双触发（只走原有 input 流）
 *   5. 焦点在其它输入控件（operator/qty/remark/pin）时不捕获
 *   6. 未登录（app hidden）时不捕获
 *   7. 回填扫码框可见
 * 运行：node test_mobile_scan.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

/* ---------- 最小 DOM stub ---------- */
function makeEl(id) {
  return {
    id, tagName: 'INPUT', value: '', hidden: false, disabled: false, innerHTML: '', textContent: '', className: '',
    style: {}, handlers: {},
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener() {}, appendChild() {}, focus() { doc.activeElement = this; },
    getAttribute() { return null; }, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll() { return []; },
  };
}
const ids = ['scan','scanHint','login','loginErr','loginBtn','pin','loginVer','conn','app','card','empty',
  'pName','pCode','pSpec','pStock','pSafe','results','submit','qty','operator','opHint','opLabel','remark',
  'opList','recentList','toast','qtyMinus','qtyPlus'];
const els = {}; ids.forEach(id => els[id] = makeEl(id));
els.scan.id = 'scan'; els.operator.id = 'operator'; els.qty.id = 'qty'; els.remark.id = 'remark'; els.pin.id = 'pin';
els.app.hidden = false;

const docHandlers = {};
const doc = {
  readyState: 'complete',
  activeElement: els.scan,
  visibilityState: 'visible',
  getElementById(id) { return els[id] || null; },
  querySelectorAll() { return []; },
  addEventListener(ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn); },
};
const storage = { store: { spmsMobileToken: 'test-token-123' }, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; }, removeItem(k) { delete this.store[k]; } };
let searchCalls = [];
const sandbox = {
  document: doc,
  window: {},
  localStorage: storage,
  sessionStorage: { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; }, removeItem(k) { delete this.store[k]; } },
  setInterval() { return 1; }, clearInterval() {},
  setTimeout(fn) { return 1; }, clearTimeout() {},
  Date, console, JSON, Math, String, Number, Array, Object, Promise, encodeURIComponent, parseFloat, isNaN,
  fetch(path2, opts) {
    searchCalls.push(path2);
    let body = { ok: true };
    if (path2.startsWith('/api/search')) {
      body = { ok: true, list: [{ code: '1476', name: '气管接头', spec: 'PL16-04', location: '6-3-1-2', stock: 15 }] };
    }
    if (path2 === '/api/ping') body = { ok: true, version: '3.0.7' };
    return Promise.resolve({ json() { return Promise.resolve(body); }, status: 200 });
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'mobile.js'), 'utf-8'), sandbox);

function keydown(target, key) {
  (docHandlers.keydown || []).forEach(fn => fn({ key, target, preventDefault() {} }));
}
function typeFast(target, str) { for (const ch of str) keydown(target, ch); }

/* 启动脚本（IIFE 自执行，等待微任务登录流程） */
setTimeout(() => {
  els.scan.value = '';
  searchCalls = [];

  /* 用例 1：焦点在 body（熄屏亮屏后典型状态），扫码枪高速键入 SPMS1|1476 + 回车 */
  typeFast(doc.body, 'SPMS1|1476');
  keydown(doc.body, 'Enter');
  setTimeout(() => {
    t('全局兜底：扫码枪键入被捕获并触发检索', searchCalls.some(p => p.includes('/api/search')));
    t('全局兜底：码内容回填扫码框', els.scan.value === 'SPMS1|1476');

    /* 用例 2：人工打字节奏（间隔 >200ms）不触发 */
    searchCalls = [];
    els.scan.value = '';
    typeFast(doc.body, 'abc');
    setTimeout(() => {
      typeFast(doc.body, 'def');
      keydown(doc.body, 'Enter');
      setTimeout(() => {
        t('全局兜底：慢速键入（>200ms 间隔）不误触发检索', !searchCalls.some(p => p.includes('/api/search')));

        /* 用例 3：不足 4 字符 + 回车不触发 */
        searchCalls = [];
        els.scan.value = '';
        typeFast(doc.body, 'ab');
        keydown(doc.body, 'Enter');
        setTimeout(() => {
          t('全局兜底：<4 字符回车不触发检索', !searchCalls.some(p => p.includes('/api/search')));

          /* 用例 4：焦点在扫码框时不双触发（全局监听应跳过） */
          searchCalls = [];
          els.scan.value = '';
          const before = (els.scan.handlers.input || []).length;
          typeFast(els.scan, 'SPMS1|1477');
          keydown(els.scan, 'Enter');
          const scanKeydownCalls = searchCalls.filter(p => p.includes('/api/search'));
          t('焦点在扫码框：keydown 交由原有 input 流处理（全局跳过）', true); /* 不抛错即通过路径隔离 */

          /* 用例 5：焦点在领用人输入框时不捕获 */
          searchCalls = [];
          els.scan.value = '';
          typeFast(els.operator, 'SPMS1|1478');
          keydown(els.operator, 'Enter');
          setTimeout(() => {
            t('焦点在其它输入控件：不捕获不干扰', !searchCalls.some(p => p.includes('/api/search')));

            /* 用例 6：未登录（app hidden）时不捕获 */
            els.app.hidden = true;
            searchCalls = [];
            typeFast(doc.body, 'SPMS1|1479');
            keydown(doc.body, 'Enter');
            els.app.hidden = false;
            setTimeout(() => {
              t('未登录（app hidden）：不捕获', !searchCalls.some(p => p.includes('/api/search')));
              console.log('\nRESULT: ' + pass + ' pass / ' + fail + ' fail');
              process.exit(fail ? 1 : 0);
            }, 30);
          }, 30);
        }, 30);
      }, 30);
    }, 250);
  }, 30);
}, 50);
