import installWebPolicy from '../../install-web-v1.manifest.json'

interface DesktopWindowManifestPolicy {
  defaultWidth: number
  defaultHeight: number
  minimumWidth: number
  minimumHeight: number
  backgroundColor: string
  safeMargin: number
}

interface DesktopCompatibilityManifestPolicy {
  disableHardwareAccelerationWindowsReleasePrefixes: string[]
}

interface DesktopManifestPolicy {
  window?: DesktopWindowManifestPolicy
  compatibility?: DesktopCompatibilityManifestPolicy
}

export interface WindowWorkAreaSize {
  width: number
  height: number
}

export interface ResolvedMainWindowBounds {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export interface ResolvedMainWindowBrowserWindowOptions {
  useContentSize: boolean
}

const WINDOWS_DEFAULT_MAIN_WINDOW_HEIGHT = 660

const desktopPolicy = (installWebPolicy as { desktop?: DesktopManifestPolicy }).desktop

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(1, Math.round(parsed))
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.max(0, Math.round(parsed))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resolveDimension(options: {
  defaultValue: number
  minimumValue: number
  availableValue: number
  safeMargin: number
}): { initial: number; minimum: number } {
  const availableValue = Math.max(1, Math.round(options.availableValue))
  const minimumValue = Math.min(toPositiveInteger(options.minimumValue, 1), availableValue)
  const maxVisibleValue = Math.max(
    minimumValue,
    availableValue - Math.max(0, Math.round(options.safeMargin)) * 2
  )
  const initial = clamp(toPositiveInteger(options.defaultValue, minimumValue), minimumValue, maxVisibleValue)

  return {
    initial,
    minimum: minimumValue,
  }
}

const defaultWindowPolicy = desktopPolicy?.window || {
  defaultWidth: 800,
  defaultHeight: 630,
  minimumWidth: 640,
  minimumHeight: 480,
  backgroundColor: '#09090b',
  safeMargin: 32,
}

const defaultCompatibilityPolicy = desktopPolicy?.compatibility || {
  disableHardwareAccelerationWindowsReleasePrefixes: ['6.1'],
}

export const DESKTOP_WINDOW_POLICY = Object.freeze({
  defaultWidth: toPositiveInteger(defaultWindowPolicy.defaultWidth, 800),
  defaultHeight: toPositiveInteger(defaultWindowPolicy.defaultHeight, 630),
  minimumWidth: toPositiveInteger(defaultWindowPolicy.minimumWidth, 640),
  minimumHeight: toPositiveInteger(defaultWindowPolicy.minimumHeight, 480),
  backgroundColor: String(defaultWindowPolicy.backgroundColor || '#09090b').trim() || '#09090b',
  safeMargin: toNonNegativeInteger(defaultWindowPolicy.safeMargin, 32),
  disableHardwareAccelerationWindowsReleasePrefixes: (
    defaultCompatibilityPolicy.disableHardwareAccelerationWindowsReleasePrefixes || ['6.1']
  )
    .map((value) => String(value || '').trim())
    .filter(Boolean),
})

function resolveDefaultMainWindowHeight(platform?: string): number {
  if (platform === 'win32') return WINDOWS_DEFAULT_MAIN_WINDOW_HEIGHT
  return DESKTOP_WINDOW_POLICY.defaultHeight
}

export function resolveMainWindowBrowserWindowOptions(platform?: string): ResolvedMainWindowBrowserWindowOptions {
  return {
    useContentSize: platform === 'win32',
  }
}

export function shouldDisableHardwareAccelerationForPlatform(
  platform: string,
  release: string
): boolean {
  if (platform !== 'win32') return false
  const normalizedRelease = String(release || '').trim()
  if (!normalizedRelease) return false
  return DESKTOP_WINDOW_POLICY.disableHardwareAccelerationWindowsReleasePrefixes.some((prefix) =>
    normalizedRelease.startsWith(prefix)
  )
}

export function resolveMainWindowBounds(
  workArea?: Partial<WindowWorkAreaSize> | null,
  platform?: string
): ResolvedMainWindowBounds {
  const defaultHeight = resolveDefaultMainWindowHeight(platform)
  const availableWidth = toPositiveInteger(workArea?.width, DESKTOP_WINDOW_POLICY.defaultWidth)
  const availableHeight = toPositiveInteger(workArea?.height, defaultHeight)

  const width = resolveDimension({
    defaultValue: DESKTOP_WINDOW_POLICY.defaultWidth,
    minimumValue: DESKTOP_WINDOW_POLICY.minimumWidth,
    availableValue: availableWidth,
    safeMargin: DESKTOP_WINDOW_POLICY.safeMargin,
  })
  const height = resolveDimension({
    defaultValue: defaultHeight,
    minimumValue: DESKTOP_WINDOW_POLICY.minimumHeight,
    availableValue: availableHeight,
    safeMargin: DESKTOP_WINDOW_POLICY.safeMargin,
  })

  return {
    width: width.initial,
    height: height.initial,
    minWidth: width.minimum,
    minHeight: height.minimum,
  }
}
