/* ============================================================
 * port-core.js — PDA 端口防火墙放行的共享规则（UMD）
 * 主进程（main.js）用它构造 netsh 命令、解析 netsh 输出；
 * 与 open-pda-port.bat 保持同一规则名与端口语义。
 * 纯逻辑、零依赖，可由 test_port.js 在 node 下直接测试。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PortCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PORT = 8765;

  /* 规则名：端口变化时规则名也变，避免改端口后旧规则残留导致误判 */
  function ruleName(port) {
    return 'SPMS PDA ' + normalizePort(port);
  }

  /* 端口归一：非法值回落到默认端口 */
  function normalizePort(port) {
    var p = Number(port);
    return (isFinite(p) && p >= 1 && p <= 65535) ? Math.floor(p) : DEFAULT_PORT;
  }

  /* 添加入站放行规则的 netsh 参数数组。
   * profile=any：现场 Wi-Fi 常被识别为「公用网络」，只放行 private/domain 会导致 PDA 仍连不上。 */
  function addArgs(port) {
    var p = normalizePort(port);
    return ['advfirewall', 'firewall', 'add', 'rule',
      'name=' + ruleName(p), 'dir=in', 'action=allow',
      'protocol=TCP', 'localport=' + p, 'profile=any'];
  }

  /* 删除同名规则的 netsh 参数（幂等：先删后加） */
  function deleteArgs(port) {
    return ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + ruleName(normalizePort(port))];
  }

  /* 查询规则的 netsh 参数（只读，不需管理员权限） */
  function showArgs(port) {
    return ['advfirewall', 'firewall', 'show', 'rule', 'name=' + ruleName(normalizePort(port))];
  }

  /* 把 netsh 参数数组拼成命令行字符串（供 bat 使用）。
   * name=SPMS PDA 8765 这类含空格的值写成 name="SPMS PDA 8765"，否则 netsh 会把规则名截断。 */
  function cmdLine(args) {
    return (args || []).map(function (a) {
      var i = String(a).indexOf('=');
      if (i < 0) return /\s/.test(a) ? '"' + a + '"' : a;
      var key = a.slice(0, i + 1);
      var val = a.slice(i + 1);
      return key + (/\s/.test(val) ? '"' + val + '"' : val);
    }).join(' ');
  }

  /* 解析 netsh show rule 的输出：找到规则且为 allow 才判为已放行。
   * netsh 找不到规则时退出码仍为 0，输出含「没有匹配的规则」/「No rules match」等本地化文案，
   * 故不能只看退出码，要看是否含规则名 + action=allow。 */
  function parseShowResult(out, port) {
    var s = String(out || '');
    var name = ruleName(port);
    if (s.indexOf(name) < 0) return false;
    // 必须含 allow（netsh 输出本地化：「允许」/「Allow」）
    if (!/\ballow\b|允许/i.test(s)) return false;
    // 排除「已启用=否 / Enabled=No」的禁用规则
    if (/\benabled\s*[:=]?\s*no\b|已启用\s*[:=]?\s*否/i.test(s)) return false;
    return true;
  }

  return {
    DEFAULT_PORT: DEFAULT_PORT,
    ruleName: ruleName,
    normalizePort: normalizePort,
    addArgs: addArgs,
    deleteArgs: deleteArgs,
    showArgs: showArgs,
    cmdLine: cmdLine,
    parseShowResult: parseShowResult
  };
});
