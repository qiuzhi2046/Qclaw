import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { registerIpcHandlers } from './ipc-handlers'
import { runAppExitCleanup } from './app-exit-cleanup'
import { isAllowedExternalOpenUrl } from '../../src/shared/desktop-url-policy'
import {
  DESKTOP_WINDOW_POLICY,
  resolveMainWindowBounds,
  shouldDisableHardwareAccelerationForPlatform,
} from '../../src/shared/desktop-window-policy'
import { tryNormalizeProcessCwd } from './runtime-working-directory'
import { revealWindow, showOrCreateWindow } from './window-lifecycle'
import { reloadGatewayForConfigChange } from './gateway-lifecycle-controller'
import { sanitizeNodeOptionsForElectron } from './node-options'
import { attachMainWindowStatePersistence, loadMainWindowStateSync } from './window-state-store'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OPEN_CONTACT_MODAL_CHANNEL = 'app:open-contact-modal'
const OPEN_MODELS_PAGE_CHANNEL = 'app:open-models-page'

function sanitizeNodeOptionsForElectronRuntime(): void {
  const sanitized = sanitizeNodeOptionsForElectron(process.env.NODE_OPTIONS)
  if (sanitized) {
    process.env.NODE_OPTIONS = sanitized
  } else {
    delete process.env.NODE_OPTIONS
  }
}

sanitizeNodeOptionsForElectronRuntime()

process.env.APP_ROOT = path.join(__dirname, '../..')
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const IS_DEV = !!VITE_DEV_SERVER_URL || !app.isPackaged

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (shouldDisableHardwareAccelerationForPlatform(process.platform, os.release())) {
  app.disableHardwareAcceleration()
}
if (process.platform === 'win32') app.setAppUserModelId('com.qclawai.qclaw')
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let win: BrowserWindow | null = null
let tray: Tray | null = null
let appExitCleanupDone = false
let appExitCleanupPromise: Promise<void> | null = null
let isQuitting = false
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')
const focusApp = process.platform === 'darwin'
  ? (options: { steal: boolean }) => app.focus(options)
  : undefined
function resolveRuntimeAppIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(process.env.APP_ROOT!, 'src', 'assets', 'logo.png')
}

function loadRuntimeAppIcon() {
  const iconPath = resolveRuntimeAppIconPath()
  if (!existsSync(iconPath)) return null

  const icon = nativeImage.createFromPath(iconPath)
  return icon.isEmpty() ? null : icon
}

function createWindow() {
  process.env.QCLAW_USER_DATA_DIR = app.getPath('userData')
  process.env.QCLAW_SAFE_WORK_DIR = path.join(process.env.QCLAW_USER_DATA_DIR, 'runtime')
  tryNormalizeProcessCwd()

  const workAreaSize = screen.getPrimaryDisplay().workAreaSize
  const mainWindowBounds = resolveMainWindowBounds(workAreaSize)
  const persistedState = loadMainWindowStateSync({
    width: mainWindowBounds.width,
    height: mainWindowBounds.height,
    minWidth: mainWindowBounds.minWidth,
    minHeight: mainWindowBounds.minHeight,
  })

  const appIcon = process.platform === 'win32'
    ? path.join(process.env.VITE_PUBLIC!, 'favicon.ico')
    : path.join(process.env.VITE_PUBLIC!, 'tray@2x.png')

  if (process.platform === 'darwin') {
    const dockIcon = loadRuntimeAppIcon()
    if (dockIcon) {
      app.dock.setIcon(dockIcon)
    }
  }

  const browserWindow = new BrowserWindow({
    title: 'Qclaw',
    icon: appIcon,
    x: persistedState.bounds.x,
    y: persistedState.bounds.y,
    width: persistedState.bounds.width,
    height: persistedState.bounds.height,
    minWidth: mainWindowBounds.minWidth,
    minHeight: mainWindowBounds.minHeight,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor: DESKTOP_WINDOW_POLICY.backgroundColor,
    webPreferences: { preload },
  })
  win = browserWindow
  attachMainWindowStatePersistence(browserWindow)

  browserWindow.once('ready-to-show', () => {
    if (win !== browserWindow) return
    if (persistedState.isMaximized && !browserWindow.isDestroyed()) {
      browserWindow.maximize()
    }
    revealWindow(browserWindow, focusApp)
  })

  browserWindow.on('closed', () => {
    if (win === browserWindow) {
      win = null
    }
  })

  browserWindow.on('close', (event) => {
    if (isQuitting) return
    // macOS: standard behavior — hide to Dock
    // Windows: minimize to system tray instead of quitting
    event.preventDefault()
    browserWindow.hide()
  })

  if (VITE_DEV_SERVER_URL) {
    void browserWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    void browserWindow.loadFile(indexHtml)
  }

  if (IS_DEV) {
    browserWindow.webContents.openDevTools({ mode: 'detach' })
  }

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalOpenUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  return browserWindow
}

function showMainWindow() {
  const result = showOrCreateWindow({
    browserWindow: win,
    createWindow,
    focusApp,
  })
  win = result.window
}

function openContactModalWindow() {
  const result = showOrCreateWindow({
    browserWindow: win,
    createWindow,
    focusApp,
  })
  win = result.window

  const sendOpenContactModal = () => {
    if (result.window.isDestroyed()) return
    result.window.webContents.send(OPEN_CONTACT_MODAL_CHANNEL)
  }

  if (result.window.webContents.isLoadingMainFrame()) {
    result.window.webContents.once('did-finish-load', () => {
      setTimeout(sendOpenContactModal, 50)
    })
    return
  }

  sendOpenContactModal()
}

function openModelsPageWindow() {
  const result = showOrCreateWindow({
    browserWindow: win,
    createWindow,
    focusApp,
  })
  win = result.window

  const sendOpenModelsPage = () => {
    if (result.window.isDestroyed()) return
    result.window.webContents.send(OPEN_MODELS_PAGE_CHANNEL)
  }

  if (result.window.webContents.isLoadingMainFrame()) {
    result.window.webContents.once('did-finish-load', () => {
      setTimeout(sendOpenModelsPage, 50)
    })
    return
  }

  sendOpenModelsPage()
}

function showTrayNotification(options: { title: string; body: string }) {
  if (!Notification.isSupported()) return
  new Notification({
    title: options.title,
    body: options.body,
    silent: true,
  }).show()
}

async function restartGatewayFromTray() {
  showTrayNotification({
    title: 'Qclaw',
    body: '网关正在重启，请稍候...',
  })

  try {
    const result = await reloadGatewayForConfigChange('tray-manual-reload', {
      preferEnsureWhenNotRunning: true,
    })

    if (!result?.ok) {
      throw new Error(result?.stderr || result?.stdout || '网关重启失败')
    }

    showTrayNotification({
      title: 'Qclaw',
      body: '网关已重启完成',
    })
  } catch (error) {
    showTrayNotification({
      title: 'Qclaw',
      body: error instanceof Error ? error.message : '网关重启失败，请稍后重试',
    })
  }
}

function createTray() {
  const trayIconPath = path.join(process.env.VITE_PUBLIC!, 'tray.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  const resized = trayIcon.resize({ width: 32, height: 32 })
  tray = new Tray(resized)
  tray.setToolTip('Qclaw')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '配置模型',
      click: () => { openModelsPageWindow() },
    },
    { type: 'separator' },
    {
      label: '联系我们',
      click: () => { openContactModalWindow() },
    },
    {
      label: '重启网关',
      click: () => { void restartGatewayFromTray() },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    showMainWindow()
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  createTray()
})

app.on('window-all-closed', () => {
  win = null
  // Keep the app running in the system tray on all platforms
})

app.on('before-quit', (event) => {
  isQuitting = true
  if (appExitCleanupDone) return
  event.preventDefault()

  if (!appExitCleanupPromise) {
    appExitCleanupPromise = runAppExitCleanup()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        appExitCleanupDone = true
        appExitCleanupPromise = null
        app.quit()
      })
  }
})

app.on('second-instance', () => {
  showMainWindow()
})

app.on('activate', () => {
  showMainWindow()
})
