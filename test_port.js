'use strict';
/* ============================================================
 * test_port.js — PDA 端口防火墙放行的纯逻辑测试
 * 覆盖：规则名 / 端口归一 / netsh 命令构造（含空格规则名引号）/
 *       netsh show 输出解析（中英文 / 禁用规则 / 找不到规则）。
 * 运行：node test_port.js
 * 说明：只读逻辑测试，不触碰真实防火墙。
 * ============================================================ */
const P = require('./js/port-core');

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

/* ---------- 端口归一 ---------- */
eq('默认端口', P.DEFAULT_PORT, 8765);
eq('正常端口', P.normalizePort(9000), 9000);
eq('字符串端口', P.normalizePort('8766'), 8766);
eq('小数取整', P.normalizePort(8765.9), 8765);
eq('0 回落默认', P.normalizePort(0), 8765);
eq('负数回落默认', P.normalizePort(-1), 8765);
eq('超范围回落默认', P.normalizePort(70000), 8765);
eq('非数字回落默认', P.normalizePort('abc'), 8765);
eq('空值回落默认', P.normalizePort(null), 8765);

/* ---------- 规则名 ---------- */
eq('规则名默认端口', P.ruleName(), 'SPMS PDA 8765');
eq('规则名自定义端口', P.ruleName(9000), 'SPMS PDA 9000');
eq('规则名随端口变化', P.ruleName(8765) === P.ruleName(8766), false);

/* ---------- netsh 命令构造 ---------- */
const add = P.addArgs(8765);
eq('add 命令动词', add.slice(0, 4).join(' '), 'advfirewall firewall add rule');
ok('add 含规则名', add.indexOf('name=SPMS PDA 8765') >= 0, JSON.stringify(add));
ok('add 含 dir=in', add.indexOf('dir=in') >= 0);
ok('add 含 action=allow', add.indexOf('action=allow') >= 0);
ok('add 含 protocol=TCP', add.indexOf('protocol=TCP') >= 0);
ok('add 含 localport', add.indexOf('localport=8765') >= 0);
ok('add 含 profile=any（公用网络也要放行）', add.indexOf('profile=any') >= 0, JSON.stringify(add));

const del = P.deleteArgs(8765);
eq('delete 命令动词', del.slice(0, 4).join(' '), 'advfirewall firewall delete rule');
ok('delete 含同名规则', del.indexOf('name=SPMS PDA 8765') >= 0);

const show = P.showArgs(9000);
eq('show 命令动词', show.slice(0, 4).join(' '), 'advfirewall firewall show rule');
ok('show 用自定义端口规则名', show.indexOf('name=SPMS PDA 9000') >= 0);

/* ---------- 命令行拼装（规则名含空格必须加引号） ---------- */
const addCmd = P.cmdLine(add);
ok('cmdLine 规则名带引号', addCmd.indexOf('name="SPMS PDA 8765"') >= 0, addCmd);
ok('cmdLine profile 无多余引号', addCmd.indexOf('profile=any') >= 0, addCmd);
ok('cmdLine 其余参数正确', /dir=in action=allow protocol=TCP localport=8765/.test(addCmd), addCmd);
eq('cmdLine 普通参数不转义', P.cmdLine(['advfirewall', 'firewall']), 'advfirewall firewall');

/* ---------- show 输出解析 ---------- */
const winCN = [
  '规则名称:                             SPMS PDA 8765',
  '---------------------------------------------------------------------------',
  '已启用:                               是',
  '方向:                                 入',
  '操作:                                 允许',
  '协议:                                 TCP',
  '本地端口:                             8765'
].join('\n');
ok('中文输出-已放行', P.parseShowResult(winCN, 8765) === true);

const winEN = [
  'Rule Name:                            SPMS PDA 9000',
  'Enabled:                              Yes',
  'Direction:                            In',
  'Action:                               Allow',
  'Protocol:                             TCP'
].join('\n');
ok('英文输出-已放行', P.parseShowResult(winEN, 9000) === true);

const notFound = '没有匹配的规则。\r\n';
ok('找不到规则-未放行', P.parseShowResult(notFound, 8765) === false);
ok('空输出-未放行', P.parseShowResult('', 8765) === false);
ok('异端口规则不算放行', P.parseShowResult(winCN, 9999) === false);

const blocked = winCN.replace('操作:                                 允许', '操作:                                 阻止');
ok('动作为阻止-未放行', P.parseShowResult(blocked, 8765) === false);

const disabled = winCN.replace('已启用:                               是', '已启用:                               否');
ok('规则被禁用-未放行', P.parseShowResult(disabled, 8765) === false);

const blockCN = winCN.replace('操作:                                 允许', '操作:                                 阻止');
ok('中文阻止-未放行', P.parseShowResult(blockCN, 8765) === false);

console.log('\n全部通过：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
