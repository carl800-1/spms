'use strict';
/* ============================================================
 * test_mobile_api.js — 移动端 HTTP 服务测试（纯 Node，无需 Electron）
 * 覆盖：静态页、鉴权、检索、出入库、库存不足、参数校验、最近记录、经办人。
 * 运行：node test_mobile_api.js
 * ============================================================ */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const store = require('./store');
const srv = require('./mobile-server');

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
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spms-mobile-test-'));
  store.setDataDir(tmp);
  store.open();

  store.addPart({ code: '1001', name: '深沟球轴承', spec: '6204-2RS', location: 'A1-03-02', category: '轴承', unit: '个', stock: 10, safeStock: 5 });
  store.addPart({ code: '1002', name: '内六角螺栓', spec: 'M8×30', location: 'B1-01-01', category: '紧固件', unit: '个', stock: 2, safeStock: 1 });

  const port = await new Promise((resolve) => {
    srv.start({ port: 0, version: '3.0.5', onListening: (st) => resolve(st.port) });
  });
  console.log('服务已启动，端口 ' + port);

  /* ---- 静态与连通 ---- */
  let r = await request(port, 'GET', '/api/ping');
  eq('ping 状态码', r.status, 200);
  eq('ping ok', r.json.ok, true);
  eq('ping 版本', r.json.version, '3.0.5');

  r = await request(port, 'GET', '/');
  eq('移动页状态码', r.status, 200);
  ok('移动页含标题', r.text.indexOf('备件仓库') >= 0);

  r = await request(port, 'GET', '/css/mobile.css');
  eq('移动端样式可访问', r.status, 200);

  r = await request(port, 'GET', '/js/app.js');
  // v3.0.5 起桌面前端脚本对电脑网页版开放（与 exe 共用同一套前端）
  eq('桌面脚本已对网页版开放', r.status, 200);
  r = await request(port, 'GET', '/js/desktop-api.js');
  eq('网页版 shim 可访问', r.status, 200);
  r = await request(port, 'GET', '/package.json');
  // 真正不在白名单内的文件仍应被拒
  eq('非白名单静态资源被拒', r.status, 404);

  /* ---- 鉴权 ---- */
  r = await request(port, 'GET', '/api/search?kw=1001');
  eq('无令牌被拒', r.status, 401);

  r = await request(port, 'POST', '/api/login', { pin: '0000' });
  eq('错误 PIN 被拒', r.status, 401);

  r = await request(port, 'POST', '/api/login', { pin: '1234' });
  eq('默认 PIN 登录成功', r.status, 200);
  const token = r.json.token;
  ok('返回令牌', !!token);

  r = await request(port, 'GET', '/api/search?kw=1001', null, token);
  eq('带令牌可检索', r.status, 200);

  /* ---- 检索 ---- */
  r = await request(port, 'GET', '/api/part?code=1001', null, token);
  eq('按编号精确匹配', r.json.part.code, '1001');

  r = await request(port, 'GET', '/api/part?code=' + encodeURIComponent('SPMS1|1001'), null, token);
  eq('兼容二维码前缀', r.json.part.code, '1001');

  r = await request(port, 'GET', '/api/search?kw=' + encodeURIComponent('轴承'), null, token);
  eq('按名称模糊检索', r.json.list.length, 1);

  r = await request(port, 'GET', '/api/search?kw=' + encodeURIComponent('A1-03-02'), null, token);
  eq('按库位检索', r.json.list[0].code, '1001');

  r = await request(port, 'GET', '/api/search?kw=' + encodeURIComponent('不存在的关键字'), null, token);
  eq('无结果返回空列表', r.json.list.length, 0);

  /* ---- 出库 ---- */
  r = await request(port, 'POST', '/api/tx', { type: 'out', code: '1001', quantity: 3, operator: '张三' }, token);
  eq('出库成功', r.status, 200);
  eq('出库后库存', r.json.part.stock, 7);

  r = await request(port, 'POST', '/api/tx', { type: 'out', code: '1002', quantity: 999, operator: '张三' }, token);
  eq('库存不足被拒', r.status, 409);
  ok('库存不足有提示', /库存不足/.test(r.json.error || ''));

  r = await request(port, 'GET', '/api/part?code=1002', null, token);
  eq('库存不足时库存未变', r.json.part.stock, 2);

  /* ---- 入库 ---- */
  r = await request(port, 'POST', '/api/tx', { type: 'in', code: '1001', quantity: 5, operator: '李四' }, token);
  eq('入库成功', r.status, 200);
  eq('入库后库存', r.json.part.stock, 12);

  /* ---- 参数校验 ---- */
  r = await request(port, 'POST', '/api/tx', { type: 'out', code: '9999', quantity: 1, operator: '张三' }, token);
  eq('不存在编号返回 404', r.status, 404);

  r = await request(port, 'POST', '/api/tx', { type: 'out', code: '1001', quantity: 0, operator: '张三' }, token);
  eq('数量为 0 被拒', r.status, 400);

  r = await request(port, 'POST', '/api/tx', { type: 'out', code: '1001', quantity: 1, operator: '' }, token);
  eq('缺经办人被拒', r.status, 400);

  r = await request(port, 'POST', '/api/tx', { type: 'bad', code: '1001', quantity: 1, operator: '张三' }, token);
  eq('非法类型被拒', r.status, 400);

  /* ---- 记录与名单 ---- */
  r = await request(port, 'GET', '/api/recent?limit=10', null, token);
  eq('最近记录条数', r.json.list.length, 2);
  eq('最近记录为入库（时间倒序）', r.json.list[0].type, 'in');

  r = await request(port, 'GET', '/api/operators', null, token);
  const ops = (r.json.list || []).slice().sort();
  eq('经办人名单', ops.join(','), ['张三', '李四'].sort().join(','));

  /* ---- 员工档案：经办人可直接传工号 ---- */
  store.setMeta('staffs', [{ no: '10086', name: '张三' }, { no: '10087', name: '李四' }]);

  r = await request(port, 'GET', '/api/staffs', null, token);
  eq('员工档案条数', (r.json.list || []).length, 2);

  r = await request(port, 'POST', '/api/tx', { type: 'in', code: '1001', quantity: 1, operator: '10086' }, token);
  eq('工号可提交', r.status, 200);
  eq('工号解析为姓名', r.json.operator, '张三');
  eq('响应回带工号', r.json.operatorNo, '10086');

  r = await request(port, 'POST', '/api/tx', { type: 'in', code: '1001', quantity: 1, operator: '李四' }, token);
  eq('姓名提交自动补工号', r.json.operatorNo, '10087');

  r = await request(port, 'POST', '/api/tx', { type: 'in', code: '1001', quantity: 1, operator: '99999' }, token);
  eq('未建档输入原样当姓名', r.json.operator, '99999');
  eq('未建档无工号', r.json.operatorNo, '');

  r = await request(port, 'GET', '/api/recent?limit=3', null, token);
  ok('最近记录带「姓名(工号)」展示串',
    r.json.list.some((t) => t.operatorLabel === '张三(10086)'),
    JSON.stringify(r.json.list.map((t) => t.operatorLabel)));

  const txWithNo = store.getAll('transactions').filter((t) => t.operatorNo === '10086');
  ok('流水已落盘 operatorNo', txWithNo.length >= 1 && txWithNo[0].operator === '张三',
    JSON.stringify(txWithNo.slice(0, 1)));

  /* ---- PIN 修改 ---- */
  srv.setPin('8888');
  r = await request(port, 'POST', '/api/login', { pin: '1234' });
  eq('旧 PIN 失效', r.status, 401);
  r = await request(port, 'POST', '/api/login', { pin: '8888' });
  eq('新 PIN 生效', r.status, 200);

  /* ---- 数据落盘一致性 ---- */
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'spms-data.json'), 'utf8'));
  eq('流水已落盘', saved.transactions.length, 5);
  const p1001 = saved.parts.find((p) => p.code === '1001');
  eq('库存已落盘', p1001.stock, 15);

  srv.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
