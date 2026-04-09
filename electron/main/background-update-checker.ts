/**
 * 后台定时轮询新版本检查器。
 *
 * 职责单一：按 interval + jitter 定时调用 checkUpdate，发现新版本时
 * 通过 onUpdateAvailable 回调通知外部（版本去重，同一版本只通知一次）。
 */

interface BackgroundUpdateCheckerDeps {
  checkUpdate: () => Promise<{ status: string; availableVersion: string | null }>
  onUpdateAvailable: (status: { status: string; availableVersion: string | null }) => void
  /** 基础轮询间隔，默认 12h */
  intervalMs?: number
  /** 随机抖动上限，默认 120min */
  jitterMs?: number
  /** 首次检查延迟，默认 5~15min 随机 */
  initialDelayMs?: number
}

const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000 // 12h
const DEFAULT_JITTER_MS = 120 * 60 * 1000 // 120min
const INITIAL_DELAY_MIN_MS = 5 * 60 * 1000 // 5min
const INITIAL_DELAY_MAX_MS = 15 * 60 * 1000 // 15min

export function startBackgroundUpdateChecker(
  deps: BackgroundUpdateCheckerDeps,
): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const jitterMs = deps.jitterMs ?? DEFAULT_JITTER_MS
  const initialDelayMs =
    deps.initialDelayMs ??
    INITIAL_DELAY_MIN_MS + Math.random() * (INITIAL_DELAY_MAX_MS - INITIAL_DELAY_MIN_MS)

  let lastNotifiedVersion: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function check(): Promise<void> {
    try {
      const status = await deps.checkUpdate()
      if (
        status.status === 'available' &&
        status.availableVersion &&
        status.availableVersion !== lastNotifiedVersion
      ) {
        lastNotifiedVersion = status.availableVersion
        deps.onUpdateAvailable(status)
      }
    } catch {
      // 后台检查不应崩溃，错误静默
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    const delay = intervalMs + Math.random() * jitterMs
    timer = setTimeout(async () => {
      await check()
      scheduleNext()
    }, delay)
  }

  // 首次检查在 initialDelayMs 后执行
  timer = setTimeout(async () => {
    await check()
    scheduleNext()
  }, initialDelayMs)

  return () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
