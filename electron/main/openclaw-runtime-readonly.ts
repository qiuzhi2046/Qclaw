import type { OpenClawPaths } from './openclaw-paths'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'

import { listExecutablePathCandidates } from './runtime-path-discovery'
import { resolveRuntimeOpenClawPaths } from './openclaw-runtime-paths'
import {
  buildWindowsActiveRuntimeSnapshot,
  resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable,
  resolveWindowsPrivateOpenClawRuntimePaths,
} from './platforms/windows/windows-runtime-policy'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

type ResolveOpenClawPathsForReadOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null | undefined
  getCachedRuntimeSnapshot?:
    | (() => WindowsActiveRuntimeSnapshot | null)
    | (() => Promise<WindowsActiveRuntimeSnapshot | null>)
  resolveSelectedRuntimeSnapshot?:
    | (() => WindowsActiveRuntimeSnapshot | null)
    | (() => Promise<WindowsActiveRuntimeSnapshot | null>)
  resolvePaths?: (input: {
    binaryPath?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | undefined
  }) => Promise<OpenClawPaths> | OpenClawPaths
}

type ResolveWindowsActiveRuntimeSnapshotForReadOptions = Pick<
  ResolveOpenClawPathsForReadOptions,
  'activeRuntimeSnapshot' | 'env' | 'getCachedRuntimeSnapshot' | 'platform' | 'resolvePaths' | 'resolveSelectedRuntimeSnapshot'
>

async function canAccessPath(targetPath: string): Promise<boolean> {
  const trimmed = String(targetPath || '').trim()
  if (!trimmed) return false

  try {
    await fs.promises.access(trimmed)
    return true
  } catch {
    return false
  }
}

async function canAccessWindowsActiveRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined
): Promise<boolean> {
  const candidate = snapshot || null
  if (!candidate) return false

  const nodePath = String(candidate.nodePath || '').trim()
  const openclawPath = String(candidate.openclawPath || '').trim()
  const hostPackageRoot = String(candidate.hostPackageRoot || '').trim()
  if (!nodePath || !openclawPath || !hostPackageRoot) return false

  const [nodeExists, openclawExists, hostPackageRootExists] = await Promise.all([
    canAccessPath(nodePath),
    canAccessPath(openclawPath),
    canAccessPath(hostPackageRoot),
  ])
  return nodeExists && openclawExists && hostPackageRootExists
}

async function resolveSelectedWindowsNodeExecutablePath(env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = listExecutablePathCandidates('node', {
    platform: 'win32',
    currentPath: env.PATH || '',
    env,
  })

  for (const candidate of candidates) {
    if (await canAccessPath(candidate)) {
      return candidate
    }
  }

  return ''
}

async function deriveSelectedWindowsRuntimeSnapshotForRead(
  options: ResolveWindowsActiveRuntimeSnapshotForReadOptions = {}
): Promise<WindowsActiveRuntimeSnapshot | null> {
  const env = options.env || process.env
  const resolvePaths = options.resolvePaths || resolveRuntimeOpenClawPaths
  const nodeExecutable = await resolveSelectedWindowsNodeExecutablePath(env)
  if (!nodeExecutable) return null

  const requiredRuntimePaths = resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
    nodeExecutable,
    {
      env,
    }
  )
  if (!requiredRuntimePaths) return null

  const openClawPaths = await resolvePaths({
    binaryPath: requiredRuntimePaths.openclawExecutable,
    env,
    platform: 'win32',
  }).catch(() => null)
  if (!openClawPaths?.homeDir || !openClawPaths.configFile) return null

  const privateRuntimeSnapshot = buildWindowsActiveRuntimeSnapshot({
    openclawExecutable: requiredRuntimePaths.openclawExecutable,
    hostPackageRoot: requiredRuntimePaths.hostPackageRoot,
    nodeExecutable,
    npmPrefix: resolveWindowsPrivateOpenClawRuntimePaths({
      env,
    }).npmPrefix,
    configPath: openClawPaths.configFile,
    stateDir: openClawPaths.homeDir,
    extensionsDir: path.join(openClawPaths.homeDir, 'extensions'),
    userDataDir: String(env.QCLAW_USER_DATA_DIR || '').trim() || undefined,
  })
  if (await canAccessWindowsActiveRuntimeSnapshot(privateRuntimeSnapshot)) {
    return privateRuntimeSnapshot
  }

  return null
}

export async function resolveWindowsActiveRuntimeSnapshotForRead(
  options: ResolveWindowsActiveRuntimeSnapshotForReadOptions = {}
): Promise<WindowsActiveRuntimeSnapshot | null> {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return null

  if (options.activeRuntimeSnapshot) return options.activeRuntimeSnapshot

  const cachedRuntimeSnapshot =
    await (options.getCachedRuntimeSnapshot
      ? options.getCachedRuntimeSnapshot()
      : getSelectedWindowsActiveRuntimeSnapshot())
  if (cachedRuntimeSnapshot) return cachedRuntimeSnapshot

  if (options.resolveSelectedRuntimeSnapshot) {
    return await options.resolveSelectedRuntimeSnapshot()
  }

  return await deriveSelectedWindowsRuntimeSnapshotForRead(options)
}

export async function resolveOpenClawPathsForRead(
  options: ResolveOpenClawPathsForReadOptions = {}
): Promise<OpenClawPaths> {
  const platform = options.platform || process.platform
  const resolvePaths = options.resolvePaths || resolveRuntimeOpenClawPaths
  if (platform !== 'win32') {
    return await resolvePaths({})
  }

  const runtimeSnapshot =
    await resolveWindowsActiveRuntimeSnapshotForRead({
      platform,
      env: options.env,
      activeRuntimeSnapshot: options.activeRuntimeSnapshot,
      getCachedRuntimeSnapshot: options.getCachedRuntimeSnapshot,
      resolveSelectedRuntimeSnapshot: options.resolveSelectedRuntimeSnapshot,
      resolvePaths,
    })
  if (!runtimeSnapshot) {
    throw new Error('Windows OpenClaw runtime not ready for read-only path resolution')
  }

  return await resolvePaths({
    activeRuntimeSnapshot: runtimeSnapshot || undefined,
  })
}
