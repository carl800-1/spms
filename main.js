'use strict';
/* ============================================================
 * main.js — Electron 主进程（v2.0）
 * 创建窗口、加载 index.html、注册 db-* IPC 交给 store.js 处理。
 * ============================================================ */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const store = require('./store');
const mobileServer = require('./mobile-server');
const PortCore = require('./js/port-core');

/* 数据文件存放位置：
 *  - 打包后的程序（portable / 解压目录）：放在「程序所在目录」下（spms-data.json），
 *    这样程序与数据库可整体复制/移动，不依赖任何绝对路径。
 *  - 开发态（electron .）：仍用 userData，避免污染项目目录。
 * 首次启动时自动把旧版存放在 userData/spms/spms-data.json 的数据迁移到新位置，避免数据丢失。 */
const exeDir = path.dirname(process.execPath);
const dataDir = app.isPackaged
  ? exeDir
  : path.join(app.getPath('userData'), 'spms');
const oldDataFile = path.join(app.getPath('userData'), 'spms', 'spms-data.json');
const newDataFile = path.join(dataDir, 'spms-data.json');
if (app.isPackaged && fs.existsSync(oldDataFile) && !fs.existsSync(newDataFile)) {
  try {
    fs.mkdirSync(path.dirname(newDataFile), { recursive: true });
    fs.copyFileSync(oldDataFile, newDataFile);
  } catch (e) { /* 迁移失败不影响启动，下次再尝试 */ }
}
store.setDataDir(dataDir);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: '备件仓库管理系统 v3.0.4',
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);
}

/* 只读查询端口是否已被防火墙入站规则放行（不需管理员权限）。
 * netsh show rule 找不到规则时退出码仍为 0，故用 PortCore.parseShowResult 解析文本。 */
function checkPortRuleSync(port) {
  const p = PortCore.normalizePort(port);
  let out = '';
  let code = -1;
  try {
    const r = execFileSync('netsh', PortCore.showArgs(p), {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    out = String(r || '');
    code = 0;
  } catch (err) {
    out = String((err && err.stdout) || '');
    code = (err && err.status) || -1;
  }
  return { port: p, rule: PortCore.ruleName(p), allowed: PortCore.parseShowResult(out, p), code: code, raw: out.slice(0, 800) };
}

const handlers = {
  'db-open': () => store.open(),
  'db-getAll': (e, name) => store.getAll(name),
  'db-get': (e, p) => store.get(p.name, p.id),
  'db-add': (e, p) => store.add(p.name, p.item),
  'db-put': (e, p) => store.put(p.name, p.item),
  'db-del': (e, p) => store.del(p.name, p.id),
  'db-clear': (e, name) => store.clear(name),
  'db-count': (e, name) => store.count(name),
  'db-getByIndex': (e, p) => store.getByIndex(p.name, p.index, p.value),
  'db-getByRange': (e, p) => store.getByRange(p.name, p.index, p.range),
  'db-addTransaction': (e, data) => store.addTransaction(data),
  'db-addPart': (e, part) => store.addPart(part),
  'db-updatePart': (e, part) => store.updatePart(part),
  'db-getMeta': (e, key) => store.getMeta(key),
  'db-setMeta': (e, p) => store.setMeta(p.key, p.value),
  'db-getLocationAudits': () => store.getLocationAudits(),
  'db-saveLocationAudit': (e, audit) => store.saveLocationAudit(audit),
  /* PDA 移动端：状态查询、修改 PIN、重启服务 */
  'mobile-status': () => mobileServer.status(),
  'mobile-set-pin': (e, pin) => {
    try { mobileServer.setPin(pin); return { ok: true, status: mobileServer.status() }; }
    catch (err) { return { ok: false, error: err.message, status: mobileServer.status() }; }
  },
  'mobile-restart': (e, port) => {
    mobileServer.restart(port);
    return { ok: true, status: mobileServer.status() };
  },
  /* 系统设置页：本机信息（版本 / 数据目录）+ 一键打开数据目录 */
  'sys-info': () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    dataDir: dataDir,
    dataFile: newDataFile,
    exists: fs.existsSync(newDataFile),
    size: (() => { try { return fs.statSync(newDataFile).size; } catch (e) { return 0; } })()
  }),
  'sys-open-data-dir': () => shell.openPath(dataDir),
  /* PDA 端口防火墙：只读查询当前端口是否已被入站规则放行（不需管理员权限）。 */
  'sys-port-check': (e, port) => checkPortRuleSync(port),
  /* PDA 端口防火墙放行：提权执行 netsh（UAC 弹窗由用户确认）。
   * 先删同名旧规则再建，保证幂等；完成后再只读复核一次，UAC 点「否」也能如实返回。 */
  'sys-open-port': (e, port) => new Promise((resolve) => {
    const p = PortCore.normalizePort(port);
    const rule = PortCore.ruleName(p);
    if (process.platform !== 'win32') {
      return resolve({ ok: false, allowed: false, port: p, rule: rule, error: '仅支持 Windows' });
    }
    // 生成临时 bat（规则名含空格，由 cmd 原生解析引号最稳），再用 PowerShell 提权执行
    const bat = path.join(os.tmpdir(), 'spms-open-port-' + process.pid + '-' + Date.now() + '.bat');
    const delLine = 'netsh ' + PortCore.cmdLine(PortCore.deleteArgs(p));
    const addLine = 'netsh ' + PortCore.cmdLine(PortCore.addArgs(p));
    const script = ['@echo off', delLine + ' >nul 2>&1', addLine + ' >nul 2>&1', 'exit /b 0'].join('\r\n');
    try { fs.writeFileSync(bat, script, 'utf8'); } catch (err) {
      return resolve({ ok: false, allowed: false, port: p, rule: rule, error: '写临时脚本失败：' + err.message });
    }
    // Start-Process -Verb RunAs 拉起 bat（UAC 由用户确认），-Wait 等它执行完再复核
    const psCmd = 'Start-Process -FilePath "' + bat + '" -Verb RunAs -Wait -WindowStyle Hidden';
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd],
      { windowsHide: true, timeout: 60000 },
      (err) => {
        try { fs.unlinkSync(bat); } catch (e2) { /* ignore */ }
        // 复核：只读查询是否真的放行（UAC 点「否」时规则不会出现）
        const check = checkPortRuleSync(p);
        resolve({
          ok: !!check.allowed,
          allowed: !!check.allowed,
          port: p,
          rule: rule,
          error: check.allowed ? '' : (err ? ('提权或执行失败：' + err.message) : 'UAC 已取消，或规则未生效')
        });
      });
  }),
  /* 打印标签：按传入的 pageSize（毫米换算的微米 / 标准尺寸名）与份数调用 Chromium 打印，
   * 由渲染进程设置 #printArea 的 CSS 变量控制对齐与边距，这里只负责把纸张规格交给打印引擎。 */
  'print-labels': (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return Promise.resolve({ ok: false, error: 'no-window' });
    return new Promise((resolve) => {
      try {
        win.webContents.print({
          silent: false,            // 弹出系统打印对话框，由用户选择打印机/确认
          printBackground: true,    // 打印标签边框与背景
          color: true,
          copies: (opts && opts.copies) || 1,
          pageSize: opts && opts.pageSize, // { width, height } 微米 或 'A4' 等标准名
          margins: { marginType: 'none' }  // 边距由渲染层 CSS 控制，避免双重计算
        }, (success, reason) => resolve({ ok: !!success, reason: reason || '' }));
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }
};
for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, fn);
}

app.whenReady().then(() => {
  createWindow();
  /* 移动端服务：让 PDA 浏览器经局域网直接办理出入库。
   * 与桌面窗口同在主进程，直接读写同一份 spms-data.json；移动端提交后广播刷新桌面。 */
  mobileServer.start({
    // 默认 8765；可用 SPMS_MOBILE_PORT 覆盖（多实例 / 自动化测试用，避免端口被占）
    port: Number(process.env.SPMS_MOBILE_PORT) || 8765,
    version: app.getVersion(),
    onChange: (info) => {
      if (!info || info.source !== 'mobile') return;
      BrowserWindow.getAllWindows().forEach((w) => {
        try { w.webContents.send('data-changed'); } catch (e) { /* 窗口已关闭 */ }
      });
    }
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
