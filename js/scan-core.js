/* ============================================================
 * scan-core.js — 扫码解析 / 编号归一化 / 备件匹配（共享模块）
 *
 * 同一份实现被两侧复用，避免「桌面一套、移动端一套」规则漂移：
 *   - 渲染进程：index.html 以 <script> 引入 → window.ScanCore
 *   - 主进程  ：mobile-server.js 以 require('./js/scan-core') 引入
 *
 * 规则（与 v2.15 起的既有行为完全一致）：
 *   - 二维码内容前缀 SPMS1|（历史兼容 SPMS|）；
 *   - 编号匹配时忽略大小写与连字符/下划线/空格差异；
 *   - 建档保存仍用 parseQRToken 的原值（保留用户定义的连字符）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanCore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var QR_PREFIX = 'SPMS1|';

  function makeQRToken(code) { return QR_PREFIX + (code == null ? '' : String(code)); }

  /* 从任意来源（扫码枪键盘键入 / 摄像头扫码 / 手动输入）归一化为纯净备品编号 */
  function parseQRToken(str) {
    if (str == null) return '';
    str = String(str).trim();
    if (!str) return '';
    // 前缀比对不区分大小写：个别扫码枪 / 手动输入可能把 SPMS1| 打成小写
    if (str.slice(0, QR_PREFIX.length).toUpperCase() === QR_PREFIX) return str.slice(QR_PREFIX.length).trim();
    var m = /^SPMS\|(.+)$/i.exec(str);
    if (m) return m[1].trim();
    return str;
  }

  /* 用于「匹配 / 检索」的归一化：剥前缀 → 小写 → 去分隔符 */
  function normalizeCode(raw) {
    var s = parseQRToken(raw == null ? '' : String(raw));
    s = s.trim().toLowerCase();
    s = s.replace(/[\s\-_]+/g, '');
    return s;
  }

  /* 按编号精确匹配（忽略格式差异），返回备件对象或 null */
  function findPart(parts, code) {
    var target = normalizeCode(code);
    if (!target) return null;
    var list = parts || [];
    for (var i = 0; i < list.length; i++) {
      if (normalizeCode(list[i].code) === target) return list[i];
    }
    return null;
  }

  /* 多字段 AND 匹配：q = { code, name, spec, loc }，空字段不参与过滤 */
  function matchParts(parts, q) {
    q = q || {};
    var codeN = normalizeCode((q.code || '').trim());
    var name = String(q.name || '').trim().toLowerCase();
    var spec = String(q.spec || '').trim().toLowerCase();
    var loc = String(q.loc || '').trim();
    return (parts || []).filter(function (p) {
      if (codeN && normalizeCode(p.code) !== codeN) return false;
      if (name && String(p.name || '').toLowerCase().indexOf(name) < 0) return false;
      if (spec && String(p.spec || '').toLowerCase().indexOf(spec) < 0) return false;
      if (loc && (p.location || '') !== loc) return false;
      return true;
    });
  }

  return {
    QR_PREFIX: QR_PREFIX,
    makeQRToken: makeQRToken,
    parseQRToken: parseQRToken,
    normalizeCode: normalizeCode,
    findPart: findPart,
    matchParts: matchParts
  };
});
