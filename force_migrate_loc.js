'use strict';
/* 强制重迁移：忽略 meta.locRenumberV1 标记，按当前库位重新映射为连续编号 001..N。
 * 用于修复 v2.28 发布时误写入的旧格式数据（flag 被错误置位导致 store.js 跳过迁移）。
 * 用法：node force_migrate_loc.js <数据文件绝对路径> */
const fs = require('fs');
const path = require('path');
const target = process.argv[2];
if (!target) { console.error('用法: node force_migrate_loc.js <spms-data.json 路径>'); process.exit(1); }

function natCompare(a, b) { return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }); }

const FILE = path.resolve(target);
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const parts = data.parts || [];

const set = new Set();
const locs = [];
parts.forEach((p) => { const k = (p.location || '').trim(); if (k && !set.has(k)) { set.add(k); locs.push(k); } });
locs.sort(natCompare);
const width = Math.max(3, String(locs.length).length);
const map = {};
locs.forEach((old, i) => { map[old] = String(i + 1).padStart(width, '0'); });

let changed = 0;
parts.forEach((p) => {
  const k = (p.location || '').trim();
  if (k && map[k] && map[k] !== k) { p.location = map[k]; changed++; }
});
data.meta = data.meta || {};
data.meta.locRenumberV1 = true;

fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
console.log(`已强制重映射 ${changed} 条备品的库位 → 连续编号 001..${String(locs.length).padStart(width,'0')}；flag 置位。文件: ${FILE}`);
