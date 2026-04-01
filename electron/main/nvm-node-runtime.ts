const fsPromises = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

interface NvmDirentLike {
  name: string
  isDirectory(): boolean
}

interface ListInstalledNvmNodeBinDirsOptions {
  readdir?: (
    path: string,
    options: { withFileTypes: true }
  ) => Promise<Array<NvmDirentLike | import('node:fs').Dirent>>
  pathModule?: typeof import('node:path')
}

interface DetectNvmDirOptions {
  env?: NodeJS.ProcessEnv
  access?: (path: string) => Promise<void>
  homedir?: () => string
  pathModule?: typeof import('node:path')
}

interface DetectNvmWindowsDirOptions {
  env?: NodeJS.ProcessEnv
  access?: (path: string) => Promise<void>
  pathModule?: typeof import('node:path')
}

interface ListInstalledNvmWindowsNodeExePathsOptions {
  readdir?: (
    path: string,
    options: { withFileTypes: true }
  ) => Promise<Array<NvmDirentLike | import('node:fs').Dirent>>
  pathModule?: typeof import('node:path')
}

function parseSemver(version: string): ParsedSemver | null {
  const matched = String(version || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!matched) return null

  return {
    major: Number(matched[1] || 0),
    minor: Number(matched[2] || 0),
    patch: Number(matched[3] || 0),
  }
}

function compareSemverDescending(left: string, right: string): number {
  const leftParsed = parseSemver(left)
  const rightParsed = parseSemver(right)
  if (!leftParsed && !rightParsed) return 0
  if (!leftParsed) return 1
  if (!rightParsed) return -1
  if (leftParsed.major !== rightParsed.major) return rightParsed.major - leftParsed.major
  if (leftParsed.minor !== rightParsed.minor) return rightParsed.minor - leftParsed.minor
  return rightParsed.patch - leftParsed.patch
}

function quotePosixShellArg(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function normalizeNvmInstallVersion(version: string): string {
  return String(version || '').trim().replace(/^v/, '')
}

export function normalizeNvmVersionTag(version: string): string {
  const normalized = normalizeNvmInstallVersion(version)
  return normalized ? `v${normalized}` : ''
}

export function buildNvmNodeBinDir(
  nvmDir: string,
  version: string,
  pathModule: typeof import('node:path') = path
): string {
  return pathModule.join(nvmDir, 'versions', 'node', normalizeNvmVersionTag(version), 'bin')
}

export function buildNvmShellPrefix(nvmDir: string): string {
  return `export NVM_DIR=${quotePosixShellArg(nvmDir)} && source ${quotePosixShellArg(`${nvmDir}/nvm.sh`)}`
}

export function buildNvmInstallCommand(nvmDir: string, targetVersion: string): string {
  const version = normalizeNvmInstallVersion(targetVersion)
  return `${buildNvmShellPrefix(nvmDir)} && nvm install ${quotePosixShellArg(version)} && nvm use ${quotePosixShellArg(version)}`
}

export function buildNvmUseCommand(nvmDir: string, targetVersion: string): string {
  const version = normalizeNvmInstallVersion(targetVersion)
  return `${buildNvmShellPrefix(nvmDir)} && nvm use ${quotePosixShellArg(version)}`
}

export async function listInstalledNvmNodeBinDirs(
  nvmDir: string,
  options: ListInstalledNvmNodeBinDirsOptions = {}
): Promise<string[]> {
  const readdir =
    options.readdir ||
    ((targetPath, readOptions) => fsPromises.readdir(targetPath, readOptions))
  const pathModule = options.pathModule || path

  let entries: Array<NvmDirentLike | import('node:fs').Dirent> = []
  try {
    entries = await readdir(pathModule.join(nvmDir, 'versions', 'node'), { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && parseSemver(entry.name))
    .sort((left, right) => compareSemverDescending(left.name, right.name))
    .map((entry) => pathModule.join(nvmDir, 'versions', 'node', entry.name, 'bin'))
}

export async function detectNvmWindowsDir(
  options: DetectNvmWindowsDirOptions = {}
): Promise<string | null> {
  const env = options.env || process.env
  const access =
    options.access ||
    (async (targetPath: string) => {
      await fsPromises.access(targetPath)
    })
  const pathModule = options.pathModule || path

  const nvmHome = String(env.NVM_HOME || '').trim()
  if (nvmHome) return nvmHome

  const appData = String(env.APPDATA || '').trim()
  if (!appData) return null

  const fallbackDir = pathModule.join(appData, 'nvm')
  try {
    await access(fallbackDir)
    return fallbackDir
  } catch {
    return null
  }
}

export async function listInstalledNvmWindowsNodeExePaths(
  nvmWindowsDir: string,
  options: ListInstalledNvmWindowsNodeExePathsOptions = {}
): Promise<string[]> {
  const readdir =
    options.readdir ||
    ((targetPath, readOptions) => fsPromises.readdir(targetPath, readOptions))
  const pathModule = options.pathModule || path

  let entries: Array<NvmDirentLike | import('node:fs').Dirent> = []
  try {
    entries = await readdir(nvmWindowsDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && parseSemver(entry.name))
    .sort((left, right) => compareSemverDescending(left.name, right.name))
    .map((entry) => pathModule.join(nvmWindowsDir, entry.name, 'node.exe'))
}

export async function detectNvmDir(
  options: DetectNvmDirOptions = {}
): Promise<string | null> {
  const env = options.env || process.env
  const access =
    options.access ||
    (async (targetPath: string) => {
      await fsPromises.access(targetPath)
    })
  const homedir = options.homedir || (() => process.env.HOME || '')
  const pathModule = options.pathModule || path

  const configuredNvmDir = String(env.NVM_DIR || '').trim()
  if (configuredNvmDir) return configuredNvmDir

  const nvmBin = String(env.NVM_BIN || '').trim()
  if (nvmBin) {
    const normalizedNvmBin = nvmBin.replace(/\\/g, '/')
    const markerIndex = normalizedNvmBin.lastIndexOf('/.nvm/')
    if (markerIndex >= 0) {
      return normalizedNvmBin.slice(0, markerIndex + '/.nvm'.length)
    }
    return pathModule.resolve(nvmBin, '..', '..', '..', '..')
  }

  const homeDir = String(homedir() || '').trim()
  if (!homeDir) return null

  const fallbackDir = pathModule.join(homeDir, '.nvm')
  try {
    await access(pathModule.join(fallbackDir, 'nvm.sh'))
    return fallbackDir
  } catch {
    return null
  }
}
