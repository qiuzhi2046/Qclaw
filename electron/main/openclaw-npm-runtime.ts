import type { OpenClawNpmCommandOptions } from './openclaw-download-fallbacks'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'

const { mkdtemp, mkdir, writeFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const { randomUUID } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { join } = path

const OPENCLAW_MANAGED_NPM_SUBDIR = join('openclaw-installer', 'npm')
const OPENCLAW_MANAGED_NPM_USERCONFIG = 'user.npmrc'
const OPENCLAW_MANAGED_NPM_GLOBALCONFIG = 'global.npmrc'
const OPENCLAW_MANAGED_NPM_CACHE_DIR = 'cache'
const OPENCLAW_PRIVILEGED_NPM_CACHE_PREFIX = 'qclaw-openclaw-admin-npm'
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_FETCH_RETRIES = 2

const MANAGED_NPM_CONFIG_CONTENT = [
  'fund=false',
  'audit=false',
  'progress=false',
  'update-notifier=false',
  'prefer-online=true',
  'strict-ssl=true',
].join('\n') + '\n'

export interface ManagedOpenClawNpmRuntime {
  rootDir: string
  userConfigPath: string
  globalConfigPath: string
  cachePath: string
  commandOptions: OpenClawNpmCommandOptions
}

export async function ensureManagedOpenClawNpmRuntime(options: {
  workingDirectory?: string
  fetchTimeoutMs?: number
  fetchRetries?: number
} = {}): Promise<ManagedOpenClawNpmRuntime> {
  const workingDirectory = String(options.workingDirectory || '').trim() || resolveSafeWorkingDirectory()
  const rootDir = join(workingDirectory, OPENCLAW_MANAGED_NPM_SUBDIR)
  const userConfigPath = join(rootDir, OPENCLAW_MANAGED_NPM_USERCONFIG)
  const globalConfigPath = join(rootDir, OPENCLAW_MANAGED_NPM_GLOBALCONFIG)
  const cacheRootDir = join(rootDir, OPENCLAW_MANAGED_NPM_CACHE_DIR)

  await mkdir(rootDir, { recursive: true })
  await mkdir(cacheRootDir, { recursive: true })
  await Promise.all([
    writeFile(userConfigPath, MANAGED_NPM_CONFIG_CONTENT, 'utf8'),
    writeFile(globalConfigPath, MANAGED_NPM_CONFIG_CONTENT, 'utf8'),
  ])
  const cachePath = await mkdtemp(join(cacheRootDir, 'run-'))

  const fetchTimeoutMs = Number(options.fetchTimeoutMs)
  const fetchRetries = Number(options.fetchRetries)

  const commandOptions: OpenClawNpmCommandOptions = {
    userConfigPath,
    globalConfigPath,
    cachePath,
    fetchTimeoutMs:
      Number.isFinite(fetchTimeoutMs) && fetchTimeoutMs > 0
        ? Math.floor(fetchTimeoutMs)
        : DEFAULT_FETCH_TIMEOUT_MS,
    fetchRetries:
      Number.isFinite(fetchRetries) && fetchRetries >= 0
        ? Math.floor(fetchRetries)
        : DEFAULT_FETCH_RETRIES,
    noAudit: true,
    noFund: true,
  }

  return {
    rootDir,
    userConfigPath,
    globalConfigPath,
    cachePath,
    commandOptions,
  }
}

export function createPrivilegedOpenClawNpmCommandOptions(
  options: OpenClawNpmCommandOptions,
  overrides: {
    platform?: NodeJS.Platform
    tempDir?: string
    uuidFactory?: () => string
  } = {}
): OpenClawNpmCommandOptions {
  const platform = overrides.platform || process.platform
  const tempRoot =
    String(overrides.tempDir || '').trim() ||
    (platform === 'darwin' ? '/private/tmp' : tmpdir())
  const suffix = String(overrides.uuidFactory?.() || randomUUID()).trim() || 'run'
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  const cachePath = pathModule.join(
    tempRoot,
    `${OPENCLAW_PRIVILEGED_NPM_CACHE_PREFIX}-${suffix}`,
    'cache'
  )

  return {
    ...options,
    cachePath,
  }
}
