import {
  buildManualBackupWarning,
  type OpenClawInstallCandidate,
} from '../../src/shared/openclaw-phase1'
import type {
  OpenClawConfigSnapshotRecord,
  OpenClawDataGuardSummary,
  OpenClawGuardPrepareResult,
  OpenClawGuardedConfigWriteRequest,
  OpenClawGuardedEnvWriteRequest,
  OpenClawGuardedWriteResult,
} from '../../src/shared/openclaw-phase2'
import { shouldEnsureBaselineBackup } from '../../src/shared/openclaw-phase1'
import { atomicWriteJson } from './atomic-write'
import { readConfig, readEnvFile, writeConfig, writeEnvFile } from './cli'
import { collectChangedJsonPaths } from './openclaw-config-diff'
import {
  getBaselineBackupBypassStatus,
  getBaselineBackupStatus,
  resolveDefaultBackupDirectory,
} from './openclaw-baseline-backup-gate'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'
import { describeManagedShellBlockScopes } from './openclaw-managed-blocks'
import {
  getOwnershipEntry,
  listOwnershipChanges,
  recordManagedConfigWrite,
  recordManagedEnvWrite,
  setFirstManagedWriteSnapshot,
  summarizeOwnershipEntry,
  upsertOwnershipCandidate,
} from './openclaw-ownership-store'
import { resolveOpenClawPathsFromStateRoot } from './openclaw-paths'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, cp, mkdir } = fs.promises

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function resolveActiveCandidate(
  preferredCandidate: OpenClawInstallCandidate | null | undefined,
  discoveredCandidates: OpenClawInstallCandidate[]
): OpenClawInstallCandidate | null {
  if (preferredCandidate?.installFingerprint) {
    const matched =
      discoveredCandidates.find(
        (candidate) => candidate.installFingerprint === preferredCandidate.installFingerprint
      ) || null
    return matched || preferredCandidate
  }

  return discoveredCandidates.find((candidate) => candidate.isPathActive) || discoveredCandidates[0] || null
}

async function resolveCurrentCandidate(
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawInstallCandidate | null> {
  const discovery = await discoverOpenClawInstallations()
  return resolveActiveCandidate(preferredCandidate, discovery.candidates)
}

function createConfigSnapshotId(installFingerprint: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const shortFingerprint = String(installFingerprint || '').slice(0, 10) || 'unknown'
  return `config-snapshot-${stamp}-${shortFingerprint}`
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) return
  await cp(sourcePath, targetPath, { recursive: true, force: true })
}

function buildSnapshotManifest(
  candidate: OpenClawInstallCandidate,
  snapshot: OpenClawConfigSnapshotRecord
): Record<string, unknown> {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotType: snapshot.snapshotType,
    createdAt: snapshot.createdAt,
    installFingerprint: snapshot.installFingerprint,
    archivePath: snapshot.archivePath,
    candidate: {
      candidateId: candidate.candidateId,
      version: candidate.version,
      binaryPath: candidate.binaryPath,
      resolvedBinaryPath: candidate.resolvedBinaryPath,
      packageRoot: candidate.packageRoot,
      installSource: candidate.installSource,
      configPath: candidate.configPath,
      stateRoot: candidate.stateRoot,
    },
  }
}

async function createFirstManagedWriteSnapshot(
  candidate: OpenClawInstallCandidate
): Promise<OpenClawConfigSnapshotRecord> {
  const snapshotId = createConfigSnapshotId(candidate.installFingerprint)
  const archivePath = path.join(resolveDefaultBackupDirectory(), snapshotId)
  const createdAt = new Date().toISOString()
  const snapshot: OpenClawConfigSnapshotRecord = {
    snapshotId,
    createdAt,
    archivePath,
    installFingerprint: candidate.installFingerprint,
    snapshotType: 'config-snapshot',
  }

  const openClawPaths = resolveOpenClawPathsFromStateRoot({
    stateRoot: candidate.stateRoot,
    configFile: candidate.configPath,
  })
  await mkdir(archivePath, { recursive: true })
  await copyIfExists(candidate.configPath, path.join(archivePath, 'openclaw.json'))
  await copyIfExists(openClawPaths.envFile, path.join(archivePath, '.env'))
  await copyIfExists(openClawPaths.credentialsDir, path.join(archivePath, 'credentials'))
  await atomicWriteJson(path.join(archivePath, 'manifest.json'), buildSnapshotManifest(candidate, snapshot), {
    description: '配置快照 manifest',
  })

  return snapshot
}

async function ensureOwnershipCandidate(candidate: OpenClawInstallCandidate) {
  return upsertOwnershipCandidate(candidate)
}

async function ensureManagedWritePreparation(
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<{
  ok: boolean
  blocked: boolean
  candidate: OpenClawInstallCandidate | null
  snapshotCreated: boolean
  snapshot: OpenClawConfigSnapshotRecord | null
  message?: string
  errorCode?: 'no_active_install' | 'baseline_backup_required' | 'snapshot_failed'
}> {
  const candidate = await resolveCurrentCandidate(preferredCandidate)
  if (!candidate) {
    return {
      ok: false,
      blocked: true,
      candidate: null,
      snapshotCreated: false,
      snapshot: null,
      errorCode: 'no_active_install',
      message: '当前没有可接管的 OpenClaw 安装对象。',
    }
  }

  const baselineBackup =
    candidate.baselineBackup || (await getBaselineBackupStatus(candidate.installFingerprint))
  const baselineBackupBypass =
    candidate.baselineBackupBypass || (await getBaselineBackupBypassStatus(candidate.installFingerprint))
  const normalizedCandidate = {
    ...candidate,
    baselineBackup,
    baselineBackupBypass,
  }

  if (shouldEnsureBaselineBackup(normalizedCandidate) && !baselineBackup) {
    return {
      ok: false,
      blocked: true,
      candidate: normalizedCandidate,
      snapshotCreated: false,
      snapshot: null,
      errorCode: 'baseline_backup_required',
      message: '当前安装尚未完成首次基线备份，暂时不能修改当前配置。',
    }
  }

  const ownershipEntry = await ensureOwnershipCandidate(normalizedCandidate)
  if (normalizedCandidate.ownershipState === 'qclaw-installed' || ownershipEntry?.firstManagedWriteSnapshot) {
    return {
      ok: true,
      blocked: false,
      candidate: normalizedCandidate,
      snapshotCreated: false,
      snapshot: ownershipEntry?.firstManagedWriteSnapshot || null,
    }
  }

  try {
    const snapshot = await createFirstManagedWriteSnapshot(normalizedCandidate)
    await setFirstManagedWriteSnapshot(normalizedCandidate, snapshot)
    return {
      ok: true,
      blocked: false,
      candidate: normalizedCandidate,
      snapshotCreated: true,
      snapshot,
      message: '已在首次写入当前配置前创建配置快照。',
    }
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      candidate: normalizedCandidate,
      snapshotCreated: false,
      snapshot: null,
      errorCode: 'snapshot_failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function prepareManagedConfigWrite(
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawGuardPrepareResult> {
  const preparation = await ensureManagedWritePreparation(preferredCandidate)
  const ownershipEntry = preparation.candidate
    ? await getOwnershipEntry(preparation.candidate.installFingerprint)
    : null

  return {
    ok: preparation.ok,
    blocked: preparation.blocked,
    prepared: preparation.ok,
    snapshotCreated: preparation.snapshotCreated,
    snapshot: preparation.snapshot,
    ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
    message: preparation.message,
    errorCode: preparation.errorCode,
  }
}

export async function guardedWriteConfig(
  request: OpenClawGuardedConfigWriteRequest,
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawGuardedWriteResult> {
  const preparation = await ensureManagedWritePreparation(preferredCandidate)
  if (!preparation.ok || !preparation.candidate) {
    return {
      ok: false,
      blocked: preparation.blocked,
      wrote: false,
      target: 'config',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: preparation.message,
      errorCode: preparation.errorCode,
    }
  }

  try {
    const currentConfig = await readConfig()
    const changedJsonPaths = collectChangedJsonPaths(currentConfig, request.config)

    if (changedJsonPaths.length === 0) {
      const ownershipEntry = await getOwnershipEntry(preparation.candidate.installFingerprint)
      return {
        ok: true,
        blocked: false,
        wrote: false,
        target: 'config',
        snapshotCreated: preparation.snapshotCreated,
        snapshot: preparation.snapshot,
        changedJsonPaths,
        ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
        message: '配置没有发生变化，无需写入。',
      }
    }

    await writeConfig(request.config)
    const ownershipEntry = await recordManagedConfigWrite(preparation.candidate, {
      filePath: preparation.candidate.configPath,
      jsonPaths: changedJsonPaths,
    })

    return {
      ok: true,
      blocked: false,
      wrote: true,
      target: 'config',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths,
      ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
      message: '当前配置已通过 DataGuard 写入。',
    }
  } catch (error) {
    return {
      ok: false,
      blocked: false,
      wrote: false,
      target: 'config',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: error instanceof Error ? error.message : String(error),
      errorCode: 'write_failed',
    }
  }
}

export async function guardedWriteEnvFile(
  request: OpenClawGuardedEnvWriteRequest,
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawGuardedWriteResult> {
  const preparation = await ensureManagedWritePreparation(preferredCandidate)
  if (!preparation.ok || !preparation.candidate) {
    return {
      ok: false,
      blocked: preparation.blocked,
      wrote: false,
      target: 'env',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: preparation.message,
      errorCode: preparation.errorCode,
    }
  }

  try {
    const currentEnv = await readEnvFile()
    const changedJsonPaths = Object.keys(request.updates)
      .filter((key) => currentEnv[key] !== request.updates[key])
      .map((key) => `$.${key}`)
      .sort((left, right) => left.localeCompare(right))

    if (changedJsonPaths.length === 0) {
      const ownershipEntry = await getOwnershipEntry(preparation.candidate.installFingerprint)
      return {
        ok: true,
        blocked: false,
        wrote: false,
        target: 'env',
        snapshotCreated: preparation.snapshotCreated,
        snapshot: preparation.snapshot,
        changedJsonPaths,
        ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
        message: '.env 没有发生变化，无需写入。',
      }
    }

    await writeEnvFile(request.updates)
    const openClawPaths = resolveOpenClawPathsFromStateRoot({
      stateRoot: preparation.candidate.stateRoot,
      configFile: preparation.candidate.configPath,
    })
    const ownershipEntry = await recordManagedEnvWrite(preparation.candidate, {
      filePath: openClawPaths.envFile,
    })

    return {
      ok: true,
      blocked: false,
      wrote: true,
      target: 'env',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths,
      ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
      message: '环境变量已通过 DataGuard 写入。',
    }
  } catch (error) {
    return {
      ok: false,
      blocked: false,
      wrote: false,
      target: 'env',
      snapshotCreated: preparation.snapshotCreated,
      snapshot: preparation.snapshot,
      changedJsonPaths: [],
      ownershipSummary: null,
      message: error instanceof Error ? error.message : String(error),
      errorCode: 'write_failed',
    }
  }
}

export async function getDataGuardSummary(
  preferredCandidate?: OpenClawInstallCandidate | null
): Promise<OpenClawDataGuardSummary> {
  const candidate = await resolveCurrentCandidate(preferredCandidate)
  if (!candidate) {
    return {
      ok: false,
      activeCandidate: null,
      baselineBackup: null,
      backupDirectory: resolveDefaultBackupDirectory(),
      firstManagedWriteSnapshot: null,
      ownershipSummary: null,
      managedScopes: [],
      untouchedScopes: [],
      warnings: [],
      message: '当前没有可展示接管关系的 OpenClaw 安装对象。',
    }
  }

  const baselineBackup =
    candidate.baselineBackup || (await getBaselineBackupStatus(candidate.installFingerprint))
  const baselineBackupBypass =
    candidate.baselineBackupBypass || (await getBaselineBackupBypassStatus(candidate.installFingerprint))
  const ownershipEntry = await upsertOwnershipCandidate({
    ...candidate,
    baselineBackup,
    baselineBackupBypass,
  })

  return {
    ok: true,
    activeCandidate: {
      ...candidate,
      baselineBackup,
      baselineBackupBypass,
    },
    baselineBackup,
    backupDirectory: resolveDefaultBackupDirectory(),
    firstManagedWriteSnapshot: ownershipEntry?.firstManagedWriteSnapshot || null,
    ownershipSummary: summarizeOwnershipEntry(ownershipEntry),
    managedScopes: [
      `Qclaw 只会通过受控入口修改 ${candidate.displayConfigPath} 中自己改动过的配置 path。`,
      `Qclaw 会记录 ${
        resolveOpenClawPathsFromStateRoot({
          stateRoot: candidate.stateRoot,
          configFile: candidate.configPath,
        }).displayEnvFile
      } 的受控写入，便于后续恢复与清理。`,
      ...describeManagedShellBlockScopes(),
    ],
    untouchedScopes: [
      '不会额外安装第二份 OpenClaw，也不会擅自迁移当前安装位置。',
      '不会自动覆盖未被 Qclaw 记录 ownership 的配置字段。',
      '不会删除用户自行维护的 shell 内容，只会识别带标记的 managed block。',
    ],
    warnings: baselineBackupBypass ? [buildManualBackupWarning(baselineBackupBypass)] : [],
  }
}

export async function getOwnershipDetails(installFingerprint: string) {
  return getOwnershipEntry(installFingerprint)
}

export async function listOwnershipDetailChanges(installFingerprint: string) {
  return listOwnershipChanges(installFingerprint)
}
