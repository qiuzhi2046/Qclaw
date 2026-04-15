const UPDATE_INSTALL_BYPASS_RESET_MS = 30_000

let qclawUpdateInstallBypassAppExitCleanup = false
let qclawUpdateInstallBypassResetTimer: NodeJS.Timeout | null = null

function clearQClawUpdateInstallBypassResetTimer(): void {
  if (!qclawUpdateInstallBypassResetTimer) return
  clearTimeout(qclawUpdateInstallBypassResetTimer)
  qclawUpdateInstallBypassResetTimer = null
}

function scheduleQClawUpdateInstallBypassReset(): void {
  clearQClawUpdateInstallBypassResetTimer()
  qclawUpdateInstallBypassResetTimer = setTimeout(() => {
    qclawUpdateInstallBypassAppExitCleanup = false
    qclawUpdateInstallBypassResetTimer = null
  }, UPDATE_INSTALL_BYPASS_RESET_MS)
  qclawUpdateInstallBypassResetTimer.unref?.()
}

function shouldBypassAppExitCleanupForUpdateInstall(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

export function markQClawUpdateInstallInProgress(platform: NodeJS.Platform = process.platform): void {
  qclawUpdateInstallBypassAppExitCleanup = shouldBypassAppExitCleanupForUpdateInstall(platform)
  if (qclawUpdateInstallBypassAppExitCleanup) {
    scheduleQClawUpdateInstallBypassReset()
    return
  }
  clearQClawUpdateInstallBypassResetTimer()
}

export function clearQClawUpdateInstallInProgress(): void {
  qclawUpdateInstallBypassAppExitCleanup = false
  clearQClawUpdateInstallBypassResetTimer()
}

export function shouldBypassAppExitCleanupOnQuit(): boolean {
  return qclawUpdateInstallBypassAppExitCleanup
}

export function runQClawUpdateInstall(
  updater: {
    autoRunAppAfterInstall?: boolean
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
  },
  platform: NodeJS.Platform = process.platform
): void {
  markQClawUpdateInstallInProgress(platform)

  try {
    if (platform === 'win32') {
      updater.autoRunAppAfterInstall = true
    }
    updater.quitAndInstall(false, platform === 'win32')
  } catch (error) {
    clearQClawUpdateInstallInProgress()
    throw error
  }
}
