import { parseJsonFromOutput } from './openclaw-command-output'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { resolveOpenClawBinaryPath } from './openclaw-package'
import {
  expandDisplayPath,
  resolveOpenClawPaths,
  resolveOpenClawPathsFromStateRoot,
  resolveUserHomeDir,
  type OpenClawPaths,
} from './openclaw-paths'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { spawn } = childProcess

export interface RuntimePathCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

interface RuntimeBackupPlanAsset {
  kind?: string
  sourcePath?: string
  displayPath?: string
}

interface RuntimeBackupPlan {
  assets?: RuntimeBackupPlanAsset[]
}

interface ResolveRuntimeOpenClawPathsOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  binaryPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cacheTtlMs?: number
  runCommand?: (binaryPath: string, args: string[]) => Promise<RuntimePathCommandResult>
}

const DEFAULT_RUNTIME_PATH_CACHE_TTL_MS = 15_000

let cachedKey = ''
let cachedRuntimePaths: OpenClawPaths | null = null
let cachedAt = 0
let cachedProbeKey = ''
let cachedRuntimePathsPromise: Promise<OpenClawPaths> | null = null

function resolveRuntimeHomeDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined
): string {
  const fallback = resolveUserHomeDir(platform)
  return String(
    platform === 'win32'
      ? env?.USERPROFILE || env?.HOME || fallback
      : env?.HOME || env?.USERPROFILE || fallback
  ).trim() || fallback
}

function stripWrappingQuotes(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function findConfigPathLine(stdout: string): string | null {
  const lines = String(stdout || '').split(/\r?\n/g)
  const pathPattern = /((?:~|\/|[A-Za-z]:[\\/]).*openclaw\.json)\s*$/i

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripWrappingQuotes(lines[index])
    if (!line) continue
    const matched = line.match(pathPattern)
    if (matched?.[1]) {
      return matched[1]
    }
  }

  return null
}

function resolveFallbackPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv | undefined
): OpenClawPaths {
  const envHomeDir = resolveRuntimeHomeDir(platform, env)

  return resolveOpenClawPaths({
    homeDir: envHomeDir,
    platform,
  })
}

async function defaultRunCommand(
  binaryPath: string,
  args: string[],
  options: ResolveRuntimeOpenClawPathsOptions
): Promise<RuntimePathCommandResult> {
  return new Promise((resolve) => {
    const runtimeEnv = options.env || process.env
    const isWindowsCmd = (options.platform || process.platform) === 'win32' && /\.cmd$/i.test(binaryPath)
    const proc = spawn(binaryPath, args, {
      cwd: resolveSafeWorkingDirectory({
        env: runtimeEnv,
        platform: options.platform || process.platform,
      }),
      env: runtimeEnv,
      shell: isWindowsCmd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: (options.platform || process.platform) === 'win32',
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', (error) => {
      resolve({
        ok: false,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        code: 1,
      })
    })
    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code,
      })
    })
  })
}

function parseRuntimeConfigPath(
  stdout: string,
  platform: NodeJS.Platform,
  userHomeDir: string
): string | null {
  const configLine = findConfigPathLine(stdout)
  if (!configLine) return null
  return expandDisplayPath(configLine, userHomeDir, platform)
}

function parseRuntimeStateRoot(
  stdout: string,
  platform: NodeJS.Platform,
  userHomeDir: string
): string | null {
  try {
    const payload = parseJsonFromOutput<RuntimeBackupPlan>(stdout)
    const stateAsset =
      (payload.assets || []).find((asset) => String(asset.kind || '').trim() === 'state') || null
    const rawPath = String(stateAsset?.sourcePath || stateAsset?.displayPath || '').trim()
    if (!rawPath) return null
    return expandDisplayPath(rawPath, userHomeDir, platform)
  } catch {
    return null
  }
}

export function resetRuntimeOpenClawPathsCache(): void {
  cachedKey = ''
  cachedRuntimePaths = null
  cachedAt = 0
  cachedProbeKey = ''
  cachedRuntimePathsPromise = null
}

export async function resolveRuntimeOpenClawPaths(
  options: ResolveRuntimeOpenClawPathsOptions = {}
): Promise<OpenClawPaths> {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const activeRuntimeSnapshot =
    options.activeRuntimeSnapshot ?? (platform === 'win32' ? getSelectedWindowsActiveRuntimeSnapshot() : null)
  const userHomeDir = resolveRuntimeHomeDir(platform, env)
  const fallback = resolveFallbackPaths(platform, env)

  if (platform === 'win32' && activeRuntimeSnapshot) {
    return resolveOpenClawPathsFromStateRoot({
      stateRoot: activeRuntimeSnapshot.stateDir,
      configFile: activeRuntimeSnapshot.configPath,
      homeDir: userHomeDir,
      platform,
    })
  }

  const resolvedBinaryPath = String(
    options.binaryPath ||
      (await resolveOpenClawBinaryPath({
        activeRuntimeSnapshot,
        env,
        platform,
      }).catch(() => ''))
  ).trim()
  if (!resolvedBinaryPath) return fallback
  const cacheKey = `${resolvedBinaryPath}\n${userHomeDir}\n${platform}`

  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_RUNTIME_PATH_CACHE_TTL_MS
  if (
    cachedRuntimePaths &&
    cachedKey === cacheKey &&
    Date.now() - cachedAt < cacheTtlMs
  ) {
    return cachedRuntimePaths
  }

  if (cachedRuntimePathsPromise && cachedProbeKey === cacheKey) {
    return cachedRuntimePathsPromise
  }

  const runCommand = async (args: string[]) =>
    (options.runCommand || ((binaryPath: string, commandArgs: string[]) => defaultRunCommand(binaryPath, commandArgs, options)))(
      resolvedBinaryPath,
      args
    )

  const probePromise = (async () => {
    const [configResult, backupResult] = await Promise.all([
      runCommand(['config', 'file']),
      runCommand(['backup', 'create', '--dry-run', '--json']),
    ])

    const configFile = configResult.ok
      ? parseRuntimeConfigPath(configResult.stdout, platform, userHomeDir)
      : null
    const stateRoot = backupResult.ok
      ? parseRuntimeStateRoot(backupResult.stdout, platform, userHomeDir)
      : null

    if (!configFile && !stateRoot) {
      cachedKey = cacheKey
      cachedRuntimePaths = fallback
      cachedAt = Date.now()
      return fallback
    }

    const nextPaths = resolveOpenClawPathsFromStateRoot({
      stateRoot: stateRoot || path.dirname(configFile || fallback.configFile),
      configFile: configFile || undefined,
      homeDir: userHomeDir,
      platform,
    })

    cachedKey = cacheKey
    cachedRuntimePaths = nextPaths
    cachedAt = Date.now()
    return nextPaths
  })()

  cachedProbeKey = cacheKey
  cachedRuntimePathsPromise = probePromise

  try {
    return await probePromise
  } finally {
    if (cachedRuntimePathsPromise === probePromise) {
      cachedProbeKey = ''
      cachedRuntimePathsPromise = null
    }
  }
}
