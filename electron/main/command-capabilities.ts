const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
import { resolveSafeWorkingDirectory } from './runtime-working-directory'

export type PlatformCommandId =
  | 'openclaw'
  | 'node'
  | 'npm'
  | 'npx'
  | 'git'
  | 'brew'
  | 'expect'
  | 'script'
  | 'powershell'
  | 'msiexec'
  | 'osascript'
  | 'installer'
  | 'launchctl'
  | 'pkgutil'
  | 'spctl'
  | 'id'
  | 'rm'
  | 'rmdir'

export interface CommandLookupInvocation {
  command: string
  args: string[]
  shell: boolean
}

export interface CommandCapabilityProbeResult {
  id: PlatformCommandId
  platform: NodeJS.Platform
  command: string
  supported: boolean
  available: boolean
  source: 'named-command' | 'shell-builtin' | 'unsupported-platform'
  message: string
  resolvedPath?: string
}

interface CommandCapabilitySpec {
  command: string
  supportedPlatforms: NodeJS.Platform[]
  source: 'named-command' | 'shell-builtin'
  missingMessage: string
  unsupportedMessage: string
}

interface CommandCapabilityRuntime {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

interface ProbeCommandCapabilityOptions extends CommandCapabilityRuntime {
  commandPathResolver?: (
    commandName: string,
    invocation: CommandLookupInvocation
  ) => Promise<string>
}

type CommandPathResolver = NonNullable<ProbeCommandCapabilityOptions['commandPathResolver']>

const COMMAND_CAPABILITY_SPECS: Record<PlatformCommandId, CommandCapabilitySpec> = {
  openclaw: {
    command: 'openclaw',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    source: 'named-command',
    missingMessage: 'OpenClaw 命令行工具命令不可用。请先在环境检查中完成安装后再试。',
    unsupportedMessage: '当前平台暂不支持检测 OpenClaw 命令行工具命令。',
  },
  node: {
    command: 'node',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    source: 'named-command',
    missingMessage: 'Node.js command is unavailable. Install or repair Node.js before continuing.',
    unsupportedMessage: 'Node.js command probing is unavailable on this platform.',
  },
  npm: {
    command: 'npm',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    source: 'named-command',
    missingMessage: 'npm command is unavailable. Install or repair Node.js before continuing.',
    unsupportedMessage: 'npm command probing is unavailable on this platform.',
  },
  npx: {
    command: 'npx',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    source: 'named-command',
    missingMessage: 'npx command is unavailable. Install or repair Node.js before continuing.',
    unsupportedMessage: 'npx command probing is unavailable on this platform.',
  },
  git: {
    command: 'git',
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    source: 'named-command',
    missingMessage:
      'git command is unavailable. Install Git first (on macOS run `xcode-select --install`) before continuing.',
    unsupportedMessage: 'git command probing is unavailable on this platform.',
  },
  brew: {
    command: 'brew',
    supportedPlatforms: ['darwin', 'linux'],
    source: 'named-command',
    missingMessage: 'Homebrew command is unavailable. Install or repair Homebrew before continuing.',
    unsupportedMessage: 'The `brew` command is only supported on macOS and Linux.',
  },
  expect: {
    command: 'expect',
    supportedPlatforms: ['darwin', 'linux'],
    source: 'named-command',
    missingMessage:
      'Gemini 浏览器授权登录的提示自动化依赖 `expect` 命令。Qclaw 将回退为直接执行 OpenClaw，流程可能停在 Gemini 风险确认提示。',
    unsupportedMessage: 'The `expect` command is only supported on macOS and Linux.',
  },
  script: {
    command: 'script',
    supportedPlatforms: ['darwin', 'linux'],
    source: 'named-command',
    missingMessage:
      '当前平台的交互式浏览器授权登录依赖 `script` 命令。Qclaw 将回退为直接执行 OpenClaw，不再自动创建 PTY 或拉起浏览器。',
    unsupportedMessage: 'The `script` PTY wrapper is only supported on macOS and Linux.',
  },
  powershell: {
    command: 'powershell',
    supportedPlatforms: ['win32'],
    source: 'named-command',
    missingMessage:
      'Windows install/elevation flow requires the `powershell` command. Ensure PowerShell is installed and allowed by system policy.',
    unsupportedMessage: 'The `powershell` command is only supported on Windows.',
  },
  msiexec: {
    command: 'msiexec',
    supportedPlatforms: ['win32'],
    source: 'named-command',
    missingMessage:
      'Windows MSI install flow requires the `msiexec` command. Ensure Windows Installer is available before continuing.',
    unsupportedMessage: 'The `msiexec` command is only supported on Windows.',
  },
  osascript: {
    command: 'osascript',
    supportedPlatforms: ['darwin'],
    source: 'named-command',
    missingMessage:
      'macOS admin elevation flow requires the `osascript` command. Ensure AppleScript is available before continuing.',
    unsupportedMessage: 'The `osascript` command is only supported on macOS.',
  },
  installer: {
    command: 'installer',
    supportedPlatforms: ['darwin'],
    source: 'named-command',
    missingMessage:
      'macOS package installation requires the `installer` command. Ensure the system installer tools are available.',
    unsupportedMessage: 'The `installer` command is only supported on macOS.',
  },
  launchctl: {
    command: 'launchctl',
    supportedPlatforms: ['darwin'],
    source: 'named-command',
    missingMessage:
      'launchd service cleanup requires the `launchctl` command. Qclaw will skip launchd fallback cleanup if it is unavailable.',
    unsupportedMessage: 'The `launchctl` command is only supported on macOS.',
  },
  pkgutil: {
    command: 'pkgutil',
    supportedPlatforms: ['darwin'],
    source: 'named-command',
    missingMessage:
      'Node installer verification on macOS requires the `pkgutil` command to validate package signatures.',
    unsupportedMessage: 'The `pkgutil` command is only supported on macOS.',
  },
  spctl: {
    command: 'spctl',
    supportedPlatforms: ['darwin'],
    source: 'named-command',
    missingMessage:
      'Node installer verification on macOS requires the `spctl` command to check system policy acceptance.',
    unsupportedMessage: 'The `spctl` command is only supported on macOS.',
  },
  id: {
    command: 'id',
    supportedPlatforms: ['darwin', 'linux'],
    source: 'named-command',
    missingMessage:
      'Installer preflight on macOS requires the `id` command to detect whether the current user is an administrator.',
    unsupportedMessage: 'The `id` command is only supported on POSIX platforms.',
  },
  rm: {
    command: 'rm',
    supportedPlatforms: ['darwin', 'linux'],
    source: 'named-command',
    missingMessage:
      'Local state cleanup requires the `rm` command. Remove the OpenClaw directory manually if cleanup cannot continue.',
    unsupportedMessage: 'The `rm` command is only supported on POSIX platforms.',
  },
  rmdir: {
    command: 'rmdir',
    supportedPlatforms: ['win32'],
    source: 'shell-builtin',
    missingMessage:
      'Windows local cleanup uses the `rmdir` shell builtin. Remove the OpenClaw directory manually if cleanup cannot continue.',
    unsupportedMessage: 'The `rmdir` cleanup builtin is only supported on Windows.',
  },
}

let nextCommandResolverId = 0
const commandResolverIds = new WeakMap<CommandPathResolver, number>()
const commandCapabilityCache = new Map<string, CommandCapabilityProbeResult>()
const commandCapabilityPromiseCache = new Map<string, Promise<CommandCapabilityProbeResult>>()

function normalizeRuntime(
  runtime: NodeJS.Platform | CommandCapabilityRuntime = process.platform
): Required<CommandCapabilityRuntime> {
  if (typeof runtime === 'string') {
    return {
      platform: runtime,
      env: process.env,
    }
  }
  return {
    platform: runtime.platform || process.platform,
    env: runtime.env || process.env,
  }
}

function getCommandResolverCacheKey(resolver?: CommandPathResolver): string {
  if (!resolver) return 'default'

  const existing = commandResolverIds.get(resolver)
  if (typeof existing === 'number') {
    return `custom:${existing}`
  }

  nextCommandResolverId += 1
  commandResolverIds.set(resolver, nextCommandResolverId)
  return `custom:${nextCommandResolverId}`
}

function buildCommandCapabilityCacheKey(
  commandId: PlatformCommandId,
  runtime: Required<CommandCapabilityRuntime>,
  resolver?: CommandPathResolver
): string {
  return JSON.stringify({
    commandId,
    platform: runtime.platform,
    path: String(runtime.env.PATH || ''),
    shell: String(runtime.env.SHELL || ''),
    resolver: getCommandResolverCacheKey(resolver),
  })
}

function escapePosixShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolvePosixLookupShell(env: NodeJS.ProcessEnv): string {
  const configuredShell = String(env.SHELL || '').trim()
  if (configuredShell.startsWith('/')) {
    return configuredShell
  }
  return '/bin/sh'
}

function extractFirstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function splitWindowsPathEntries(value: string): string[] {
  const entries = String(value || '').split(';')
  const uniqueEntries: string[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniqueEntries.push(trimmed)
  }

  return uniqueEntries
}

function listWindowsExecutableNameCandidates(commandName: string, env: NodeJS.ProcessEnv): string[] {
  const trimmedCommand = String(commandName || '').trim()
  if (!trimmedCommand) return []

  const explicitExt = path.win32.extname(trimmedCommand)
  if (explicitExt) return [trimmedCommand]

  const rawPathExt = String(env.PATHEXT || '').trim()
  const pathExts = rawPathExt ? rawPathExt.split(';') : ['.COM', '.EXE', '.BAT', '.CMD']
  const uniqueCandidates = new Set<string>([trimmedCommand])

  for (const pathExt of pathExts) {
    const trimmedExt = pathExt.trim()
    if (!trimmedExt) continue
    const normalizedExt = trimmedExt.startsWith('.') ? trimmedExt : `.${trimmedExt}`
    uniqueCandidates.add(`${trimmedCommand}${normalizedExt}`)
  }

  return Array.from(uniqueCandidates)
}

function resolveWindowsNamedCommandPath(commandName: string, env: NodeJS.ProcessEnv): string | null {
  const candidateNames = listWindowsExecutableNameCandidates(commandName, env)
  if (candidateNames.length === 0) return null

  const hasPathSeparators = /[\\/]/.test(commandName)
  const searchDirs = hasPathSeparators ? [''] : splitWindowsPathEntries(String(env.PATH || ''))

  for (const searchDir of searchDirs) {
    for (const candidateName of candidateNames) {
      const candidatePath = searchDir ? path.win32.join(searchDir, candidateName) : candidateName
      try {
        if (fs.existsSync(candidatePath)) {
          return candidatePath
        }
      } catch {
        // Ignore malformed path candidates and continue probing.
      }
    }
  }

  return null
}

function runNamedCommandLookup(
  invocation: CommandLookupInvocation,
  runtime: Required<CommandCapabilityRuntime>
): Promise<string> {
  if (runtime.platform === 'win32') {
    const commandName = invocation.args[0]
    const resolvedPath = resolveWindowsNamedCommandPath(commandName, runtime.env)
    if (resolvedPath) {
      return Promise.resolve(resolvedPath)
    }
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
      env: runtime.env,
      cwd: resolveSafeWorkingDirectory({ env: runtime.env, platform: runtime.platform }),
      windowsHide: runtime.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const resolvedPath = extractFirstNonEmptyLine(stdout)
      if (code === 0 && resolvedPath) {
        resolve(resolvedPath)
        return
      }
      reject(new Error(stderr.trim() || `Unable to resolve command path for ${invocation.command}`))
    })
  })
}

export function getNamedCommandLookupInvocation(
  commandName: string,
  runtime: NodeJS.Platform | CommandCapabilityRuntime = process.platform
): CommandLookupInvocation {
  const normalizedRuntime = normalizeRuntime(runtime)
  const normalizedCommand = String(commandName || '').trim()
  if (!normalizedCommand) {
    throw new Error('Command name is required for command lookup')
  }

  if (normalizedRuntime.platform === 'win32') {
    return {
      command: 'where.exe',
      args: [normalizedCommand],
      shell: false,
    }
  }

  const lookupShell = resolvePosixLookupShell(normalizedRuntime.env)
  return {
    command: lookupShell,
    args: ['-lc', `command -v -- ${escapePosixShellArgument(normalizedCommand)}`],
    shell: false,
  }
}

export function buildMissingCommandMessage(
  commandId: PlatformCommandId,
  platform: NodeJS.Platform = process.platform,
  supported = true
): string {
  const spec = COMMAND_CAPABILITY_SPECS[commandId]
  if (!spec) {
    return `Required command ${commandId} is unavailable on ${platform}.`
  }
  return supported ? spec.missingMessage : spec.unsupportedMessage
}

export async function probePlatformCommandCapability(
  commandId: PlatformCommandId,
  options: ProbeCommandCapabilityOptions = {}
): Promise<CommandCapabilityProbeResult> {
  const runtime = normalizeRuntime(options)
  const cacheKey = buildCommandCapabilityCacheKey(commandId, runtime, options.commandPathResolver)
  const cached = commandCapabilityCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const cachedPromise = commandCapabilityPromiseCache.get(cacheKey)
  if (cachedPromise) {
    return cachedPromise
  }

  const probePromise = (async (): Promise<CommandCapabilityProbeResult> => {
    const spec = COMMAND_CAPABILITY_SPECS[commandId]
    if (!spec) {
      throw new Error(`Unknown platform command id: ${commandId}`)
    }

    const supported = spec.supportedPlatforms.includes(runtime.platform)
    if (!supported) {
      return {
        id: commandId,
        platform: runtime.platform,
        command: spec.command,
        supported: false,
        available: false,
        source: 'unsupported-platform',
        message: buildMissingCommandMessage(commandId, runtime.platform, false),
      }
    }

    if (spec.source === 'shell-builtin') {
      return {
        id: commandId,
        platform: runtime.platform,
        command: spec.command,
        supported: true,
        available: true,
        source: 'shell-builtin',
        message: '',
      }
    }

    const invocation = getNamedCommandLookupInvocation(spec.command, runtime)
    const resolveCommandPath =
      options.commandPathResolver ||
      ((commandName: string, lookupInvocation: CommandLookupInvocation) =>
        runNamedCommandLookup(lookupInvocation, runtime))

    try {
      const resolvedPath = await resolveCommandPath(spec.command, invocation)
      return {
        id: commandId,
        platform: runtime.platform,
        command: spec.command,
        supported: true,
        available: true,
        source: 'named-command',
        message: '',
        resolvedPath: String(resolvedPath || '').trim() || undefined,
      }
    } catch {
      return {
        id: commandId,
        platform: runtime.platform,
        command: spec.command,
        supported: true,
        available: false,
        source: 'named-command',
        message: buildMissingCommandMessage(commandId, runtime.platform, true),
      }
    }
  })()

  commandCapabilityPromiseCache.set(cacheKey, probePromise)
  try {
    const result = await probePromise
    if (result.available) {
      commandCapabilityCache.set(cacheKey, result)
    }
    return result
  } finally {
    if (commandCapabilityPromiseCache.get(cacheKey) === probePromise) {
      commandCapabilityPromiseCache.delete(cacheKey)
    }
  }
}

export function resetCommandCapabilityCache(): void {
  commandCapabilityCache.clear()
  commandCapabilityPromiseCache.clear()
}

export function resetCommandCapabilityCacheForTests(): void {
  resetCommandCapabilityCache()
}
