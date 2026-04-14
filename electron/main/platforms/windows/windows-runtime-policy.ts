const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
import { atomicWriteJson } from '../../atomic-write'

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
  installStagingDir: string
  npmPrefix: string
  openclawExecutable: string
  packageJsonPath: string
  runtimeMarkerPath: string
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
  preferPrivate?: boolean
}

export interface WindowsManagedOpenClawRuntimeMarker {
  generatedBy: 'qclaw'
  hostPackageRoot: string
  nodeVersion: string
  schema: 'qclaw-managed-openclaw-runtime'
}

export interface PrepareWindowsManagedOpenClawRuntimeCandidateOptions {
  configPath: string
  env?: NodeJS.ProcessEnv
  extensionsDir?: string
  stateDir: string
  userDataDir?: string
}

export interface PrepareWindowsManagedOpenClawRuntimeCandidateResult {
  errors: string[]
  marker: WindowsManagedOpenClawRuntimeMarker | null
  missingPaths: string[]
  ok: boolean
  paths: WindowsPrivateOpenClawRuntimePaths
  snapshot: WindowsActiveRuntimeSnapshot | null
  version: string | null
}

export interface PrepareWindowsManagedOpenClawRuntimeCandidateDependencies {
  access?: (targetPath: string) => Promise<void>
  probeVersion?: (binaryPath: string) => Promise<string>
  readTextFile?: (targetPath: string) => Promise<string>
}

export const WINDOWS_MANAGED_OPENCLAW_RUNTIME_MARKER_FILENAME = '.qclaw-managed-runtime.json'

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
  const hostPackageRoot = path.win32.join(npmPrefix, 'node_modules', 'openclaw')

  return {
    hostPackageRoot,
    installStagingDir: path.win32.join(nodeRuntimePaths.runtimeRoot, 'openclaw', '.staging', path.win32.basename(npmPrefix)),
    npmPrefix,
    openclawExecutable: path.win32.join(npmPrefix, 'openclaw.cmd'),
    packageJsonPath: path.win32.join(hostPackageRoot, 'package.json'),
    runtimeMarkerPath: path.win32.join(hostPackageRoot, WINDOWS_MANAGED_OPENCLAW_RUNTIME_MARKER_FILENAME),
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

export function buildWindowsManagedOpenClawRuntimeMarker(
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): WindowsManagedOpenClawRuntimeMarker {
  const nodeRuntimePaths = resolveWindowsPrivateNodeRuntimePaths(options)
  const openClawRuntimePaths = resolveWindowsPrivateOpenClawRuntimePaths(options)
  return {
    generatedBy: 'qclaw',
    hostPackageRoot: openClawRuntimePaths.hostPackageRoot,
    nodeVersion: path.win32.basename(nodeRuntimePaths.nodeVersionDir),
    schema: 'qclaw-managed-openclaw-runtime',
  }
}

export async function writeWindowsManagedOpenClawRuntimeMarker(
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): Promise<{ ok: boolean; markerPath: string; error?: string }> {
  const paths = resolveWindowsPrivateOpenClawRuntimePaths(options)
  const markerPath = paths.runtimeMarkerPath

  try {
    await fs.promises.access(paths.openclawExecutable)
    await fs.promises.access(paths.packageJsonPath)
    const pkg = JSON.parse(await fs.promises.readFile(paths.packageJsonPath, 'utf8')) as { name?: string }
    if (String(pkg.name || '').trim() !== 'openclaw') {
      return { ok: false, markerPath, error: 'package.json name is not openclaw' }
    }
  } catch {
    return { ok: false, markerPath, error: 'managed path not populated' }
  }

  const marker = buildWindowsManagedOpenClawRuntimeMarker(options)
  try {
    await atomicWriteJson(markerPath, marker)
    return { ok: true, markerPath }
  } catch (error) {
    return {
      ok: false,
      markerPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function healMissingManagedRuntimeMarker(
  options: ResolveWindowsPrivateNodeRuntimePathsOptions = {}
): Promise<{ healed: boolean; markerPath: string }> {
  if (process.platform !== 'win32') return { healed: false, markerPath: '' }

  const paths = resolveWindowsPrivateOpenClawRuntimePaths(options)
  const markerPath = paths.runtimeMarkerPath

  try {
    await fs.promises.access(markerPath)
    return { healed: false, markerPath }
  } catch {
    // marker missing, attempt heal
  }

  const result = await writeWindowsManagedOpenClawRuntimeMarker(options)
  return { healed: result.ok, markerPath }
}

function normalizeOpenClawVersionProbe(value: string | null | undefined): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const matched = raw.match(/\d{4}\.\d+\.\d+/)
  if (matched?.[0]) return matched[0]
  return raw.replace(/^v/i, '').split('-')[0].trim() || null
}

function isManagedOpenClawRuntimeMarker(value: unknown): value is WindowsManagedOpenClawRuntimeMarker {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WindowsManagedOpenClawRuntimeMarker>
  return (
    candidate.generatedBy === 'qclaw' &&
    candidate.schema === 'qclaw-managed-openclaw-runtime' &&
    Boolean(trim(candidate.hostPackageRoot || '')) &&
    Boolean(trim(candidate.nodeVersion || ''))
  )
}

async function pathExists(
  targetPath: string,
  accessFn: (targetPath: string) => Promise<void>
): Promise<boolean> {
  try {
    await accessFn(targetPath)
    return true
  } catch {
    return false
  }
}

export async function prepareWindowsManagedOpenClawRuntimeCandidate(
  options: PrepareWindowsManagedOpenClawRuntimeCandidateOptions,
  dependencies: PrepareWindowsManagedOpenClawRuntimeCandidateDependencies = {}
): Promise<PrepareWindowsManagedOpenClawRuntimeCandidateResult> {
  const env = options.env || process.env
  const accessFn =
    dependencies.access ||
    (async (targetPath: string) => {
      await fs.promises.access(targetPath)
    })
  const readTextFile =
    dependencies.readTextFile ||
    (async (targetPath: string) => fs.promises.readFile(targetPath, 'utf8'))
  const probeVersion = dependencies.probeVersion || (async () => '')
  const nodeRuntimePaths = resolveWindowsPrivateNodeRuntimePaths({ env })
  const paths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
  const requiredPaths = [
    nodeRuntimePaths.nodeExecutable,
    paths.openclawExecutable,
    paths.hostPackageRoot,
    paths.packageJsonPath,
    paths.runtimeMarkerPath,
  ]
  const missingPaths: string[] = []

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath, accessFn))) {
      missingPaths.push(requiredPath)
    }
  }

  if (missingPaths.length > 0) {
    return {
      errors: [],
      marker: null,
      missingPaths,
      ok: false,
      paths,
      snapshot: null,
      version: null,
    }
  }

  const errors: string[] = []
  let marker: WindowsManagedOpenClawRuntimeMarker | null = null

  try {
    const parsedMarker = JSON.parse(await readTextFile(paths.runtimeMarkerPath)) as unknown
    if (!isManagedOpenClawRuntimeMarker(parsedMarker)) {
      errors.push('Invalid Qclaw managed OpenClaw runtime marker.')
    } else {
      marker = parsedMarker
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  let packageVersion: string | null = null

  try {
    const packageJson = JSON.parse(await readTextFile(paths.packageJsonPath)) as {
      name?: string
      version?: string
    }
    if (String(packageJson.name || '').trim() !== 'openclaw') {
      errors.push('Managed OpenClaw runtime package.json is not the openclaw package.')
    } else {
      packageVersion = normalizeOpenClawVersionProbe(packageJson.version)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const version =
    normalizeOpenClawVersionProbe(await probeVersion(paths.openclawExecutable).catch(() => '')) ||
    packageVersion
  if (!version) {
    errors.push('Managed OpenClaw runtime version probe failed.')
  }

  if (errors.length > 0 || !marker || !version) {
    return {
      errors,
      marker,
      missingPaths: [],
      ok: false,
      paths,
      snapshot: null,
      version,
    }
  }

  const stateDir = trim(options.stateDir)
  const configPath = trim(options.configPath)
  const extensionsDir = trim(options.extensionsDir || path.win32.join(stateDir, 'extensions'))
  const userDataDir = trim(options.userDataDir || env.QCLAW_USER_DATA_DIR || '')

  return {
    errors: [],
    marker,
    missingPaths: [],
    ok: true,
    paths,
    snapshot: buildWindowsActiveRuntimeSnapshot({
      configPath,
      extensionsDir,
      hostPackageRoot: paths.hostPackageRoot,
      nodeExecutable: nodeRuntimePaths.nodeExecutable,
      npmPrefix: paths.npmPrefix,
      openclawExecutable: paths.openclawExecutable,
      stateDir,
      userDataDir: userDataDir || undefined,
    }),
    version,
  }
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
      const preferredFamily = dependencies.preferPrivate ? 'private' : 'external'
      return leftFamily === preferredFamily ? -1 : 1
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
