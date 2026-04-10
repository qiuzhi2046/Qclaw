const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export interface WindowsSelectedRuntimeSnapshotFields {
  hostPackageRoot: string
  nodePath: string
  openclawPath: string
  stateDir: string
}

export interface WindowsActiveRuntimeSnapshot {
  configPath: string
  extensionsDir: string
  hostPackageRoot: string
  logsDir: string
  nodePath: string
  /**
   * Windows bin-root hint derived from the active OpenClaw executable layout.
   * This is not guaranteed to equal `npm config get prefix`, especially for
   * manager-provided shims such as Volta.
   */
  npmPrefix: string
  openclawPath: string
  stateDir: string
  tmpDir: string
}

export const WINDOWS_PRIVATE_NODE_VERSION = 'v24.14.1'

interface BuildWindowsActiveRuntimeSnapshotOptions {
  configPath: string
  extensionsDir: string
  hostPackageRoot?: string
  nodeExecutable: string
  npmPrefix: string
  openclawExecutable: string
  stateDir: string
  userDataDir?: string
}

export interface WindowsPrivateNodeRuntimePaths {
  downloadDir: string
  installStagingDir: string
  nodeBinDir: string
  nodeExecutable: string
  nodeVersionDir: string
  npmExecutable: string
  pathPrefix: string
  runtimeRoot: string
  shaSumsPath: string
  zipPath: string
  zipStagingDir: string
}

export interface WindowsPrivateOpenClawRuntimePaths {
  hostPackageRoot: string
  npmPrefix: string
  openclawExecutable: string
}

export interface ResolveWindowsPrivateNodeRuntimePathsOptions {
  env?: NodeJS.ProcessEnv
  filename?: string
  rootDir?: string
  version?: string
}

export interface SelectAuthoritativeWindowsActiveRuntimeSnapshotDependencies {
  env?: NodeJS.ProcessEnv
  isSnapshotComplete?: (snapshot: WindowsActiveRuntimeSnapshot) => Promise<boolean>
}

function normalizeComparableWindowsPath(value: string): string {
  return trimWindowsPath(value).toLowerCase()
}

function isWithinComparableWindowsPathRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeComparableWindowsPath(candidate)
  const normalizedRoot = normalizeComparableWindowsPath(root)
  if (!normalizedCandidate || !normalizedRoot) return false
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  )
}

function trim(value: string): string {
  return String(value || '').trim()
}

function trimWindowsPath(value: string): string {
  const trimmed = trim(value)
  if (!trimmed) return ''
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) return `${trimmed[0]}:\\`
  return trimmed.replace(/[\\/]+$/, '')
}

function normalizeVersionTag(version: string): string {
  const trimmed = trim(version)
  if (!trimmed) return WINDOWS_PRIVATE_NODE_VERSION
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

function resolveWindowsLocalAppData(env: NodeJS.ProcessEnv): string {
  const localAppData = trimWindowsPath(env.LOCALAPPDATA || '')
  if (localAppData) return localAppData
  return path.win32.join(os.homedir(), 'AppData', 'Local')
}

function normalizeZipStagingName(filename: string, version: string): string {
  const candidate = path.win32.basename(trim(filename))
  const withoutExtension = candidate.replace(/\.zip$/i, '')
  return withoutExtension || `node-${version}-win-x64`
}

export function resolveWindowsPrivateNodeRuntimePaths(
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): WindowsPrivateNodeRuntimePaths {
  const env = options.env || process.env
  const version = normalizeVersionTag(options.version || WINDOWS_PRIVATE_NODE_VERSION)
  const runtimeRoot =
    trimWindowsPath(options.rootDir || '') ||
    path.win32.join(resolveWindowsLocalAppData(env), 'Qclaw', 'runtime', 'win32')
  const nodeVersionDir = path.win32.join(runtimeRoot, 'node', version)
  const downloadDir = path.win32.join(runtimeRoot, 'node', '.downloads', version)
  const zipStagingDir = path.win32.join(
    downloadDir,
    normalizeZipStagingName(options.filename || '', version)
  )
  const installStagingDir = path.win32.join(runtimeRoot, 'node', '.staging', version)
  const filename = path.win32.basename(trim(options.filename || `node-${version}-win-x64.zip`))

  return {
    downloadDir,
    installStagingDir,
    nodeBinDir: nodeVersionDir,
    nodeExecutable: path.win32.join(nodeVersionDir, 'node.exe'),
    nodeVersionDir,
    npmExecutable: path.win32.join(nodeVersionDir, 'npm.cmd'),
    pathPrefix: nodeVersionDir,
    runtimeRoot,
    shaSumsPath: path.win32.join(downloadDir, 'SHASUMS256.txt'),
    zipPath: path.win32.join(downloadDir, filename),
    zipStagingDir,
  }
}

export function resolveWindowsPrivateOpenClawRuntimePaths(
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): WindowsPrivateOpenClawRuntimePaths {
  const nodeRuntimePaths = resolveWindowsPrivateNodeRuntimePaths(options)
  const npmPrefix = nodeRuntimePaths.nodeVersionDir

  return {
    hostPackageRoot: path.win32.join(npmPrefix, 'node_modules', 'openclaw'),
    npmPrefix,
    openclawExecutable: path.win32.join(npmPrefix, 'openclaw.cmd'),
  }
}

export function resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
  nodeExecutable: string,
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): WindowsPrivateOpenClawRuntimePaths | null {
  const normalizedNodeExecutable = normalizeComparableWindowsPath(nodeExecutable)
  if (!normalizedNodeExecutable) return null

  const privateNodeRuntimePaths = resolveWindowsPrivateNodeRuntimePaths(options)
  if (
    normalizedNodeExecutable !== normalizeComparableWindowsPath(privateNodeRuntimePaths.nodeExecutable)
  ) {
    return null
  }

  return resolveWindowsPrivateOpenClawRuntimePaths(options)
}

export function buildWindowsActiveRuntimeSnapshot(
  input: BuildWindowsActiveRuntimeSnapshotOptions
): WindowsActiveRuntimeSnapshot {
  const stateDir = trim(input.stateDir)
  const runtimeRoot = path.win32.join(trim(input.userDataDir || '') || stateDir, 'runtime', 'win32')

  return {
    configPath: trim(input.configPath),
    extensionsDir: trim(input.extensionsDir),
    hostPackageRoot: trim(input.hostPackageRoot || ''),
    logsDir: path.win32.join(runtimeRoot, 'logs'),
    nodePath: trim(input.nodeExecutable),
    npmPrefix: trim(input.npmPrefix),
    openclawPath: trim(input.openclawExecutable),
    stateDir,
    tmpDir: path.win32.join(runtimeRoot, 'tmp'),
  }
}

export function buildWindowsSelectedRuntimeSnapshotFields(
  snapshot: WindowsSelectedRuntimeSnapshotFields | WindowsActiveRuntimeSnapshot | null | undefined
): WindowsSelectedRuntimeSnapshotFields {
  const candidate = snapshot || null

  return {
    hostPackageRoot: trim(candidate?.hostPackageRoot || ''),
    nodePath: trim(candidate?.nodePath || ''),
    openclawPath: trim(candidate?.openclawPath || ''),
    stateDir: trim(candidate?.stateDir || ''),
  }
}

export function reuseWindowsSelectedRuntimeSnapshotFields(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
  existingSnapshot?: WindowsSelectedRuntimeSnapshotFields | null
): WindowsSelectedRuntimeSnapshotFields {
  const nextSnapshot = buildWindowsSelectedRuntimeSnapshotFields(snapshot)
  const existing = existingSnapshot || null
  if (!existing) return nextSnapshot

  const matchesExisting = (
    [
      ['hostPackageRoot', existing.hostPackageRoot, nextSnapshot.hostPackageRoot],
      ['nodePath', existing.nodePath, nextSnapshot.nodePath],
      ['openclawPath', existing.openclawPath, nextSnapshot.openclawPath],
      ['stateDir', existing.stateDir, nextSnapshot.stateDir],
    ] as const
  ).every(([, previousValue, nextValue]) => {
    return normalizeComparableWindowsPath(previousValue) === normalizeComparableWindowsPath(nextValue)
  })

  return matchesExisting
    ? {
        hostPackageRoot: existing.hostPackageRoot,
        nodePath: existing.nodePath,
        openclawPath: existing.openclawPath,
        stateDir: existing.stateDir,
      }
    : nextSnapshot
}

export async function selectAuthoritativeWindowsActiveRuntimeSnapshot(
  candidates: Array<{
    isPathActive?: boolean
    snapshot: WindowsActiveRuntimeSnapshot
  }>,
  dependencies: SelectAuthoritativeWindowsActiveRuntimeSnapshotDependencies = {}
): Promise<WindowsActiveRuntimeSnapshot | null> {
  const isSnapshotComplete = dependencies.isSnapshotComplete || (async () => true)
  const env = dependencies.env || process.env
  const privateNodePaths = resolveWindowsPrivateNodeRuntimePaths({ env })
  const privateRuntimeRoot = privateNodePaths.runtimeRoot

  const prioritizedCandidates = [...candidates].sort((left, right) => {
    const leftFamily = [
      left.snapshot.nodePath,
      left.snapshot.openclawPath,
      left.snapshot.hostPackageRoot,
      left.snapshot.npmPrefix,
    ]
      .some((value) => isWithinComparableWindowsPathRoot(value, privateRuntimeRoot))
      ? 'private'
      : 'external'
    const rightFamily = [
      right.snapshot.nodePath,
      right.snapshot.openclawPath,
      right.snapshot.hostPackageRoot,
      right.snapshot.npmPrefix,
    ]
      .some((value) => isWithinComparableWindowsPathRoot(value, privateRuntimeRoot))
      ? 'private'
      : 'external'

    if (leftFamily !== rightFamily) {
      return leftFamily === 'external' ? -1 : 1
    }

    const leftActive = Boolean(left.isPathActive)
    const rightActive = Boolean(right.isPathActive)
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1
    }

    return String(left.snapshot.openclawPath || '').localeCompare(String(right.snapshot.openclawPath || ''))
  })

  for (const candidate of prioritizedCandidates) {
    if (await isSnapshotComplete(candidate.snapshot)) {
      return candidate.snapshot
    }
  }

  return null
}
