'use strict';
/* ============================================================
 * smoke_web_gui.mjs — 电脑网页版真机渲染冒烟（CDP，需要打包后的 exe）
 * 运行：SPMS_RELEASE=<win-unpacked目录> node smoke_web_gui.mjs
 * 覆盖：HTTP 起服务 → 浏览器导航 /pc → 登录注入令牌 → reload →
 *       9 视图渲染、真实数据加载、系统设置网页版面板、PDA 端不受影响。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
/* WebSocket 用 Node 22 全局实现（与 smoke_packed_v30.mjs 一致），无需 ws 包 */

const CDP_PORT = 9355;
const MOBILE_PORT = Number(process.env.SPMS_MOBILE_PORT) || 18767;
const RELEASE_DIR = process.env.SPMS_RELEASE || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers || {});
    const req = http.request(url, { method: 'POST', headers: h }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ }
    await sleep(400);
  }
  throw new Error('超时等待：' + label);
}
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP 连接失败'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(msg.error.message)); else rs(msg.result);
        } else if (msg.method) this.events.push(msg);
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  }
}

(async function () {
  const exeName = '备件仓库管理系统.exe';
  if (!fs.existsSync(path.join(RELEASE_DIR, exeName))) {
    console.error('未找到打包 exe：' + path.join(RELEASE_DIR, exeName));
    process.exit(1);
  }
  const work = RELEASE_DIR;
  const exe = path.join(work, exeName);
  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE; delete env.CODEBUDDY_SESSION_ID;
  env.SPMS_MOBILE_PORT = String(MOBILE_PORT);

  const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--remote-debugging-port=' + CDP_PORT], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = () => { try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  try {
    /* 1. 服务起 */
    const ping = await waitFor(async () => {
      try { return await getJson('http://127.0.0.1:' + MOBILE_PORT + '/api/ping'); } catch (e) { return null; }
    }, 30000, '网页版服务 ping');
    ok('网页版 HTTP 服务已监听', !!ping, ping);

    /* 2. 登录拿 desktop scope 令牌 */
    const login = await postJson('http://127.0.0.1:' + MOBILE_PORT + '/api/login', { pin: '1234', scope: 'desktop' });
    ok('desktop scope 登录成功', login.status === 200 && !!login.json.token, login.json);
    const token = login.json.token;

    /* 3. CDP 接上页面，导航到 /pc */
    const target = await waitFor(async () => {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      return (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 30000, 'CDP 页面目标');
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + MOBILE_PORT + '/pc' });
    await sleep(1200);
    /* 注入令牌到 sessionStorage，再 reload 让 desktop-api.js 探测到已登录 */
    await cdp.eval("sessionStorage.setItem('spms_desktop_token', '" + token + "'); 'ok'");
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(3000);

    /* 4. 结构断言 */
    const title = await cdp.eval('document.title');
    ok('网页标题含 v3.0', /3\.0/.test(String(title)), title);
    const badge = await cdp.eval("(document.querySelector('.desk-web-badge')||{}).textContent||''");
    ok('网页版角标存在', /网页版/.test(String(badge)), badge);
    const nav = await cdp.eval("Array.from(document.querySelectorAll('.nav-item')).map(b=>b.dataset.view).join(',')");
    const navs = String(nav).split(',').filter(Boolean);
    ok('导航 9 项', navs.length === 9, navs);
    ok('导航含系统设置', navs.indexOf('settings') >= 0, navs);
    ok('导航无夹具入口', !/fixture/i.test(String(nav)), nav);
    const apiOk = await cdp.eval("[typeof window.api, typeof window.api.invoke, window.desktopWeb===true].join(',')");
    ok('window.api shim 注入成功', apiOk === 'object,function,true', apiOk);

    /* 5. 真实数据加载：仪表盘应有统计，切换到备品管理应出现卡片 */
    const dashStats = await cdp.eval("(document.getElementById('topStats')||{}).textContent||''");
    ok('仪表盘统计已渲染', String(dashStats).trim().length > 0, dashStats);
    await cdp.eval("document.querySelector('[data-view=parts]').click(); 'ok'");
    await sleep(1200);
    const partRows = await cdp.eval("document.querySelectorAll('#partResults tbody tr').length");
    ok('备品表格行已渲染（真实数据）', Number(partRows) > 0, partRows);

    /* 6. 系统设置网页版面板 */
    await cdp.eval("document.querySelector('[data-view=settings]').click(); 'ok'");
    await sleep(1500);
    const deskPanel = await cdp.eval("!!document.getElementById('deskUrl') && !!document.getElementById('deskPinInput')");
    ok('网页版访问面板已渲染', deskPanel === true, deskPanel);
    const deskUrl = await cdp.eval("(document.getElementById('deskUrl')||{}).textContent||''");
    ok('网页版地址含 /pc', /\/pc/.test(String(deskUrl)), deskUrl);
    const deskPin = await cdp.eval("(document.getElementById('deskPinInput')||{}).value||''");
    ok('网页版 PIN 已填充', /^\d{4}$/.test(String(deskPin)), deskPin);
    const portRule = await cdp.eval("(document.getElementById('sysPortRule')||{}).textContent||''");
    ok('网页版端口状态提示客户端查看', /客户端/.test(String(portRule)), portRule);

    /* 7. PDA 端不受影响 */
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + MOBILE_PORT + '/' });
    await sleep(1200);
    const pdaTitle = await cdp.eval('document.title');
    ok('PDA 页面标题未被网页版覆盖', /PDA|移动|扫码|备件/.test(String(pdaTitle)), pdaTitle);

    console.log('\n网页版真机冒烟：' + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('冒烟异常：', e.message);
    console.error('进程日志尾部：', log.slice(-600));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
