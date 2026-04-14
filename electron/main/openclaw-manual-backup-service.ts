import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type { OpenClawManualBackupRunResult } from '../../src/shared/openclaw-phase3'
import { createManagedBackupArchive } from './openclaw-backup-index'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const { rm } = fs.promises

function resolveCurrentCandidate(
  candidates: OpenClawInstallCandidate[]
): OpenClawInstallCandidate | null {
  return candidates.find((candidate) => candidate.isPathActive) || candidates[0] || null
}

async function cleanupInvalidArchive(archivePath: string): Promise<void> {
  const normalized = String(archivePath || '').trim()
  if (!normalized) return
  await rm(normalized, { recursive: true, force: true }).catch(() => undefined)
}

export async function runOpenClawManualBackup(): Promise<OpenClawManualBackupRunResult> {
  const discovery = await discoverOpenClawInstallations()
  const activeCandidate = resolveCurrentCandidate(discovery.candidates)
  if (!activeCandidate) {
    return {
      ok: false,
      backup: null,
      errorCode: 'no_active_install',
      message: '当前没有可备份的 OpenClaw 安装对象。',
    }
  }

  try {
    const backup = await createManagedBackupArchive({
      candidate: activeCandidate,
      backupType: 'manual-backup',
      strategyId: 'full-state',
    })
    if (!backup.scopeAvailability.hasMemoryData) {
      await cleanupInvalidArchive(backup.archivePath)
      return {
        ok: false,
        backup: null,
        errorCode: 'backup_failed',
        message: '备份未包含 openclaw-home 目录，已取消本次备份，请稍后重试。',
      }
    }

    return {
      ok: true,
      backup,
      message: '手动备份已完成。',
    }
  } catch (error) {
    return {
      ok: false,
      backup: null,
      errorCode: 'backup_failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
