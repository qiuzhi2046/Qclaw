import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import {
  resolveWindowsPrivateNodeRuntimePaths,
  resolveWindowsPrivateOpenClawRuntimePaths,
} from './platforms/windows/windows-runtime-policy'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export type ExecutableSearchTarget = 'node' | 'openclaw'

interface RuntimePathDiscoveryOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  currentPath?: string
  detectedNodeBinDir?: string | null
  npmPrefix?: string | null
}

interface NormalizedRuntimePathDiscoveryOptions {
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  currentPath: string
  detectedNodeBinDir: string | null
  npmPrefix: string | null
}

const SHARED_EXTRA_BIN_DIRS_ENV = 'QCLAW_CLI_EXTRA_BIN_DIRS'
const NODE_EXTRA_BIN_DIRS_ENV = 'QCLAW_NODE_EXTRA_BIN_DIRS'
const OPENCLAW_EXTRA_BIN_DIRS_ENV = 'QCLAW_OPENCLAW_EXTRA_BIN_DIRS'

const POSIX_SHARED_BIN_DIR_SUFFIX = 'homebrew/bin'
const POSIX_SHARED_STATIC_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

function normalizeRuntime(
  options: RuntimePathDiscoveryOptions = {}
): NormalizedRuntimePathDiscoveryOptions {
  const platform = options.platform || process.platform
  return {
    activeRuntimeSnapshot:
      options.activeRuntimeSnapshot ?? (platform === 'win32' ? getSelectedWindowsActiveRuntimeSnapshot() : null),
    platform,
    env: options.env || process.env,
    currentPath:
      options.currentPath !== undefined
        ? options.currentPath
        : String((options.env || process.env).PATH || ''),
    detectedNodeBinDir: options.detectedNodeBinDir ?? null,
    npmPrefix: options.npmPrefix ?? null,
  }
}

function pathSeparatorFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function trimTrailingSeparators(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return `${trimmed[0]}:\\`
  }
  if (trimmed === '/') return '/'
  return trimmed.replace(/[\\/]+$/, '')
}

function uniqueNonEmpty(
  values: Array<string | null | undefined>,
  platform: NodeJS.Platform
): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    const trimmed = trimTrailingSeparators(String(value || ''))
    if (!trimmed) continue
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

function splitPathEntries(value: string, platform: NodeJS.Platform): string[] {
  return uniqueNonEmpty(value.split(pathSeparatorFor(platform)), platform)
}

function isPosixAbsolutePath(value: string): boolean {
  const trimmed = String(value || '').trim()
  return trimmed.startsWith('/') && !trimmed.startsWith('//')
}

function pathModuleForPath(basePath: string, platform: NodeJS.Platform): typeof path.posix {
  if (platform === 'win32' && isPosixAbsolutePath(basePath)) {
    return path.posix
  }
  return platform === 'win32' ? path.win32 : path.posix
}

function joinBinPath(baseDir: string, child: string, platform: NodeJS.Platform): string {
  return pathModuleForPath(baseDir, platform).join(baseDir, child)
}

function dirnameForPath(value: string, platform: NodeJS.Platform): string {
  return pathModuleForPath(value, platform).dirname(value)
}

function resolveEnvValue(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] || '').trim()
}

function resolveExtraBinDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  envNames: string[]
): string[] {
  const items: string[] = []
  for (const envName of envNames) {
    const raw = resolveEnvValue(env, envName)
    if (!raw) continue
    items.push(...splitPathEntries(raw, platform))
  }
  return uniqueNonEmpty(items, platform)
}

function toBinDir(value: string, platform: NodeJS.Platform): string {
  const normalized = trimTrailingSeparators(value)
  if (!normalized) return ''
  if (/[\\/]bin$/i.test(normalized)) {
    return normalized
  }
  return joinBinPath(normalized, 'bin', platform)
}

function resolveToolManagerBinDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const candidates: string[] = []
  const nvmBin = resolveEnvValue(env, 'NVM_BIN')
  const nvmSymlink = resolveEnvValue(env, 'NVM_SYMLINK')
  const voltaHome = resolveEnvValue(env, 'VOLTA_HOME')
  const fnmMultishellPath = resolveEnvValue(env, 'FNM_MULTISHELL_PATH')
  const asdfDataDir = resolveEnvValue(env, 'ASDF_DATA_DIR')
  const asdfDir = resolveEnvValue(env, 'ASDF_DIR')
  const pnpmHome = resolveEnvValue(env, 'PNPM_HOME')
  const miseShimsDir = resolveEnvValue(env, 'MISE_SHIMS_DIR')
  const miseDataDir = resolveEnvValue(env, 'MISE_DATA_DIR')
  const rtxBinHome = resolveEnvValue(env, 'RTX_BIN_HOME')

  if (nvmBin) candidates.push(nvmBin)
  if (nvmSymlink) candidates.push(nvmSymlink)
  if (voltaHome) candidates.push(joinBinPath(voltaHome, 'bin', platform))
  if (fnmMultishellPath) candidates.push(toBinDir(fnmMultishellPath, platform))
  if (asdfDataDir) candidates.push(joinBinPath(asdfDataDir, 'shims', platform))
  if (asdfDir) candidates.push(joinBinPath(asdfDir, 'shims', platform))
  if (pnpmHome) candidates.push(pnpmHome)
  if (miseShimsDir) candidates.push(miseShimsDir)
  if (miseDataDir) candidates.push(joinBinPath(miseDataDir, 'shims', platform))
  if (rtxBinHome) candidates.push(rtxBinHome)

  return uniqueNonEmpty(candidates, platform)
}

function resolveNpmPrefixDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  npmPrefix: string | null
): string[] {
  const prefixes = uniqueNonEmpty(
    [
      npmPrefix,
      resolveEnvValue(env, 'npm_config_prefix'),
      resolveEnvValue(env, 'NPM_CONFIG_PREFIX'),
    ],
    platform
  )
  const candidates: string[] = []
  for (const prefix of prefixes) {
    if (platform === 'win32') {
      candidates.push(prefix, joinBinPath(prefix, 'bin', platform))
    } else {
      candidates.push(joinBinPath(prefix, 'bin', platform), prefix)
    }
  }
  return uniqueNonEmpty(candidates, platform)
}

function resolveWindowsActiveRuntimeSnapshotBinDirs(
  platform: NodeJS.Platform,
  snapshot: WindowsActiveRuntimeSnapshot | null
): string[] {
  if (platform !== 'win32' || !snapshot) return []

  const openclawBinDir = snapshot.openclawPath ? dirnameForPath(snapshot.openclawPath, platform) : ''
  const nodeBinDir = snapshot.nodePath ? dirnameForPath(snapshot.nodePath, platform) : ''

  return uniqueNonEmpty(
    [openclawBinDir, nodeBinDir, snapshot.npmPrefix],
    'win32'
  )
}

function resolveWindowsPrivateNodeBinDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform !== 'win32') return []
  const paths = resolveWindowsPrivateNodeRuntimePaths({ env })
  return uniqueNonEmpty([paths.nodeBinDir], platform)
}

function resolveWindowsPrivateOpenClawBinDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform !== 'win32') return []
  const paths = resolveWindowsPrivateOpenClawRuntimePaths({ env })
  return uniqueNonEmpty([path.win32.dirname(paths.openclawExecutable), paths.npmPrefix], platform)
}

function resolvePosixSharedBinDirs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const homeDir = resolveEnvValue(env, 'HOME')
  return uniqueNonEmpty(
    [
      homeDir ? joinBinPath(homeDir, POSIX_SHARED_BIN_DIR_SUFFIX, platform) : '',
      ...POSIX_SHARED_STATIC_BIN_DIRS,
    ],
    platform
  )
}

function resolveNodeCommonBinDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return uniqueNonEmpty(
      [
        joinBinPath(resolveEnvValue(env, 'ProgramFiles') || 'C:\\Program Files', 'nodejs', platform),
        joinBinPath(
          resolveEnvValue(env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)',
          'nodejs',
          platform
        ),
      ],
      platform
    )
  }
  return uniqueNonEmpty([...resolvePosixSharedBinDirs(platform, env), '/usr/bin'], platform)
}

function resolveOpenClawCommonBinDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const appData = resolveEnvValue(env, 'APPDATA')
    const userProfile = resolveEnvValue(env, 'USERPROFILE')
    return uniqueNonEmpty(
      [
        appData ? joinBinPath(appData, 'npm', platform) : '',
        userProfile ? joinBinPath(userProfile, 'AppData\\Roaming\\npm', platform) : '',
      ],
      platform
    )
  }

  const homeDir = resolveEnvValue(env, 'HOME')
  return uniqueNonEmpty(
    [
      homeDir ? joinBinPath(homeDir, '.npm-global/bin', platform) : '',
      ...resolvePosixSharedBinDirs(platform, env),
    ],
    platform
  )
}

function listAugmentBinDirs(options: NormalizedRuntimePathDiscoveryOptions): string[] {
  return uniqueNonEmpty(
    [
      ...resolveWindowsActiveRuntimeSnapshotBinDirs(options.platform, options.activeRuntimeSnapshot),
      ...resolveExtraBinDirs(options.env, options.platform, [
        SHARED_EXTRA_BIN_DIRS_ENV,
        NODE_EXTRA_BIN_DIRS_ENV,
        OPENCLAW_EXTRA_BIN_DIRS_ENV,
      ]),
      options.detectedNodeBinDir,
      ...resolveToolManagerBinDirs(options.platform, options.env),
      ...resolveNpmPrefixDirs(options.platform, options.env, options.npmPrefix),
      ...resolveWindowsPrivateNodeBinDirs(options.platform, options.env),
      ...resolveWindowsPrivateOpenClawBinDirs(options.platform, options.env),
      ...resolveNodeCommonBinDirs(options.platform, options.env),
      ...resolveOpenClawCommonBinDirs(options.platform, options.env),
    ],
    options.platform
  )
}

export function buildCliPathWithCandidates(options: RuntimePathDiscoveryOptions = {}): string {
  const runtime = normalizeRuntime(options)
  const currentEntries = splitPathEntries(runtime.currentPath, runtime.platform)
  const extras = listAugmentBinDirs(runtime).filter((item) => {
    const normalizedItem = runtime.platform === 'win32' ? item.toLowerCase() : item
    return !currentEntries.some((entry) =>
      (runtime.platform === 'win32' ? entry.toLowerCase() : entry) === normalizedItem
    )
  })

  if (currentEntries.length === 0) {
    return extras.join(pathSeparatorFor(runtime.platform))
  }
  if (extras.length === 0) {
    return currentEntries.join(pathSeparatorFor(runtime.platform))
  }
  return `${extras.join(pathSeparatorFor(runtime.platform))}${pathSeparatorFor(runtime.platform)}${currentEntries.join(pathSeparatorFor(runtime.platform))}`
}

export function listNodeBinDirCandidates(options: RuntimePathDiscoveryOptions = {}): string[] {
  const runtime = normalizeRuntime(options)
  return uniqueNonEmpty(
    [
      ...resolveWindowsActiveRuntimeSnapshotBinDirs(runtime.platform, runtime.activeRuntimeSnapshot),
      ...resolveExtraBinDirs(runtime.env, runtime.platform, [
        SHARED_EXTRA_BIN_DIRS_ENV,
        NODE_EXTRA_BIN_DIRS_ENV,
      ]),
      ...splitPathEntries(runtime.currentPath, runtime.platform),
      ...resolveWindowsPrivateNodeBinDirs(runtime.platform, runtime.env),
      runtime.detectedNodeBinDir,
      ...resolveToolManagerBinDirs(runtime.platform, runtime.env),
      ...resolveNodeCommonBinDirs(runtime.platform, runtime.env),
    ],
    runtime.platform
  )
}

export function listOpenClawBinDirCandidates(options: RuntimePathDiscoveryOptions = {}): string[] {
  const runtime = normalizeRuntime(options)
  return uniqueNonEmpty(
    [
      ...resolveWindowsActiveRuntimeSnapshotBinDirs(runtime.platform, runtime.activeRuntimeSnapshot),
      ...resolveExtraBinDirs(runtime.env, runtime.platform, [
        SHARED_EXTRA_BIN_DIRS_ENV,
        OPENCLAW_EXTRA_BIN_DIRS_ENV,
      ]),
      ...splitPathEntries(runtime.currentPath, runtime.platform),
      ...resolveNpmPrefixDirs(runtime.platform, runtime.env, runtime.npmPrefix),
      ...resolveWindowsPrivateOpenClawBinDirs(runtime.platform, runtime.env),
      ...resolveToolManagerBinDirs(runtime.platform, runtime.env),
      ...resolveOpenClawCommonBinDirs(runtime.platform, runtime.env),
    ],
    runtime.platform
  )
}

function getExecutableNames(
  target: ExecutableSearchTarget,
  platform: NodeJS.Platform
): string[] {
  if (target === 'node') {
    return platform === 'win32' ? ['node.exe'] : ['node']
  }
  return platform === 'win32'
    ? ['openclaw.cmd', 'openclaw.exe', 'openclaw']
    : ['openclaw']
}

export function listExecutablePathCandidates(
  target: ExecutableSearchTarget,
  options: RuntimePathDiscoveryOptions = {}
): string[] {
  const runtime = normalizeRuntime(options)
  const binDirs =
    target === 'node'
      ? listNodeBinDirCandidates(runtime)
      : listOpenClawBinDirCandidates(runtime)
  const executableNames = getExecutableNames(target, runtime.platform)
  const candidates: string[] = []

  for (const binDir of binDirs) {
    for (const executableName of executableNames) {
      candidates.push(joinBinPath(binDir, executableName, runtime.platform))
    }
  }

  return uniqueNonEmpty(candidates, runtime.platform)
}
