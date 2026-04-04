import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawCleanupPreviewRequest,
  OpenClawCleanupPreviewResult,
} from '../../src/shared/openclaw-phase3'
import { discoverOpenClawInstallations } from './openclaw-install-discovery'
import { resolveBackupRootDirectory } from './openclaw-backup-index'

const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { homedir } = os

function resolveCurrentCandidate(
  candidates: OpenClawInstallCandidate[]
): OpenClawInstallCandidate | null {
  return candidates.find((candidate) => candidate.isPathActive) || candidates[0] || null
}

function normalizeSelectedCandidateIds(candidateIds: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (candidateIds || [])
        .map((candidateId) => String(candidateId || '').trim())
        .filter(Boolean)
    )
  )
}

function resolveSelectedCandidates(
  candidates: OpenClawInstallCandidate[],
  selectedCandidateIds: string[]
): OpenClawInstallCandidate[] {
  if (selectedCandidateIds.length === 0) return []
  const selectedSet = new Set(selectedCandidateIds)
  return candidates.filter((candidate) => selectedSet.has(candidate.candidateId))
}

function resolveManualQClawUninstallStep(): string {
  if (process.platform === 'darwin') {
    return '环境清理完成后，请将 Qclaw 应用拖入废纸篓。'
  }
  if (process.platform === 'win32') {
    return '环境清理完成后，请通过“应用和功能”或安装器卸载 Qclaw。'
  }
  return '环境清理完成后，请手动删除或卸载 Qclaw 应用本体。'
}

function buildProgramRemovalLines(candidate: OpenClawInstallCandidate): string[] {
  if (candidate.installSource === 'homebrew') {
    return ['将尝试通过 Homebrew 卸载 OpenClaw 程序本体。']
  }
  if (candidate.installSource === 'custom' || candidate.installSource === 'unknown') {
    return [`安装来源为 ${candidate.installSource}，程序本体不会自动卸载。`]
  }
  return [`将尝试移除 ${candidate.installSource} 环境中的 OpenClaw 程序本体。`]
}

export async function buildOpenClawCleanupPreview(
  request: OpenClawCleanupPreviewRequest
): Promise<OpenClawCleanupPreviewResult> {
  const discovery = await discoverOpenClawInstallations()
  const availableCandidates = discovery.candidates
  const normalizedSelectedCandidateIds = normalizeSelectedCandidateIds(request.selectedCandidateIds)
  const selectedCandidates = resolveSelectedCandidates(availableCandidates, normalizedSelectedCandidateIds)
  const activeCandidate =
    selectedCandidates[0] || resolveCurrentCandidate(availableCandidates)
  const backupDirectory = resolveBackupRootDirectory()
  const qclawDataGuardDir = path.join(
    String(process.env.QCLAW_USER_DATA_DIR || path.join(homedir(), '.qclaw-lite')).trim(),
    'data-guard'
  )

  const deleteItems: string[] = []
  const keepItems: string[] = [
    `所有已存在备份会继续保留在 ${backupDirectory}`,
    `Qclaw 的私有索引会继续保留在 ${qclawDataGuardDir}`,
  ]
  const backupItems: string[] = request.backupBeforeDelete
    ? [`执行前会在 ${backupDirectory} 中额外创建一次当前完整状态备份。`]
    : []
  const warnings: string[] = [...(discovery.warnings || [])]
  const blockedReasons: string[] = []
  const missingSelectedCandidateIds = normalizedSelectedCandidateIds.filter(
    (candidateId) => !availableCandidates.some((candidate) => candidate.candidateId === candidateId)
  )
  if (missingSelectedCandidateIds.length > 0) {
    warnings.push(`有 ${missingSelectedCandidateIds.length} 个已选择实例当前未检测到，将忽略这些实例。`)
  }

  if (request.actionType === 'qclaw-uninstall-keep-openclaw') {
    keepItems.unshift('当前 OpenClaw 程序本体、配置和全部记忆数据都会原样保留。')
    return {
      ok: true,
      canRun: true,
      actionType: request.actionType,
      activeCandidate,
      deleteItems,
      keepItems,
      backupItems,
      warnings,
      blockedReasons,
      backupDirectory,
      availableCandidates,
      selectedCandidateIds: normalizedSelectedCandidateIds,
      manualNextStep: resolveManualQClawUninstallStep(),
    }
  }

  if (!activeCandidate) {
    blockedReasons.push('当前没有检测到可清理的 OpenClaw 安装对象。')
  } else {
    const targetCandidates = selectedCandidates.length > 0 ? selectedCandidates : [activeCandidate]
    deleteItems.push(
      targetCandidates.length > 1
        ? `已选择 ${targetCandidates.length} 个 OpenClaw 实例进行清理。`
        : `将清理 ${targetCandidates[0].displayStateRoot} 对应的 OpenClaw 实例。`
    )
    for (const candidate of targetCandidates) {
      deleteItems.push(...buildProgramRemovalLines(candidate))
      deleteItems.push(`将删除 ${candidate.displayStateRoot} 下的配置数据与记忆数据。`)
      if (candidate.installSource === 'custom' || candidate.installSource === 'unknown') {
        warnings.push(
          `${candidate.displayStateRoot} 的安装来源为 ${candidate.installSource}，不会自动卸载程序本体，请在清理后手动移除并确认命令路径。`
        )
      }
    }
    deleteItems.push('将停止网关服务并清理 Qclaw 管理的 shell block。')
  }

  if (request.actionType === 'qclaw-uninstall-remove-openclaw') {
    warnings.push('Qclaw 应用本体不会自删除，完成环境清理后仍需你手动卸载应用。')
  }

  return {
    ok: true,
    canRun: blockedReasons.length === 0,
    actionType: request.actionType,
    activeCandidate,
    deleteItems,
    keepItems,
    backupItems,
    warnings,
    blockedReasons,
    backupDirectory,
    availableCandidates,
    selectedCandidateIds: normalizedSelectedCandidateIds,
    manualNextStep:
      request.actionType === 'qclaw-uninstall-remove-openclaw' ? resolveManualQClawUninstallStep() : undefined,
  }
}
