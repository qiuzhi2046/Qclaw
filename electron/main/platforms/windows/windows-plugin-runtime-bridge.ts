import type { WindowsActiveRuntimeSnapshot } from './windows-runtime-policy'
import { getSelectedWindowsActiveRuntimeSnapshot } from '../../windows-active-runtime'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { mkdir, readFile, realpath, rm, symlink } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

export interface WindowsPluginHostRuntimeBridgeOptions {
  homeDir: string
  hostOpenClawPackageRoot?: string
  platform?: NodeJS.Platform
  resolveHostOpenClawPackageRoot?: () => Promise<string | null>
}

export interface WindowsPluginHostRuntimeBridgeResult {
  ok: boolean
  bridgePath: string
  created: boolean
  targetPath: string | null
}

export async function ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
  options: {
    platform?: NodeJS.Platform
  } = {}
): Promise<WindowsPluginHostRuntimeBridgeResult> {
  const activeSnapshot = snapshot || getSelectedWindowsActiveRuntimeSnapshot()
  const stateDir = String(activeSnapshot?.stateDir || '').trim()

  if (!activeSnapshot || !stateDir) {
    return {
      ok: false,
      bridgePath: path.join(stateDir || '.', 'node_modules', 'openclaw'),
      created: false,
      targetPath: null,
    }
  }

  return ensureWindowsPluginHostRuntimeBridge({
    homeDir: stateDir,
    hostOpenClawPackageRoot: activeSnapshot.hostPackageRoot,
    platform: options.platform,
  })
}

async function isUsableOpenClawPackageRoot(candidatePath: string): Promise<boolean> {
  const packageJsonPath = path.join(candidatePath, 'package.json')
  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { name?: string }
    return parsed.name === 'openclaw'
  } catch {
    return false
  }
}

async function resolveHostOpenClawPackageRoot(
  options: WindowsPluginHostRuntimeBridgeOptions
): Promise<string | null> {
  const explicitPath = String(options.hostOpenClawPackageRoot || '').trim()
  if (explicitPath) {
    return (await isUsableOpenClawPackageRoot(explicitPath)) ? explicitPath : null
  }

  const resolvedPath = await options.resolveHostOpenClawPackageRoot?.().catch(() => null)
  if (resolvedPath && await isUsableOpenClawPackageRoot(resolvedPath)) {
    return resolvedPath
  }

  const selectedSnapshotPackageRoot = String(
    getSelectedWindowsActiveRuntimeSnapshot()?.hostPackageRoot || ''
  ).trim()
  if (
    selectedSnapshotPackageRoot &&
    await isUsableOpenClawPackageRoot(selectedSnapshotPackageRoot)
  ) {
    return selectedSnapshotPackageRoot
  }

  return null
}

export async function ensureWindowsPluginHostRuntimeBridge(
  options: WindowsPluginHostRuntimeBridgeOptions
): Promise<WindowsPluginHostRuntimeBridgeResult> {
  const homeDir = String(options.homeDir || '').trim()
  const bridgePath = path.join(homeDir, 'node_modules', 'openclaw')
  const platform = options.platform || process.platform
  if (platform !== 'win32' || !homeDir) {
    return {
      ok: false,
      bridgePath,
      created: false,
      targetPath: null,
    }
  }

  const hostPackageRoot = await resolveHostOpenClawPackageRoot(options)
  if (!hostPackageRoot) {
    return {
      ok: false,
      bridgePath,
      created: false,
      targetPath: null,
    }
  }

  const [resolvedHostPackageRoot, resolvedBridgePath] = await Promise.all([
    realpath(hostPackageRoot),
    realpath(bridgePath).catch(() => null),
  ])
  if (resolvedBridgePath === resolvedHostPackageRoot) {
    return {
      ok: true,
      bridgePath,
      created: false,
      targetPath: resolvedHostPackageRoot,
    }
  }

  await mkdir(path.dirname(bridgePath), { recursive: true })
  await rm(bridgePath, { recursive: true, force: true })
  await symlink(resolvedHostPackageRoot, bridgePath, 'junction')

  return {
    ok: true,
    bridgePath,
    created: true,
    targetPath: resolvedHostPackageRoot,
  }
}
