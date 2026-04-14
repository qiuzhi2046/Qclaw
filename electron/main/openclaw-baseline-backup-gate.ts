import type {
  OpenClawBaselineBackupEnsureResult,
  OpenClawBaselineBackupBypassRecord,
  OpenClawBaselineBackupManualAction,
  OpenClawBaselineBackupRecord,
  OpenClawBaselineBackupSkipResult,
  OpenClawInstallCandidate,
} from '../../src/shared/openclaw-phase1'
import { shouldEnsureBaselineBackup } from '../../src/shared/openclaw-phase1'
import { atomicWriteJson } from './atomic-write'
import { getOpenClawBackupStrategy } from './openclaw-backup-strategy'
import {
  ensureWritableOpenClawBackupRootDirectory,
  resolvePreferredOpenClawBackupDirectory,
  resolveOpenClawUserDataDirectory,
} from './openclaw-backup-roots'
import { formatDisplayPath } from './openclaw-paths'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
const { access, mkdir, readFile } = fs.promises
const { homedir } = os

interface BaselineBackupStore {
  version: 2
  entries: OpenClawBaselineBackupRecord[]
  bypasses: OpenClawBaselineBackupBypassRecord[]
}

const STORE_VERSION = 2
const STORE_RELATIVE_PATH = path.join('data-guard', 'baseline-backups.json')

function resolveUserDataDirectory(): string {
  return resolveOpenClawUserDataDirectory()
}

export function resolveDefaultBackupDirectory(): string {
  return resolvePreferredOpenClawBackupDirectory()
}

function resolveStorePath(): string {
  return path.join(resolveUserDataDirectory(), STORE_RELATIVE_PATH)
}

async function loadStore(): Promise<BaselineBackupStore> {
  const storePath = resolveStorePath()
  try {
    const raw = await readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<BaselineBackupStore>
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const bypasses = Array.isArray(parsed.bypasses) ? parsed.bypasses : []
    return {
      version: STORE_VERSION,
      entries: entries.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false
        return typeof entry.backupId === 'string' && typeof entry.archivePath === 'string'
      }) as OpenClawBaselineBackupRecord[],
      bypasses: bypasses.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false
        return (
          typeof entry.installFingerprint === 'string' &&
          typeof entry.skippedAt === 'string' &&
          typeof entry.sourcePath === 'string' &&
          typeof entry.suggestedArchivePath === 'string'
        )
      }) as OpenClawBaselineBackupBypassRecord[],
    }
  } catch {
    return {
      version: STORE_VERSION,
      entries: [],
      bypasses: [],
    }
  }
}

async function saveStore(store: BaselineBackupStore): Promise<void> {
  const storePath = resolveStorePath()
  await atomicWriteJson(storePath, store, {
    description: '基线备份状态',
  })
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function resolveValidBackupRecord(
  installFingerprint: string
): Promise<OpenClawBaselineBackupRecord | null> {
  const store = await loadStore()
  const matched = store.entries.find((entry) => entry.installFingerprint === installFingerprint) || null
  if (!matched) return null
  if (!(await pathExists(matched.archivePath))) return null
  return matched
}

async function resolveBackupBypassRecord(
  installFingerprint: string
): Promise<OpenClawBaselineBackupBypassRecord | null> {
  const store = await loadStore()
  return store.bypasses.find((entry) => entry.installFingerprint === installFingerprint) || null
}

export async function getBaselineBackupStatus(
  installFingerprint: string
): Promise<OpenClawBaselineBackupRecord | null> {
  if (!String(installFingerprint || '').trim()) return null
  return resolveValidBackupRecord(String(installFingerprint).trim())
}

export async function getBaselineBackupBypassStatus(
  installFingerprint: string
): Promise<OpenClawBaselineBackupBypassRecord | null> {
  if (!String(installFingerprint || '').trim()) return null
  return resolveBackupBypassRecord(String(installFingerprint).trim())
}

function createBackupId(installFingerprint: string): string {
  const shortHash = createHash('sha256')
    .update(installFingerprint)
    .digest('hex')
    .slice(0, 10)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `baseline-${stamp}-${shortHash}`
}

function buildManualBackupActionFromSource(params: {
  installFingerprint: string
  sourcePath?: string
  displaySourcePath?: string
  backupId?: string
}): OpenClawBaselineBackupManualAction {
  const backupId = String(params.backupId || createBackupId(params.installFingerprint)).trim()
  const sourcePath = String(params.sourcePath || '').trim()
  const suggestedArchivePath = path.join(resolveDefaultBackupDirectory(), `${backupId}-manual`)

  return {
    sourcePath,
    displaySourcePath:
      String(params.displaySourcePath || '').trim() ||
      (sourcePath ? formatDisplayPath(sourcePath, homedir()) : sourcePath),
    suggestedArchivePath,
    displaySuggestedArchivePath: formatDisplayPath(suggestedArchivePath, homedir()),
  }
}

function buildManualBackupAction(
  candidate: OpenClawInstallCandidate,
  backupId = createBackupId(candidate.installFingerprint)
): OpenClawBaselineBackupManualAction {
  return buildManualBackupActionFromSource({
    installFingerprint: candidate.installFingerprint,
    sourcePath: candidate.stateRoot,
    displaySourcePath: candidate.displayStateRoot,
    backupId,
  })
}

export async function recordBaselineBackupDeletionBypass(params: {
  installFingerprint: string
  sourcePath?: string
  displaySourcePath?: string
}): Promise<OpenClawBaselineBackupBypassRecord | null> {
  const installFingerprint = String(params.installFingerprint || '').trim()
  if (!installFingerprint) return null

  const bypassRecord: OpenClawBaselineBackupBypassRecord = {
    installFingerprint,
    skippedAt: new Date().toISOString(),
    reason: 'manual-backup-required',
    ...buildManualBackupActionFromSource({
      installFingerprint,
      sourcePath: params.sourcePath,
      displaySourcePath: params.displaySourcePath,
    }),
  }

  const store = await loadStore()
  store.entries = store.entries.filter((entry) => entry.installFingerprint !== installFingerprint)
  store.bypasses = [bypassRecord, ...store.bypasses.filter((entry) => entry.installFingerprint !== installFingerprint)]
  await saveStore(store)
  return bypassRecord
}

function buildBackupManifest(
  candidate: OpenClawInstallCandidate,
  backup: OpenClawBaselineBackupRecord,
  strategy = getOpenClawBackupStrategy('takeover-safeguard')
): Record<string, unknown> {
  return {
    backupId: backup.backupId,
    createdAt: backup.createdAt,
    backupType: 'baseline-backup',
    strategyId: strategy.id,
    homeCaptureMode: strategy.homeCaptureMode,
    installFingerprint: backup.installFingerprint,
    archivePath: backup.archivePath,
    candidate: {
      candidateId: candidate.candidateId,
      version: candidate.version,
      binaryPath: candidate.binaryPath,
      resolvedBinaryPath: candidate.resolvedBinaryPath,
      packageRoot: candidate.packageRoot,
      installSource: candidate.installSource,
      configPath: candidate.configPath,
      stateRoot: candidate.stateRoot,
      ownershipState: candidate.ownershipState,
    },
  }
}

export async function ensureBaselineBackup(
  candidate: OpenClawInstallCandidate | null | undefined
): Promise<OpenClawBaselineBackupEnsureResult> {
  if (!candidate) {
    return {
      ok: false,
      created: false,
      backup: null,
      errorCode: 'invalid_candidate',
      message: '未找到可接管的 OpenClaw 安装对象。',
    }
  }

  if (!shouldEnsureBaselineBackup(candidate)) {
    return {
      ok: true,
      created: false,
      backup: candidate.baselineBackup,
      errorCode: 'not_required',
      message: '当前安装不需要执行首次基线备份。',
    }
  }

  const existing = await resolveValidBackupRecord(candidate.installFingerprint)
  if (existing) {
    return {
      ok: true,
      created: false,
      backup: existing,
      message: '已存在该安装对象的基线备份。',
    }
  }

  try {
    const backupRoot = (await ensureWritableOpenClawBackupRootDirectory()).effectiveRootDirectory
    const backupId = createBackupId(candidate.installFingerprint)
    const backupDir = path.join(backupRoot, backupId)
    const createdAt = new Date().toISOString()
    const strategy = getOpenClawBackupStrategy('takeover-safeguard')
    const backupRecord: OpenClawBaselineBackupRecord = {
      backupId,
      createdAt,
      archivePath: backupDir,
      installFingerprint: candidate.installFingerprint,
    }

    await mkdir(backupDir, { recursive: true })
    await strategy.apply({ archivePath: backupDir, candidate })
    await atomicWriteJson(path.join(backupDir, 'manifest.json'), buildBackupManifest(candidate, backupRecord, strategy), {
      description: '基线备份 manifest',
    })

    const store = await loadStore()
    store.entries = [backupRecord, ...store.entries.filter((entry) => entry.installFingerprint !== candidate.installFingerprint)]
    store.bypasses = store.bypasses.filter((entry) => entry.installFingerprint !== candidate.installFingerprint)
    await saveStore(store)

    return {
      ok: true,
      created: true,
      backup: backupRecord,
      message: '已完成首次基线备份。',
    }
  } catch (error) {
    return {
      ok: false,
      created: false,
      backup: null,
      errorCode: 'backup_failed',
      message: error instanceof Error ? error.message : String(error),
      manualBackupAction: buildManualBackupAction(candidate),
    }
  }
}

export async function skipBaselineBackup(
  candidate: OpenClawInstallCandidate | null | undefined
): Promise<OpenClawBaselineBackupSkipResult> {
  if (!candidate) {
    return {
      ok: false,
      bypass: null,
      errorCode: 'invalid_candidate',
      message: '未找到可跳过自动备份的 OpenClaw 安装对象。',
    }
  }

  if (!shouldEnsureBaselineBackup(candidate)) {
    return {
      ok: true,
      bypass: candidate.baselineBackupBypass,
      errorCode: 'not_required',
      message: '当前安装不需要跳过首次基线备份。',
    }
  }

  try {
    const manualBackupAction = buildManualBackupAction(candidate)
    const bypassRecord: OpenClawBaselineBackupBypassRecord = {
      installFingerprint: candidate.installFingerprint,
      skippedAt: new Date().toISOString(),
      reason: 'manual-backup-required',
      ...manualBackupAction,
    }
    const store = await loadStore()
    store.bypasses = [bypassRecord, ...store.bypasses.filter((entry) => entry.installFingerprint !== candidate.installFingerprint)]
    await saveStore(store)
    return {
      ok: true,
      bypass: bypassRecord,
      message: '已记录手动备份提醒，可以继续流程。',
    }
  } catch (error) {
    return {
      ok: false,
      bypass: null,
      errorCode: 'skip_failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
