import { resolveOpenClawPackageRoot } from './openclaw-package'
import { resolveWindowsActiveRuntimeSnapshotForRead } from './openclaw-runtime-readonly'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url') as typeof import('node:url')

interface DistJavaScriptFileLookupOptions {
  preferredPrefixes?: string[]
}

interface OpenClawGatewayConnectionDetails {
  url?: string
}

interface OpenClawGatewayConnectionAuth {
  token?: string
  password?: string
}

interface OpenClawGatewayRuntimeModule {
  buildGatewayConnectionDetails: (options?: { config?: Record<string, any> | null }) => OpenClawGatewayConnectionDetails
  resolveGatewayConnectionAuth: (params: {
    config: Record<string, any> | null
    env?: NodeJS.ProcessEnv
    urlOverride?: string
    urlOverrideSource?: string
  }) => Promise<OpenClawGatewayConnectionAuth>
}

const preferredPrefixes = ['reply', 'auth-profiles', 'thread-bindings']
const requiredTokens = ['buildGatewayConnectionDetails as', 'resolveGatewayConnectionAuth as']
const runtimeModuleCache = new Map<string, Promise<OpenClawGatewayRuntimeModule | null>>()

function getDistFilePriority(name: string, prefixes: string[]): number {
  for (let index = 0; index < prefixes.length; index += 1) {
    const prefix = prefixes[index]
    if (name === `${prefix}.js` || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`)) {
      return index
    }
  }
  return prefixes.length
}

async function findGatewayRuntimeBundle(packageRoot: string): Promise<string | null> {
  const distDir = path.join(packageRoot, 'dist')
  let entries: string[]
  try {
    entries = await fs.promises.readdir(distDir)
  } catch {
    return null
  }

  const candidates = entries
    .filter((entry) => entry.endsWith('.js'))
    .sort((left, right) => {
      const leftPriority = getDistFilePriority(left, preferredPrefixes)
      const rightPriority = getDistFilePriority(right, preferredPrefixes)
      if (leftPriority !== rightPriority) return leftPriority - rightPriority
      return left.localeCompare(right)
    })

  for (const candidate of candidates) {
    const filePath = path.join(distDir, candidate)
    let content = ''
    try {
      content = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      continue
    }
    if (requiredTokens.every((token) => content.includes(token))) {
      return filePath
    }
  }

  return null
}

function pickNamedExport<T extends Function>(module: Record<string, unknown>, functionName: string): T | null {
  for (const value of Object.values(module)) {
    if (typeof value === 'function' && value.name === functionName) {
      return value as T
    }
  }
  return null
}

async function loadGatewayRuntimeModule(packageRoot: string): Promise<OpenClawGatewayRuntimeModule | null> {
  const bundlePath = await findGatewayRuntimeBundle(packageRoot)
  if (!bundlePath) return null

  const module = (await import(pathToFileURL(bundlePath).href)) as Record<string, unknown>
  const buildGatewayConnectionDetails = pickNamedExport<
    OpenClawGatewayRuntimeModule['buildGatewayConnectionDetails']
  >(module, 'buildGatewayConnectionDetails')
  const resolveGatewayConnectionAuth = pickNamedExport<
    OpenClawGatewayRuntimeModule['resolveGatewayConnectionAuth']
  >(module, 'resolveGatewayConnectionAuth')

  if (!buildGatewayConnectionDetails || !resolveGatewayConnectionAuth) return null

  return {
    buildGatewayConnectionDetails,
    resolveGatewayConnectionAuth,
  }
}

export async function loadOpenClawGatewayRuntime(packageRoot?: string): Promise<OpenClawGatewayRuntimeModule | null> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  const resolvedPackageRoot =
    String(packageRoot || '').trim() ||
    (await resolveOpenClawPackageRoot({
      activeRuntimeSnapshot,
    }))
  const cached = runtimeModuleCache.get(resolvedPackageRoot)
  if (cached) return cached

  const task = loadGatewayRuntimeModule(resolvedPackageRoot).catch(() => null)
  runtimeModuleCache.set(resolvedPackageRoot, task)
  return task
}
