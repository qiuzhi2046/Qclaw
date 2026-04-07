import type { BrowserWindow } from 'electron'
import { screen } from 'electron'
import { atomicWriteJson } from './atomic-write'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const { homedir } = os

export interface PersistedWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface WindowStateStoreV1 {
  version: 1
  bounds?: PersistedWindowBounds
  isMaximized?: boolean
}

export interface DefaultBoundsInput {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface ResolvedWindowState {
  bounds: PersistedWindowBounds
  isMaximized: boolean
}

const STORE_VERSION = 1
const STORE_RELATIVE_PATH = path.join('window', 'main-window-state.json')

function resolveUserDataDirectory(): string {
  return String(process.env.QCLAW_USER_DATA_DIR || path.join(homedir(), '.qclaw-lite')).trim()
}

function resolveStorePath(): string {
  return path.join(resolveUserDataDirectory(), STORE_RELATIVE_PATH)
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toOptionalInt(value: unknown): number | undefined {
  const n = toFiniteNumber(value)
  if (n === null) return undefined
  return Math.round(n)
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

function sanitizeBounds(value: unknown): PersistedWindowBounds | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const width = toOptionalInt(record.width)
  const height = toOptionalInt(record.height)
  if (!width || !height) return null
  if (width <= 0 || height <= 0) return null
  return {
    x: toOptionalInt(record.x),
    y: toOptionalInt(record.y),
    width,
    height,
  }
}

function isBoundsVisibleOnAnyDisplay(bounds: PersistedWindowBounds): boolean {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Math.max(1, Math.round(bounds.width))
  const height = Math.max(1, Math.round(bounds.height))
  const rect = { x, y, width, height }
  return screen.getAllDisplays().some((display) => {
    const work = display.workArea
    const overlapX = Math.max(0, Math.min(rect.x + rect.width, work.x + work.width) - Math.max(rect.x, work.x))
    const overlapY = Math.max(0, Math.min(rect.y + rect.height, work.y + work.height) - Math.max(rect.y, work.y))
    return overlapX > 32 && overlapY > 32
  })
}

function resolveBoundsWithinPrimaryWorkArea(
  persisted: PersistedWindowBounds,
  defaults: DefaultBoundsInput
): PersistedWindowBounds {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea
  const maxWidth = Math.max(defaults.minWidth, primaryWorkArea.width)
  const maxHeight = Math.max(defaults.minHeight, primaryWorkArea.height)
  const width = clampInt(persisted.width, defaults.minWidth, maxWidth)
  const height = clampInt(persisted.height, defaults.minHeight, maxHeight)

  const candidate: PersistedWindowBounds = { width, height }
  if (isBoundsVisibleOnAnyDisplay(persisted)) {
    candidate.x = toOptionalInt(persisted.x)
    candidate.y = toOptionalInt(persisted.y)
  }
  return candidate
}

function loadWindowStateRawSync(): WindowStateStoreV1 | null {
  try {
    const raw = fs.readFileSync(resolveStorePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<WindowStateStoreV1> & { version?: number }
    if (Number(parsed.version) !== STORE_VERSION) return null
    return parsed as WindowStateStoreV1
  } catch {
    return null
  }
}

export function loadMainWindowStateSync(defaults: DefaultBoundsInput): ResolvedWindowState {
  const raw = loadWindowStateRawSync()
  const bounds = sanitizeBounds(raw?.bounds) || { width: defaults.width, height: defaults.height }
  const resolvedBounds = resolveBoundsWithinPrimaryWorkArea(bounds, defaults)
  const isMaximized = raw?.isMaximized === true
  return { bounds: resolvedBounds, isMaximized }
}

export function attachMainWindowStatePersistence(win: BrowserWindow): () => void {
  let disposed = false
  let timer: NodeJS.Timeout | null = null
  let lastWritten: string | null = null

  const flush = async () => {
    if (disposed || win.isDestroyed()) return
    timer = null

    const isMaximized = win.isMaximized()
    const isFullScreen = win.isFullScreen()
    const bounds = (isMaximized || isFullScreen) ? win.getNormalBounds() : win.getBounds()

    const payload: WindowStateStoreV1 = {
      version: STORE_VERSION,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      isMaximized: isMaximized ? true : undefined,
    }

    const serialized = JSON.stringify(payload)
    if (serialized === lastWritten) return
    lastWritten = serialized

    try {
      await atomicWriteJson(resolveStorePath(), payload, { description: '主窗口大小与位置缓存' })
    } catch {
      // best-effort persistence only
    }
  }

  const schedule = () => {
    if (disposed || win.isDestroyed()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, 400)
  }

  const onClose = () => {
    if (disposed) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    void flush()
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', onClose)

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    win.removeListener('resize', schedule)
    win.removeListener('move', schedule)
    win.removeListener('close', onClose)
  }
}

