import { PINNED_OPENCLAW_VERSION } from '../../src/shared/openclaw-version-policy'

export interface OpenClawRepositoryMirror {
  id: string
  label: string
  cloneUrl: string
}

export interface OpenClawNpmRegistryMirror {
  id: string
  label: string
  registryUrl: string | null
}

export interface OpenClawCommandResultLike {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  canceled?: boolean
}

export interface OpenClawNpmCommandOptions {
  userConfigPath?: string | null
  globalConfigPath?: string | null
  prefixPath?: string | null
  cachePath?: string | null
  fetchTimeoutMs?: number | null
  fetchRetries?: number | null
  noAudit?: boolean
  noFund?: boolean
}

export interface OpenClawNpmRegistryAttempt<T extends OpenClawCommandResultLike> {
  mirror: OpenClawNpmRegistryMirror
  result: T
}

export const OPENCLAW_REPOSITORY_MIRRORS: OpenClawRepositoryMirror[] = [
  {
    id: 'github-official',
    label: 'GitHub 官方仓库',
    cloneUrl: 'https://github.com/pjasicek/OpenClaw.git',
  },
  {
    id: 'github-gitclone',
    label: 'GitHub 镜像仓库（gitclone）',
    cloneUrl: 'https://gitclone.com/github.com/pjasicek/OpenClaw.git',
  },
]

export const OPENCLAW_NPM_REGISTRY_MIRRORS: OpenClawNpmRegistryMirror[] = [
  {
    id: 'npmmirror',
    label: 'npmmirror',
    registryUrl: 'https://registry.npmmirror.com',
  },
  {
    id: 'tencent',
    label: '腾讯云镜像',
    registryUrl: 'https://mirrors.cloud.tencent.com/npm/',
  },
  {
    id: 'huawei',
    label: '华为云镜像',
    registryUrl: 'https://repo.huaweicloud.com/repository/npm/',
  },
  {
    id: 'npmjs',
    label: 'npm 官方源',
    registryUrl: null,
  },
]

export const OPENCLAW_NPM_REGISTRY_ATTEMPT_COUNT = OPENCLAW_NPM_REGISTRY_MIRRORS.length
const OPENCLAW_VERSION_TAG_REGEX = /^(latest|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i

function compactOutput(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 180)
}

function describeMirror(mirror: OpenClawNpmRegistryMirror): string {
  return mirror.registryUrl ? `${mirror.label} (${mirror.registryUrl})` : mirror.label
}

const TLS_CERTIFICATE_ERROR_PATTERN =
  /(UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_OSSL|certificate)/i

function hasLikelyTlsCertificateFailure(
  attempts: OpenClawNpmRegistryAttempt<OpenClawCommandResultLike>[]
): boolean {
  return attempts.some((attempt) => {
    const detail = `${String(attempt.result.stderr || '')}\n${String(attempt.result.stdout || '')}`
    return TLS_CERTIFICATE_ERROR_PATTERN.test(detail)
  })
}

export function buildOpenClawInstallArgs(
  version: string,
  registryUrl?: string | null,
  options?: OpenClawNpmCommandOptions
): string[] {
  const normalizedVersion = normalizeOpenClawVersionTag(version)
  const args = ['install', '-g', `openclaw@${normalizedVersion}`]
  const normalizedRegistry = String(registryUrl || '').trim()
  if (normalizedRegistry) {
    args.push(`--registry=${normalizedRegistry}`)
  }
  return appendNpmCommandOptions(args, options, {
    includeInstallStabilityFlags: true,
  })
}

export function buildOpenClawConfigGetPrefixArgs(
  options?: OpenClawNpmCommandOptions
): string[] {
  return appendNpmCommandOptions(['config', 'get', 'prefix'], options, {
    includeRuntimeTransportFlags: false,
  })
}

export function buildOpenClawUninstallArgs(
  options?: OpenClawNpmCommandOptions
): string[] {
  return appendNpmCommandOptions(['uninstall', '-g', 'openclaw'], options)
}

export function normalizeOpenClawVersionTag(version: string): string {
  const normalized = String(version || '').trim() || 'latest'
  if (!OPENCLAW_VERSION_TAG_REGEX.test(normalized)) {
    throw new Error(`Invalid openclaw version tag: ${normalized}`)
  }
  return normalized.toLowerCase() === 'latest' ? 'latest' : normalized
}

export function buildOpenClawNpmViewArgs(
  registryUrl?: string | null,
  options?: OpenClawNpmCommandOptions
): string[] {
  const args = ['view', 'openclaw', 'version', '--silent']
  const normalizedRegistry = String(registryUrl || '').trim()
  if (normalizedRegistry) {
    args.push(`--registry=${normalizedRegistry}`)
  }
  return appendNpmCommandOptions(args, options)
}

export function buildOpenClawManualInstallCommands(version = PINNED_OPENCLAW_VERSION): string[] {
  return OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) => {
    const args = buildOpenClawInstallArgs(version, mirror.registryUrl)
    return `npm ${args.join(' ')}`
  })
}

export function buildOpenClawRegistrySwitchCommands(): string[] {
  return OPENCLAW_NPM_REGISTRY_MIRRORS
    .filter((mirror) => Boolean(String(mirror.registryUrl || '').trim()))
    .map((mirror) => `npm config set registry ${String(mirror.registryUrl || '').trim()}`)
}

function appendNpmCommandOptions(
  args: string[],
  options?: OpenClawNpmCommandOptions,
  behavior: {
    includeInstallStabilityFlags?: boolean
    includeRuntimeTransportFlags?: boolean
  } = {}
): string[] {
  if (!options) return args

  const next = [...args]
  const userConfigPath = String(options.userConfigPath || '').trim()
  const globalConfigPath = String(options.globalConfigPath || '').trim()
  const prefixPath = String(options.prefixPath || '').trim()
  const cachePath = String(options.cachePath || '').trim()
  const fetchTimeoutMs = Number(options.fetchTimeoutMs)
  const fetchRetries = Number(options.fetchRetries)

  if (userConfigPath) {
    next.push(`--userconfig=${userConfigPath}`)
  }
  if (globalConfigPath) {
    next.push(`--globalconfig=${globalConfigPath}`)
  }
  if (prefixPath) {
    next.push(`--prefix=${prefixPath}`)
  }
  if (behavior.includeRuntimeTransportFlags !== false) {
    if (cachePath) {
      next.push(`--cache=${cachePath}`)
    }
    if (Number.isFinite(fetchTimeoutMs) && fetchTimeoutMs > 0) {
      next.push(`--fetch-timeout=${Math.floor(fetchTimeoutMs)}`)
    }
    if (Number.isFinite(fetchRetries) && fetchRetries >= 0) {
      next.push(`--fetch-retries=${Math.floor(fetchRetries)}`)
    }
  }
  if (behavior.includeInstallStabilityFlags) {
    if (options.noAudit !== false) {
      next.push('--no-audit')
    }
    if (options.noFund !== false) {
      next.push('--no-fund')
    }
  }

  return next
}

export function buildMirrorAwareTimeoutMs(
  baseTimeoutMs: number,
  attemptCount = OPENCLAW_NPM_REGISTRY_ATTEMPT_COUNT
): number {
  const normalizedBase = Math.max(1_000, Math.floor(Number(baseTimeoutMs) || 0))
  const normalizedAttempts = Math.max(1, Math.floor(Number(attemptCount) || 0))

  // First attempt gets full budget; each additional mirror gets 60% of base budget.
  // This scales total timeout with mirror count while avoiding an excessively large multiplier.
  const factor = 1 + (normalizedAttempts - 1) * 0.6
  return Math.floor(normalizedBase * factor)
}

export async function runOpenClawNpmRegistryFallback<T extends OpenClawCommandResultLike>(
  runner: (mirror: OpenClawNpmRegistryMirror) => Promise<T>
): Promise<{ result: T; attempts: OpenClawNpmRegistryAttempt<T>[] }> {
  const attempts: OpenClawNpmRegistryAttempt<T>[] = []

  for (const mirror of OPENCLAW_NPM_REGISTRY_MIRRORS) {
    const result = await runner(mirror)
    attempts.push({ mirror, result })
    if (result.ok || result.canceled) {
      return { result, attempts }
    }
  }

  return {
    result: attempts[attempts.length - 1].result,
    attempts,
  }
}

export function formatOpenClawMirrorFailureDetails(
  attempts: OpenClawNpmRegistryAttempt<OpenClawCommandResultLike>[],
  options: {
    operationLabel: string
    version?: string
  }
): string {
  const operationLabel = String(options.operationLabel || '').trim() || 'OpenClaw 操作'
  const version = String(options.version || '').trim() || 'latest'
  const lines: string[] = [`${operationLabel}失败，已按镜像顺序自动重试。`]

  if (attempts.length > 0) {
    lines.push('已尝试来源：')
    for (const [index, attempt] of attempts.entries()) {
      const detail = compactOutput(attempt.result.stderr || attempt.result.stdout) || '无详细输出'
      lines.push(`${index + 1}. ${describeMirror(attempt.mirror)} -> ${detail}`)
    }
  }

  if (hasLikelyTlsCertificateFailure(attempts)) {
    lines.push('检测到 TLS 证书链校验失败（例如 local issuer certificate）。')
    lines.push('建议先清理全局 Node/npm 证书相关覆盖后再重试：')
    lines.push('- unset NODE_OPTIONS')
    lines.push('- npm config delete cafile')
    lines.push('- npm config delete ca')
    lines.push('- export SSL_CERT_FILE=/etc/ssl/cert.pem')
  }

  lines.push('可手动重试（一次性指定 registry）：')
  for (const command of buildOpenClawManualInstallCommands(version)) {
    lines.push(`- ${command}`)
  }

  lines.push('也可先切换 npm registry 后再重试：')
  for (const command of buildOpenClawRegistrySwitchCommands()) {
    lines.push(`- ${command}`)
  }

  lines.push('OpenClaw 仓库镜像（备用）：')
  for (const mirror of OPENCLAW_REPOSITORY_MIRRORS) {
    lines.push(`- git clone ${mirror.cloneUrl}`)
  }

  return lines.join('\n')
}

export function attachOpenClawMirrorFailureDetails<T extends OpenClawCommandResultLike>(
  result: T,
  attempts: OpenClawNpmRegistryAttempt<OpenClawCommandResultLike>[],
  options: {
    operationLabel: string
    version?: string
  }
): T {
  if (result.ok) return result
  const baseStderr = String(result.stderr || '').trim()
  const details = formatOpenClawMirrorFailureDetails(attempts, options)
  return {
    ...result,
    stderr: baseStderr ? `${baseStderr}\n\n${details}` : details,
  }
}
