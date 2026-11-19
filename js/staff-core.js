/* ============================================================
 * staff-core.js — 员工档案（工号 ↔ 姓名）解析与 CSV 读写（共享模块）
 *
 * 同一份规则被两侧复用，避免「桌面一套、移动端一套」漂移：
 *   - 渲染进程：index.html 以 <script> 引入 → window.StaffCore
 *   - 主进程  ：mobile-server.js 以 require('./js/staff-core') 引入
 *
 * 设计要点：
 *   - 档案存 meta.staffs = [{ no:'10086', name:'张三' }]，工号为唯一键；
 *   - 出入库的「经办人 / 领用人」允许直接输入工号，提交时解析为「姓名 + 工号」，
 *     流水主字段仍是姓名（向后兼容旧数据与既有报表），工号另存 operatorNo；
 *   - 姓名同名多人时不做猜测（返回 null，按原样当姓名处理），避免把记录记到错的人头上。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaffCore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* 工号归一化：去空白、转大写。比较用；展示用原始值（trim 后） */
  function normNo(v) {
    return String(v == null ? '' : v).trim().replace(/\s+/g, '').toUpperCase();
  }
  function normName(v) {
    return String(v == null ? '' : v).trim();
  }

  /* 清洗档案数组：丢空行、工号去空格。保留原工号大小写（展示友好） */
  function sanitize(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (!s) return;
      var no = String(s.no == null ? '' : s.no).trim().replace(/\s+/g, '');
      var name = normName(s.name);
      if (!no && !name) return;
      out.push({ no: no, name: name });
    });
    return out;
  }

  /* 按工号精确查找（忽略大小写与空格） */
  function findByNo(staffs, q) {
    var n = normNo(q);
    if (!n) return null;
    var list = sanitize(staffs);
    for (var i = 0; i < list.length; i++) {
      if (list[i].no && normNo(list[i].no) === n) return list[i];
    }
    return null;
  }

  /* 按姓名精确查找；同名多人返回 null（不猜） */
  function findByName(staffs, q) {
    var n = normName(q).toLowerCase();
    if (!n) return null;
    var list = sanitize(staffs);
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name && list[i].name.toLowerCase() === n) {
        if (hit && hit.no !== list[i].no) return null;
        hit = list[i];
      }
    }
    return hit;
  }

  /* 输入解析：工号 → {name, no}；姓名 → {name, no(若有档案)}；都不是 → {name: 原值, no: ''} */
  function resolveOperator(staffs, raw) {
    var v = normName(raw);
    if (!v) return { name: '', no: '' };
    var s = findByNo(staffs, v) || findByName(staffs, v);
    if (s && s.name) return { name: s.name, no: s.no || '' };
    /* 只有工号没录姓名：保留输入值当姓名，避免出现空经办人 */
    if (s && !s.name) return { name: v, no: s.no || '' };
    return { name: v, no: '' };
  }

  /* 流水的经办人展示串：张三(10086)；旧流水无 operatorNo 时只显示姓名 */
  function opLabel(tx) {
    if (!tx) return '';
    var name = normName(tx.operator);
    var no = normName(tx.operatorNo);
    if (!no) return name;
    if (!name) return no;
    return name + '(' + no + ')';
  }

  /* 工号是否已被别人占用（exceptNo 用于编辑时排除自己） */
  function noExists(staffs, no, exceptNo) {
    var n = normNo(no);
    if (!n) return false;
    var ex = normNo(exceptNo);
    var list = sanitize(staffs);
    for (var i = 0; i < list.length; i++) {
      if (!list[i].no) continue;
      var cur = normNo(list[i].no);
      if (cur !== n) continue;
      if (ex && cur === ex) continue;   // 编辑自己，跳过
      return true;
    }
    return false;
  }

  /* ---------------- CSV ----------------
   * 期望两列：工号,姓名（列顺序固定；首行含「工号」字样视为表头跳过）
   * 容忍：UTF-8 BOM / CRLF / Tab 或中文逗号分隔 / 单元格引号
   * 返回 { list:[{no,name}], skipped:[{line,text,reason}] }
   */
  function splitLine(line) {
    var s = String(line == null ? '' : line);
    var sep = s.indexOf('\t') >= 0 ? '\t' : (s.indexOf('，') >= 0 && s.indexOf(',') < 0 ? '，' : ',');
    var cells = [];
    var cur = '';
    var quote = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (quote) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i++; }
          else quote = false;
        } else cur += c;
      } else if (c === '"') quote = true;
      else if (c === sep) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map(function (x) { return String(x).trim(); });
  }

  function parseStaffCSV(text) {
    var list = [];
    var skipped = [];
    var seen = {};
    var raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    var lines = raw.split(/\r\n|\n|\r/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) continue;
      var cells = splitLine(line);
      var c0 = cells[0] || '';
      var c1 = cells[1] || '';
      /* 表头：首列含「工号」或「编号」，且第二列含「姓名」 */
      if (i === 0 && /工号|编号|员工号|ID/i.test(c0) && (/姓名|名字|人员/.test(c1) || !c1)) continue;
      if (!c0 && !c1) continue;
      if (!c0) { skipped.push({ line: i + 1, text: line, reason: '工号为空' }); continue; }
      if (!c1) { skipped.push({ line: i + 1, text: line, reason: '姓名为空' }); continue; }
      var key = normNo(c0);
      if (seen[key]) { skipped.push({ line: i + 1, text: line, reason: '工号重复（文件内）' }); continue; }
      seen[key] = true;
      list.push({ no: c0, name: c1 });
    }
    return { list: list, skipped: skipped };
  }

  function buildStaffCSV(staffs) {
    var list = sanitize(staffs);
    var lines = ['工号,姓名'];
    list.forEach(function (s) {
      lines.push([csvCell(s.no), csvCell(s.name)].join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  return {
    normNo: normNo,
    sanitize: sanitize,
    findByNo: findByNo,
    findByName: findByName,
    resolveOperator: resolveOperator,
    opLabel: opLabel,
    noExists: noExists,
    parseStaffCSV: parseStaffCSV,
    buildStaffCSV: buildStaffCSV
  };
});
