const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

type PathModule = typeof import('node:path')

export interface OpenClawSkillLocations {
  workspaceDir: string
  workspaceSkillsDir: string
  managedSkillsDir: string
  clawhubWorkdir: string
  clawhubDir: string
}

interface ResolveOpenClawSkillLocationsOptions {
  homeDir?: string
  pathModule?: PathModule
}

function normalizePathLikeValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function inferPathModule(...values: unknown[]): PathModule {
  const normalizedValues = values
    .map((value) => normalizePathLikeValue(value))
    .filter(Boolean)
  if (normalizedValues.some((value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\'))) {
    return path.win32
  }
  if (normalizedValues.some((value) => value.startsWith('/') || value.includes('/'))) {
    return path.posix
  }
  return path
}

export function resolveOpenClawSkillLocations(
  payload?: Record<string, unknown> | null,
  options: ResolveOpenClawSkillLocationsOptions = {}
): OpenClawSkillLocations {
  const homeDir = normalizePathLikeValue(options.homeDir || os.homedir())
  const pathModule = options.pathModule || inferPathModule(
    payload?.workspaceDir,
    payload?.managedSkillsDir,
    options.homeDir
  )
  const fallbackStateRoot = homeDir
    ? pathModule.join(homeDir, '.openclaw')
    : pathModule.resolve('.openclaw')
  const managedSkillsDir =
    normalizePathLikeValue(payload?.managedSkillsDir) || pathModule.join(fallbackStateRoot, 'skills')
  const workspaceDir =
    normalizePathLikeValue(payload?.workspaceDir) || pathModule.join(fallbackStateRoot, 'workspace')

  return {
    workspaceDir,
    workspaceSkillsDir: pathModule.join(workspaceDir, 'skills'),
    managedSkillsDir,
    clawhubWorkdir: pathModule.dirname(managedSkillsDir),
    clawhubDir: pathModule.basename(managedSkillsDir) || 'skills',
  }
}

export function normalizeOpenClawSkillsListPayload(
  payload: Record<string, unknown>,
  options: ResolveOpenClawSkillLocationsOptions = {}
): Record<string, unknown> {
  const locations = resolveOpenClawSkillLocations(payload, options)

  return {
    ...payload,
    workspaceDir: locations.workspaceDir,
    workspaceSkillsDir: locations.workspaceSkillsDir,
    managedSkillsDir: locations.managedSkillsDir,
    clawhubWorkdir: locations.clawhubWorkdir,
    clawhubDir: locations.clawhubDir,
    skills: Array.isArray(payload.skills) ? payload.skills : [],
  }
}

function buildClawHubBaseArgs(locations: OpenClawSkillLocations): string[] {
  return [
    '-y',
    'clawhub',
    '--workdir',
    locations.clawhubWorkdir,
    '--dir',
    locations.clawhubDir,
  ]
}

export function buildClawHubInstallArgs(
  slug: string,
  locations: OpenClawSkillLocations
): string[] {
  return [...buildClawHubBaseArgs(locations), 'install', slug]
}

export function buildClawHubUninstallArgs(
  slug: string,
  locations: OpenClawSkillLocations
): string[] {
  return [...buildClawHubBaseArgs(locations), 'uninstall', slug, '--yes']
}

export function resolveClawHubLockFilePath(
  locations: OpenClawSkillLocations,
  options: ResolveOpenClawSkillLocationsOptions = {}
): string {
  const pathModule = options.pathModule || inferPathModule(
    locations.clawhubWorkdir,
    locations.managedSkillsDir,
    locations.workspaceDir
  )
  return pathModule.join(locations.clawhubWorkdir, '.clawhub', 'lock.json')
}
