'use strict';
/* 逻辑级验证：从 js/app.js 抽取「真实」renderLocation 源码驱动，断言十二列网格（三行可视）+ 垂直滚动、仅显示编号。对库位标签格式无关。 */
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');

// ---- 从 app.js 抽取 renderLocation 函数体（花括号配对；模板字符串插值 ${} 天然平衡）----
const startIdx = appJs.indexOf('function renderLocation()');
if (startIdx < 0) { console.error('未找到 renderLocation'); process.exit(2); }
let i = appJs.indexOf('{', startIdx), depth = 0, endIdx = -1;
for (; i < appJs.length; i++) {
  const c = appJs[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}
if (endIdx < 0) { console.error('renderLocation 未正常闭合'); process.exit(2); }
const fnText = appJs.slice(startIdx, endIdx);

// ---- 受控作用域：注入依赖 + 真实 renderLocation，导出 run / locSort ----
const harness = (function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function natCompare(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  }
  function locSort(keys) {
    const UNASSIGNED = '（未分配）';
    return keys.sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return natCompare(a, b);
    });
  }
  function stockStatus(p) {
    if (p.stock <= 0) return { cls: 'danger', text: '缺货' };
    if (p.safeStock > 0 && p.stock < p.safeStock) return { cls: 'warn', text: '预警' };
    return { cls: 'ok', text: '正常' };
  }
  const state = { parts: [], locFilter: '' };
  let captured = '';
  const $ = (sel) => ({ set innerHTML(v) { captured = v; } });
  global.document = { querySelector: () => null };
  function selectLocation(loc) { state.locFilter = loc; }
  function exportLocationCSV() { return true; }
  const renderLocation = eval('(' + fnText + ')'); // 定义真实 renderLocation（使用上方依赖，strict 下需以表达式返回）
  function run(parts, filter) {
    state.parts = parts; state.locFilter = filter || '';
    captured = '';
    renderLocation();
    return captured;
  }
  return { run, locSort };
})();

function cardNos(html) {
  const re = /<span class="loc-card-no">(.*?)<\/span>/g;
  const out = []; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

let fail = 0;
function assert(cond, msg) { if (!cond) { console.log('  ✗ ' + msg); fail++; } else { console.log('  ✓ ' + msg); } }

// CSS 侧断言（确保 10 列网格样式就位）
console.log('CSS 侧（库位十列网格）:');
assert(css.includes('.loc-grid10'), 'CSS 含 .loc-grid10 容器规则');
assert(css.includes('repeat(10, 1fr)'), 'CSS 网格为 10 列等宽（repeat(10, 1fr)）');
assert(css.includes('max-height'), 'CSS 容器限制最大高度（三行可视）');

// 数据集 A：真实发布数据（A1-03-02 等旧格式，对格式无关校验）
const realData = JSON.parse(fs.readFileSync('D:/project/release/备件仓库系统v2.30/spms-data.json', 'utf8'));
const A = harness.run(realData.parts, '');
const nosA = cardNos(A);
const uniqA = [...new Set(realData.parts.map((p) => (p.location || '（未分配）')))];
const expectedOrderA = harness.locSort(uniqA);
console.log('数据集 A（真实发布数据，' + uniqA.length + ' 个库位）:');
assert(A.includes('class="loc-split"'), '含上下分屏容器 loc-split');
assert(A.includes('class="loc-grid10"'), '含十列网格容器 loc-grid10');
assert(!A.includes('loc-grid3'), '旧三列网格容器 loc-grid3 已移除');
assert(!A.includes('loc-strip'), '旧横向滑动容器 loc-strip 已移除');
assert(!A.includes('loc-card-meta'), '卡片内已无件数/预警小数字（loc-card-meta 已移除）');
const cardCount = (A.match(/class="loc-card[ "]/g) || []).length;
assert(cardCount === uniqA.length, '卡片数 = 唯一库位数（' + uniqA.length + '）');
assert(nosA.length === uniqA.length, '卡片编号提取数正确（' + nosA.length + '）');
assert(JSON.stringify(nosA) === JSON.stringify(expectedOrderA), '卡片顺序与 locSort 一致（未分配置末）');
assert(A.includes('10 列网格') && A.includes('三行可视') && A.includes('上下滑动浏览'), '标题含「10 列网格」「三行可视」「上下滑动浏览」');
assert((A.match(/onclick="selectLocation\('([^']+)'\)"/g) || []).length === uniqA.length, '每个卡片均绑定 selectLocation(编号)');
assert(A.includes('全部备品（' + realData.parts.length + ' 项）'), '未筛选时下方标题显示全部备品项数');
assert((A.match(/<tr>/g) || []).length >= realData.parts.length, '下方列表渲染全部物品行');

// 数据集 B：边界（未分配 / 缺货预警 / 选中态），用短编号便于断言
const Bparts = [
  { id: 1, code: '1001', name: 'A', spec: '', category: '', unit: '个', location: '003', stock: 0, safeStock: 5 },
  { id: 2, code: '1002', name: 'B', spec: '', category: '', unit: '个', location: '001', stock: 10, safeStock: 0 },
  { id: 3, code: '1003', name: 'C', spec: '', category: '', unit: '个', location: '', stock: 3, safeStock: 0 },
  { id: 4, code: '1004', name: 'D', spec: '', category: '', unit: '个', location: '002', stock: 2, safeStock: 8 }
];
const B = harness.run(Bparts, '');
const nosB = cardNos(B);
console.log('数据集 B（边界情况）:');
assert(nosB.length === 4, '卡片数 = 4（实际 ' + nosB.length + '）');
assert(JSON.stringify(nosB) === JSON.stringify(['001', '002', '003', '（未分配）']), '顺序为 001,002,003,（未分配）末位');
assert(B.includes('unassigned') && B.includes('（未分配）'), '（未分配）卡片带 unassigned 样式');
assert(!B.includes('loc-card-count'), '卡片内无件数小数字');
assert(B.includes('库存预警'), '悬停提示仍含库存预警信息（title 中）');
assert(B.includes('<span class="loc-card-no">003</span>'), '003 卡片仅含编号、无件数子元素');

const B2 = harness.run(Bparts, '002');
const activeCount = (B2.match(/loc-card active/g) || []).length;
console.log('数据集 B2（选中 002）:');
assert(activeCount === 1, '选中时仅 1 张卡片高亮（实际 ' + activeCount + '）');
assert(B2.includes('当前库位：<b>002</b>'), '明细区显示「当前库位：002」');
assert(B2.includes('库位「002」下备品（1 项）'), '下方标题显示「库位「002」下备品（1 项）」');

console.log(fail === 0 ? '\n全部通过 ✅' : '\n失败 ' + fail + ' 项 ❌');
process.exit(fail === 0 ? 0 : 1);
