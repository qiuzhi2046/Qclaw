import type { OpenClawDataCleanupRunRequest, OpenClawDataCleanupRunResult } from '../../src/shared/openclaw-phase3'
import { runCli } from './cli'
import { createManagedBackupArchive, createStateRootBackupArchive } from './openclaw-backup-index'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { access, rm } = fs.promises

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizePathForCompare(targetPath: string): string {
  const resolvedPath = path.resolve(String(targetPath || '').trim())
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

function resolveAllowedTargets(discovery: Awaited<ReturnType<typeof discoverOpenClawInstallations>>) {
  const targets = new Map<string, { path: string; displayPath: string }>()

  for (const candidate of discovery.candidates || []) {
    const normalizedPath = String(candidate.stateRoot || '').trim()
    if (!normalizedPath) continue
    targets.set(normalizePathForCompare(normalizedPath), {
      path: normalizedPath,
      displayPath: String(candidate.displayStateRoot || normalizedPath).trim() || normalizedPath,
    })
  }

  for (const item of discovery.historyDataCandidates || []) {
    const normalizedPath = String(item.path || '').trim()
    if (!normalizedPath) continue
    const key = normalizePathForCompare(normalizedPath)
    if (targets.has(key)) continue
    targets.set(key, {
      path: normalizedPath,
      displayPath: String(item.displayPath || normalizedPath).trim() || normalizedPath,
    })
  }

  return targets
}

function shouldStopGatewayBeforeDelete(options: {
  discovery: Awaited<ReturnType<typeof discoverOpenClawInstallations>>
  targetPath: string
}): boolean {
  const normalizedTargetPath = normalizePathForCompare(options.targetPath)
  return (options.discovery.candidates || []).some(
    (candidate) =>
      candidate.isPathActive &&
      normalizePathForCompare(candidate.stateRoot) === normalizedTargetPath
  )
}

export async function runOpenClawDataCleanup(
  request: OpenClawDataCleanupRunRequest
): Promise<OpenClawDataCleanupRunResult> {
  const requestedPath = String(request.targetPath || '').trim()
  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    return {
      ok: false,
      deletedPath: null,
      existedBefore: false,
      backupCreated: null,
      warnings: [],
      message: '目标数据目录不合法。',
      errorCode: 'invalid_target',
    }
  }

  const discovery = await discoverOpenClawInstallations()
  const allowedTargets = resolveAllowedTargets(discovery)
  const target = allowedTargets.get(normalizePathForCompare(requestedPath))
  if (!target) {
    return {
      ok: false,
      deletedPath: null,
      existedBefore: false,
      backupCreated: null,
      warnings: [],
      message: '目标数据目录不在允许清理的 OpenClaw 数据范围内。',
      errorCode: 'invalid_target',
    }
  }

  const existedBefore = await pathExists(target.path)
  let backupCreated = null
  if (request.backupBeforeDelete !== false && existedBefore) {
    try {
      const matchedCandidate =
        (discovery.candidates || []).find(
          (candidate) => normalizePathForCompare(candidate.stateRoot) === normalizePathForCompare(target.path)
        ) || null
      backupCreated = matchedCandidate
        ? await createManagedBackupArchive({
            candidate: matchedCandidate,
            backupType: 'cleanup-backup',
            strategyId: 'full-state',
          })
        : await createStateRootBackupArchive({
            stateRoot: target.path,
            backupType: 'cleanup-backup',
          })
    } catch (error) {
      return {
        ok: false,
        deletedPath: target.path,
        existedBefore,
        backupCreated: null,
        warnings: [],
        message: error instanceof Error ? error.message : String(error),
        errorCode: 'backup_failed',
      }
    }
  }

  if (shouldStopGatewayBeforeDelete({ discovery, targetPath: target.path })) {
    try {
      await runCli(['gateway', 'stop']).catch(() => ({ ok: false }))
    } catch {
      // Best effort only.
    }
  }

  try {
    await rm(target.path, { recursive: true, force: true })
    const stillExists = await pathExists(target.path)
    if (stillExists) {
      return {
        ok: false,
        deletedPath: target.path,
        existedBefore,
        backupCreated,
        warnings: [],
        message: `删除 ${target.displayPath} 失败。`,
        errorCode: 'delete_failed',
      }
    }

    return {
      ok: true,
      deletedPath: target.path,
      existedBefore,
      backupCreated,
      warnings: [],
      message: existedBefore ? `已删除 ${target.displayPath}。` : `${target.displayPath} 不存在，视为已清理。`,
    }
  } catch (error) {
    return {
      ok: false,
      deletedPath: target.path,
      existedBefore,
      backupCreated,
      warnings: [],
      message: error instanceof Error ? error.message : String(error),
      errorCode: 'delete_failed',
    }
  }
}
