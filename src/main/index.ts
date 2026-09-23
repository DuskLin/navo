import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  powerSaveBlocker,
  powerMonitor,
  safeStorage,
  shell
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { isAbsolute, join } from 'node:path'
import { isTrustedRendererUrl } from './services/renderer-trust'
import { IPC } from '../shared/contracts'
import { SettingsStore, validateSettings } from './services/settings'
import { LaunchAtLogin } from './services/launch-at-login'
import { RequestSleepBlocker } from './services/request-sleep-blocker'
import { MacSleepProtection } from './services/mac-sleep'
import { GatewayStore, string } from './services/gateway-store'
import { Gateway } from './services/gateway'
import { metadataRequest } from './services/metadata-request'
import { kimiModelConfig } from './services/kimi-model-config'
import { UsageService } from './services/usage-service'
import { UpdateService } from './services/updates'
import { UnsignedMacUpdater } from './services/mac-updater'
import { createTray } from './tray'
import { DashboardServer } from './services/dashboard-server'
import { dashboardSource } from './services/dashboard-source'
import { startKimiQuotaExport } from './services/kimi-quota-export'
import { SessionMigrationService } from './services/session-migration-service'
import { KimiDesktopIntegration } from './services/kimi-desktop-integration'
import {
  APP_MANAGEMENT_URL,
  PERMISSION_HINT,
  withKimiPermissionGuide
} from './services/kimi-desktop-permission'
import kimiQuotaWidget from '../../scripts/kimi-quota/widget.js?raw'

// 源码运行不能改写安装版配置：新供应商和认证类型可能无法被旧安装版读取。
const appName = app.isPackaged ? 'Navo' : 'Navo Dev'
app.setName(appName)
app.setPath('userData', join(app.getPath('appData'), appName))
// 自动化验证使用临时目录，避免改变用户设置。
if (process.env.NAVO_TEST_USER_DATA) app.setPath('userData', process.env.NAVO_TEST_USER_DATA)
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
let gateway: Gateway | undefined
let requestSleepBlocker: RequestSleepBlocker | undefined
let macSleepProtection: MacSleepProtection | undefined
let stopSleepActivity: (() => void) | undefined
let stopPowerMonitoring: (() => void) | undefined
let dashboard: DashboardServer | undefined
let usageService: UsageService | undefined
let stopKimiQuotaExport: (() => void) | undefined
let kimiDesktop: KimiDesktopIntegration | undefined
let updates: UpdateService | undefined
let quitting = false
let tray: Electron.Tray | undefined
function showWindow(): void {
  if (quitting) return
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  } else if (tray) {
    createWindow()
  }
}
app.on('second-instance', showWindow)
// electron-updater closes windows before app.quit() on Windows.
nativeAutoUpdater.on('before-quit-for-update', () => {
  quitting = true
})
const rendererFile = join(__dirname, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
function isTrusted(url: string): boolean {
  return isTrustedRendererUrl(url, rendererFile, developmentUrl)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 440,
    title: 'Navo',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151719' : '#f8f9fa',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 22, y: 22 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once('ready-to-show', () => window.show())
  const publishVisibility = () => {
    if (!window.webContents.isDestroyed())
      window.webContents.send(IPC.windowVisibility, window.isVisible() && !window.isMinimized())
  }
  window.on('show', publishVisibility)
  window.on('hide', publishVisibility)
  window.on('minimize', publishVisibility)
  window.on('restore', publishVisibility)
  window.on('close', (event) => {
    if (quitting || !tray || tray.isDestroyed()) return
    event.preventDefault()
    window.hide()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrusted(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  const loading = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(rendererFile)
  void loading.catch((error) => console.error('窗口加载失败：', error))
}

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
    await settings.load()
    nativeTheme.themeSource = settings.get().theme
    const gatewayStore = new GatewayStore(join(app.getPath('userData'), 'gateway.json'), {
      encrypt: (value) => {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        )
          throw new Error('系统安全存储不可用，请解锁钥匙串或启用系统密钥环后重试')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
    })
    await gatewayStore.load()
    const service = new Gateway(gatewayStore, fetch, metadataRequest)
    macSleepProtection = process.platform === 'darwin' ? new MacSleepProtection() : undefined
    const requestPower = {
      start(type: 'prevent-app-suspension') {
        const id = powerSaveBlocker.start(type)
        try {
          macSleepProtection?.setWanted(true)
        } catch (error) {
          powerSaveBlocker.stop(id)
          throw error
        }
        return id
      },
      stop(id: number) {
        // Release the idle assertion even if communicating with the helper fails.
        const stopped = powerSaveBlocker.stop(id)
        macSleepProtection?.setWanted(false)
        return stopped
      }
    }
    requestSleepBlocker = macSleepProtection
      ? new RequestSleepBlocker(requestPower, {
          ...settings.get(),
          preventSleepDuringRequests: false
        })
      : undefined
    if (requestSleepBlocker) {
      const onBattery = () => requestSleepBlocker?.setOnBatteryPower(true)
      const onAC = () => requestSleepBlocker?.setOnBatteryPower(false)
      const refreshPower = () =>
        requestSleepBlocker?.setOnBatteryPower(powerMonitor.isOnBatteryPower())
      refreshPower()
      powerMonitor.on('on-battery', onBattery)
      powerMonitor.on('on-ac', onAC)
      powerMonitor.on('resume', refreshPower)
      stopPowerMonitoring = () => {
        powerMonitor.off('on-battery', onBattery)
        powerMonitor.off('on-ac', onAC)
        powerMonitor.off('resume', refreshPower)
      }
    }
    stopSleepActivity = service.onActiveRequestsChange((count) =>
      requestSleepBlocker?.setActiveRequests(count)
    )
    kimiDesktop = new KimiDesktopIntegration(app.getPath('userData'), kimiQuotaWidget)
    await kimiDesktop.load()
    kimiDesktop.start()
    stopKimiQuotaExport = startKimiQuotaExport(
      app.getPath('userData'),
      () => gatewayStore.get().accounts,
      () => kimiDesktop!.getState()
    )
    const statistics = new UsageService(gatewayStore.historyPath)
    usageService = statistics
    dashboard = new DashboardServer({
      file: join(app.getPath('userData'), 'dashboard.json'),
      assets: join(__dirname, '../mobile'),
      binary: app.isPackaged
        ? join(
            process.resourcesPath,
            'cloudflared',
            process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
          )
        : join(
            __dirname,
            '../../build/cloudflared',
            `${process.platform}-${process.arch}`,
            process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
          ),
      codec: {
        encrypt: (value) => {
          if (
            !safeStorage.isEncryptionAvailable() ||
            (process.platform === 'linux' &&
              safeStorage.getSelectedStorageBackend() === 'basic_text')
          )
            throw new Error('系统安全存储不可用')
          return safeStorage.encryptString(value).toString('base64')
        },
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
      },
      source: dashboardSource(service, statistics),
      publicRequest: (input, init) => net.fetch(input instanceof URL ? input.href : input, init)
    })
    await dashboard.load()
    await service.pricing.load()
    gateway = service
    const handle = (
      channel: string,
      callback: (value: unknown, event: Electron.IpcMainInvokeEvent) => unknown
    ): void => {
      ipcMain.handle(channel, (event, value: unknown) => {
        if (
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrusted(event.senderFrame.url)
        ) {
          throw new Error('不允许的调用来源')
        }
        return callback(value, event)
      })
    }
    let canInstall = app.isPackaged
    let updateReason = app.isPackaged ? '' : '开发模式不检查或安装更新。'
    if (app.isPackaged && process.platform === 'linux' && !process.env.APPIMAGE) {
      canInstall = false
      updateReason = '请运行 AppImage 安装包以使用自动安装。'
    }
    const updater = new UpdateService(
      process.platform === 'darwin' ? new UnsignedMacUpdater() : autoUpdater,
      { version: app.getVersion(), enabled: app.isPackaged, canInstall, reason: updateReason },
      async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: '重启并安装更新',
          message: '现在重启并安装新版本？',
          detail: '网关将暂时停止，正在处理的请求会被中断。账号和设置会保留。',
          buttons: ['重启安装', '稍后'],
          defaultId: 1,
          cancelId: 1
        })
        if (response !== 0) throw new Error('已取消安装，可稍后重试。')
        await service.shutdown()
      }
    )
    updates = updater
    handle(IPC.updateGet, () => updater.get())
    handle(IPC.updateCheck, () => {
      void updater.check()
    })
    handle(IPC.updateInstall, () => updater.install())
    handle(IPC.updateOpenRelease, () =>
      shell.openExternal('https://github.com/DuskLin/navo/releases/latest')
    )
    handle(IPC.appOpenIssues, () => shell.openExternal('https://github.com/DuskLin/navo/issues'))
    handle(IPC.appOpenProject, () => shell.openExternal('https://github.com/DuskLin/navo'))
    handle(IPC.appInfo, () => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron
    }))
    handle(IPC.settingsGet, () => settings.get())
    const launchAtLogin = new LaunchAtLogin(app)
    handle(IPC.launchAtLoginGet, () => launchAtLogin.get())
    handle(IPC.launchAtLoginSet, (enabled) => launchAtLogin.set(enabled as boolean))
    handle(IPC.sleepProtectionGet, () => ({
      ...(macSleepProtection?.snapshot() ?? {
        mode: 'idle',
        authorized: false,
        active: false,
        externallyDisabled: false,
        error: ''
      }),
      onBatteryPower: powerMonitor.isOnBatteryPower()
    }))
    handle(IPC.migrationChooseDirectory, async (currentPath) => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: '选择数据目录',
        buttonLabel: '选择文件夹',
        defaultPath:
          typeof currentPath === 'string' && isAbsolute(currentPath) ? currentPath : undefined,
        properties: ['openDirectory']
      }
      const result = await (parent
        ? dialog.showOpenDialog(parent, options)
        : dialog.showOpenDialog(options))
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
    const sessionMigration = new SessionMigrationService()
    for (const operation of ['scan', 'migrate'] as const) {
      handle(operation === 'scan' ? IPC.zcodeScan : IPC.zcodeMigrate, (value, event) =>
        sessionMigration.run(operation, value, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC.migrationProgress, progress)
        })
      )
    }
    handle(IPC.kimiDesktopGet, () => kimiDesktop!.check())
    const guideKimiPermission = async () => {
      const options: Electron.MessageBoxOptions = {
        type: 'info',
        title: '需要 App 管理权限',
        message: 'macOS 阻止了 Navo 修改 Kimi Code',
        detail: `此集成需要在 Kimi Code 中添加或移除额度展示文件。\n\n${PERMISSION_HINT}\n\n如果列表中没有 Navo，可点击“＋”添加 Navo.app。`,
        buttons: ['打开系统设置', '稍后'],
        defaultId: 0,
        cancelId: 1
      }
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const { response } = await (parent
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options))
      if (response === 0) {
        try {
          await shell.openExternal(APP_MANAGEMENT_URL)
        } catch {
          await dialog.showMessageBox({
            type: 'info',
            title: '请手动打开系统设置',
            message: '无法自动打开系统设置',
            detail: PERMISSION_HINT,
            buttons: ['知道了']
          })
        }
      }
    }
    handle(IPC.kimiDesktopSave, (value) =>
      withKimiPermissionGuide(
        () => kimiDesktop!.save(value),
        () => kimiDesktop!.check(),
        guideKimiPermission
      )
    )
    handle(IPC.kimiDesktopReapply, () =>
      withKimiPermissionGuide(
        () => kimiDesktop!.reapply(),
        () => kimiDesktop!.check(),
        guideKimiPermission
      )
    )
    handle(IPC.settingsSave, async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('设置格式无效')
      if (
        'preventSleepDuringRequests' in value &&
        value.preventSleepDuringRequests === true &&
        process.platform !== 'darwin'
      )
        throw new Error('请求期间阻止休眠仅支持 macOS')
      const next = validateSettings({ ...settings.get(), ...value })
      if (
        'preventSleepDuringRequests' in value &&
        value.preventSleepDuringRequests === true &&
        next.preventSleepDuringRequests
      ) {
        await macSleepProtection?.prepare()
      }
      const saved = await settings.save(value)
      nativeTheme.themeSource = saved.theme
      requestSleepBlocker?.configure({
        ...saved,
        preventSleepDuringRequests:
          saved.preventSleepDuringRequests && !!macSleepProtection?.snapshot().authorized
      })
      return saved
    })
    handle(IPC.windowVisibility, (_value, event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      return !!window && window.isVisible() && !window.isMinimized()
    })
    handle(IPC.gatewayGet, (version) =>
      service.snapshotUpdate(typeof version === 'number' ? version : undefined)
    )
    handle(IPC.dashboardGet, () => dashboard!.state())
    handle(IPC.dashboardSave, (value) => dashboard!.save(value))
    handle(IPC.dashboardRotate, () => dashboard!.rotate())
    handle(IPC.dashboardCopyCode, () => clipboard.writeText(dashboard!.accessCode()))
    handle(IPC.dashboardCopyUrl, (lanUrl) => {
      const state = dashboard!.state()
      if (lanUrl !== undefined) {
        if (typeof lanUrl !== 'string' || !state.lanUrls.includes(lanUrl)) {
          throw new Error('局域网地址已失效，请刷新后重试')
        }
        clipboard.writeText(lanUrl)
        return
      }
      if (!state.publicUrl) throw new Error('公网链接尚未生成')
      clipboard.writeText(state.publicUrl)
    })
    handle(IPC.dashboardCheckPublic, () => dashboard!.checkPublic())
    handle(IPC.dashboardOpen, () => shell.openExternal(dashboard!.state().localUrl))
    handle(IPC.requestHistory, (before) => service.history.page(before as number | undefined))
    handle(IPC.quotaCycles, (query) => service.history.getQuotaCycles(query))
    handle(IPC.quotaCycleExclude, (input) => {
      service.history.setQuotaCycleExcluded(input)
      return service.snapshotReady()
    })
    handle(IPC.usageStats, (query) => {
      const pricing = service.getRequestPricing()
      return statistics.usage(
        query as import('../shared/usage').UsageQuery,
        pricing.value,
        pricing.version
      )
    })
    handle(IPC.accountImportKimi, (region) => service.importKimiAccount(region))
    handle(IPC.accountImportCodex, () => service.importCodexAccount())
    handle(IPC.accountSave, (value) => service.saveAccount(value))
    handle(IPC.accountInspect, (value) => service.inspectAccount(value))
    handle(IPC.accountModelTest, (value) => service.testAccountModel(value))
    handle(IPC.accountRefresh, (value) => service.refreshAccount(value))
    handle(IPC.accountDelete, async (value) => {
      await gatewayStore.deleteAccount(value)
      service.scheduler.prune(gatewayStore.get().accounts)
      return service.snapshotReady()
    })
    handle(IPC.accountReset, (value) => {
      const id = string(value, '账号 ID')
      if (!gatewayStore.get().accounts.some((a) => a.id === id)) throw new Error('账号不存在')
      service.scheduler.reset(id)
      return service.snapshotReady()
    })
    handle(IPC.modelPriceRefresh, async (force) => {
      if (force !== undefined && typeof force !== 'boolean') throw new Error('刷新参数无效')
      await service.pricing.refresh(force as boolean | undefined)
      return service.snapshotReady()
    })
    handle(IPC.quotaCardOrderSave, async (value) => {
      await gatewayStore.saveQuotaCardOrder(value)
      return service.snapshotReady()
    })
    handle(IPC.modelPriceSave, async (value) => {
      await gatewayStore.saveModelPrice(value)
      return service.snapshotReady()
    })
    handle(IPC.gatewaySave, (value) => service.saveSettings(value))
    handle(IPC.gatewayRunning, (value) => service.setRunning(value))
    handle(IPC.connectionRotate, (value) => service.rotateKey(value))
    handle(IPC.connectionCopy, async (value) => {
      // 保存默认分组后再复制，避免尚未落盘的密钥在重启后变化。
      await gatewayStore.mutate(() => {})
      clipboard.writeText(service.connection(value))
    })
    handle(IPC.kimiModelConfigCopy, async (value) => {
      const model = string(value, '模型 ID')
      await service.pricing.refresh()
      clipboard.writeText(kimiModelConfig(model, service.snapshot()))
    })
    if (gatewayStore.get().settings.autoStart) {
      try {
        await service.setRunning(true)
      } catch {
        /* 启动错误在界面呈现，仍允许更换端口。 */
      }
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
      ])
    )
    tray = createTray(
      showWindow,
      (listener) => service.onActiveRequestsChange(listener),
      launchAtLogin
    )
    createWindow()
    if (macSleepProtection && settings.get().preventSleepDuringRequests) {
      void macSleepProtection
        .prepare()
        .then(() => {
          requestSleepBlocker?.configure(settings.get())
        })
        .catch((error) => console.warn('系统休眠控制尚未授权：', error))
    }
    updater.start()
    service.startAccountRefresh()
    app.on('activate', showWindow)
  })
  .catch((error) => {
    console.error('应用启动失败：', error)
    dialog.showErrorBox(
      'Navo 启动失败',
      error instanceof Error ? error.message : '无法读取本地配置'
    )
    app.quit()
  })

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  requestSleepBlocker?.dispose()
  if (!gateway && !macSleepProtection) return
  event.preventDefault()
  void Promise.allSettled([
    gateway?.shutdown(),
    dashboard?.close(),
    macSleepProtection?.close()
  ]).finally(() => {
    app.quit()
  })
})

// before-quit / will-quit 可被取消；仅在不可取消的实际退出事件关闭数据库。
app.on('quit', () => {
  stopSleepActivity?.()
  stopPowerMonitoring?.()
  requestSleepBlocker?.dispose()
  macSleepProtection?.invalidate()
  stopKimiQuotaExport?.()
  kimiDesktop?.close()
  dashboard?.tunnel.terminate()
  void usageService?.close()
  tray?.destroy()
  updates?.dispose()
  gateway?.history.close()
})

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') app.quit()
})
