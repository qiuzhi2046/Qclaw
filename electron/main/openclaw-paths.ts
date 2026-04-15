const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export interface OpenClawPaths {
  homeDir: string
  configFile: string
  envFile: string
  credentialsDir: string
  modelCatalogCacheFile: string
  displayHomeDir: string
  displayConfigFile: string
  displayEnvFile: string
  displayCredentialsDir: string
  displayModelCatalogCacheFile: string
}

interface ResolveOpenClawPathsOptions {
  homeDir?: string
  platform?: NodeJS.Platform
}

interface ResolveOpenClawPathsFromStateRootOptions {
  stateRoot: string
  configFile?: string
  homeDir?: string
  platform?: NodeJS.Platform
}

function trimTrailingSeparators(value: string, platform: NodeJS.Platform): string {
  if (!value) return ''
  const pattern = platform === 'win32' ? /[\\/]+$/ : /\/+$/
  return value.replace(pattern, '')
}

function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts)
}

export function resolveUserHomeDir(platform: NodeJS.Platform = process.platform): string {
  return String(
    platform === 'win32'
      ? process.env.USERPROFILE || process.env.HOME || os.homedir()
      : process.env.HOME || process.env.USERPROFILE || os.homedir()
  ).trim()
}

export function expandDisplayPath(
  inputPath: string,
  userHomeDir?: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedPath = String(inputPath || '').trim()
  if (!normalizedPath) return ''

  const normalizedHomeDir = trimTrailingSeparators(
    String(userHomeDir || resolveUserHomeDir(platform)).trim(),
    platform
  )
  if (!normalizedHomeDir) return normalizedPath

  if (normalizedPath === '~') return normalizedHomeDir
  if (normalizedPath.startsWith('~/') || normalizedPath.startsWith('~\\')) {
    return joinForPlatform(platform, normalizedHomeDir, normalizedPath.slice(2))
  }

  return normalizedPath
}

export function formatDisplayPath(
  absolutePath: string,
  userHomeDir?: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedPath = String(absolutePath || '').trim()
  const normalizedHomeDir = trimTrailingSeparators(
    String(userHomeDir || resolveUserHomeDir(platform)).trim(),
    platform
  )
  if (!normalizedPath || !normalizedHomeDir) return normalizedPath

  const remainder = normalizedPath.slice(normalizedHomeDir.length)
  const isMatch =
    normalizedPath === normalizedHomeDir ||
    (normalizedPath.startsWith(normalizedHomeDir) &&
      (remainder.startsWith('/') || remainder.startsWith('\\')))

  if (!isMatch) return normalizedPath
  return `~${normalizedPath.slice(normalizedHomeDir.length)}`
}

export function resolveOpenClawPaths(
  options: ResolveOpenClawPathsOptions = {}
): OpenClawPaths {
  const platform = options.platform || process.platform
  const userHomeDir = trimTrailingSeparators(
    String(options.homeDir || resolveUserHomeDir(platform)).trim(),
    platform
  )
  const openClawHomeDir = joinForPlatform(platform, userHomeDir, '.openclaw')
  const configFile = joinForPlatform(platform, openClawHomeDir, 'openclaw.json')
  const envFile = joinForPlatform(platform, openClawHomeDir, '.env')
  const credentialsDir = joinForPlatform(platform, openClawHomeDir, 'credentials')
  const modelCatalogCacheFile = joinForPlatform(platform, openClawHomeDir, 'qclaw-model-catalog-cache.json')

  return {
    homeDir: openClawHomeDir,
    configFile,
    envFile,
    credentialsDir,
    modelCatalogCacheFile,
    displayHomeDir: formatDisplayPath(openClawHomeDir, userHomeDir, platform),
    displayConfigFile: formatDisplayPath(configFile, userHomeDir, platform),
    displayEnvFile: formatDisplayPath(envFile, userHomeDir, platform),
    displayCredentialsDir: formatDisplayPath(credentialsDir, userHomeDir, platform),
    displayModelCatalogCacheFile: formatDisplayPath(modelCatalogCacheFile, userHomeDir, platform),
  }
}

export function resolveOpenClawPathsFromStateRoot(
  options: ResolveOpenClawPathsFromStateRootOptions
): OpenClawPaths {
  const platform = options.platform || process.platform
  const userHomeDir = trimTrailingSeparators(
    String(options.homeDir || resolveUserHomeDir(platform)).trim(),
    platform
  )
  const openClawHomeDir = trimTrailingSeparators(
    expandDisplayPath(String(options.stateRoot || '').trim(), userHomeDir, platform),
    platform
  )
  const configFile = expandDisplayPath(
    String(options.configFile || joinForPlatform(platform, openClawHomeDir, 'openclaw.json')).trim(),
    userHomeDir,
    platform
  )
  const envFile = joinForPlatform(platform, openClawHomeDir, '.env')
  const credentialsDir = joinForPlatform(platform, openClawHomeDir, 'credentials')
  const modelCatalogCacheFile = joinForPlatform(platform, openClawHomeDir, 'qclaw-model-catalog-cache.json')

  return {
    homeDir: openClawHomeDir,
    configFile,
    envFile,
    credentialsDir,
    modelCatalogCacheFile,
    displayHomeDir: formatDisplayPath(openClawHomeDir, userHomeDir, platform),
    displayConfigFile: formatDisplayPath(configFile, userHomeDir, platform),
    displayEnvFile: formatDisplayPath(envFile, userHomeDir, platform),
    displayCredentialsDir: formatDisplayPath(credentialsDir, userHomeDir, platform),
    displayModelCatalogCacheFile: formatDisplayPath(modelCatalogCacheFile, userHomeDir, platform),
  }
}
