import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawBackupHomeCaptureMode,
  OpenClawBackupStrategyId,
} from '../../src/shared/openclaw-phase3'
import { copyManagedPathIfExists } from './openclaw-managed-copy'
import { resolveOpenClawPathsFromStateRoot } from './openclaw-paths'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { readdir } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

type InternalOpenClawBackupStrategyId = Exclude<OpenClawBackupStrategyId, 'unknown'>

export interface OpenClawBackupStrategyDefinition {
  id: InternalOpenClawBackupStrategyId
  homeCaptureMode: OpenClawBackupHomeCaptureMode
  apply: (params: {
    archivePath: string
    candidate: OpenClawInstallCandidate
  }) => Promise<void>
}

function normalizePathForCompare(targetPath: string): string {
  const normalized = path.resolve(String(targetPath || '').trim())
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathWithinParent(targetPath: string, parentPath: string): boolean {
  const normalizedTarget = normalizePathForCompare(targetPath)
  const normalizedParent = normalizePathForCompare(parentPath)
  if (!normalizedTarget || !normalizedParent) return false
  if (normalizedTarget === normalizedParent) return true
  return normalizedTarget.startsWith(`${normalizedParent}${path.sep}`)
}

async function copyConfigScope(
  candidate: OpenClawInstallCandidate,
  archivePath: string
): Promise<void> {
  const openClawPaths = resolveOpenClawPathsFromStateRoot({
    stateRoot: candidate.stateRoot,
    configFile: candidate.configPath,
  })

  await copyManagedPathIfExists(candidate.configPath, path.join(archivePath, 'openclaw.json'))
  await copyManagedPathIfExists(openClawPaths.envFile, path.join(archivePath, '.env'))
  await copyManagedPathIfExists(openClawPaths.credentialsDir, path.join(archivePath, 'credentials'))
}

async function copyFullState(
  candidate: OpenClawInstallCandidate,
  archivePath: string
): Promise<void> {
  await copyManagedPathIfExists(candidate.stateRoot, path.join(archivePath, 'openclaw-home'))
  if (!isPathWithinParent(candidate.configPath, candidate.stateRoot)) {
    await copyManagedPathIfExists(candidate.configPath, path.join(archivePath, 'openclaw.json'))
  }
}

async function copyTakeoverSafeguardState(
  candidate: OpenClawInstallCandidate,
  archivePath: string
): Promise<void> {
  const essentialStateDirectories = ['identity', 'memory'] as const

  await copyConfigScope(candidate, archivePath)
  for (const directoryName of essentialStateDirectories) {
    await copyManagedPathIfExists(
      path.join(candidate.stateRoot, directoryName),
      path.join(archivePath, 'openclaw-home', directoryName)
    )
  }
  await copyTakeoverSafeguardAgentAuthProfiles(candidate, archivePath)
}

async function copyTakeoverSafeguardAgentAuthProfiles(
  candidate: OpenClawInstallCandidate,
  archivePath: string
): Promise<void> {
  const agentsRoot = path.join(candidate.stateRoot, 'agents')
  let entries: import('node:fs').Dirent[]

  try {
    entries = await readdir(agentsRoot, { withFileTypes: true }) as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await copyManagedPathIfExists(
      path.join(agentsRoot, entry.name, 'agent', 'auth-profiles.json'),
      path.join(archivePath, 'openclaw-home', 'agents', entry.name, 'agent', 'auth-profiles.json')
    )
  }
}

const BACKUP_STRATEGIES = {
  'config-only': {
    id: 'config-only',
    homeCaptureMode: 'none',
    apply: async ({ archivePath, candidate }) => copyConfigScope(candidate, archivePath),
  },
  'full-state': {
    id: 'full-state',
    homeCaptureMode: 'full-home',
    apply: async ({ archivePath, candidate }) => copyFullState(candidate, archivePath),
  },
  'takeover-safeguard': {
    id: 'takeover-safeguard',
    homeCaptureMode: 'essential-state',
    apply: async ({ archivePath, candidate }) => copyTakeoverSafeguardState(candidate, archivePath),
  },
} as const satisfies Record<InternalOpenClawBackupStrategyId, OpenClawBackupStrategyDefinition>

export function getOpenClawBackupStrategy(
  strategyId: InternalOpenClawBackupStrategyId
): OpenClawBackupStrategyDefinition {
  return BACKUP_STRATEGIES[strategyId]
}
