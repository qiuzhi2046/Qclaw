const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

type PathModule = typeof import('node:path')

const SKILL_SLUG_REGEX = /^[a-z0-9][a-z0-9._-]*$/i

interface ResolveSkillPathOptions {
  homeDir?: string
  rootKind?: 'managed' | 'workspace'
}

function normalizePathValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function inferPathModule(...values: unknown[]): PathModule {
  const normalizedValues = values
    .map((value) => normalizePathValue(value))
    .filter(Boolean)
  if (normalizedValues.some((value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\'))) {
    return path.win32
  }
  if (normalizedValues.some((value) => value.startsWith('/') || value.includes('/'))) {
    return path.posix
  }
  return path
}

export function isAllowedOpenClawSkillsRoot(
  skillsRootDir: string,
  options: ResolveSkillPathOptions = {}
): boolean {
  const pathModule = inferPathModule(skillsRootDir, options.homeDir)
  const homeDir = normalizePathValue(options.homeDir || os.homedir())
  if (!homeDir) return false

  const stateRoot = pathModule.resolve(homeDir, '.openclaw')
  const skillsRoot = pathModule.resolve(skillsRootDir)
  const relative = pathModule.relative(stateRoot, skillsRoot)
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
    return false
  }

  const segments = relative.split(pathModule.sep).filter(Boolean)
  if (options.rootKind === 'managed') {
    return segments.length === 1 && segments[0] === 'skills'
  }

  if (options.rootKind === 'workspace') {
    return (
      segments.length === 2 &&
      segments[1] === 'skills' &&
      /^workspace(?:$|[-_])/.test(segments[0])
    )
  }

  return (
    (segments.length === 1 && segments[0] === 'skills') ||
    (segments.length === 2 && segments[1] === 'skills' && /^workspace(?:$|[-_])/.test(segments[0]))
  )
}

export function normalizeSafeSkillSlug(input: string): string | null {
  const normalized = String(input || '').trim()
  if (!normalized) return null
  if (!SKILL_SLUG_REGEX.test(normalized)) return null
  return normalized
}

export function findExactSafeSkillSlugMatch(
  requestedSlug: string,
  candidateSlugs: string[]
): string | null {
  const safeRequested = normalizeSafeSkillSlug(requestedSlug)
  if (!safeRequested) return null
  const requestedKey = safeRequested.toLowerCase()

  for (const rawCandidate of candidateSlugs || []) {
    const safeCandidate = normalizeSafeSkillSlug(String(rawCandidate || ''))
    if (!safeCandidate) continue
    if (safeCandidate.toLowerCase() === requestedKey) {
      return safeCandidate
    }
  }

  return null
}

export function resolveSkillPathUnderRoot(
  skillsRootDir: string,
  skillSlug: string,
  options: ResolveSkillPathOptions = {}
): { ok: true; skillsRoot: string; targetPath: string } | { ok: false; error: string } {
  const safeSlug = normalizeSafeSkillSlug(skillSlug)
  if (!safeSlug) {
    return { ok: false, error: 'invalid-skill-slug' }
  }

  const normalizedSkillsRootDir = String(skillsRootDir || '').trim()
  if (!normalizedSkillsRootDir) {
    return { ok: false, error: 'invalid-managed-skills-dir' }
  }

  const pathModule = inferPathModule(normalizedSkillsRootDir, options.homeDir)
  const skillsRoot = pathModule.resolve(normalizedSkillsRootDir)
  if (!isAllowedOpenClawSkillsRoot(skillsRoot, options)) {
    return { ok: false, error: 'unsafe-skills-root' }
  }

  const targetPath = pathModule.resolve(skillsRoot, safeSlug)
  const relative = pathModule.relative(skillsRoot, targetPath)
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
    return { ok: false, error: 'unsafe-fallback-path' }
  }

  return { ok: true, skillsRoot, targetPath }
}

export function resolveManagedSkillFallbackPath(
  managedSkillsDir: string,
  skillSlug: string,
  options: ResolveSkillPathOptions = {}
): { ok: true; skillsRoot: string; targetPath: string } | { ok: false; error: string } {
  return resolveSkillPathUnderRoot(managedSkillsDir, skillSlug, {
    ...options,
    rootKind: 'managed',
  })
}
