import {
  listExecutablePathCandidates,
  listNodeBinDirCandidates,
} from './runtime-path-discovery'

interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

const MAC_SYSTEM_CERT_FILE_PATH = '/etc/ssl/cert.pem'
const NPM_TLS_CERT_FAILURE_REGEX =
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_OSSL|certificate'

function quotePosixShellArg(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function escapeAppleScriptString(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

export function buildAppleScriptDoShellScript(
  command: string,
  options: {
    administratorPrivileges?: boolean
    prompt?: string
  } = {}
): string {
  const segments = [`do shell script "${escapeAppleScriptString(command)}"`]
  if (options.administratorPrivileges !== false) {
    segments.push('with administrator privileges')
  }
  const prompt = String(options.prompt || '')
  if (prompt.trim()) {
    segments.push(`with prompt "${escapeAppleScriptString(prompt)}"`)
  }
  return segments.join(' ')
}

export function prefixPosixCommandWithWorkingDirectory(
  command: string,
  workingDirectory?: string | null
): string {
  const normalizedWorkingDirectory = String(workingDirectory || '').trim()
  if (!normalizedWorkingDirectory) return command
  return `cd ${quotePosixShellArg(normalizedWorkingDirectory)} && ${command}`
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

function joinPosixPath(baseDir: string, child: string): string {
  const normalizedBase = String(baseDir || '').replace(/\/+$/, '')
  return normalizedBase ? `${normalizedBase}/${child}` : child
}

function dirnameOfPath(filePath: string): string {
  const normalized = String(filePath || '').trim()
  if (!normalized) return ''

  const lastSlashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSlashIndex <= 0) return normalized.startsWith('/') ? '/' : ''
  return normalized.slice(0, lastSlashIndex)
}

export function buildGitHubHttpsRewriteEnvCommands(): string[] {
  const rewritePairs = [
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ] as const

  const commands: string[] = [`export GIT_CONFIG_COUNT=${quotePosixShellArg(String(rewritePairs.length))}`]
  rewritePairs.forEach(([key, value], index) => {
    commands.push(`export GIT_CONFIG_KEY_${index}=${quotePosixShellArg(key)}`)
    commands.push(`export GIT_CONFIG_VALUE_${index}=${quotePosixShellArg(value)}`)
  })
  return commands
}

export function buildNodePathWithCandidates(
  platform: NodeJS.Platform = process.platform,
  currentPath = process.env.PATH || '',
  detectedBinDir: string | null = null,
  appDataDir = process.env.APPDATA || ''
): string {
  const pathSep = platform === 'win32' ? ';' : ':'
  const currentEntries = currentPath
    .split(pathSep)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const preferredEntries = listNodeBinDirCandidates({
    platform,
    currentPath,
    detectedNodeBinDir: detectedBinDir,
    env: {
      ...process.env,
      APPDATA: appDataDir || process.env.APPDATA || '',
      PATH: currentPath,
    },
  })
  const extras = preferredEntries.filter((entry) => {
    const normalized = platform === 'win32' ? entry.toLowerCase() : entry
    return !currentEntries.some((currentEntry) =>
      (platform === 'win32' ? currentEntry.toLowerCase() : currentEntry) === normalized
    )
  })
  if (currentEntries.length === 0) return extras.join(pathSep)
  if (extras.length === 0) return currentEntries.join(pathSep)
  return `${extras.join(pathSep)}${pathSep}${currentEntries.join(pathSep)}`
}

export function listNodeExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  currentPath = process.env.PATH || '',
  detectedBinDir: string | null = null
): string[] {
  return listExecutablePathCandidates('node', {
    platform,
    currentPath,
    detectedNodeBinDir: detectedBinDir,
    env: {
      ...process.env,
      PATH: currentPath,
    },
  })
}

export function extractNodeBinDir(execPathOutput: string): string | null {
  const execPath = execPathOutput
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)

  if (!execPath) return null
  const dir = dirnameOfPath(execPath)
  return dir || null
}

export function buildMacNpmCommand(
  npmArgs: string[],
  options: {
    detectedBinDir?: string | null
    user?: string
    npmCacheDir?: string
    fixCacheOwnership?: boolean
    workingDirectory?: string | null
  } = {}
): string {
  const searchPath = buildNodePathWithCandidates(
    'darwin',
    '',
    options.detectedBinDir ?? null,
    process.env.APPDATA || ''
  )
  const npmCommand = `npm ${npmArgs.map((arg) => quotePosixShellArg(arg)).join(' ')}`
  const commands = [
    `export PATH=${quotePosixShellArg(searchPath)}:$PATH`,
    ...buildGitHubHttpsRewriteEnvCommands(),
    'unset NODE_OPTIONS npm_config_userconfig NPM_CONFIG_USERCONFIG npm_config_globalconfig NPM_CONFIG_GLOBALCONFIG npm_config_prefix NPM_CONFIG_PREFIX npm_config_registry NPM_CONFIG_REGISTRY npm_config_cache NPM_CONFIG_CACHE npm_config_cafile NPM_CONFIG_CAFILE npm_config_ca NPM_CONFIG_CA SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS',
    [
      'qclaw_npm_log="$(mktemp -t qclaw-npm-log.XXXXXX)"',
      `${npmCommand} >"$qclaw_npm_log" 2>&1`,
      'qclaw_npm_status="$?"',
      'cat "$qclaw_npm_log"',
      `if [ "$qclaw_npm_status" -ne 0 ] && grep -Eiq ${quotePosixShellArg(
        NPM_TLS_CERT_FAILURE_REGEX
      )} "$qclaw_npm_log"; then`,
      '  unset npm_config_cafile NPM_CONFIG_CAFILE npm_config_ca NPM_CONFIG_CA',
      `  if [ -f ${quotePosixShellArg(
        MAC_SYSTEM_CERT_FILE_PATH
      )} ]; then export SSL_CERT_FILE=${quotePosixShellArg(MAC_SYSTEM_CERT_FILE_PATH)}; fi`,
      `  ${npmCommand} >"$qclaw_npm_log" 2>&1`,
      '  qclaw_npm_status="$?"',
      '  cat "$qclaw_npm_log"',
      'fi',
      'rm -f "$qclaw_npm_log"',
      '[ "$qclaw_npm_status" -eq 0 ]',
    ].join('\n'),
  ]

  if (options.fixCacheOwnership !== false) {
    commands.push(
      `chown -R ${quotePosixShellArg(options.user || process.env.USER || 'root')} ${quotePosixShellArg(
        options.npmCacheDir || joinPosixPath(process.env.HOME || '', '.npm')
      )}`
    )
  }

  return prefixPosixCommandWithWorkingDirectory(commands.join(' && '), options.workingDirectory)
}

export function buildWindowsNpmCommand(
  npmArgs: string[],
  options: {
    detectedBinDir?: string | null
    npmCacheDir?: string
    workingDirectory?: string | null
  } = {}
): { command: string; args: string[]; shell: boolean } {
  // On Windows we invoke npm.cmd directly; PATH augmentation is handled by the caller via env.
  const npmExecutable = 'npm.cmd'
  return {
    command: npmExecutable,
    args: npmArgs,
    shell: true,
  }
}

export function isNodeVersionAtLeast(currentVersion: string, requiredVersion: string): boolean {
  const current = parseSemver(currentVersion)
  const required = parseSemver(requiredVersion)
  if (!current || !required) return false

  if (current.major !== required.major) return current.major > required.major
  if (current.minor !== required.minor) return current.minor > required.minor
  return current.patch >= required.patch
}
