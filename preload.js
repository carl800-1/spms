'use strict';
/* ============================================================
 * preload.js — 渲染进程桥（v2.0）
 * 以 contextBridge 暴露 window.api，供 js/db.js 调用主进程 db-* IPC。
 * 渲染进程（app.js）始终通过 window.api，不直接接触 Node。
 * ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: '2.0',
  // 统一单 payload 转发，db.js 以此调用主进程 store.js
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // 打印标签：opts = { pageSize, copies }，返回 { ok, reason? }
  printLabels: (opts) => ipcRenderer.invoke('print-labels', opts),
  // 库位盘点
  getLocationAudits: () => ipcRenderer.invoke('db-getLocationAudits'),
  saveLocationAudit: (audit) => ipcRenderer.invoke('db-saveLocationAudit', audit),
  // 夹具管理
  fixtureAdd: (fixture) => ipcRenderer.invoke('fixture-add', fixture),
  fixtureUpdate: (fixture) => ipcRenderer.invoke('fixture-update', fixture),
  fixtureDel: (id) => ipcRenderer.invoke('fixture-del', id),
  fixtureGetAll: () => ipcRenderer.invoke('fixture-getAll'),
  fixtureAddTransaction: (tx) => ipcRenderer.invoke('fixture-addTransaction', tx),
  fixtureGetTransactions: () => ipcRenderer.invoke('fixture-getTransactions')
});
