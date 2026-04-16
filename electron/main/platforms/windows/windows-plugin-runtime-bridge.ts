import type { WindowsActiveRuntimeSnapshot } from './windows-runtime-policy'
import { getSelectedWindowsActiveRuntimeSnapshot } from '../../windows-active-runtime'
import {
  PINNED_OPENCLAW_VERSION,
  normalizeOpenClawPolicyVersion,
} from '../../../../src/shared/openclaw-version-policy'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { lstat, mkdir, readFile, realpath, rm, symlink } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

export type WindowsPluginHostRuntimeBridgeCaller = 'startup' | 'channel-preflight'
export type WindowsPluginHostRuntimeBridgeFailureKind =
  | 'non_windows_platform'
  | 'missing_home_dir'
  | 'missing_active_runtime'
  | 'invalid_host_package'
  | 'version_mismatch'
  | 'bridge_path_outside_home'
  | 'unsafe_existing_bridge_path'

export interface WindowsPluginHostRuntimeBridgeOptions {
  caller?: WindowsPluginHostRuntimeBridgeCaller
  homeDir: string
  hostOpenClawPackageRoot?: string
  platform?: NodeJS.Platform
  resolveHostOpenClawPackageRoot?: () => Promise<string | null>
}

export interface WindowsPluginHostRuntimeBridgeResult {
  ok: boolean
  bridgePath: string
  created: boolean
  diagnosticSeverity: 'none' | 'warning' | 'error'
  failureKind?: WindowsPluginHostRuntimeBridgeFailureKind
  message?: string
  packageVersion: string | null
  targetPath: string | null
}

interface OpenClawPackageRootInfo {
  path: string
  version: string | null
}

function getDiagnosticSeverity(
  ok: boolean,
  caller: WindowsPluginHostRuntimeBridgeCaller | null | undefined
): WindowsPluginHostRuntimeBridgeResult['diagnosticSeverity'] {
  if (ok) return 'none'
  return caller === 'channel-preflight' ? 'error' : 'warning'
}

function createBridgeResult(params: {
  bridgePath: string
  caller?: WindowsPluginHostRuntimeBridgeCaller
  created?: boolean
  failureKind?: WindowsPluginHostRuntimeBridgeFailureKind
  message?: string
  ok: boolean
  packageVersion?: string | null
  targetPath?: string | null
}): WindowsPluginHostRuntimeBridgeResult {
  return {
    ok: params.ok,
    bridgePath: params.bridgePath,
    created: params.created === true,
    diagnosticSeverity: getDiagnosticSeverity(params.ok, params.caller),
    ...(params.failureKind ? { failureKind: params.failureKind } : {}),
    ...(params.message ? { message: params.message } : {}),
    packageVersion: params.packageVersion ?? null,
    targetPath: params.targetPath ?? null,
  }
}

function normalizeComparablePath(value: string): string {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase()
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeComparablePath(candidatePath)
  const root = normalizeComparablePath(rootPath)
  return candidate === root || candidate.startsWith(`${root}${path.sep.toLowerCase()}`)
}

export async function ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
  options: {
    caller?: WindowsPluginHostRuntimeBridgeCaller
    platform?: NodeJS.Platform
  } = {}
): Promise<WindowsPluginHostRuntimeBridgeResult> {
  const activeSnapshot = snapshot || getSelectedWindowsActiveRuntimeSnapshot()
  const stateDir = String(activeSnapshot?.stateDir || '').trim()

  if (!activeSnapshot || !stateDir) {
    return createBridgeResult({
      ok: false,
      bridgePath: path.join(stateDir || '.', 'node_modules', 'openclaw'),
      caller: options.caller,
      failureKind: activeSnapshot ? 'missing_home_dir' : 'missing_active_runtime',
      message: activeSnapshot ? 'Windows OpenClaw stateDir is missing.' : 'Windows active runtime snapshot is missing.',
    })
  }

  return ensureWindowsPluginHostRuntimeBridge({
    caller: options.caller,
    homeDir: stateDir,
    hostOpenClawPackageRoot: activeSnapshot.hostPackageRoot,
    platform: options.platform,
  })
}

async function readOpenClawPackageRootInfo(candidatePath: string): Promise<OpenClawPackageRootInfo | null> {
  const packageJsonPath = path.join(candidatePath, 'package.json')
  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { name?: string; version?: string }
    if (parsed.name !== 'openclaw') return null
    return {
      path: candidatePath,
      version: normalizeOpenClawPolicyVersion(parsed.version) || null,
    }
  } catch {
    return null
  }
}

async function resolveHostOpenClawPackageRoot(
  options: WindowsPluginHostRuntimeBridgeOptions
): Promise<OpenClawPackageRootInfo | null> {
  const explicitPath = String(options.hostOpenClawPackageRoot || '').trim()
  if (explicitPath) {
    return readOpenClawPackageRootInfo(explicitPath)
  }

  const resolvedPath = await options.resolveHostOpenClawPackageRoot?.().catch(() => null)
  if (resolvedPath) {
    const packageInfo = await readOpenClawPackageRootInfo(resolvedPath)
    if (packageInfo) return packageInfo
  }

  const selectedSnapshotPackageRoot = String(
    getSelectedWindowsActiveRuntimeSnapshot()?.hostPackageRoot || ''
  ).trim()
  if (selectedSnapshotPackageRoot) {
    return readOpenClawPackageRootInfo(selectedSnapshotPackageRoot)
  }

  return null
}

async function canReplaceExistingBridgePath(bridgePath: string): Promise<boolean> {
  try {
    const stats = await lstat(bridgePath)
    return stats.isSymbolicLink()
  } catch {
    return true
  }
}

export async function ensureWindowsPluginHostRuntimeBridge(
  options: WindowsPluginHostRuntimeBridgeOptions
): Promise<WindowsPluginHostRuntimeBridgeResult> {
  const homeDir = String(options.homeDir || '').trim()
  const bridgePath = path.join(homeDir, 'node_modules', 'openclaw')
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'non_windows_platform',
      message: 'Windows plugin runtime bridge is only available on win32.',
    })
  }

  if (!homeDir) {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'missing_home_dir',
      message: 'Windows OpenClaw homeDir is missing.',
    })
  }

  if (!isPathWithinRoot(bridgePath, homeDir)) {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'bridge_path_outside_home',
      message: 'Windows plugin runtime bridge path is outside the selected OpenClaw homeDir.',
    })
  }

  const hostPackageRootInfo = await resolveHostOpenClawPackageRoot(options)
  if (!hostPackageRootInfo) {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'invalid_host_package',
      message: 'Selected Windows OpenClaw host package root is not a valid openclaw package.',
    })
  }

  if (hostPackageRootInfo.version !== PINNED_OPENCLAW_VERSION) {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'version_mismatch',
      message: `Selected Windows OpenClaw host package version ${hostPackageRootInfo.version || 'unknown'} does not match ${PINNED_OPENCLAW_VERSION}.`,
      packageVersion: hostPackageRootInfo.version,
      targetPath: hostPackageRootInfo.path,
    })
  }

  const [resolvedHostPackageRoot, resolvedBridgePath] = await Promise.all([
    realpath(hostPackageRootInfo.path),
    realpath(bridgePath).catch(() => null),
  ])
  if (resolvedBridgePath === resolvedHostPackageRoot) {
    return createBridgeResult({
      ok: true,
      bridgePath,
      created: false,
      packageVersion: hostPackageRootInfo.version,
      targetPath: resolvedHostPackageRoot,
    })
  }

  if (!(await canReplaceExistingBridgePath(bridgePath))) {
    return createBridgeResult({
      ok: false,
      bridgePath,
      caller: options.caller,
      failureKind: 'unsafe_existing_bridge_path',
      message: 'Existing Windows plugin runtime bridge path is a real directory or file; refusing to delete it.',
      packageVersion: hostPackageRootInfo.version,
      targetPath: resolvedHostPackageRoot,
    })
  }

  await mkdir(path.dirname(bridgePath), { recursive: true })
  await rm(bridgePath, { recursive: true, force: true })
  await symlink(resolvedHostPackageRoot, bridgePath, 'junction')

  return createBridgeResult({
    ok: true,
    bridgePath,
    created: true,
    packageVersion: hostPackageRootInfo.version,
    targetPath: resolvedHostPackageRoot,
  })
}
