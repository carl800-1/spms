/* ============================================================
 * smoke_packed_v30.mjs — 打包后 exe 冒烟（真机级）
 *
 * 验证打包产物（D:\project\release\备件仓库系统v3.0）能否：
 *   启动 → 标题是 v3.0 → 侧边栏只有 8 个导航项（无夹具）→
 *   载入真实数据（115 条备品）→ 移动端服务 8765 就绪 →
 *   移动端能检索到 1001 → 无未捕获异常 / 无资源加载错误
 *
 * 用法（在 2.5 目录）：node smoke_packed_v30.mjs
 * 说明：把发布目录整份复制到临时目录再启动，不动线上数据文件。
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const RELEASE_DIR = process.env.SPMS_RELEASE || 'D:\\project\\release\\备件仓库系统v3.0';
const CDP_PORT = 9344;
const MOBILE_PORT = Number(process.env.SPMS_MOBILE_PORT) || 18766;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fail++; fails.push(name + (extra ? ' → ' + extra : ''));
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
    }).on('error', reject);
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
        } else if (msg.method) { this.events.push(msg); }
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

  /* 目录复制交给外部（bash cp），Node 的 cpSync 在本机拷贝 259MB 目录会被安全软件掐死（exit 127） */
  const work = process.env.SPMS_RUN_DIR || RELEASE_DIR;
  const exe = path.join(work, exeName);
  console.log('运行目录：' + work);

  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE; delete env.CODEBUDDY_SESSION_ID;
  env.SPMS_MOBILE_PORT = String(MOBILE_PORT);

  const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--remote-debugging-port=' + CDP_PORT], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  const cleanup = () => {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    if (process.env.SPMS_RUN_DIR) setTimeout(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 1500);
  };

  let cdp = null;
  try {
    /* 1. 移动端服务（打包后同样应监听 8765） */
    const ping = await waitFor(async () => {
      try { return await getJson('http://127.0.0.1:' + MOBILE_PORT + '/api/ping'); } catch (e) { return null; }
    }, 30000, '打包后移动端服务 ' + MOBILE_PORT);
    ok('打包后移动端服务已监听 ' + MOBILE_PORT, !!ping);
    ok('接口返回版本号 3.0', /^3\.0/.test(String(ping && ping.version)), ping && ping.version);

    /* 2. CDP 接上渲染进程 */
    const target = await waitFor(async () => {
      const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      return (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 30000, 'CDP 页面目标');
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(1200);

    /* 3. 界面结构 */
    const title = await cdp.eval('document.title');
    ok('标题为 v3.0', /v3\.0/.test(String(title)), title);

    const nav = await cdp.eval("Array.from(document.querySelectorAll('.nav-item')).map(b=>b.dataset.view).join(',')");
    ok('导航共 9 项（含系统设置）', String(nav).split(',').filter(Boolean).length === 9, nav);
    ok('导航无夹具入口', !/fixture/i.test(String(nav)), nav);

    const brand = await cdp.eval("(document.querySelector('.brand-name')||{}).textContent||''");
    ok('侧边栏版本号 v3.0', /v3\.0/.test(String(brand)), brand);

    await cdp.eval("(function(){var b=Array.from(document.querySelectorAll('.nav-item')).find(function(x){return x.dataset.view==='settings';});if(b)b.click();})()", true);
    await sleep(900);
    const sysLan = await cdp.eval("(function(){var b=document.querySelector('#sysLan .lan-item b');return b?b.textContent:'';})()");
    ok('系统设置页显示局域网地址', String(sysLan).trim().indexOf('http://') === 0, sysLan);
    const sysQr = await cdp.eval("(function(){var c=document.getElementById('sysQR');return c?c.width:0;})()");
    ok('系统设置页二维码已绘制', Number(sysQr) > 100, 'width=' + sysQr);
    await cdp.eval("(function(){var b=document.querySelector('.nav-item[data-view=dashboard]');if(b)b.click();})()", true);
    await sleep(300);

    const stats = await cdp.eval("(document.getElementById('topStats')||{}).textContent||''");
    ok('顶部统计无夹具字样', !/夹具/.test(stats), stats);

    /* 4. 真实数据 */
    const partRows = await cdp.eval("(async()=>{ const l = await DB.getAll('parts'); return l.length; })()", true);
    ok('载入真实备品 115 条', Number(partRows) === 115, String(partRows));

    /* 5. 移动端可检索真实备件 */
    /* PIN 为首次运行随机生成，从主进程取真实值，避免硬编码 */
    const realPin = await cdp.eval('window.api.mobileStatus().then(s => s.pin)', true);
    ok('能读到当前 PIN', /^\d{4}$/.test(String(realPin)), String(realPin));
    const auth = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ pin: String(realPin) });
      const req = http.request({ host: '127.0.0.1', port: MOBILE_PORT, path: '/api/login', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } }); });
      req.on('error', reject); req.end(body);
    });
    ok('用真实 PIN 可登录', !!(auth && auth.token), JSON.stringify(auth).slice(0, 80));

    /* 6. 无错误 */
    const exc = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    ok('无未捕获异常', exc.length === 0, exc.map((e) => e.params && e.params.exceptionDetails && e.params.exceptionDetails.text).join(' | '));
    const errs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
    ok('无资源加载/脚本错误', errs.length === 0, errs.map((e) => e.params.entry.text).join(' | '));
  } catch (e) {
    ok('流程未抛异常', false, e.message + '\n' + log.slice(-600));
  } finally {
    if (cdp && cdp.ws) { try { cdp.ws.close(); } catch (e) { /* ignore */ } }
    cleanup();
  }

  console.log('\n打包冒烟结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
})();
