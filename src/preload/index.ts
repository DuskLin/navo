import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type HelperApi } from '../shared/contracts'

// 仅暴露白名单业务方法，不允许渲染进程任意调用 IPC。
const api: HelperApi = {
  onMigrationProgress: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: import('../shared/session-migration').MigrationProgress
    ) => listener(progress)
    ipcRenderer.on(IPC.migrationProgress, handler)
    return () => {
      ipcRenderer.removeListener(IPC.migrationProgress, handler)
    }
  },
  chooseMigrationDirectory: (path) => ipcRenderer.invoke(IPC.migrationChooseDirectory, path),
  scanZcodeSessions: (paths) => ipcRenderer.invoke(IPC.zcodeScan, paths),
  migrateZcodeSessions: (paths, sessions) =>
    ipcRenderer.invoke(IPC.zcodeMigrate, { paths, sessions }),
  getKimiDesktop: () => ipcRenderer.invoke(IPC.kimiDesktopGet),
  saveKimiDesktop: (value) => ipcRenderer.invoke(IPC.kimiDesktopSave, value),
  reapplyKimiDesktop: () => ipcRenderer.invoke(IPC.kimiDesktopReapply),
  getDashboard: () => ipcRenderer.invoke(IPC.dashboardGet),
  saveDashboard: (input) => ipcRenderer.invoke(IPC.dashboardSave, input),
  rotateDashboardCode: () => ipcRenderer.invoke(IPC.dashboardRotate),
  copyDashboardCode: () => ipcRenderer.invoke(IPC.dashboardCopyCode),
  copyDashboardUrl: (lanUrl) => ipcRenderer.invoke(IPC.dashboardCopyUrl, lanUrl),
  checkDashboardPublic: () => ipcRenderer.invoke(IPC.dashboardCheckPublic),
  openDashboard: () => ipcRenderer.invoke(IPC.dashboardOpen),
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGet),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  openReleasePage: () => ipcRenderer.invoke(IPC.updateOpenRelease),
  openIssuesPage: () => ipcRenderer.invoke(IPC.appOpenIssues),
  openProjectPage: () => ipcRenderer.invoke(IPC.appOpenProject),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  getGateway: () => ipcRenderer.invoke(IPC.gatewayGet),
  getRequestHistory: (before) => ipcRenderer.invoke(IPC.requestHistory, before),
  getQuotaCycles: (query) => ipcRenderer.invoke(IPC.quotaCycles, query),
  setQuotaCycleExcluded: (input) => ipcRenderer.invoke(IPC.quotaCycleExclude, input),
  getUsageStats: (query) => ipcRenderer.invoke(IPC.usageStats, query),
  importCodexAccount: () => ipcRenderer.invoke(IPC.accountImportCodex),
  saveAccount: (input) => ipcRenderer.invoke(IPC.accountSave, input),
  inspectAccount: (input) => ipcRenderer.invoke(IPC.accountInspect, input),
  testAccountModel: (input) => ipcRenderer.invoke(IPC.accountModelTest, input),
  refreshAccount: (id) => ipcRenderer.invoke(IPC.accountRefresh, id),
  deleteAccount: (id) => ipcRenderer.invoke(IPC.accountDelete, id),
  resetAccount: (id) => ipcRenderer.invoke(IPC.accountReset, id),
  refreshModelPrices: (force) => ipcRenderer.invoke(IPC.modelPriceRefresh, force),
  saveQuotaCardOrder: (ids) => ipcRenderer.invoke(IPC.quotaCardOrderSave, ids),
  saveModelPrice: (input) => ipcRenderer.invoke(IPC.modelPriceSave, input),
  saveGateway: (input) => ipcRenderer.invoke(IPC.gatewaySave, input),
  setGatewayRunning: (running) => ipcRenderer.invoke(IPC.gatewayRunning, running),
  rotateGatewayKey: (groupId) => ipcRenderer.invoke(IPC.connectionRotate, groupId),
  copyConnection: (input) => ipcRenderer.invoke(IPC.connectionCopy, input)
}
contextBridge.exposeInMainWorld('navo', api)
