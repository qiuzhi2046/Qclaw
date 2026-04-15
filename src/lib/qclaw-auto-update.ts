import type { QClawUpdateActionResult, QClawUpdateStatus } from '../shared/openclaw-phase4'

export interface QClawAutoUpdateApi {
  downloadQClawUpdate: () => Promise<QClawUpdateActionResult>
  installQClawUpdate: () => Promise<QClawUpdateActionResult>
}

export type QClawAutoUpdatePhase = 'download' | 'install'

export type QClawAutoUpdateResult =
  | {
      ok: true
      status: QClawUpdateStatus
      downloadResult: QClawUpdateActionResult
      installResult: QClawUpdateActionResult
      message: string
    }
  | {
      ok: false
      phase: QClawAutoUpdatePhase
      status: QClawUpdateStatus
      actionResult: QClawUpdateActionResult
      message: string
    }

function resolveActionMessage(
  result: QClawUpdateActionResult,
  fallback: string
): string {
  return (
    String(result.message || '').trim() ||
    String(result.error || '').trim() ||
    String(result.status.message || '').trim() ||
    fallback
  )
}

export async function runQClawAutoUpdate(api: QClawAutoUpdateApi): Promise<QClawAutoUpdateResult> {
  const downloadResult = await api.downloadQClawUpdate()
  if (!downloadResult.ok) {
    return {
      ok: false,
      phase: 'download',
      status: downloadResult.status,
      actionResult: downloadResult,
      message: resolveActionMessage(downloadResult, 'Qclaw 更新包下载失败。'),
    }
  }

  if (downloadResult.status.status !== 'downloaded') {
    return {
      ok: false,
      phase: 'download',
      status: downloadResult.status,
      actionResult: downloadResult,
      message: resolveActionMessage(downloadResult, 'Qclaw 更新包尚未下载完成，请稍后重试。'),
    }
  }

  const installResult = await api.installQClawUpdate()
  if (!installResult.ok) {
    return {
      ok: false,
      phase: 'install',
      status: installResult.status,
      actionResult: installResult,
      message: resolveActionMessage(installResult, 'Qclaw 安装更新失败。'),
    }
  }

  return {
    ok: true,
    status: installResult.status,
    downloadResult,
    installResult,
    message: resolveActionMessage(installResult, 'Qclaw 即将退出并安装更新。'),
  }
}
