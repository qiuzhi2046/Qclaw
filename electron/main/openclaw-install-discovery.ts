import type {
  OpenClawDiscoveryResult,
  OpenClawHistoryDataCandidate,
  OpenClawInstallCandidate,
  OpenClawInstallSource,
  OpenClawOwnershipState,
} from '../../src/shared/openclaw-phase1'
import { atomicWriteJson } from './atomic-write'
import { formatDisplayPath, resolveOpenClawPaths } from './openclaw-paths'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import {
  buildWindowsManagedOpenClawRuntimeMarker,
  buildWindowsActiveRuntimeSnapshot,
  resolveWindowsPrivateOpenClawRuntimePaths,
} from './platforms/windows/windows-runtime-policy'
import { readOpenClawPackageInfo, resolveOpenClawBinaryPath } from './openclaw-package'
import { resolveRuntimeOpenClawPaths } from './openclaw-runtime-paths'
import { listExecutablePathCandidates } from './runtime-path-discovery'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'
import {
  getBaselineBackupBypassStatus,
  getBaselineBackupStatus,
  resolveDefaultBackupDirectory,
} from './openclaw-baseline-backup-gate'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
const { access, readFile, realpath } = fs.promises
const { homedir } = os
const { spawn } = childProcess
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 5_000

interface WindowsInstallSnapshotCandidate extends OpenClawInstallCandidate {
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
}

interface CandidateRuntimeStateSnapshot {
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
  configPath: string
  displayConfigPath: string
  displayStateRoot: string
  stateRoot: string
}

interface WindowsOpenClawDiscoveryResult extends OpenClawDiscoveryResult {
  candidates: WindowsInstallSnapshotCandidate[]
}

function resolveVersionProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.QCLAW_RUNTIME_LIGHTWEIGHT_PROBE_TIMEOUT_MS || '').trim()
  if (!raw) return DEFAULT_VERSION_PROBE_TIMEOUT_MS

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_VERSION_PROBE_TIMEOUT_MS
  return Math.max(500, Math.floor(parsed))
}

interface ManagedInstallEntry {
  installFingerprint: string
  markedAt: string
  verified: boolean
}

interface ManagedInstallStore {
  version: 2
  entries: ManagedInstallEntry[]
}

const MANAGED_INSTALL_STORE_PATH = path.join('data-guard', 'managed-openclaw-installs.json')

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? String(value || '').toLowerCase() : String(value || '')
}

function resolveManagedInstallStorePath(): string {
  return path.join(String(process.env.QCLAW_USER_DATA_DIR || path.join(homedir(), '.qclaw-lite')).trim(), MANAGED_INSTALL_STORE_PATH)
}

async function loadManagedInstallStore(): Promise<ManagedInstallStore> {
  try {
    const raw = await readFile(resolveManagedInstallStorePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ManagedInstallStore>
    const legacyFingerprints = Array.isArray((parsed as { installFingerprints?: unknown[] }).installFingerprints)
      ? ((parsed as { installFingerprints?: unknown[] }).installFingerprints || [])
      : []
    const parsedEntries = Array.isArray(parsed.entries) ? parsed.entries : []
    return {
      version: 2,
      entries: [
        ...parsedEntries
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => {
            const candidate = entry as Partial<ManagedInstallEntry>
            const installFingerprint = String(candidate.installFingerprint || '').trim()
            if (!installFingerprint) return null
            return {
              installFingerprint,
              markedAt: String(candidate.markedAt || '').trim() || '',
              verified: candidate.verified !== false,
            }
          })
          .filter((entry): entry is ManagedInstallEntry => Boolean(entry)),
        ...legacyFingerprints
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .map((installFingerprint) => ({
            installFingerprint,
            markedAt: '',
            // Legacy stores only persisted fingerprints, which is insufficient to
            // prove that Qclaw created this install. Treat them as historical hints
            // instead of authoritative ownership records.
            verified: false,
          })),
      ],
    }
  } catch {
    return {
      version: 2,
      entries: [],
    }
  }
}

async function saveManagedInstallStore(store: ManagedInstallStore): Promise<void> {
  const storePath = resolveManagedInstallStorePath()
  await atomicWriteJson(storePath, store, {
    description: '托管安装记录',
  })
}

async function isManagedInstallFingerprint(installFingerprint: string): Promise<boolean> {
  const store = await loadManagedInstallStore()
  return store.entries.some(
    (entry) => entry.installFingerprint === installFingerprint && entry.verified
  )
}

export async function markManagedOpenClawInstall(installFingerprint: string): Promise<boolean> {
  const normalizedFingerprint = String(installFingerprint || '').trim()
  if (!normalizedFingerprint) return false
  const store = await loadManagedInstallStore()
  const existing = store.entries.find((entry) => entry.installFingerprint === normalizedFingerprint)
  if (existing?.verified) return true
  store.entries = [
    {
      installFingerprint: normalizedFingerprint,
      markedAt: new Date().toISOString(),
      verified: true,
    },
    ...store.entries.filter((entry) => entry.installFingerprint !== normalizedFingerprint),
  ]
  await saveManagedInstallStore(store)
  return true
}

function buildFingerprint(
  resolvedBinaryPath: string,
  packageRoot: string,
  version: string,
  configPath: string,
  stateRoot: string
): string {
  return createHash('sha256')
    .update([resolvedBinaryPath, packageRoot, version, configPath, stateRoot].join('\n'))
    .digest('hex')
}

function isQclawOwnedInstallSource(source: OpenClawInstallSource): boolean {
  return source === 'qclaw-bundled' || source === 'qclaw-managed'
}

function normalizePathForCompare(value: string): string {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase()
}

function isWithinOwnedRoot(candidatePath: string, roots: string[]): boolean {
  const normalizedCandidatePath = normalizePathForCompare(candidatePath)
  if (!normalizedCandidatePath) return false
  return roots.some((root) => {
    const normalizedRoot = normalizePathForCompare(root)
    if (!normalizedRoot) return false
    return (
      normalizedCandidatePath === normalizedRoot ||
      normalizedCandidatePath.startsWith(`${normalizedRoot}/`)
    )
  })
}

function resolveQclawOwnedDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>()
  const userDataDir = String(env.QCLAW_USER_DATA_DIR || '').trim()
  if (userDataDir) roots.add(userDataDir)

  if (process.platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
    if (localAppData) {
      roots.add(path.join(localAppData, 'Qclaw'))
    }
  }

  return Array.from(roots)
}

function isQclawOwnedStateSnapshot(input: {
  configPath: string
  stateRoot: string
  env?: NodeJS.ProcessEnv
}): boolean {
  const ownedRoots = resolveQclawOwnedDataRoots(input.env)
  if (ownedRoots.length === 0) return false
  return (
    isWithinOwnedRoot(input.configPath, ownedRoots) &&
    isWithinOwnedRoot(input.stateRoot, ownedRoots)
  )
}

function resolveOwnershipState(input: {
  installSource: OpenClawInstallSource
  managedInstall: boolean
  baselineBackup: OpenClawInstallCandidate['baselineBackup']
  configPath: string
  stateRoot: string
  env?: NodeJS.ProcessEnv
  fallbackOwnership: Extract<OpenClawOwnershipState, 'external-preexisting' | 'unknown-external'>
}): OpenClawOwnershipState {
  if (input.baselineBackup) {
    return 'mixed-managed'
  }
  const qclawOwnedStateSnapshot = isQclawOwnedStateSnapshot({
    configPath: input.configPath,
    stateRoot: input.stateRoot,
    env: input.env,
  })
  if ((isQclawOwnedInstallSource(input.installSource) || input.managedInstall) && qclawOwnedStateSnapshot) {
    return 'qclaw-installed'
  }
  return input.fallbackOwnership
}

async function persistManagedInstallFingerprintForSource(
  installSource: OpenClawInstallSource,
  installFingerprint: string
): Promise<boolean> {
  if (installSource !== 'qclaw-managed') return false
  return markManagedOpenClawInstall(installFingerprint).catch(() => false)
}

async function isVerifiedQclawManagedInstallCandidate(input: {
  binaryPath: string
  resolvedBinaryPath: string
  packageRoot: string
  env?: NodeJS.ProcessEnv
}): Promise<boolean> {
  if (process.platform !== 'win32') return false

  const env = input.env || process.env
  const expectedRuntimePaths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
  const expectedMarker = buildWindowsManagedOpenClawRuntimeMarker({ env })
  const candidateBinaryPaths = [
    input.binaryPath,
    input.resolvedBinaryPath,
  ].map((value) => normalizePathForCompare(value))
  const normalizedExpectedExecutable = normalizePathForCompare(expectedRuntimePaths.openclawExecutable)
  const normalizedExpectedPackageRoot = normalizePathForCompare(expectedRuntimePaths.hostPackageRoot)

  if (
    normalizePathForCompare(input.packageRoot) !== normalizedExpectedPackageRoot &&
    !candidateBinaryPaths.includes(normalizedExpectedExecutable)
  ) {
    return false
  }

  const requiredPaths = [
    expectedRuntimePaths.openclawExecutable,
    expectedRuntimePaths.hostPackageRoot,
    expectedRuntimePaths.packageJsonPath,
    expectedRuntimePaths.runtimeMarkerPath,
  ]

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      return false
    }
  }

  try {
    const packageJson = JSON.parse(await readFile(expectedRuntimePaths.packageJsonPath, 'utf8')) as { name?: string }
    if (String(packageJson.name || '').trim() !== 'openclaw') {
      return false
    }
  } catch {
    return false
  }

  try {
    const marker = JSON.parse(await readFile(expectedRuntimePaths.runtimeMarkerPath, 'utf8')) as Partial<{
      generatedBy: string
      hostPackageRoot: string
      nodeVersion: string
      schema: string
    }>
    return (
      String(marker.generatedBy || '').trim() === expectedMarker.generatedBy &&
      normalizePathForCompare(String(marker.hostPackageRoot || '')) === normalizePathForCompare(expectedMarker.hostPackageRoot) &&
      String(marker.nodeVersion || '').trim() === expectedMarker.nodeVersion &&
      String(marker.schema || '').trim() === expectedMarker.schema
    )
  } catch {
    return false
  }
}

async function resolveVerifiedInstallSource(input: {
  installSource: OpenClawInstallSource
  binaryPath: string
  resolvedBinaryPath: string
  packageRoot: string
  env?: NodeJS.ProcessEnv
}): Promise<OpenClawInstallSource> {
  if (input.installSource !== 'qclaw-managed') {
    return input.installSource
  }

  const verified = await isVerifiedQclawManagedInstallCandidate({
    binaryPath: input.binaryPath,
    resolvedBinaryPath: input.resolvedBinaryPath,
    packageRoot: input.packageRoot,
    env: input.env,
  })
  return verified ? input.installSource : 'custom'
}

function resolveCandidateRuntimeStateSnapshot(input: {
  activeBinaryPath: string | null
  binaryPath: string
  packageRoot: string
  resolvedBinaryPath: string
  runtimePaths: Awaited<ReturnType<typeof resolveRuntimeOpenClawPaths>>
}): CandidateRuntimeStateSnapshot {
  const selectedRuntimeSnapshot =
    process.platform === 'win32' ? getSelectedWindowsActiveRuntimeSnapshot() : null
  const normalizedSelectedBinaryPath = normalizePathForCompare(selectedRuntimeSnapshot?.openclawPath || '')
  const normalizedBinaryCandidates = [
    input.binaryPath,
    input.resolvedBinaryPath,
  ].map((value) => normalizePathForCompare(value))

  if (
    selectedRuntimeSnapshot &&
    normalizedSelectedBinaryPath &&
    normalizedBinaryCandidates.includes(normalizedSelectedBinaryPath)
  ) {
    return {
      activeRuntimeSnapshot: { ...selectedRuntimeSnapshot },
      configPath: selectedRuntimeSnapshot.configPath,
      displayConfigPath: formatDisplayPath(selectedRuntimeSnapshot.configPath),
      displayStateRoot: formatDisplayPath(selectedRuntimeSnapshot.stateDir),
      stateRoot: selectedRuntimeSnapshot.stateDir,
    }
  }

  return {
    activeRuntimeSnapshot: buildWindowsInstallSnapshot({
      binaryPath: input.binaryPath,
      configPath: input.runtimePaths.configFile,
      hostPackageRoot: input.packageRoot,
      stateRoot: input.runtimePaths.homeDir,
    }),
    configPath: input.runtimePaths.configFile,
    displayConfigPath: input.runtimePaths.displayConfigFile,
    displayStateRoot: input.runtimePaths.displayHomeDir,
    stateRoot: input.runtimePaths.homeDir,
  }
}

export function inferOpenClawInstallSource(input: {
  binaryPath: string
  resolvedBinaryPath?: string
  packageRoot?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
}): OpenClawInstallSource {
  const platform = input.platform || process.platform
  const binaryPath = String(input.binaryPath || '').replace(/\\/g, '/').toLowerCase()
  const resolvedBinaryPath = String(input.resolvedBinaryPath || '').replace(/\\/g, '/').toLowerCase()
  const packageRoot = String(input.packageRoot || '').replace(/\\/g, '/').toLowerCase()
  const fullText = `${binaryPath}\n${resolvedBinaryPath}\n${packageRoot}`
  if (platform === 'win32') {
    const env = input.env || process.env
    const privateRuntimePaths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
    const normalizedManagedExecutable = privateRuntimePaths.openclawExecutable.replace(/\\/g, '/').toLowerCase()
    const normalizedManagedPackageRoot = privateRuntimePaths.hostPackageRoot.replace(/\\/g, '/').toLowerCase()
    if (
      fullText.includes(normalizedManagedExecutable) ||
      fullText.includes(normalizedManagedPackageRoot)
    ) {
      return 'qclaw-managed'
    }

    const normalizedResourcesPath = String(input.resourcesPath || process.resourcesPath || '')
      .replace(/\\/g, '/')
      .toLowerCase()
    const bundledBinarySignature = '/resources/cli/openclaw'
    const bundledPackageSignature = '/resources/openclaw'
    const matchesBundledBinary =
      fullText.includes(bundledBinarySignature) ||
      (normalizedResourcesPath && fullText.includes(`${normalizedResourcesPath}/cli/openclaw`))
    const matchesBundledPackage =
      fullText.includes(bundledPackageSignature) ||
      (normalizedResourcesPath && fullText.includes(`${normalizedResourcesPath}/openclaw`))
    if (matchesBundledBinary || matchesBundledPackage) {
      return 'qclaw-bundled'
    }
  }
  const hasHomebrewCellarSignature =
    fullText.includes('/cellar/openclaw') || fullText.includes('/caskroom/openclaw')
  const hasHomebrewPrefixSignature = fullText.includes('/homebrew/') || fullText.includes('/linuxbrew/')
  const hasNpmGlobalSignature =
    fullText.includes('/node_modules/openclaw') ||
    fullText.includes('/.npm-global/') ||
    fullText.includes('/appdata/roaming/npm/')

  if (hasHomebrewCellarSignature) {
    return 'homebrew'
  }
  if (hasNpmGlobalSignature) return 'npm-global'
  if (hasHomebrewPrefixSignature) return 'homebrew'
  if (fullText.includes('/.nvm/')) return 'nvm'
  if (fullText.includes('/.fnm/') || fullText.includes('/fnm_multishells/')) return 'fnm'
  if (fullText.includes('/.asdf/') || fullText.includes('/asdf/shims/')) return 'asdf'
  if (fullText.includes('/mise/') || fullText.includes('/.mise/') || fullText.includes('/.local/share/mise/')) {
    return 'mise'
  }
  if (fullText.includes('/.volta/')) return 'volta'
  if (!binaryPath && !resolvedBinaryPath && !packageRoot) {
    return 'unknown'
  }
  if (packageRoot || resolvedBinaryPath) {
    return 'custom'
  }
  return 'unknown'
}

async function runBinaryVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve) => {
    const isWindowsCmd = process.platform === 'win32' && /\.cmd$/i.test(binaryPath)
    const timeoutMs = resolveVersionProbeTimeoutMs()
    const proc = spawn(binaryPath, ['--version'], {
      cwd: resolveSafeWorkingDirectory(),
      env: process.env,
      shell: isWindowsCmd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    })

    let stdout = ''
    let settled = false
    const timeoutId = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // noop
      }
      if (settled) return
      settled = true
      resolve('')
    }, timeoutMs)

    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(value)
    }

    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.on('close', () => {
      finish(String(stdout || '').trim())
    })
    proc.on('error', () => {
      finish('')
    })
  })
}

async function buildCandidateFromBinary(
  binaryPath: string,
  activeBinaryPath: string | null
): Promise<WindowsInstallSnapshotCandidate | null> {
  const openClawPaths = await resolveRuntimeOpenClawPaths({ binaryPath })
  try {
    const packageInfo = await readOpenClawPackageInfo({ binaryPath })
    const candidateRuntimeState = resolveCandidateRuntimeStateSnapshot({
      activeBinaryPath,
      binaryPath: packageInfo.binaryPath,
      packageRoot: packageInfo.packageRoot,
      resolvedBinaryPath: packageInfo.resolvedBinaryPath,
      runtimePaths: openClawPaths,
    })
    const installFingerprint = buildFingerprint(
      packageInfo.resolvedBinaryPath,
      packageInfo.packageRoot,
      packageInfo.version,
      candidateRuntimeState.configPath,
      candidateRuntimeState.stateRoot
    )
    const baselineBackup = await getBaselineBackupStatus(installFingerprint)
    const baselineBackupBypass = await getBaselineBackupBypassStatus(installFingerprint)
    const rawInstallSource = inferOpenClawInstallSource(packageInfo)
    const installSource = await resolveVerifiedInstallSource({
      installSource: rawInstallSource,
      binaryPath: packageInfo.binaryPath,
      resolvedBinaryPath: packageInfo.resolvedBinaryPath,
      packageRoot: packageInfo.packageRoot,
      env: process.env,
    })
    const managedInstall =
      (await isManagedInstallFingerprint(installFingerprint)) ||
      (await persistManagedInstallFingerprintForSource(installSource, installFingerprint))

    return {
      activeRuntimeSnapshot: candidateRuntimeState.activeRuntimeSnapshot,
      candidateId: installFingerprint.slice(0, 16),
      binaryPath: packageInfo.binaryPath,
      resolvedBinaryPath: packageInfo.resolvedBinaryPath,
      packageRoot: packageInfo.packageRoot,
      version: packageInfo.version,
      installSource,
      isPathActive:
        normalizeForCompare(activeBinaryPath || '') === normalizeForCompare(packageInfo.binaryPath) ||
        normalizeForCompare(activeBinaryPath || '') === normalizeForCompare(packageInfo.resolvedBinaryPath),
      configPath: candidateRuntimeState.configPath,
      stateRoot: candidateRuntimeState.stateRoot,
      displayConfigPath: candidateRuntimeState.displayConfigPath,
      displayStateRoot: candidateRuntimeState.displayStateRoot,
      ownershipState: resolveOwnershipState({
        installSource,
        managedInstall,
        baselineBackup,
        configPath: candidateRuntimeState.configPath,
        stateRoot: candidateRuntimeState.stateRoot,
        env: process.env,
        fallbackOwnership: 'external-preexisting',
      }),
      installFingerprint,
      baselineBackup,
      baselineBackupBypass,
    }
  } catch {
    const resolvedBinaryPath = await realpath(binaryPath).catch(() => binaryPath)
    const version = await runBinaryVersion(binaryPath)
    if (!version) return null

    const packageRoot = path.dirname(resolvedBinaryPath)
    const candidateRuntimeState = resolveCandidateRuntimeStateSnapshot({
      activeBinaryPath,
      binaryPath,
      packageRoot,
      resolvedBinaryPath,
      runtimePaths: openClawPaths,
    })
    const installFingerprint = buildFingerprint(
      resolvedBinaryPath,
      packageRoot,
      version,
      candidateRuntimeState.configPath,
      candidateRuntimeState.stateRoot
    )
    const baselineBackup = await getBaselineBackupStatus(installFingerprint)
    const baselineBackupBypass = await getBaselineBackupBypassStatus(installFingerprint)
    const rawInstallSource = inferOpenClawInstallSource({ binaryPath, resolvedBinaryPath, packageRoot })
    const installSource = await resolveVerifiedInstallSource({
      installSource: rawInstallSource,
      binaryPath,
      resolvedBinaryPath,
      packageRoot,
      env: process.env,
    })
    const managedInstall =
      (await isManagedInstallFingerprint(installFingerprint)) ||
      (await persistManagedInstallFingerprintForSource(installSource, installFingerprint))

    return {
      activeRuntimeSnapshot: candidateRuntimeState.activeRuntimeSnapshot,
      candidateId: installFingerprint.slice(0, 16),
      binaryPath,
      resolvedBinaryPath,
      packageRoot,
      version,
      installSource,
      isPathActive:
        normalizeForCompare(activeBinaryPath || '') === normalizeForCompare(binaryPath) ||
        normalizeForCompare(activeBinaryPath || '') === normalizeForCompare(resolvedBinaryPath),
      configPath: candidateRuntimeState.configPath,
      stateRoot: candidateRuntimeState.stateRoot,
      displayConfigPath: candidateRuntimeState.displayConfigPath,
      displayStateRoot: candidateRuntimeState.displayStateRoot,
      ownershipState: resolveOwnershipState({
        installSource,
        managedInstall,
        baselineBackup,
        configPath: candidateRuntimeState.configPath,
        stateRoot: candidateRuntimeState.stateRoot,
        env: process.env,
        fallbackOwnership: 'unknown-external',
      }),
      installFingerprint,
      baselineBackup,
      baselineBackupBypass,
    }
  }
}

function resolveClosestWindowsNodeBinary(
  openclawExecutable: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (candidatePath: string) => boolean = fs.existsSync
): string {
  const normalizedOpenclawExecutable = String(openclawExecutable || '').trim().toLowerCase()
  const candidates = listExecutablePathCandidates('node', {
    platform: 'win32',
    env,
    currentPath: env.PATH || '',
  })
  const prefersGlobalNpmShim =
    normalizedOpenclawExecutable.includes('\\appdata\\roaming\\npm\\openclaw.') ||
    normalizedOpenclawExecutable.includes('\\appdata\\local\\npm\\openclaw.')

  const preferredSignatures = [
    '.volta\\',
    '.nvm\\',
    '\\fnm\\',
    'fnm_multishell',
    '\\asdf\\',
    '\\mise\\',
    '\\rtx\\',
    '\\program files\\nodejs',
    '\\program files (x86)\\nodejs',
  ].filter((signature) => normalizedOpenclawExecutable.includes(signature))

  let fallbackCandidate = ''
  for (const candidate of candidates) {
    try {
      if (!fileExists(candidate)) continue
      const normalizedCandidate = String(candidate || '').trim().toLowerCase()
      const isProgramFilesNode =
        normalizedCandidate.includes('\\program files\\nodejs') ||
        normalizedCandidate.includes('\\program files (x86)\\nodejs')

      if (prefersGlobalNpmShim && isProgramFilesNode) {
        return candidate
      }
      if (preferredSignatures.some((signature) => normalizedCandidate.includes(signature))) {
        return candidate
      }
      if (!fallbackCandidate && path.dirname(normalizedCandidate) === path.dirname(normalizedOpenclawExecutable)) {
        fallbackCandidate = candidate
      }
    } catch {
      // Ignore invalid candidate checks and continue probing.
    }
  }

  return fallbackCandidate
}

function buildWindowsInstallSnapshot(input: {
  binaryPath: string
  configPath: string
  hostPackageRoot?: string
  stateRoot: string
}): WindowsActiveRuntimeSnapshot | null {
  if (process.platform !== 'win32') return null

  const openclawExecutable = String(input.binaryPath || '').trim()
  const stateRoot = String(input.stateRoot || '').trim()
  const configPath = String(input.configPath || '').trim()
  if (!openclawExecutable || !stateRoot || !configPath) return null

  return buildWindowsActiveRuntimeSnapshot({
    openclawExecutable,
    hostPackageRoot: input.hostPackageRoot,
    nodeExecutable: resolveClosestWindowsNodeBinary(openclawExecutable),
    // This is intentionally a lightweight bin-root hint, not a guaranteed
    // `npm config get prefix` result. Some Windows managers such as Volta
    // expose command shims from a bin directory that does not equal the real
    // package prefix, but the current snapshot only uses this field to add
    // extra executable search candidates.
    npmPrefix: path.dirname(openclawExecutable),
    configPath,
    stateDir: stateRoot,
    extensionsDir: path.join(stateRoot, 'extensions'),
    userDataDir: String(process.env.QCLAW_USER_DATA_DIR || '').trim() || undefined,
  })
}

async function resolveHistoryDataCandidates(
  candidates: WindowsInstallSnapshotCandidate[]
): Promise<OpenClawHistoryDataCandidate[]> {
  // Treat a state root as historical only when one of its runtime-resolved data files exists.
  // This keeps the empty default ~/.openclaw directory out of history-only flows while still
  // supporting custom config filenames discovered from the active runtime.
  const hasHistoryData = async (options: {
    stateRoot?: string
    configFile?: string
    envFile?: string
  }) => {
    const checks = [
      String(options.configFile || '').trim(),
      String(options.envFile || '').trim(),
    ].filter(Boolean)

    for (const targetPath of checks) {
      if (await pathExists(targetPath)) return true
    }

    const stateRoot = String(options.stateRoot || '').trim()
    if (!stateRoot) return false
    return false
  }

  if (candidates.length > 0) {
    const deduped = new Map<string, OpenClawHistoryDataCandidate>()
    for (const candidate of candidates) {
      if (!candidate.stateRoot) continue
      if (!(await pathExists(candidate.stateRoot))) continue
      if (!(await hasHistoryData({
        stateRoot: candidate.stateRoot,
        configFile: candidate.configPath,
        envFile: path.join(candidate.stateRoot, '.env'),
      }))) continue
      if (deduped.has(candidate.stateRoot)) continue
      deduped.set(candidate.stateRoot, {
        path: candidate.stateRoot,
        displayPath: candidate.displayStateRoot,
        reason: 'runtime-state-root',
      })
    }
    if (deduped.size > 0) {
      return Array.from(deduped.values())
    }
  }

  const openClawPaths = resolveOpenClawPaths()
  if (!(await pathExists(openClawPaths.homeDir))) return []
  if (!(await hasHistoryData({
    stateRoot: openClawPaths.homeDir,
    configFile: openClawPaths.configFile,
    envFile: openClawPaths.envFile,
  }))) return []
  return [
    {
      path: openClawPaths.homeDir,
      displayPath: openClawPaths.displayHomeDir,
      reason: 'default-home-dir',
    },
  ]
}

export async function discoverOpenClawInstallationsFromKnownPaths(input: {
  activeBinaryPath?: string | null
  knownPaths?: Array<string | null | undefined>
} = {}): Promise<WindowsOpenClawDiscoveryResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const activeBinaryPath = String(input.activeBinaryPath || '').trim() || null
  const knownPaths = (input.knownPaths || [])
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean)

  const uniquePaths: string[] = []
  const seen = new Set<string>()
  for (const candidatePath of knownPaths) {
    const key = normalizeForCompare(candidatePath)
    if (seen.has(key)) continue
    seen.add(key)
    uniquePaths.push(candidatePath)
  }

  const candidates: WindowsInstallSnapshotCandidate[] = []
  const seenFingerprints = new Set<string>()
  for (const candidatePath of uniquePaths) {
    if (!(await pathExists(candidatePath))) continue
    const candidate = await buildCandidateFromBinary(candidatePath, activeBinaryPath)
    if (!candidate) continue
    if (seenFingerprints.has(candidate.installFingerprint)) continue
    seenFingerprints.add(candidate.installFingerprint)
    candidates.push(candidate)
  }

  candidates.sort((left, right) => {
    if (left.isPathActive && !right.isPathActive) return -1
    if (!left.isPathActive && right.isPathActive) return 1
    return left.binaryPath.localeCompare(right.binaryPath)
  })

  const historyDataCandidates = await resolveHistoryDataCandidates(candidates)
  if (candidates.length > 1) {
    warnings.push('检测到多个 OpenClaw 安装，请确认要接管的对象。')
  }
  if (!activeBinaryPath && candidates.length > 0) {
    warnings.push('已发现 OpenClaw 安装，但当前 PATH 生效项不可可靠判断。')
  }

  const status = candidates.length > 0 ? 'installed' : historyDataCandidates.length > 0 ? 'history-only' : 'absent'
  if (status === 'history-only') {
    warnings.push('检测到历史 OpenClaw 数据，但当前机器缺少可执行的 OpenClaw 环境。')
  }
  const activeCandidateId =
    candidates.find((candidate) => candidate.isPathActive)?.candidateId || candidates[0]?.candidateId || null

  return {
    status,
    candidates,
    activeCandidateId,
    hasMultipleCandidates: candidates.length > 1,
    historyDataCandidates,
    errors,
    warnings,
    defaultBackupDirectory: formatDisplayPath(resolveDefaultBackupDirectory(), homedir()),
  }
}

export async function discoverOpenClawInstallations(): Promise<WindowsOpenClawDiscoveryResult> {
  const activeBinaryPath = await resolveOpenClawBinaryPath().catch(() => null)
  return discoverOpenClawInstallationsFromKnownPaths({
    activeBinaryPath,
    knownPaths: [
      activeBinaryPath,
      ...listExecutablePathCandidates('openclaw', {
        platform: process.platform,
        env: process.env,
        currentPath: process.env.PATH || '',
      }),
    ],
  })
}
