'use strict';
/* ============================================================
 * main.js — Electron 主进程（v2.0）
 * 创建窗口、加载 index.html、注册 db-* IPC 交给 store.js 处理。
 * ============================================================ */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');

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
    title: '备件仓库管理系统 v2.33',
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
  /* 夹具管理 */
  'fixture-add': (e, fixture) => store.addFixture(fixture),
  'fixture-update': (e, fixture) => store.updateFixture(fixture),
  'fixture-del': (e, id) => store.delFixture(id),
  'fixture-getAll': () => store.getFixtures(),
  'fixture-addTransaction': (e, tx) => store.addFixTransaction(tx),
  'fixture-getTransactions': () => store.getFixTransactions(),
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

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
