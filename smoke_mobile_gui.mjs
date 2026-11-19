/* ============================================================
 * smoke_mobile_gui.mjs — 真机级冒烟：启动 Electron + CDP 检查
 *
 * 验证：程序能启动、桌面页渲染正常、scan-core 加载成功、
 *       移动端服务在 8765 监听、关于面板能显示访问地址与二维码、
 *       移动端接口能读到真实数据。
 *
 * 用法（在 2.5 目录）：node smoke_mobile_gui.mjs
 * 说明：使用临时 userData 目录 + 真实数据副本，不动业务数据。
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DATA = process.env.SPMS_DATA || 'D:\\project\\release\\备件仓库系统v2.32\\spms-data.json';
const CDP_PORT = 9333;
const MOBILE_PORT = Number(process.env.SPMS_MOBILE_PORT) || 18765; // 默认用 18765，避开用户正在运行的 8765 实例

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fail++; fails.push(name + (extra ? ' → ' + extra : ''));
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('超时等待：' + label);
}

/* ---------------- CDP 客户端 ---------------- */
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('CDP 连接失败'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(msg.error.message)); else rs(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result ? r.result.value : undefined;
  }
}

/* ---------------- 主流程 ---------------- */
(async function () {
  const userDir = path.join(os.tmpdir(), 'spms-smoke-' + Date.now());
  fs.mkdirSync(path.join(userDir, 'spms'), { recursive: true });
  if (fs.existsSync(LIVE_DATA)) {
    fs.copyFileSync(LIVE_DATA, path.join(userDir, 'spms', 'spms-data.json'));
  }

  const electronBin = path.join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) { console.error('未找到 electron：' + electronBin); process.exit(1); }

  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEBUDDY_SESSION_ID;
  env.SPMS_MOBILE_PORT = String(MOBILE_PORT);

  const child = spawn(electronBin, [
    '.', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
    '--user-data-dir=' + userDir, '--remote-debugging-port=' + CDP_PORT
  ], { cwd: HERE, env: env, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  const cleanup = () => {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };

  try {
    /* 1. 移动端服务 */
    const ping = await waitFor(async () => {
      try { return await getJson('http://127.0.0.1:' + MOBILE_PORT + '/api/ping'); } catch (e) { return null; }
    }, 20000, '移动端服务 ' + MOBILE_PORT);
    ok('移动端服务已监听 ' + MOBILE_PORT, ping && ping.ok === true);
    ok('接口返回版本号', ping && /^3\.0/.test(String(ping.version)), ping && ping.version);

    /* 2. 页面目标 */
    const list = await waitFor(async () => {
      const j = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const page = (j || []).find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      return page ? page : null;
    }, 20000, '渲染进程调试目标');

    const cdp = new Cdp(list.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(1500);

    /* 3. 桌面页基础渲染 */
    const title = await cdp.eval('document.title');
    ok('窗口标题含 v3.0', /v3\.0/.test(String(title)), title);

    const brand = await cdp.eval("(document.querySelector('.brand-name')||{}).textContent || ''");
    ok('侧边栏版本号已更新', /v3\.0/.test(String(brand)), brand);

    const navCount = await cdp.eval("document.querySelectorAll('.nav-item').length");
    ok('导航项已渲染（9 项，含系统设置）', Number(navCount) === 9, 'count=' + navCount);
    const navLast = await cdp.eval("(function(){var n=document.querySelectorAll('.nav-item');return n.length?n[n.length-1].dataset.view:'';})()");
    ok('系统设置位于导航末项（数据备份下方）', navLast === 'settings', navLast);

    const stats = await cdp.eval("(document.getElementById('topStats')||{}).textContent || ''");
    ok('顶部统计已渲染', /备品种类/.test(stats), stats);

    const hasScanCore = await cdp.eval("typeof window.ScanCore === 'object' && typeof window.ScanCore.parseQRToken === 'function'");
    ok('共享扫码模块已加载', hasScanCore === true);

    const parseCheck = await cdp.eval("JSON.stringify([ScanCore.parseQRToken('SPMS1|1001'), ScanCore.normalizeCode('SPMS1|A-1_2 '), ScanCore.findPart([{code:'1001'}], 'spms1|1001') ? 'hit' : 'miss'])");
    ok('扫码解析规则正确', parseCheck === JSON.stringify(['1001', 'a12', 'hit']), parseCheck);

    /* 4. 真实数据是否能被桌面读到（从顶部统计文本判断，state 在闭包内不可直接访问） */
    const statsText = await cdp.eval("(document.getElementById('topStats')||{}).textContent || ''");
    ok('桌面已载入真实备品数据', /备品种类\s*\d+/.test(statsText) && !/备品种类\s*0/.test(statsText), statsText);

    /* 5. 移动端接口读到真实数据（1001 螺丝） */
    const login = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ pin: '1234' });
      const req = http.request({ host: '127.0.0.1', port: MOBILE_PORT, method: 'POST', path: '/api/login', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.write(body); req.end();
    });
    ok('默认 PIN 可登录', login && login.ok === true);

    const token = login && login.token;
    const part = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: MOBILE_PORT, method: 'GET', path: '/api/part?code=' + encodeURIComponent('SPMS1|1001'), headers: { 'x-spms-token': token } }, (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.end();
    });
    ok('移动端能查到真实备件 1001', part && part.ok && part.part && part.part.code === '1001', JSON.stringify(part && part.part));

    /* 6. 系统设置页：服务状态 / 地址列表 / PIN / 端口 / 二维码 / 本机信息 */
    await cdp.eval("(function(){var b=Array.from(document.querySelectorAll('.nav-item')).find(function(x){return x.dataset.view==='settings';});if(b)b.click();})()", true);
    await sleep(1000);
    const sysTitle = await cdp.eval("(document.getElementById('viewTitle')||{}).textContent || ''");
    ok('系统设置页标题正确', String(sysTitle).trim() === '系统设置', sysTitle);

    const sysStatus = await cdp.eval("(document.getElementById('sysStatus')||{}).textContent || ''");
    ok('显示移动端服务状态', /运行中/.test(String(sysStatus)), sysStatus);

    const lanFirst = await cdp.eval("(function(){var b=document.querySelector('#sysLan .lan-item b');return b?b.textContent:'';})()");
    ok('局域网地址列表已渲染', String(lanFirst).trim().indexOf('http://') === 0, lanFirst);

    const copyBtns = await cdp.eval("document.querySelectorAll('#sysLan .lan-item button').length");
    ok('每个地址带复制按钮', Number(copyBtns) >= 1, 'count=' + copyBtns);

    const qrW = await cdp.eval("(function(){var c=document.getElementById('sysQR');return c?c.width:0;})()");
    ok('访问地址二维码已绘制', Number(qrW) > 100, 'width=' + qrW);

    const pinVal = await cdp.eval("(document.getElementById('sysPinInput')||{}).value || ''");
    ok('系统设置页显示 PIN', /^\d{4}$/.test(String(pinVal)), pinVal);

    const portVal = await cdp.eval("(document.getElementById('sysPortInput')||{}).value || ''");
    ok('系统设置页显示端口', String(portVal).trim() !== '', portVal);

    /* 端口放行：状态行 + 检查/放行按钮 + 已自动查询 */
    ok('系统设置页有端口放行状态行', (await cdp.eval("!!document.getElementById('sysPortRule')")) === true);
    const portRuleFns = await cdp.eval("[typeof window.checkPortRule, typeof window.openPortFirewall].join(',')");
    ok('端口检查/放行函数已挂载', portRuleFns === 'function,function', portRuleFns);
    const ruleBtns = await cdp.eval("document.querySelectorAll('button[onclick=\"checkPortRule()\"],button[onclick=\"openPortFirewall()\"]').length");
    ok('端口放行按钮已渲染（检查 + 一键放行）', Number(ruleBtns) === 2, 'count=' + ruleBtns);
    await sleep(600);
    const ruleTxt = await cdp.eval("(document.getElementById('sysPortRule')||{}).textContent || ''");
    ok('端口放行状态已自动查询', /已放行|未放行|查询失败/.test(String(ruleTxt)), ruleTxt);

    const sysVer = await cdp.eval("(document.getElementById('sysVer')||{}).textContent || ''");
    ok('本机信息显示版本号', /^v3\.0/.test(String(sysVer)), sysVer);

    const sysDataPath = await cdp.eval("(document.getElementById('sysData')||{}).textContent || ''");
    ok('本机信息显示数据文件路径', /spms-data\.json/.test(String(sysDataPath)), sysDataPath);

    /* 关于面板只留入口提示，不再承载移动端设置 */
    await cdp.eval("window.openAbout ? window.openAbout() : null", true);
    await sleep(300);
    const aboutHasMobileCfg = await cdp.eval("!!document.querySelector('.about-mobile')");
    ok('关于面板不再重复移动端设置', aboutHasMobileCfg === false);
    await cdp.eval("window.closeModal ? window.closeModal() : null", true);
    await sleep(200);

    /* 6b. 员工档案：新增 → 工号联想 → 清理（不留脏数据） */
    await cdp.eval("(function(){var b=Array.from(document.querySelectorAll('.nav-item')).find(function(x){return x.dataset.view==='settings';});if(b)b.click();})()", true);
    await sleep(700);
    ok('系统设置页有员工档案区', (await cdp.eval("!!document.getElementById('staffList')")) === true);
    ok('员工档案有导入入口', (await cdp.eval("!!document.getElementById('staffFile') && typeof window.importStaffCSV === 'function'")) === true);

    const TEST_NO = 'ZZSMOKE01';
    await cdp.eval("document.getElementById('staffNo').value='" + TEST_NO + "'", true);
    await cdp.eval("document.getElementById('staffName').value='冒烟测试'", true);
    await cdp.eval("window.saveStaff()", true);
    await sleep(700);
    const staffText = await cdp.eval("(document.getElementById('staffList')||{}).textContent || ''");
    ok('员工档案可新增', /ZZSMOKE01/.test(String(staffText)) && /冒烟测试/.test(String(staffText)), String(staffText).slice(0, 120));

    /* 入库页：输工号 → 候选下拉应带出姓名与工号 */
    await cdp.eval("(function(){var b=document.querySelector('.nav-item[data-view=inbound]');if(b)b.click();})()", true);
    await sleep(700);
    await cdp.eval("(function(){var i=document.getElementById('in_op');i.value='ZZSMOKE01';window.operatorSuggest(i);})()", true);
    await sleep(300);
    const acText = await cdp.eval("(document.getElementById('in_op_ac')||{}).textContent || ''");
    ok('输工号可联想到姓名', /冒烟测试/.test(String(acText)) && /ZZSMOKE01/.test(String(acText)), String(acText).slice(0, 120));

    const resolved = await cdp.eval("JSON.stringify(window.StaffCore.resolveOperator([{no:'ZZSMOKE01',name:'冒烟测试'}],'ZZSMOKE01'))");
    ok('工号解析为姓名+工号', /"name":"冒烟测试"/.test(String(resolved)) && /"no":"ZZSMOKE01"/.test(String(resolved)), resolved);

    /* 清理：delStaff 会调 confirm，先替换为恒真 */
    await cdp.eval("(function(){var b=Array.from(document.querySelectorAll('.nav-item')).find(function(x){return x.dataset.view==='settings';});if(b)b.click();})()", true);
    await sleep(700);
    await cdp.eval("window.confirm=function(){return true;}", true);
    await cdp.eval("window.delStaff('" + TEST_NO + "')", true);
    await sleep(700);
    const afterDel = await cdp.eval("(document.getElementById('staffList')||{}).textContent || ''");
    ok('冒烟档案已清理', !/ZZSMOKE01/.test(String(afterDel)), String(afterDel).slice(0, 120));

    /* 7. 渲染进程无未捕获异常 */
    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const exText = exceptions.map((e) => {
      const d = e.params && e.params.exceptionDetails;
      if (!d) return 'unknown';
      return (d.text || '') + ' ' + ((d.exception && (d.exception.description || d.exception.value)) || '') + ' @' + ((d.url || '') + ':' + (d.lineNumber || 0));
    }).join(' | ');
    ok('渲染进程无未捕获异常', exceptions.length === 0, exText);
    if (exceptions.length) {
      const body = await cdp.eval("(document.getElementById('content')||{}).textContent || ''");
      console.log('    [诊断] 页面内容：' + String(body).slice(0, 300).replace(/\s+/g, ' '));
      console.log('    [诊断] window.openAbout = ' + await cdp.eval('typeof window.openAbout'));
    }

    const errors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
    ok('无资源加载/脚本错误日志', errors.length === 0,
      errors.map((e) => e.params.entry.text).slice(0, 3).join(' | '));
  } catch (e) {
    fail++;
    fails.push('冒烟执行异常：' + e.message);
    console.error('冒烟执行异常：', e.message);
    if (log) console.error('--- Electron 输出（尾部）---\n' + log.slice(-2000));
  } finally {
    cleanup();
  }

  console.log('\n冒烟结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
})();
