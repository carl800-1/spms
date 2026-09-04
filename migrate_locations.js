'use strict';
/* 预迁移脚本：计算旧库位→新连续编号映射并生成报告，再调用 store.js 真实迁移落盘。
 * 映射算法与 store.js migrateLocations 完全一致：去重→自然序排序→零填充连续编号。 */
const fs = require('fs');

// 与 store.js 相同的自然排序
function natCompare(a, b) { return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }); }

const DATA_DIR = 'D:/project/release/备件仓库系统v2.27';
const FILE = DATA_DIR + '/spms-data.json';
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 计算映射（仅用于报告，store.js 会再次应用相同映射）
const set = new Set();
const locs = [];
(data.parts || []).forEach((p) => { const k = (p.location || '').trim(); if (k && !set.has(k)) { set.add(k); locs.push(k); } });
locs.sort(natCompare);
const width = Math.max(3, String(locs.length).length);
const map = {};
const counts = {};
(data.parts || []).forEach((p) => { const k = (p.location || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1; });
locs.forEach((old, i) => { map[old] = String(i + 1).padStart(width, '0'); });

// 写报告（CSV + 可读 MD）
const REPORT_DIR = 'C:/Users/Chenzhichao/WorkBuddy/2026-07-27-10-11-40/2.5';
const csv = ['新编号,原库位,备品件数'].concat(locs.map((o) => `${map[o]},${o},${counts[o] || 0}`)).join('\n');
fs.writeFileSync(REPORT_DIR + '/库位重编号映射表.csv', '\ufeff' + csv, 'utf8');
const md = ['# 库位重编号映射表（v2.28）', '', `> 共 ${locs.length} 个库位，按原编码自然序重排为连续编号 001–${String(locs.length).padStart(width,'0')}。`, '> 旧混杂编码（如 1-1-1 / 1-2-1上 / A1-02-03）已统一；旧货架标签需按本表重打。', '', '| 新编号 | 原库位 | 备品件数 |', '| --- | --- | --- |'].concat(locs.map((o) => `| ${map[o]} | ${o} | ${counts[o] || 0} |`)).join('\n');
fs.writeFileSync(REPORT_DIR + '/库位重编号映射表.md', md, 'utf8');
console.log('映射报告已生成，库位数 =', locs.length, '宽度 =', width);
console.log(csv.split('\n').slice(0, 6).join('\n'));

// 调用 store.js 真实迁移（幂等，已迁移则跳过；此处为首次，必执行）
const store = require('./store.js');
store.setDataDir(DATA_DIR);
store.open(); // 触发 migrateCodes + migrateLocations + save
console.log('store.js 迁移完成，文件已落盘');
