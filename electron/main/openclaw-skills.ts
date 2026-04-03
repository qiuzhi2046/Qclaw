import type { CliResult } from './cli'
import { parseJsonFromCommandResult, parseJsonFromOutput } from './openclaw-command-output'
import { normalizeOpenClawSkillsListPayload } from './skills-paths'
import installWebPolicy from '../../install-web-v1.manifest.json'

type PathModule = typeof import('node:path')

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      const record = asRecord(item)
      if (!record) return ''
      return (
        asTrimmedString(record.name) ||
        asTrimmedString(record.key) ||
        asTrimmedString(record.env) ||
        asTrimmedString(record.label)
      )
    })
    .filter(Boolean)
}

function normalizeSkillMissing(value: unknown): {
  bins: string[]
  anyBins: string[]
  env: string[]
  config: string[]
  os: string[]
} | undefined {
  const record = asRecord(value)
  if (!record) return undefined

  return {
    bins: normalizeStringList(record.bins),
    anyBins: normalizeStringList(record.anyBins),
    env: normalizeStringList(record.env),
    config: normalizeStringList(record.config),
    os: normalizeStringList(record.os),
  }
}

function normalizeInstallSteps(value: unknown): Array<{
  id: string
  kind: string
  label: string
  bins: string[]
}> {
  if (!Array.isArray(value)) return []

  return value
    .map((step, index) => {
      const record = asRecord(step)
      if (!record) return null
      const id = asTrimmedString(record.id) || `step-${index + 1}`
      const kind = asTrimmedString(record.kind) || 'manual'
      const label =
        asTrimmedString(record.label) ||
        asTrimmedString(record.title) ||
        asTrimmedString(record.description) ||
        kind
      return {
        id,
        kind,
        label,
        bins: normalizeStringList(record.bins),
      }
    })
    .filter((step): step is { id: string; kind: string; label: string; bins: string[] } => Boolean(step))
}

function getPathValue(value: unknown, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean)
  let cursor: unknown = value
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function getBooleanPathValue(value: unknown, path: string): boolean | undefined {
  const resolved = getPathValue(value, path)
  return typeof resolved === 'boolean' ? resolved : undefined
}

interface InstallWebSkillManifestEntry {
  id?: string
  label?: string
  description?: string
  kind?: string
  enableConfigKeys?: string[]
}

interface InstallWebSkillsManifest {
  skills?: InstallWebSkillManifestEntry[]
  webSearch?: {
    enabledConfigKey?: string
  }
}

const installWebSkillsPolicy = installWebPolicy as InstallWebSkillsManifest

export interface NormalizedOpenClawSkillEntry {
  name: string
  description: string
  source: string
  eligible: boolean
  disabled: boolean
  blockedByAllowlist?: boolean
  bundled?: boolean
  skillKey: string
  homepage?: string
  emoji?: string
  primaryEnv?: string
  apiKeys?: string[]
  configKeys?: string[]
  requires?: string[]
  installTarget?: string
  location?: string
  path?: string
  missing?: {
    bins: string[]
    anyBins: string[]
    env: string[]
    config: string[]
    os: string[]
  }
  install?: Array<{
    id: string
    kind: string
    label: string
    bins: string[]
  }>
}

function buildManifestBundledSkillEntries(
  config?: Record<string, unknown> | null
): NormalizedOpenClawSkillEntry[] {
  const manifestSkills = Array.isArray(installWebSkillsPolicy.skills) ? installWebSkillsPolicy.skills : []

  return manifestSkills
    .map((skill) => {
      const id = asTrimmedString(skill.id)
      if (!id) return null

      const configKeys = (() => {
        if (id === 'web-search') {
          const enabledConfigKey = asTrimmedString(installWebSkillsPolicy.webSearch?.enabledConfigKey)
          return enabledConfigKey ? [enabledConfigKey] : []
        }
        return normalizeStringList(skill.enableConfigKeys)
      })()

      const enabledStates = configKeys
        .map((configKey) => getBooleanPathValue(config, configKey))
        .filter((state): state is boolean => typeof state === 'boolean')
      const disabled = enabledStates.length > 0 ? !enabledStates.every(Boolean) : false

      const manifestEntry: NormalizedOpenClawSkillEntry = {
        name: asTrimmedString(skill.label) || id,
        description: asTrimmedString(skill.description),
        source: 'openclaw-bundled',
        eligible: true,
        disabled,
        bundled: true,
        skillKey: id,
        configKeys,
        installTarget: asTrimmedString(skill.kind) || 'builtin',
        location: 'install-web-v1.manifest.json',
      }

      return manifestEntry
    })
    .filter((skill): skill is NormalizedOpenClawSkillEntry => Boolean(skill))
}

function mergeBundledManifestSkills(params: {
  payload: Record<string, unknown>
  config?: Record<string, unknown> | null
}): Record<string, unknown> {
  const bundledSkills = buildManifestBundledSkillEntries(params.config)
  if (bundledSkills.length === 0) return params.payload

  const existingSkills = Array.isArray(params.payload.skills) ? params.payload.skills : []
  const mergedSkills: unknown[] = [...existingSkills]
  const seen = new Set<string>()

  for (const skill of existingSkills) {
    const normalized = normalizeOpenClawSkillEntry(skill)
    if (!normalized) continue
    seen.add(normalized.skillKey.toLowerCase())
    seen.add(normalized.name.toLowerCase())
  }

  for (const bundledSkill of bundledSkills) {
    if (seen.has(bundledSkill.skillKey.toLowerCase()) || seen.has(bundledSkill.name.toLowerCase())) {
      continue
    }
    mergedSkills.push(bundledSkill)
  }

  return {
    ...params.payload,
    skills: mergedSkills,
  }
}

export function normalizeSkillConfigKey(raw: unknown): string | null {
  const normalized = asTrimmedString(raw)
  if (!normalized || normalized.length > 160) return null
  if (/[\0\r\n]/.test(normalized)) return null
  return normalized
}

export function normalizeOpenClawSkillEntry(value: unknown): NormalizedOpenClawSkillEntry | null {
  const record = asRecord(value)
  if (!record) return null

  const metadata = asRecord(record.metadata)
  const metadataOpenClaw = asRecord(metadata?.openclaw)
  const name = asTrimmedString(record.name) || asTrimmedString(record.id)
  if (!name) return null

  const skillKey =
    normalizeSkillConfigKey(record.skillKey) ||
    normalizeSkillConfigKey(record.key) ||
    normalizeSkillConfigKey(metadataOpenClaw?.skillKey) ||
    name

  return {
    name,
    description:
      asTrimmedString(record.description) ||
      asTrimmedString(record.summary) ||
      asTrimmedString(record.title),
    source: asTrimmedString(record.source) || 'unknown',
    eligible: asBoolean(record.eligible) ?? true,
    disabled: asBoolean(record.disabled) ?? false,
    blockedByAllowlist: asBoolean(record.blockedByAllowlist),
    bundled:
      asBoolean(record.bundled) ??
      ['openclaw-bundled', 'openclaw-extra'].includes(asTrimmedString(record.source)),
    skillKey,
    homepage:
      asTrimmedString(record.homepage) ||
      asTrimmedString(metadataOpenClaw?.homepage) ||
      asTrimmedString(metadata?.homepage),
    emoji: asTrimmedString(record.emoji) || asTrimmedString(metadataOpenClaw?.emoji),
    primaryEnv:
      asTrimmedString(record.primaryEnv) ||
      asTrimmedString(metadataOpenClaw?.primaryEnv),
    apiKeys:
      normalizeStringList(record.apiKeys).length > 0
        ? normalizeStringList(record.apiKeys)
        : normalizeStringList(metadataOpenClaw?.apiKeys),
    configKeys:
      normalizeStringList(record.configKeys).length > 0
        ? normalizeStringList(record.configKeys)
        : normalizeStringList(metadataOpenClaw?.configKeys),
    requires:
      normalizeStringList(record.requires).length > 0
        ? normalizeStringList(record.requires)
        : normalizeStringList(metadataOpenClaw?.requires),
    installTarget:
      asTrimmedString(record.installTarget) ||
      asTrimmedString(metadataOpenClaw?.installTarget),
    location: asTrimmedString(record.location),
    path: asTrimmedString(record.path),
    missing: normalizeSkillMissing(record.missing),
    install:
      normalizeInstallSteps(record.install).length > 0
        ? normalizeInstallSteps(record.install)
        : normalizeInstallSteps(metadataOpenClaw?.install),
  }
}

export function normalizeOpenClawSkillsPayload(
  payload: Record<string, unknown>,
  options: {
    config?: Record<string, unknown> | null
    pathModule?: PathModule
  } = {}
): Record<string, unknown> {
  const normalizedPayload = mergeBundledManifestSkills({
    payload: normalizeOpenClawSkillsListPayload(payload, {
      pathModule: options.pathModule,
    }),
    config: options.config,
  })
  const rawSkills = Array.isArray(normalizedPayload.skills) ? normalizedPayload.skills : []
  return {
    ...normalizedPayload,
    skills: rawSkills
      .map((skill) => normalizeOpenClawSkillEntry(skill))
      .filter((skill): skill is NormalizedOpenClawSkillEntry => Boolean(skill)),
  }
}

export function buildBundledFallbackSkillsPayload(
  config?: Record<string, unknown> | null,
  payload: Record<string, unknown> = {}
): Record<string, unknown> {
  return normalizeOpenClawSkillsPayload(payload, { config })
}

export function normalizeSkillsPayloadCliResult(result: CliResult): CliResult {
  if (!result.ok || (!result.stdout && !result.stderr)) return result
  try {
    const parsed = parseJsonFromCommandResult<Record<string, unknown>>(result)
    return {
      ...result,
      stdout: JSON.stringify(normalizeOpenClawSkillsPayload(parsed)),
    }
  } catch {
    return result
  }
}

export function normalizeSkillInfoCliResult(result: CliResult): CliResult {
  if (!result.ok || (!result.stdout && !result.stderr)) return result
  try {
    const parsed = parseJsonFromCommandResult<Record<string, unknown>>(result)
    const topLevelSkill = asRecord(parsed.skill) || parsed
    const normalized = normalizeOpenClawSkillEntry(topLevelSkill)
    if (!normalized) return result
    return {
      ...result,
      stdout: JSON.stringify({
        ...parsed,
        ...normalized,
      }),
    }
  } catch {
    return result
  }
}

export function isUnsupportedSkillsCommand(result: Pick<CliResult, 'ok' | 'stdout' | 'stderr'>): boolean {
  if (result.ok) return false
  const corpus = `${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase()
  return (
    /\bunknown command\b/.test(corpus)
    || /\bunsupported\b/.test(corpus)
    || /\bunrecognized command\b/.test(corpus)
    || /\bno such command\b/.test(corpus)
    || /\binvalid command\b/.test(corpus)
    || /\btoo many arguments\b/.test(corpus)
    || /\bexpected 0 arguments\b/.test(corpus)
  )
}

export function findNormalizedSkillByNameOrKey(
  payload: Record<string, unknown> | null | undefined,
  lookup: string
): NormalizedOpenClawSkillEntry | null {
  const normalizedLookup = lookup.trim().toLowerCase()
  if (!normalizedLookup) return null

  const skills = Array.isArray(payload?.skills) ? payload.skills : []
  for (const skill of skills) {
    const normalized = normalizeOpenClawSkillEntry(skill)
    if (!normalized) continue
    if (
      normalized.name.trim().toLowerCase() === normalizedLookup ||
      normalized.skillKey.trim().toLowerCase() === normalizedLookup
    ) {
      return normalized
    }
  }

  return null
}

export function findBundledManifestSkillByNameOrKey(
  lookup: string,
  config?: Record<string, unknown> | null
): NormalizedOpenClawSkillEntry | null {
  const normalizedLookup = lookup.trim().toLowerCase()
  if (!normalizedLookup) return null

  for (const skill of buildManifestBundledSkillEntries(config)) {
    if (
      skill.skillKey.toLowerCase() === normalizedLookup ||
      skill.name.toLowerCase() === normalizedLookup
    ) {
      return skill
    }
  }

  return null
}
