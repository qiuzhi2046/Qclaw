import { resolveOpenClawPackageRoot } from './openclaw-package'
import { resolveWindowsActiveRuntimeSnapshotForRead } from './openclaw-runtime-readonly'
import { WINDOWS_PRIVATE_NODE_VERSION } from './platforms/windows/windows-runtime-policy'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'

const http = process.getBuiltinModule('node:http') as typeof import('node:http')
const https = process.getBuiltinModule('node:https') as typeof import('node:https')
const fsPromises = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export const DEFAULT_NODE_DIST_BASE_URL = 'https://nodejs.org/dist'
const DEFAULT_OPENCLAW_METADATA_URL = 'https://registry.npmmirror.com/openclaw/latest'
export const DEFAULT_BUNDLED_NODE_REQUIREMENT = '22.19.0'

const ENV_NODE_MIN_VERSION = 'QCLAW_NODE_MIN_VERSION'
const ENV_NODE_INSTALL_VERSION = 'QCLAW_NODE_INSTALL_VERSION'
const ENV_NODE_DIST_BASE_URL = 'QCLAW_NODE_DIST_BASE_URL'
const ENV_OPENCLAW_METADATA_URL = 'QCLAW_OPENCLAW_METADATA_URL'

const DEFAULT_REQUEST_TIMEOUT_MS = MAIN_RUNTIME_POLICY.node.metadataRequestTimeoutMs

const BUNDLED_LTS_RELEASES: Record<number, string> = {
  24: WINDOWS_PRIVATE_NODE_VERSION,
  22: 'v22.22.1',
  20: 'v20.20.1',
  18: 'v18.20.8',
}

type NodeArch = 'x64' | 'arm64' | 'x86'
type NodeInstallerArch = NodeArch | 'universal'
type NodeArtifactKind = 'pkg' | 'zip'
type RequirementSource =
  | 'env-override'
  | 'installed-openclaw-package'
  | 'openclaw-registry'
  | 'bundled-fallback'
type PlanSource = 'env-override' | 'official-dist-index' | 'bundled-fallback'

interface ParsedSemver {
  major: number
  minor: number
  patch: number
}

interface NodeDistIndexEntry {
  version?: string
  lts?: string | boolean | null
  files?: string[]
}

export interface OpenClawNodeRequirement {
  minVersion: string
  source: RequirementSource
}

export interface NodeInstallPlan {
  version: string
  requiredVersion: string
  requirementSource: RequirementSource
  source: PlanSource
  platform: 'darwin' | 'win32'
  detectedArch: NodeArch
  installerArch: NodeInstallerArch
  artifactKind: NodeArtifactKind
  distBaseUrl: string
  url: string
  filename: string
}

interface ResolveNodeInstallPlanOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  processArch?: string
  readInstalledOpenClawPackageJson?: () => Promise<Record<string, unknown> | null>
  fetchOpenClawMetadata?: () => Promise<Record<string, unknown>>
  fetchNodeDistIndex?: () => Promise<NodeDistIndexEntry[]>
  skipDynamicOpenClawRequirementProbe?: boolean
}

interface ResolveRequirementOptions {
  env?: NodeJS.ProcessEnv
  readInstalledOpenClawPackageJson?: () => Promise<Record<string, unknown> | null>
  fetchOpenClawMetadata?: () => Promise<Record<string, unknown>>
  skipDynamicOpenClawRequirementProbe?: boolean
}

let cachedDefaultRequirement: Promise<OpenClawNodeRequirement> | null = null
let cachedDefaultRequirementKey: string | null = null
let cachedDefaultPlan: Promise<NodeInstallPlan> | null = null
let cachedDefaultPlanKey: string | null = null

export function resetNodeInstallationPolicyCache(): void {
  cachedDefaultRequirement = null
  cachedDefaultRequirementKey = null
  cachedDefaultPlan = null
  cachedDefaultPlanKey = null
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

function normalizeNodeVersionTag(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

function normalizeSemverValue(value: string): string | null {
  const parsed = parseSemver(value)
  if (!parsed) return null
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

function trimTrailingSlash(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

function normalizeDistBaseUrl(rawUrl: string | undefined): string {
  return trimTrailingSlash(rawUrl || DEFAULT_NODE_DIST_BASE_URL) || DEFAULT_NODE_DIST_BASE_URL
}

function isNodeVersionAtLeast(currentVersion: string, requiredVersion: string): boolean {
  const current = parseSemver(currentVersion)
  const required = parseSemver(requiredVersion)
  if (!current || !required) return false
  if (current.major !== required.major) return current.major > required.major
  if (current.minor !== required.minor) return current.minor > required.minor
  return current.patch >= required.patch
}

function enforceBundledNodeRequirementFloor(requirement: OpenClawNodeRequirement): OpenClawNodeRequirement {
  if (requirement.source === 'env-override') return requirement
  if (isNodeVersionAtLeast(requirement.minVersion, DEFAULT_BUNDLED_NODE_REQUIREMENT)) return requirement
  return {
    ...requirement,
    minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
  }
}

function readEnginesNode(packageJson: Record<string, unknown> | null | undefined): string {
  if (!packageJson) return ''
  const engines = packageJson.engines
  if (!engines || typeof engines !== 'object') return ''
  const nodeRange = (engines as Record<string, unknown>).node
  return typeof nodeRange === 'string' ? nodeRange.trim() : ''
}

function getDefaultReadInstalledOpenClawPackageJson(): () => Promise<Record<string, unknown> | null> {
  return async () => {
    try {
      const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
      const packageRoot = await resolveOpenClawPackageRoot({
        activeRuntimeSnapshot,
      })
      const packageJsonPath = path.join(packageRoot, 'package.json')
      const raw = await fsPromises.readFile(packageJsonPath, 'utf8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

function getDefaultFetchOpenClawMetadata(env: NodeJS.ProcessEnv): () => Promise<Record<string, unknown>> {
  const metadataUrl = String(env[ENV_OPENCLAW_METADATA_URL] || DEFAULT_OPENCLAW_METADATA_URL).trim() || DEFAULT_OPENCLAW_METADATA_URL
  return async () => {
    const payload = await readJsonFromUrl(metadataUrl)
    return payload as Record<string, unknown>
  }
}

function getDefaultFetchNodeDistIndex(distBaseUrl: string): () => Promise<NodeDistIndexEntry[]> {
  const indexUrl = `${distBaseUrl}/index.json`
  return async () => {
    const payload = await readJsonFromUrl(indexUrl)
    return Array.isArray(payload) ? (payload as NodeDistIndexEntry[]) : []
  }
}

function shouldUseDefaultRequirementCache(options: ResolveRequirementOptions): boolean {
  return (
    !options.env &&
    !options.readInstalledOpenClawPackageJson &&
    !options.fetchOpenClawMetadata &&
    options.skipDynamicOpenClawRequirementProbe !== true
  )
}

function shouldUseDefaultPlanCache(options: ResolveNodeInstallPlanOptions): boolean {
  return (
    !options.env &&
    !options.platform &&
    !options.processArch &&
    !options.readInstalledOpenClawPackageJson &&
    !options.fetchOpenClawMetadata &&
    !options.fetchNodeDistIndex &&
    options.skipDynamicOpenClawRequirementProbe !== true
  )
}

function buildDefaultRequirementCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    minVersion: String(env[ENV_NODE_MIN_VERSION] || ''),
    metadataUrl: String(env[ENV_OPENCLAW_METADATA_URL] || ''),
  })
}

function buildDefaultPlanCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    requirement: buildDefaultRequirementCacheKey(env),
    installVersion: String(env[ENV_NODE_INSTALL_VERSION] || ''),
    distBaseUrl: String(env[ENV_NODE_DIST_BASE_URL] || ''),
    platform: process.platform,
    processArch: process.arch,
    processorArchitecture: String(env.PROCESSOR_ARCHITECTURE || ''),
    processorArchitew6432: String(env.PROCESSOR_ARCHITEW6432 || ''),
  })
}

function requestText(url: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, redirectCount = 0): Promise<string> {
  if (redirectCount > 3) {
    return Promise.reject(new Error(`Too many redirects while requesting ${url}`))
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const client = parsedUrl.protocol === 'http:' ? http : https
    const request = client.get(parsedUrl, (response) => {
      const statusCode = response.statusCode || 0
      const redirectUrl = response.headers.location

      if (redirectUrl && [301, 302, 307, 308].includes(statusCode)) {
        response.resume()
        const nextUrl = new URL(redirectUrl, parsedUrl).toString()
        requestText(nextUrl, timeoutMs, redirectCount + 1).then(resolve).catch(reject)
        return
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new Error(`Request failed with status ${statusCode} for ${url}`))
        return
      }

      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => resolve(body))
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout for ${url}`))
    })
    request.on('error', reject)
  })
}

async function readJsonFromUrl(url: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const text = await requestText(url, timeoutMs)
  return JSON.parse(text) as unknown
}

export function extractMinNodeVersionFromRange(range: string): string | null {
  const normalized = String(range || '').trim()
  if (!normalized) return null

  const gteMatch = normalized.match(/>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (gteMatch) {
    return `${Number(gteMatch[1] || 0)}.${Number(gteMatch[2] || 0)}.${Number(gteMatch[3] || 0)}`
  }

  const caretMatch = normalized.match(/^[~^]\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (caretMatch) {
    return `${Number(caretMatch[1] || 0)}.${Number(caretMatch[2] || 0)}.${Number(caretMatch[3] || 0)}`
  }

  const exactMatch = normalized.match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i)
  if (exactMatch) {
    const minor = exactMatch[2] && exactMatch[2] !== 'x' && exactMatch[2] !== '*' ? Number(exactMatch[2]) : 0
    const patch = exactMatch[3] && exactMatch[3] !== 'x' && exactMatch[3] !== '*' ? Number(exactMatch[3]) : 0
    return `${Number(exactMatch[1] || 0)}.${minor}.${patch}`
  }

  return null
}

export function detectNativeWindowsArch(
  processArch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env
): NodeArch {
  const hints = [
    String(env.PROCESSOR_ARCHITEW6432 || '').trim(),
    String(env.PROCESSOR_ARCHITECTURE || '').trim(),
    String(processArch || '').trim(),
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase())

  if (hints.some((value) => value.includes('arm64'))) return 'arm64'
  if (hints.some((value) => value.includes('amd64') || value.includes('x64'))) return 'x64'
  return 'x86'
}

function detectInstallerArch(platform: NodeJS.Platform, processArch: string, env: NodeJS.ProcessEnv): NodeArch {
  if (platform === 'win32') {
    return detectNativeWindowsArch(processArch, env)
  }

  if (processArch === 'arm64') return 'arm64'
  if (processArch === 'ia32') return 'x86'
  return 'x64'
}

function getBundledFallbackVersion(requiredVersion: string): string {
  const required = parseSemver(requiredVersion)
  const bundledVersions = Object.values(BUNDLED_LTS_RELEASES).sort(compareSemverDescending)
  if (!required) return bundledVersions[0]

  const sameMajor = BUNDLED_LTS_RELEASES[required.major]
  if (sameMajor) return sameMajor

  const compatible = bundledVersions.find((candidate) => isNodeVersionAtLeast(candidate, requiredVersion))
  return compatible || bundledVersions[0]
}

export function getBundledTargetNodeVersion(requiredVersion: string): string {
  return getBundledFallbackVersion(requiredVersion)
}

function resolveWindowsZipInstallerArch(files: string[], detectedArch: NodeArch): NodeArch | null {
  const availability: Array<{ installerArch: NodeArch; fileKey: string }> =
    detectedArch === 'arm64'
      ? [
          { installerArch: 'arm64', fileKey: 'win-arm64-zip' },
          { installerArch: 'x64', fileKey: 'win-x64-zip' },
        ]
      : detectedArch === 'x64'
        ? [{ installerArch: 'x64', fileKey: 'win-x64-zip' }]
        : []

  for (const candidate of availability) {
    if (files.includes(candidate.fileKey)) return candidate.installerArch
  }

  return null
}

function resolveInstallerArchForRelease(
  platform: 'darwin' | 'win32',
  files: string[],
  detectedArch: NodeArch
): { artifactKind: NodeArtifactKind; installerArch: NodeInstallerArch } | null {
  if (platform === 'darwin') {
    return files.includes('osx-x64-pkg')
      ? { artifactKind: 'pkg', installerArch: 'universal' }
      : null
  }

  const installerArch = resolveWindowsZipInstallerArch(files, detectedArch)
  return installerArch ? { artifactKind: 'zip', installerArch } : null
}

function buildInstallerFilename(
  version: string,
  platform: 'darwin' | 'win32',
  installerArch: NodeInstallerArch,
  artifactKind: NodeArtifactKind
): string {
  if (platform === 'darwin') {
    return `node-${version}.pkg`
  }

  if (artifactKind === 'zip') {
    return `node-${version}-win-${installerArch}.zip`
  }

  return `node-${version}.pkg`
}

function buildInstallPlan(
  version: string,
  source: PlanSource,
  platform: 'darwin' | 'win32',
  detectedArch: NodeArch,
  installerArch: NodeInstallerArch,
  artifactKind: NodeArtifactKind,
  requiredVersion: string,
  requirementSource: RequirementSource,
  distBaseUrl: string
): NodeInstallPlan {
  const normalizedVersion = normalizeNodeVersionTag(version)
  const filename = buildInstallerFilename(normalizedVersion, platform, installerArch, artifactKind)
  return {
    version: normalizedVersion,
    requiredVersion,
    requirementSource,
    source,
    platform,
    detectedArch,
    installerArch,
    artifactKind,
    distBaseUrl,
    url: `${distBaseUrl}/${normalizedVersion}/${filename}`,
    filename,
  }
}

function selectPlanFromDistIndex(
  entries: NodeDistIndexEntry[],
  platform: 'darwin' | 'win32',
  detectedArch: NodeArch,
  requiredVersion: string,
  requirementSource: RequirementSource,
  distBaseUrl: string
): NodeInstallPlan | null {
  const normalizedEntries = entries
    .map((entry) => ({
      version: normalizeNodeVersionTag(String(entry.version || '')),
      lts: Boolean(entry.lts),
      files: Array.isArray(entry.files) ? entry.files : [],
    }))
    .filter((entry) => entry.version)
    .sort((left, right) => compareSemverDescending(left.version, right.version))

  const requiredMajor =
    parseSemver(requiredVersion)?.major ?? parseSemver(DEFAULT_BUNDLED_NODE_REQUIREMENT)?.major ?? 22

  const candidateGroups = [
    normalizedEntries.filter(
      (entry) =>
        entry.lts &&
        parseSemver(entry.version)?.major === requiredMajor &&
        isNodeVersionAtLeast(entry.version, requiredVersion)
    ),
    normalizedEntries.filter(
      (entry) =>
        parseSemver(entry.version)?.major === requiredMajor &&
        isNodeVersionAtLeast(entry.version, requiredVersion)
    ),
    normalizedEntries.filter((entry) => entry.lts && isNodeVersionAtLeast(entry.version, requiredVersion)),
    normalizedEntries.filter((entry) => isNodeVersionAtLeast(entry.version, requiredVersion)),
  ]

  for (const group of candidateGroups) {
    for (const entry of group) {
      const installer = resolveInstallerArchForRelease(platform, entry.files, detectedArch)
      if (!installer) continue
      return buildInstallPlan(
        entry.version,
        'official-dist-index',
        platform,
        detectedArch,
        installer.installerArch,
        installer.artifactKind,
        requiredVersion,
        requirementSource,
        distBaseUrl
      )
    }
  }

  return null
}

export async function resolveOpenClawNodeRequirement(
  options: ResolveRequirementOptions = {}
): Promise<OpenClawNodeRequirement> {
  const env = options.env || process.env
  const useDefaultCache = shouldUseDefaultRequirementCache(options)
  const cacheKey = useDefaultCache ? buildDefaultRequirementCacheKey(env) : null

  if (useDefaultCache && cachedDefaultRequirement && cachedDefaultRequirementKey === cacheKey) {
    return cachedDefaultRequirement
  }

  if (useDefaultCache && cachedDefaultRequirementKey !== cacheKey) {
    cachedDefaultRequirement = null
    cachedDefaultRequirementKey = null
  }

  const promise = (async () => {
    const envOverride = normalizeSemverValue(String(env[ENV_NODE_MIN_VERSION] || ''))
    if (envOverride) {
      return {
        minVersion: envOverride,
        source: 'env-override' as const,
      }
    }

    if (options.skipDynamicOpenClawRequirementProbe === true) {
      return {
        minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
        source: 'bundled-fallback' as const,
      }
    }

    const readInstalledOpenClawPackageJson =
      options.readInstalledOpenClawPackageJson || getDefaultReadInstalledOpenClawPackageJson()
    const installedPackageJson = await readInstalledOpenClawPackageJson()
    const installedEnginesNode = extractMinNodeVersionFromRange(readEnginesNode(installedPackageJson))
    if (installedEnginesNode) {
      return enforceBundledNodeRequirementFloor({
        minVersion: installedEnginesNode,
        source: 'installed-openclaw-package' as const,
      })
    }

    const fetchOpenClawMetadata = options.fetchOpenClawMetadata || getDefaultFetchOpenClawMetadata(env)
    try {
      const metadata = await fetchOpenClawMetadata()
      const registryEnginesNode = extractMinNodeVersionFromRange(readEnginesNode(metadata))
      if (registryEnginesNode) {
        return enforceBundledNodeRequirementFloor({
          minVersion: registryEnginesNode,
          source: 'openclaw-registry' as const,
        })
      }
    } catch {
      // ignore metadata fetch failures and fall back to the bundled requirement.
    }

    return {
      minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
      source: 'bundled-fallback' as const,
    }
  })()

  if (useDefaultCache) {
    const cachedPromise = promise.catch((error) => {
      if (cachedDefaultRequirement === cachedPromise) {
        cachedDefaultRequirement = null
        cachedDefaultRequirementKey = null
      }
      throw error
    })
    cachedDefaultRequirement = cachedPromise
    cachedDefaultRequirementKey = cacheKey
    return cachedPromise
  }

  return promise
}

export async function resolveNodeInstallPlan(
  options: ResolveNodeInstallPlanOptions = {}
): Promise<NodeInstallPlan> {
  const env = options.env || process.env
  const useDefaultCache = shouldUseDefaultPlanCache(options)
  const cacheKey = useDefaultCache ? buildDefaultPlanCacheKey(env) : null

  if (useDefaultCache && cachedDefaultPlan && cachedDefaultPlanKey === cacheKey) {
    return cachedDefaultPlan
  }

  if (useDefaultCache && cachedDefaultPlanKey !== cacheKey) {
    cachedDefaultPlan = null
    cachedDefaultPlanKey = null
  }

  const promise = (async () => {
    const platform = (options.platform || process.platform) as NodeJS.Platform
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new Error(`Unsupported platform for auto-install: ${platform}`)
    }

    const required = await resolveOpenClawNodeRequirement({
      env,
      readInstalledOpenClawPackageJson: options.readInstalledOpenClawPackageJson,
      fetchOpenClawMetadata: options.fetchOpenClawMetadata,
      skipDynamicOpenClawRequirementProbe: options.skipDynamicOpenClawRequirementProbe,
    })
    const detectedArch = detectInstallerArch(platform, options.processArch || process.arch, env)
    const distBaseUrl = normalizeDistBaseUrl(String(env[ENV_NODE_DIST_BASE_URL] || DEFAULT_NODE_DIST_BASE_URL))
    const pinnedVersion = normalizeNodeVersionTag(String(env[ENV_NODE_INSTALL_VERSION] || ''))

    if (platform === 'win32' && detectedArch === 'x86') {
      throw new Error('Unsupported Windows Node zip architecture: x86')
    }

    if (pinnedVersion) {
      const installerArch = platform === 'darwin' ? 'universal' : detectedArch === 'arm64' ? 'arm64' : 'x64'
      const artifactKind: NodeArtifactKind = platform === 'darwin' ? 'pkg' : 'zip'
      return buildInstallPlan(
        pinnedVersion,
        'env-override',
        platform,
        detectedArch,
        installerArch,
        artifactKind,
        required.minVersion,
        required.source,
        distBaseUrl
      )
    }

    if (platform === 'win32') {
      return buildInstallPlan(
        WINDOWS_PRIVATE_NODE_VERSION,
        'bundled-fallback',
        platform,
        detectedArch,
        detectedArch === 'arm64' ? 'arm64' : 'x64',
        'zip',
        required.minVersion,
        required.source,
        distBaseUrl
      )
    }

    const fetchNodeDistIndex = options.fetchNodeDistIndex || getDefaultFetchNodeDistIndex(distBaseUrl)
    try {
      const distIndex = await fetchNodeDistIndex()
      const planFromIndex = selectPlanFromDistIndex(
        distIndex,
        platform,
        detectedArch,
        required.minVersion,
        required.source,
        distBaseUrl
      )
      if (planFromIndex) return planFromIndex
    } catch {
      // ignore dist index failures and use the bundled fallback.
    }

    const fallbackVersion = getBundledFallbackVersion(required.minVersion)
    const fallbackInstallerArch = 'universal'
    return buildInstallPlan(
      fallbackVersion,
      'bundled-fallback',
      platform,
      detectedArch,
      fallbackInstallerArch,
      'pkg',
      required.minVersion,
      required.source,
      distBaseUrl
    )
  })()

  if (useDefaultCache) {
    const cachedPromise = promise.catch((error) => {
      if (cachedDefaultPlan === cachedPromise) {
        cachedDefaultPlan = null
        cachedDefaultPlanKey = null
      }
      throw error
    })
    cachedDefaultPlan = cachedPromise
    cachedDefaultPlanKey = cacheKey
    return cachedPromise
  }

  return promise
}
