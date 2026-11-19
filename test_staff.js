'use strict';
/* ============================================================
 * test_staff.js — 员工档案（工号 ↔ 姓名）纯逻辑测试
 * 覆盖：归一化、按工号/姓名查找、同名不猜、解析、展示串、
 *       工号占用判定、CSV 解析（表头/BOM/CRLF/Tab/引号/重复/空值）、CSV 生成。
 * 运行：node test_staff.js
 * ============================================================ */
const S = require('./js/staff-core');

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

const STAFFS = [
  { no: '10086', name: '张三' },
  { no: '10087', name: '李四' },
  { no: ' 10088 ', name: ' 王五 ' },
  { no: '20001', name: '张三' },   // 同名不同人
  { no: '', name: '无号员' }
];

/* ---------- 归一化 ---------- */
eq('工号归一化转大写去空格', S.normNo('  a b 1 '), 'AB1');
eq('工号归一化空值', S.normNo(null), '');

const clean = S.sanitize([{ no: ' 1 0 ', name: ' 甲 ' }, null, { no: '', name: '' }, {}, 'x']);
eq('清洗后条数', clean.length, 1);
eq('清洗去空格', clean[0].no, '10');
eq('清洗姓名 trim', clean[0].name, '甲');
eq('清洗非数组返回空', S.sanitize(null).length, 0);

/* ---------- 查找 ---------- */
eq('按工号精确命中', (S.findByNo(STAFFS, '10086') || {}).name, '张三');
eq('按工号忽略空格', (S.findByNo(STAFFS, ' 1 0086 ') || {}).name, '张三');
eq('按工号大小写不敏感', (S.findByNo([{ no: 'ab12', name: '赵六' }], 'AB12') || {}).name, '赵六');
eq('按工号未命中', S.findByNo(STAFFS, '99999'), null);
eq('按工号空查询', S.findByNo(STAFFS, ''), null);

/* 张三有两个工号 → 同名多人不猜，返回 null（绝不把记录记到错的人头上） */
eq('同名多人工号不明返回 null', S.findByName(STAFFS, '张三'), null);
eq('唯一姓名可命中', (S.findByName(STAFFS, '李四') || {}).name, '李四');
eq('唯一姓名返回工号', (S.findByName(STAFFS, '李四') || {}).no, '10087');
eq('姓名前后空格容错', (S.findByName(STAFFS, '  李四  ') || {}).no, '10087');
eq('姓名大小写不敏感', (S.findByName([{ no: '1', name: 'Tom' }], 'tom') || {}).no, '1');

/* ---------- 输入解析 ---------- */
let r = S.resolveOperator(STAFFS, '10086');
eq('输工号 → 姓名', r.name, '张三');
eq('输工号 → 工号', r.no, '10086');

r = S.resolveOperator(STAFFS, '李四');
eq('输姓名 → 工号补齐', r.no, '10087');
eq('输姓名 → 姓名保持', r.name, '李四');

r = S.resolveOperator(STAFFS, '张三');
eq('同名多人输姓名不加猜测', r.no, '');
eq('同名多人输姓名保留原值', r.name, '张三');

r = S.resolveOperator(STAFFS, '99999');
eq('未建档原样保留', r.name, '99999');
eq('未建档无工号', r.no, '');

r = S.resolveOperator(STAFFS, '   ');
eq('空输入返回空', r.name, '');

r = S.resolveOperator(STAFFS, '无号员');
eq('只有姓名无工号的档案', r.name, '无号员');
eq('只有姓名无工号 → no 空', r.no, '');

/* ---------- 展示串 ---------- */
eq('展示串含工号', S.opLabel({ operator: '张三', operatorNo: '10086' }), '张三(10086)');
eq('旧流水无工号', S.opLabel({ operator: '张三' }), '张三');
eq('工号空串按无处理', S.opLabel({ operator: '张三', operatorNo: '' }), '张三');
eq('只有工号', S.opLabel({ operator: '', operatorNo: '10086' }), '10086');
eq('空流水', S.opLabel(null), '');

/* ---------- 工号占用 ---------- */
ok('工号已被占用', S.noExists(STAFFS, '10086'));
ok('工号忽略空格占用', S.noExists(STAFFS, ' 1 0086 '));
ok('新工号可用', S.noExists(STAFFS, '30001') === false);
ok('编辑自己不算占用', S.noExists(STAFFS, '10086', '10086') === false);
ok('编辑改成别人的号仍算占用', S.noExists(STAFFS, '10087', '10086'));

/* ---------- CSV 解析 ---------- */
r = S.parseStaffCSV('工号,姓名\r\n10086,张三\r\n10087,李四');
eq('CSV 跳过表头', r.list.length, 2);
eq('CSV 首行工号', r.list[0].no, '10086');
eq('CSV 首行姓名', r.list[0].name, '张三');
eq('CSV 无跳过', r.skipped.length, 0);

r = S.parseStaffCSV('\uFEFF10086,张三\n10087,李四');
eq('CSV 去 BOM 且无表头', r.list.length, 2);
eq('CSV BOM 后工号干净', r.list[0].no, '10086');

r = S.parseStaffCSV('工号\t姓名\n10086\t张三');
eq('CSV 支持 Tab 分隔', r.list.length, 1);
eq('CSV Tab 第二列', r.list[0].name, '张三');

r = S.parseStaffCSV('工号，姓名\n10086，张三');
eq('CSV 支持中文逗号', r.list.length, 1);
eq('CSV 中文逗号姓名', r.list[0].name, '张三');

r = S.parseStaffCSV('工号,姓名\r\n10086,张三\r\n10086,李四\r\n,王五\r\n10087,');
eq('CSV 有效行数', r.list.length, 1);
eq('CSV 跳过行数', r.skipped.length, 3);
ok('CSV 跳过原因含重复', r.skipped.some((s) => /重复/.test(s.reason)), JSON.stringify(r.skipped));
ok('CSV 跳过原因含工号为空', r.skipped.some((s) => /工号为空/.test(s.reason)));
ok('CSV 跳过原因含姓名为空', r.skipped.some((s) => /姓名为空/.test(s.reason)));
eq('CSV 跳过的行号是原始行号', r.skipped[0].line, 3);

r = S.parseStaffCSV('"工号","姓名"\n"10086","张,三"');
eq('CSV 带引号姓名', r.list[0].name, '张,三');
eq('CSV 带引号表头被跳过', r.list.length, 1);

r = S.parseStaffCSV('员工号,人员\n10086,张三');
eq('CSV 别名表头被跳过', r.list.length, 1);

r = S.parseStaffCSV('');
eq('CSV 空文本无数据', r.list.length, 0);
r = S.parseStaffCSV(null);
eq('CSV null 不抛错', r.list.length, 0);

r = S.parseStaffCSV('\n\n10086,张三\n\n');
eq('CSV 忽略空行', r.list.length, 1);

/* ---------- CSV 生成 ---------- */
const csv = S.buildStaffCSV([{ no: '10086', name: '张三' }, { no: '1', name: '李,四' }]);
ok('CSV 带 BOM', csv.charCodeAt(0) === 0xFEFF);
ok('CSV 含表头', csv.indexOf('工号,姓名') === 1);
ok('CSV 使用 CRLF', csv.indexOf('\r\n') > 0);
ok('CSV 逗号姓名加引号', csv.indexOf('"李,四"') > 0);
ok('CSV 回读一致', S.parseStaffCSV(csv).list.length === 2);
eq('CSV 回读姓名', S.parseStaffCSV(csv).list[1].name, '李,四');

console.log('\n' + (fail === 0 ? '全部通过' : '存在失败') + '：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
