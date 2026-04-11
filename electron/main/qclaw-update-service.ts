import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import type {
  QClawUpdateActionResult,
  QClawUpdateErrorCode,
  QClawUpdateOpenDownloadResult,
  QClawUpdateStatus,
} from '../../src/shared/openclaw-phase4'
import { createRequire } from 'node:module'
import { runQClawUpdateInstall } from './qclaw-update-install-lifecycle'
import {
  type BuilderPublishConfig,
  type QClawUpdateConfigurationState,
  extractPublishUrlFromAppUpdateYaml,
  looksPlaceholderPublishUrl,
  resolveConfigurationStateFromBuilderConfig,
  resolveConfigurationStateFromPackagedYaml,
} from './qclaw-update-config'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, readFile } = fs.promises
const require = createRequire(import.meta.url)

interface ElectronAppLike {
  getAppPath: () => string
  getVersion: () => string
  isPackaged: boolean
}

interface ElectronShellLike {
  openExternal: (url: string) => Promise<void> | void
}

interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall?: boolean
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  getFeedURL: () => string
  on: (event: string, listener: (...args: any[]) => void) => void
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

let electronAppCache: ElectronAppLike | null = null
let electronShellCache: ElectronShellLike | null = null
let autoUpdaterCache: AutoUpdaterLike | null = null

function getElectronApp(): ElectronAppLike {
  if (electronAppCache) return electronAppCache
  const electronModule = require('electron') as { app: ElectronAppLike }
  electronAppCache = electronModule.app
  return electronAppCache
}

function getElectronShell(): ElectronShellLike {
  if (electronShellCache) return electronShellCache
  const electronModule = require('electron') as { shell: ElectronShellLike }
  electronShellCache = electronModule.shell
  return electronShellCache
}

function getAutoUpdater(): AutoUpdaterLike {
  if (autoUpdaterCache) return autoUpdaterCache
  const electronUpdaterModule = require('electron-updater') as { autoUpdater: AutoUpdaterLike }
  autoUpdaterCache = electronUpdaterModule.autoUpdater
  return autoUpdaterCache
}

function resolveCurrentAppVersion(): string {
  try {
    return String(getElectronApp().getVersion() || '').trim()
  } catch {
    return ''
  }
}

let listenersBound = false

let currentStatus: QClawUpdateStatus = {
  ok: true,
  supported: process.platform === 'darwin' || process.platform === 'win32',
  configured: false,
  currentVersion: resolveCurrentAppVersion(),
  availableVersion: null,
  status: 'disabled',
  progressPercent: null,
  downloaded: false,
  message: 'Qclaw 自动更新尚未启用。',
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}


function resolveFeedUrl(): string | undefined {
  try {
    const feedUrl = normalizeText(getAutoUpdater().getFeedURL())
    return feedUrl || undefined
  } catch {
    return undefined
  }
}

function normalizeReleaseNotes(releaseNotes: UpdateInfo['releaseNotes']): string | undefined {
  if (!releaseNotes) return undefined
  if (typeof releaseNotes === 'string') {
    const normalized = releaseNotes.trim()
    return normalized || undefined
  }

  if (!Array.isArray(releaseNotes)) return undefined

  const notes = releaseNotes
    .map((entry: any) => normalizeText(entry?.note || entry?.name || entry?.version))
    .filter(Boolean)
  if (notes.length === 0) return undefined
  return notes.join('\n\n')
}

function normalizeFileUrl(rawUrl: unknown): string {
  if (typeof rawUrl === 'string') return rawUrl.trim()
  if (rawUrl && typeof rawUrl === 'object' && 'href' in rawUrl) {
    const href = (rawUrl as { href?: unknown }).href
    return normalizeText(href)
  }
  return normalizeText(rawUrl)
}

function normalizeFeedBase(feedUrl?: string): string | undefined {
  const normalized = normalizeText(feedUrl)
  if (!normalized) return undefined
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

function toAbsoluteDownloadUrl(rawUrl: string, feedUrl?: string): string | undefined {
  const normalizedUrl = normalizeText(rawUrl)
  if (!normalizedUrl) return undefined

  try {
    const absoluteUrl = new URL(normalizedUrl)
    if (absoluteUrl.protocol !== 'https:' && absoluteUrl.protocol !== 'http:') return undefined
    return absoluteUrl.toString()
  } catch {
    const baseUrl = normalizeFeedBase(feedUrl)
    if (!baseUrl) return undefined
    try {
      const absoluteUrl = new URL(normalizedUrl, baseUrl)
      if (absoluteUrl.protocol !== 'https:' && absoluteUrl.protocol !== 'http:') return undefined
      return absoluteUrl.toString()
    } catch {
      return undefined
    }
  }
}

function collectCandidateDownloadUrls(info: UpdateInfo, feedUrl?: string): string[] {
  const set = new Set<string>()
  const add = (rawUrl: unknown) => {
    const absoluteUrl = toAbsoluteDownloadUrl(normalizeFileUrl(rawUrl), feedUrl)
    if (absoluteUrl) set.add(absoluteUrl)
  }

  const files = Array.isArray((info as any).files) ? ((info as any).files as any[]) : []
  for (const file of files) {
    add(file?.url)
    add(file?.path)
    add(file?.name)
  }

  add((info as any).path)
  add((info as any).url)

  return Array.from(set).filter((url) => !url.toLowerCase().endsWith('.blockmap'))
}

function selectManualDownloadUrl(info: UpdateInfo, feedUrl?: string): string | undefined {
  const candidates = collectCandidateDownloadUrls(info, feedUrl)
  if (candidates.length === 0) return undefined

  const lowerCandidates = candidates.map((url) => ({
    original: url,
    lower: url.toLowerCase(),
  }))

  const preferredExtensions =
    process.platform === 'darwin'
      ? ['.dmg', '.zip']
      : process.platform === 'win32'
      ? ['.exe', '.msi']
      : []

  for (const extension of preferredExtensions) {
    const match = lowerCandidates.find((candidate) => candidate.lower.endsWith(extension))
    if (match) return match.original
  }

  return candidates[0]
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function classifyUpdaterError(input: unknown): QClawUpdateErrorCode {
  const message = normalizeText(input instanceof Error ? input.message : input).toLowerCase()

  if (!message) return 'unknown'
  if (/enotfound|econnrefused|etimedout|network|dns|socket hang up|getaddrinfo/.test(message)) return 'network'
  if (/404|not found|latest\.yml|latest-mac\.yml|yaml|cannot parse|no published versions/.test(message)) {
    return 'metadata_missing'
  }
  if (/sha512|checksum|signature|code signature|verify/.test(message)) return 'signature_invalid'
  return 'unknown'
}

function explainUpdaterError(code: QClawUpdateErrorCode, fallback: string): string {
  if (code === 'network') return '无法连接更新服务器，请检查网络后重试。'
  if (code === 'metadata_missing') return '更新元数据不存在或配置不完整，请联系管理员检查发布目录。'
  if (code === 'signature_invalid') return '更新包签名或校验失败，已停止更新以保护本机安全。'
  return fallback
}

function cloneStatus(): QClawUpdateStatus {
  return {
    ...currentStatus,
    currentVersion: resolveCurrentAppVersion(),
    feedUrl: currentStatus.feedUrl || resolveFeedUrl(),
  }
}

function setStatus(patch: Partial<QClawUpdateStatus>): QClawUpdateStatus {
  const nextFeedUrl = patch.feedUrl !== undefined ? patch.feedUrl : currentStatus.feedUrl || resolveFeedUrl()
  currentStatus = {
    ...currentStatus,
    ...patch,
    currentVersion: resolveCurrentAppVersion(),
    feedUrl: nextFeedUrl,
  }
  return cloneStatus()
}

async function resolveUpdateConfigurationState(): Promise<QClawUpdateConfigurationState> {
  const supported = process.platform === 'darwin' || process.platform === 'win32'
  if (!supported) {
    return {
      supported: false,
      configured: false,
      message: '当前平台暂未接入 Qclaw 自动更新。',
    }
  }

  const app = getElectronApp()
  if (app.isPackaged) {
    const updateConfigPath = path.join(process.resourcesPath, 'app-update.yml')
    if (await pathExists(updateConfigPath)) {
      try {
        const rawConfig = await readFile(updateConfigPath, 'utf8')
        return resolveConfigurationStateFromPackagedYaml(rawConfig)
      } catch {
        return {
          supported: true,
          configured: false,
          message: 'app-update.yml 读取失败，Qclaw 自动更新当前不可用。',
        }
      }
    }

    return {
      supported: true,
      configured: false,
      message: '未检测到 app-update.yml，Qclaw 自动更新配置尚未补齐。',
    }
  }

  const appRoot = normalizeText(process.env.APP_ROOT || app.getAppPath())
  const builderConfigPath = appRoot ? path.join(appRoot, 'electron-builder.json') : ''
  if (!builderConfigPath || !(await pathExists(builderConfigPath))) {
    return {
      supported: true,
      configured: false,
      message: '当前为开发环境，Qclaw 自动更新需在打包产物中验证。',
    }
  }

  try {
    const raw = await readFile(builderConfigPath, 'utf8')
    const config = JSON.parse(raw) as BuilderPublishConfig
    return resolveConfigurationStateFromBuilderConfig(config)
  } catch {
    return {
      supported: true,
      configured: false,
      message: 'Qclaw 更新配置读取失败，当前不会执行自动更新。',
    }
  }
}

function bindUpdaterEvents() {
  if (listenersBound) return
  listenersBound = true

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  if (process.platform === 'win32') {
    autoUpdater.autoRunAppAfterInstall = true
  }

  autoUpdater.on('checking-for-update', () => {
    setStatus({
      ok: true,
      status: 'checking',
      progressPercent: null,
      error: undefined,
      errorCode: undefined,
      message: '正在检查 Qclaw 更新...',
    })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const feedUrl = resolveFeedUrl()
    setStatus({
      ok: true,
      status: 'available',
      availableVersion: normalizeText(info.version) || null,
      manualDownloadUrl: selectManualDownloadUrl(info, feedUrl),
      releaseDate: normalizeText(info.releaseDate) || undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      downloaded: false,
      progressPercent: null,
      error: undefined,
      errorCode: undefined,
      feedUrl,
      message: `检测到 Qclaw 新版本 ${info.version}。`,
    })
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({
      ok: true,
      status: 'unavailable',
      availableVersion: null,
      manualDownloadUrl: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      downloaded: false,
      progressPercent: null,
      error: undefined,
      errorCode: undefined,
      message: '当前 Qclaw 已是最新版本。',
    })
  })

  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    setStatus({
      ok: true,
      status: 'downloading',
      progressPercent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : null,
      error: undefined,
      errorCode: undefined,
      message: 'Qclaw Lite 更新包下载中...',
    })
  })

  autoUpdater.on('update-downloaded', (event: { version?: string }) => {
    setStatus({
      ok: true,
      status: 'downloaded',
      availableVersion: normalizeText(event.version) || currentStatus.availableVersion,
      downloaded: true,
      progressPercent: 100,
      error: undefined,
      errorCode: undefined,
      message: 'Qclaw Lite 更新包已下载完成，确认后可安装。',
    })
  })

  autoUpdater.on('error', (error: Error) => {
    const errorCode = classifyUpdaterError(error)
    setStatus({
      ok: false,
      status: 'error',
      progressPercent: null,
      error: error.message || 'unknown updater error',
      errorCode,
      message: explainUpdaterError(errorCode, error.message || 'Qclaw 更新失败。'),
    })
  })
}

async function ensureUpdaterAvailability(): Promise<QClawUpdateStatus> {
  const state = await resolveUpdateConfigurationState()
  bindUpdaterEvents()

  const errorCode: QClawUpdateErrorCode | undefined = !state.supported
    ? 'unsupported'
    : !state.configured
    ? 'not_configured'
    : currentStatus.errorCode

  const baseStatus = setStatus({
    ok: true,
    supported: state.supported,
    configured: state.configured,
    currentVersion: resolveCurrentAppVersion(),
    feedUrl: currentStatus.feedUrl || resolveFeedUrl(),
    status:
      !state.supported || !state.configured
        ? 'disabled'
        : currentStatus.status === 'disabled'
        ? 'idle'
        : currentStatus.status,
    message:
      !state.supported || !state.configured || currentStatus.status === 'disabled'
        ? state.message
        : currentStatus.message,
    error: !state.supported || !state.configured ? undefined : currentStatus.error,
    errorCode,
  })

  return baseStatus
}

export async function getQClawUpdateStatus(): Promise<QClawUpdateStatus> {
  return ensureUpdaterAvailability()
}

export async function checkQClawUpdate(): Promise<QClawUpdateStatus> {
  const baseStatus = await ensureUpdaterAvailability()
  if (!baseStatus.supported || !baseStatus.configured) {
    return baseStatus
  }

  try {
    await getAutoUpdater().checkForUpdates()
    return cloneStatus()
  } catch (error) {
    const errorCode = classifyUpdaterError(error)
    return setStatus({
      ok: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      message: explainUpdaterError(errorCode, '检查 Qclaw 更新失败。'),
      progressPercent: null,
    })
  }
}

export async function downloadQClawUpdate(): Promise<QClawUpdateActionResult> {
  const baseStatus = await ensureUpdaterAvailability()
  if (!baseStatus.supported || !baseStatus.configured) {
    return {
      ok: false,
      status: baseStatus,
      error: baseStatus.message,
      errorCode: baseStatus.errorCode,
      message: baseStatus.message,
    }
  }

  let status = cloneStatus()
  if (status.status !== 'available' && status.status !== 'downloaded' && !status.availableVersion) {
    status = await checkQClawUpdate()
  }

  if (status.status === 'downloaded') {
    return {
      ok: true,
      status,
      message: 'Qclaw Lite 更新包已经下载完成。',
    }
  }

  if (status.status !== 'available' || !status.availableVersion) {
    return {
      ok: false,
      status,
      errorCode: 'no_update',
      error: status.message || '当前没有可下载的更新。',
      message: status.message || '当前没有可下载的更新。',
    }
  }

  try {
    setStatus({
      ok: true,
      status: 'downloading',
      progressPercent: 0,
      error: undefined,
      errorCode: undefined,
      message: 'Qclaw Lite 更新包下载中...',
    })
    await getAutoUpdater().downloadUpdate()
    return {
      ok: true,
      status: cloneStatus(),
      message: cloneStatus().message || 'Qclaw Lite 更新包下载完成。',
    }
  } catch (error) {
    const errorCode = classifyUpdaterError(error)
    return {
      ok: false,
      status: setStatus({
        ok: false,
        status: 'error',
        progressPercent: null,
        error: error instanceof Error ? error.message : String(error),
        errorCode,
        message: explainUpdaterError(errorCode, 'Qclaw Lite 更新包下载失败。'),
      }),
      errorCode,
      error: error instanceof Error ? error.message : String(error),
      message: explainUpdaterError(errorCode, 'Qclaw Lite 更新包下载失败。'),
    }
  }
}

export async function installQClawUpdate(): Promise<QClawUpdateActionResult> {
  const baseStatus = await ensureUpdaterAvailability()
  if (!baseStatus.supported || !baseStatus.configured) {
    return {
      ok: false,
      status: baseStatus,
      errorCode: baseStatus.errorCode,
      error: baseStatus.message,
      message: baseStatus.message,
    }
  }

  if (!currentStatus.downloaded || currentStatus.status !== 'downloaded') {
    return {
      ok: false,
      status: cloneStatus(),
      errorCode: 'no_update',
      error: '当前还没有可安装的 Qclaw Lite 更新包。',
      message: '当前还没有可安装的 Qclaw Lite 更新包。',
    }
  }

  const status = setStatus({
    ok: true,
    status: 'installing',
    progressPercent: 100,
    message: 'Qclaw 即将退出并安装更新...',
    error: undefined,
    errorCode: undefined,
  })

  setImmediate(() => {
    runQClawUpdateInstall(getAutoUpdater(), process.platform)
  })

  return {
    ok: true,
    status,
    message: 'Qclaw 即将退出并安装更新。',
    willQuitAndInstall: true,
  }
}

export async function openQClawUpdateDownloadUrl(): Promise<QClawUpdateOpenDownloadResult> {
  const baseStatus = await ensureUpdaterAvailability()
  if (!baseStatus.supported || !baseStatus.configured) {
    return {
      ok: false,
      status: baseStatus,
      errorCode: baseStatus.errorCode,
      error: baseStatus.message,
      message: baseStatus.message,
    }
  }

  let status = cloneStatus()
  if (!status.manualDownloadUrl || !status.availableVersion) {
    status = await checkQClawUpdate()
  }

  const manualDownloadUrl = normalizeText(status.manualDownloadUrl)
  if (!manualDownloadUrl || !status.availableVersion) {
    return {
      ok: false,
      status,
      errorCode: 'no_update',
      error: '当前没有可下载的 Qclaw 新版本。',
      message: '当前没有可下载的 Qclaw 新版本。',
    }
  }

  if (!isAllowedExternalUrl(manualDownloadUrl)) {
    const nextStatus = setStatus({
      ok: false,
      status: 'error',
      errorCode: 'invalid_download_url',
      error: `invalid download url: ${manualDownloadUrl}`,
      message: '更新下载链接无效，请检查发布配置。',
    })
    return {
      ok: false,
      status: nextStatus,
      errorCode: 'invalid_download_url',
      error: `invalid download url: ${manualDownloadUrl}`,
      message: '更新下载链接无效，请检查发布配置。',
    }
  }

  try {
    await getElectronShell().openExternal(manualDownloadUrl)
    return {
      ok: true,
      status,
      openedUrl: manualDownloadUrl,
      message: '已在浏览器打开 Qclaw Lite 最新安装包下载链接。',
    }
  } catch (error) {
    const errorCode = classifyUpdaterError(error)
    const nextStatus = setStatus({
      ok: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      message: explainUpdaterError(errorCode, '打开下载链接失败。'),
    })
    return {
      ok: false,
      status: nextStatus,
      errorCode,
      error: error instanceof Error ? error.message : String(error),
      message: explainUpdaterError(errorCode, '打开下载链接失败。'),
    }
  }
}
