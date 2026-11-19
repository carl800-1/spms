'use strict';
/* ============================================================
 * preload.js — 渲染进程桥（v2.0）
 * 以 contextBridge 暴露 window.api，供 js/db.js 调用主进程 db-* IPC。
 * 渲染进程（app.js）始终通过 window.api，不直接接触 Node。
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: '3.0.4',
  // 统一单 payload 转发，db.js 以此调用主进程 store.js
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // 打印标签：opts = { pageSize, copies }，返回 { ok, reason? }
  printLabels: (opts) => ipcRenderer.invoke('print-labels', opts),
  // 库位盘点
  getLocationAudits: () => ipcRenderer.invoke('db-getLocationAudits'),
  saveLocationAudit: (audit) => ipcRenderer.invoke('db-saveLocationAudit', audit),
  // PDA 移动端
  mobileStatus: () => ipcRenderer.invoke('mobile-status'),
  mobileSetPin: (pin) => ipcRenderer.invoke('mobile-set-pin', pin),
  mobileRestart: (port) => ipcRenderer.invoke('mobile-restart', port),
  // 系统设置：本机信息（版本 / 数据目录）与打开数据目录
  sysInfo: () => ipcRenderer.invoke('sys-info'),
  openDataDir: () => ipcRenderer.invoke('sys-open-data-dir'),
  // PDA 端口防火墙：只读查询 + 提权放行（返回 { ok, allowed, error }）
  sysPortCheck: (port) => ipcRenderer.invoke('sys-port-check', port),
  sysOpenPort: (port) => ipcRenderer.invoke('sys-open-port', port),
  // 移动端提交数据后，主进程广播 → 桌面端刷新
  onDataChanged: (cb) => {
    const h = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('data-changed', h);
    return () => ipcRenderer.removeListener('data-changed', h);
  }
});
