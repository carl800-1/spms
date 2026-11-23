'use strict';
/* ============================================================
 * test_desktop.js — 电脑网页版 HTTP 网关测试（纯 Node，无需 Electron）
 * 运行：node test_desktop.js
 * 覆盖：桌面前端静态白名单、/api/invoke 数据分发（读/写/校验）、
 *       PIN 双端拆分与 scope 隔离、Electron 专属能力降级、数据版本轮询、
 *       PDA 端路由不受影响。
 * ============================================================ */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const store = require('./store');
const srv = require('./mobile-server');
const ROOT = __dirname;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++; fails.push(name + (extra ? ' → ' + extra : ''));
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}
function request(port, method, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['x-spms-token'] = token;
    if (body) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: pathName, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function invoke(port, token, channel, payload) {
  return request(port, 'POST', '/api/invoke', { channel: channel, payload: payload === undefined ? null : payload }, token);
}

(async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spms-desktop-test-'));
  store.setDataDir(tmp);
  store.open();
  /* 造一条备品，供 invoke 读 */
  const partId = store.addPart({ code: '1001', name: '测试轴承', spec: '6205', location: 'A-01-01', stock: 10, safeStock: 2 });

  const port = await new Promise((resolve) => {
    srv.start({ port: 0, version: '3.0.5', dataDir: tmp, onListening: (st) => resolve(st.port) });
  });
  console.log('电脑网页版测试服务端口 ' + port);

  /* ---- 静态资源：桌面前端全套可访问，PDA 端仍在 ---- */
  const statics = [
    ['/desktop.html', 'desktop-api.js'],
    ['/pc', 'desk-web-badge'],
    ['/css/style.css', 'sidebar'],
    ['/js/desktop-api.js', 'window.api'],
    ['/js/app.js', 'saveDeskPin'],
    ['/js/db.js', 'APP_VERSION'],
    ['/js/staff-core.js', 'resolveOperator'],
    ['/js/vendor/qrcode-generator.js', ''],
    ['/js/vendor/jsQR.js', '']
  ];
  for (const [p, keyword] of statics) {
    const r = await request(port, 'GET', p);
    eq('静态可访问 ' + p, r.status, 200);
    if (keyword) ok('内容含 ' + keyword, r.text.indexOf(keyword) >= 0);
  }
  eq('PDA 首页仍在', (await request(port, 'GET', '/')).status, 200);
  eq('PDA 样式仍在', (await request(port, 'GET', '/css/mobile.css')).status, 200);
  eq('未知路径 404', (await request(port, 'GET', '/no-such')).status, 404);

  /* ---- 鉴权：invoke 需要带 desktop scope 的令牌 ---- */
  eq('invoke 无令牌被拒', (await invoke(port, '', 'db-getAll', 'parts')).status, 401);
  let r = await request(port, 'POST', '/api/login', { pin: '1234', scope: 'desktop' });
  eq('默认 PIN + desktop scope 登录', r.status, 200);
  eq('登录返回 scope=desktop', r.json.scope, 'desktop');
  const token = r.json.token;
  ok('拿到令牌', !!token);
  eq('旧调用（无 scope）默认 pda', (await request(port, 'POST', '/api/login', { pin: '1234' })).json.scope, 'pda');

  /* PDA scope 令牌不能调 desktop-only 接口 */
  const rPda = await request(port, 'POST', '/api/login', { pin: '1234', scope: 'pda' });
  const pdaToken = rPda.json.token;
  eq('PDA scope 登录成功', rPda.status, 200);
  eq('PDA 令牌调 /api/invoke 被 403 拒绝', (await invoke(port, pdaToken, 'db-getAll', 'parts')).status, 403);
  eq('PDA 令牌调 /api/sys-info 被 403 拒绝', (await request(port, 'GET', '/api/sys-info', null, pdaToken)).status, 403);
  eq('PDA 令牌调 /api/mobile-set-pin 被 403 拒绝', (await request(port, 'POST', '/api/mobile-set-pin', { pin: '1234' }, pdaToken)).status, 403);
  /* desktop 令牌不能冒用 PDA 接口 */
  eq('desktop 令牌调 /api/tx 被 403 拒绝', (await request(port, 'POST', '/api/tx', { type: 'in', code: '1001', quantity: 1, operator: '张三' }, token)).status, 403);

  /* 双 PIN 拆分：单独设电脑 PIN 后旧 PDA PIN 登不上 desktop，PDA 仍用旧 PIN */
  r = await request(port, 'POST', '/api/mobile-set-pin', { pin: '5678', scope: 'desktop' }, token);
  eq('desktop scope 可改电脑 PIN', r.status, 200);
  eq('改 PIN 后 desktopPin 生效', r.json.status.desktopPin, '5678');
  eq('改电脑 PIN 不影响 PDA PIN', r.json.status.pdaPin, '1234');
  eq('旧 PIN 登录 desktop 被拒', (await request(port, 'POST', '/api/login', { pin: '1234', scope: 'desktop' })).status, 401);
  eq('新电脑 PIN 登录 desktop 成功', (await request(port, 'POST', '/api/login', { pin: '5678', scope: 'desktop' })).status, 200);
  eq('PDA 仍用旧 PIN 登录', (await request(port, 'POST', '/api/login', { pin: '1234', scope: 'pda' })).status, 200);
  await request(port, 'POST', '/api/mobile-set-pin', { pin: '1234', scope: 'desktop' }, token); // 还原

  /* ---- invoke：通用数据层读写（标量 payload 原样透传是关键） ---- */
  r = await invoke(port, token, 'db-getAll', 'parts');
  eq('db-getAll parts 成功', r.status, 200);
  eq('db-getAll 解包为数组', Array.isArray(r.json.result), true);
  eq('先前建的备品可见', r.json.result.some((x) => x.id === partId), true);

  r = await invoke(port, token, 'db-get', { name: 'parts', id: partId });
  eq('db-get 读回备品', r.json.result.code, '1001');
  r = await invoke(port, token, 'db-count', 'parts');
  eq('db-count 标量 payload', r.json.result, 1);
  r = await invoke(port, token, 'db-getMeta', 'no-such-key');
  eq('db-getMeta 空键返回 null', r.json.result, null);
  r = await invoke(port, token, 'db-setMeta', { key: 'k1', value: 'v1' });
  eq('db-setMeta 成功', r.status, 200);
  r = await invoke(port, token, 'db-getMeta', 'k1');
  eq('db-getMeta 读回', r.json.result, 'v1');
  r = await invoke(port, token, 'db-getByIndex', { name: 'parts', index: 'code', value: '1001' });
  eq('db-getByIndex 命中', r.json.result.length, 1);
  r = await invoke(port, token, 'db-getByRange', { name: 'parts', index: 'stock', range: { min: 5, max: 20 } });
  eq('db-getByRange 命中', r.json.result.length, 1);

  /* ---- invoke：业务写入经 store 校验（口径与 exe 一致） ---- */
  r = await invoke(port, token, 'db-addPart', { code: '1002', name: '无效编号测试', stock: 1 });
  eq('合法备品建档成功', r.status, 200);
  const pid2 = r.json.result;
  ok('返回备品 id', !!pid2);
  r = await invoke(port, token, 'db-updatePart', { id: pid2, code: '1002', name: '改名后', stock: 5 });
  eq('更新备品成功', r.status, 200);
  r = await invoke(port, token, 'db-get', { name: 'parts', id: pid2 });
  eq('读回改名', r.json.result.name, '改名后');

  r = await invoke(port, token, 'db-addTransaction', { type: 'in', partId: partId, quantity: 3, operator: '张三', time: Date.now() });
  eq('流水写入成功', r.status, 200);
  r = await invoke(port, token, 'db-getAll', 'transactions');
  eq('流水可读回', r.json.result.length >= 1, true);

  /* ---- invoke：Electron 专属能力优雅降级 ---- */
  r = await invoke(port, token, 'print-labels', {});
  eq('打印返回 501 不支持', r.status, 501);
  ok('降级信息含提示', /不支持/.test(r.json.error));
  r = await invoke(port, token, 'sys-open-data-dir', null);
  eq('打开目录返回 501', r.status, 501);
  r = await invoke(port, token, 'sys-port-check', 8765);
  eq('端口检查返回 501', r.status, 501);

  /* ---- 未知通道明确拒绝 ---- */
  r = await invoke(port, token, 'no-such-channel', null);
  eq('未知通道被拒', r.status, 400);
  ok('未知通道有错误信息', /未知的数据通道/.test(r.json.error || ''));

  /* ---- 数据版本轮询：写操作后版本号递增 ---- */
  r = await request(port, 'GET', '/api/data-revision', null, token);
  const rev0 = r.json.revision;
  await invoke(port, token, 'db-setMeta', { key: 'revtest', value: Date.now() });
  r = await request(port, 'GET', '/api/data-revision', null, token);
  ok('写操作后数据版本递增', r.json.revision > rev0, rev0 + ' -> ' + r.json.revision);

  /* ---- 系统设置辅助端点 ---- */
  r = await request(port, 'GET', '/api/desktop-status', null, token);
  eq('desktop-status 可访问', r.status, 200);
  ok('返回局域网地址', Array.isArray(r.json.lan));
  eq('返回 desktopPin', r.json.desktopPin, '1234');
  r = await request(port, 'GET', '/api/sys-info', null, token);
  eq('sys-info 可访问', r.status, 200);
  eq('sys-info 标记为网页版', r.json.web, true);

  srv.stop();
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) { console.log(fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
