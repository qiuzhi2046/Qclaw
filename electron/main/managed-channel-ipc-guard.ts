import {
  getManagedChannelPluginByPluginId,
  listManagedChannelPluginRecords,
  type ManagedChannelPluginRecord,
} from '../../src/shared/managed-channel-plugin-registry'
import {
  tryAcquireManagedOperationLeases,
  isManagedOperationLockBusy,
  type ManagedOperationLease,
} from './managed-operation-lock'

interface CliResultLike {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

interface RepairIncompatibleExtensionsResultLike {
  ok: boolean
  repaired: boolean
  summary: string
  stderr: string
  incompatiblePlugins: unknown[]
  quarantinedPluginIds: string[]
  prunedPluginIds: string[]
  orphanedPluginIds?: string[]
  dryRun?: boolean
  smokeTestSkipped?: boolean
}

export interface ManagedPluginIpcTargetClassification {
  blockedMessage: string | null
  expectedPluginIds: string[]
  managedRecords: ManagedChannelPluginRecord[]
}

const MANAGED_PACKAGE_SCOPES = [
  '@dingtalk-real-ai/',
  '@feishu/',
  '@larksuite/',
  '@tencent-connect/',
  '@tencent-weixin/',
  '@wecom/',
]

const MANAGED_CHANNEL_ALIASES = [
  'dingtalk',
  'feishu',
  'lark',
  'openclaw-weixin',
  'qqbot',
  'wecom',
  'weixin',
]

const MANAGED_SCOPED_PACKAGE_PATTERN = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi
const SPEC_ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar', '.zip', '.git']

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function normalizeId(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function normalizePackageSpec(value: unknown): string {
  return normalizeId(value).replace(/^npm:/, '')
}

function stripPackageVersion(value: string): string {
  const normalized = normalizePackageSpec(value)
  if (!normalized) return ''
  if (normalized.startsWith('@')) {
    const slashIndex = normalized.indexOf('/')
    if (slashIndex < 0) return normalized
    const versionIndex = normalized.indexOf('@', slashIndex + 1)
    return versionIndex >= 0 ? normalized.slice(0, versionIndex) : normalized
  }
  const versionIndex = normalized.indexOf('@')
  return versionIndex >= 0 ? normalized.slice(0, versionIndex) : normalized
}

function safeDecodeSpecifier(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripSpecifierArchiveSuffix(value: string): string {
  const normalized = normalizePackageSpec(value)
  for (const suffix of SPEC_ARCHIVE_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length)
    }
  }
  return normalized
}

function stripSpecifierVersionSuffix(value: string): string {
  const normalized = stripSpecifierArchiveSuffix(value)
  if (!normalized) return ''
  return normalized.replace(/-(?:v?\d+(?:\.\d+)+(?:[-+_.][a-z0-9]+)*)$/i, '')
}

function addSpecifierCandidate(candidates: Set<string>, value: unknown): void {
  const normalized = normalizePackageSpec(value)
  if (!normalized) return
  candidates.add(normalized)

  const versionless = stripPackageVersion(normalized)
  if (versionless) candidates.add(versionless)

  const archiveLess = stripSpecifierArchiveSuffix(versionless)
  if (archiveLess) candidates.add(archiveLess)

  const releaseStem = stripSpecifierVersionSuffix(archiveLess)
  if (releaseStem) candidates.add(releaseStem)
}

function collectNormalizedSpecifierCandidates(spec: string): string[] {
  const candidates = new Set<string>()
  const normalizedSpec = normalizeText(spec).replace(/\\/g, '/')
  if (!normalizedSpec) return []

  const variants = [...new Set([normalizedSpec, safeDecodeSpecifier(normalizedSpec)])]
  for (const variant of variants) {
    addSpecifierCandidate(candidates, variant)

    const withoutQuery = variant.split(/[?#]/, 1)[0] || ''
    addSpecifierCandidate(candidates, withoutQuery)

    const scopedMatches = withoutQuery.match(MANAGED_SCOPED_PACKAGE_PATTERN) || []
    for (const scopedMatch of scopedMatches) {
      addSpecifierCandidate(candidates, scopedMatch)
    }

    for (const segment of withoutQuery.replace(/^git\+/, '').split('/')) {
      addSpecifierCandidate(candidates, segment)
    }
  }

  return Array.from(candidates)
}

function addRecord(records: ManagedChannelPluginRecord[], record: ManagedChannelPluginRecord | null): void {
  if (!record) return
  if (records.some((candidate) => normalizeId(candidate.channelId) === normalizeId(record.channelId))) return
  records.push(record)
}

function isSpecificManagedIdentifier(value: unknown): boolean {
  const normalized = normalizePackageSpec(value)
  if (!normalized) return false
  return normalized.includes('-') || normalized.includes('/') || normalized.startsWith('@')
}

function collectManagedRecordSpecifierCandidates(record: ManagedChannelPluginRecord): string[] {
  const candidates = new Set<string>()
  for (const value of [
    record.pluginId,
    record.packageName,
    record.npxSpecifier,
    ...record.cleanupPluginIds.filter((item) => isSpecificManagedIdentifier(item)),
  ]) {
    for (const candidate of collectNormalizedSpecifierCandidates(String(value || ''))) {
      candidates.add(candidate)
    }
  }
  return Array.from(candidates)
}

function findManagedRecordBySpecifier(spec: string): ManagedChannelPluginRecord | null {
  const specCandidates = collectNormalizedSpecifierCandidates(spec)
  if (specCandidates.length === 0) return null

  for (const record of listManagedChannelPluginRecords()) {
    const recordCandidates = collectManagedRecordSpecifierCandidates(record)
    if (specCandidates.some((candidate) => recordCandidates.includes(candidate))) return record
  }

  return null
}

function isManagedLikeSpecifier(spec: string): boolean {
  const normalizedSpec = normalizeText(spec)
  if (!normalizedSpec) return false

  const exactForms = [...new Set([
    normalizePackageSpec(normalizedSpec),
    normalizePackageSpec(safeDecodeSpecifier(normalizedSpec)),
  ])].filter(Boolean)

  if (exactForms.some((candidate) => MANAGED_CHANNEL_ALIASES.includes(candidate))) return true

  const candidates = collectNormalizedSpecifierCandidates(spec)
  return candidates.some((candidate) =>
    MANAGED_PACKAGE_SCOPES.some((scope) => candidate.startsWith(scope))
  )
}

function normalizeExpectedPluginIds(expectedPluginIds: string[] | undefined): string[] {
  return [...new Set((expectedPluginIds || []).map(normalizeText).filter(Boolean))]
}

export function getManagedChannelPluginLockKey(channelId: string): string {
  return `managed-channel-plugin:${normalizeText(channelId)}`
}

export function isAnyManagedChannelOperationBusy(channelIds?: string[]): boolean {
  const targetChannelIds = (channelIds && channelIds.length > 0)
    ? channelIds
    : listManagedChannelPluginRecords().map((record) => record.channelId)
  return targetChannelIds.some((channelId) =>
    isManagedOperationLockBusy(getManagedChannelPluginLockKey(channelId))
  )
}

export function classifyManagedPluginIpcTarget(input: {
  expectedPluginIds?: string[]
  spec: string
}): ManagedPluginIpcTargetClassification {
  const spec = normalizeText(input.spec)
  const expectedPluginIds = normalizeExpectedPluginIds(input.expectedPluginIds)
  const managedRecords: ManagedChannelPluginRecord[] = []

  for (const pluginId of expectedPluginIds) {
    addRecord(managedRecords, getManagedChannelPluginByPluginId(pluginId))
  }

  const specRecord = findManagedRecordBySpecifier(spec)
  addRecord(managedRecords, specRecord)

  if (specRecord && expectedPluginIds.length > 0) {
    const expectedRecords = expectedPluginIds
      .map((pluginId) => getManagedChannelPluginByPluginId(pluginId))
      .filter(Boolean)
    const expectedMatchesSpecRecord = expectedRecords.some((record) =>
      normalizeId(record?.channelId) === normalizeId(specRecord.channelId)
    )
    if (!expectedMatchesSpecRecord) {
      return {
        blockedMessage:
          `官方消息渠道插件 ${specRecord.pluginId} 的 expectedPluginIds 与 package spec 不匹配，已阻止本次安装。`,
        expectedPluginIds,
        managedRecords: [],
      }
    }
  }

  if (managedRecords.length === 0 && isManagedLikeSpecifier(spec)) {
    return {
      blockedMessage:
        '该插件看起来是官方消息渠道插件，但无法按 registry 明确归类。请传入明确的 expectedPluginIds 后重试。',
      expectedPluginIds,
      managedRecords: [],
    }
  }

  const synthesizedExpectedPluginIds = managedRecords.length > 0
    ? [...new Set([...expectedPluginIds, ...managedRecords.map((record) => record.pluginId)])]
    : expectedPluginIds

  return {
    blockedMessage: null,
    expectedPluginIds: synthesizedExpectedPluginIds,
    managedRecords,
  }
}

function createManagedChannelBusyCliResult(): CliResultLike {
  return {
    ok: false,
    stdout: '',
    stderr: '官方消息渠道插件正在执行安装、修复或配置同步，请稍后重试。',
    code: 1,
  }
}

function createManagedChannelBlockedCliResult(message: string): CliResultLike {
  return {
    ok: false,
    stdout: '',
    stderr: message,
    code: 1,
  }
}

function createManagedChannelBusyRepairResult(): RepairIncompatibleExtensionsResultLike {
  return {
    ok: false,
    repaired: false,
    incompatiblePlugins: [],
    quarantinedPluginIds: [],
    prunedPluginIds: [],
    orphanedPluginIds: [],
    summary: '官方消息渠道插件正在执行安装、修复或配置同步，请稍后重试。',
    stderr: 'managed_channel_busy',
  }
}

function collectManagedChannelLockKeys(records: ManagedChannelPluginRecord[]): string[] {
  return [...new Set(records.map((record) => normalizeText(record.channelId)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map((channelId) => getManagedChannelPluginLockKey(channelId))
}

function releaseManagedOperationLeases(leases: ManagedOperationLease[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    leases[index].release()
  }
}

export async function runManagedPluginIpcOperation(
  classification: ManagedPluginIpcTargetClassification,
  operation: (expectedPluginIds: string[]) => Promise<CliResultLike>
): Promise<CliResultLike> {
  if (classification.blockedMessage) {
    return createManagedChannelBlockedCliResult(classification.blockedMessage)
  }
  if (classification.managedRecords.length === 0) {
    return operation(classification.expectedPluginIds)
  }
  const leases = tryAcquireManagedOperationLeases(
    collectManagedChannelLockKeys(classification.managedRecords)
  )
  if (!leases) {
    return createManagedChannelBusyCliResult()
  }
  try {
    return await operation(classification.expectedPluginIds)
  } finally {
    releaseManagedOperationLeases(leases)
  }
}

export async function runManagedPluginRepairIpcOperation<T extends RepairIncompatibleExtensionsResultLike>(
  options: { scopePluginIds?: string[] },
  operation: () => Promise<T>
): Promise<T | RepairIncompatibleExtensionsResultLike> {
  const scopePluginIds = normalizeExpectedPluginIds(options.scopePluginIds)
  const managedRecords: ManagedChannelPluginRecord[] = []
  if (scopePluginIds.length > 0) {
    for (const pluginId of scopePluginIds) {
      addRecord(managedRecords, getManagedChannelPluginByPluginId(pluginId))
    }
  } else {
    for (const record of listManagedChannelPluginRecords()) {
      addRecord(managedRecords, record)
    }
  }

  if (managedRecords.length === 0) {
    return operation()
  }
  const leases = tryAcquireManagedOperationLeases(collectManagedChannelLockKeys(managedRecords))
  if (!leases) {
    return createManagedChannelBusyRepairResult()
  }
  try {
    return await operation()
  } finally {
    releaseManagedOperationLeases(leases)
  }
}
