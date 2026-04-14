import type { QClawUpdateStatus, QClawUpdateStatusState } from './openclaw-phase4'

const VISIBLE_QCLAW_UPDATE_STATES: QClawUpdateStatusState[] = [
  'available',
  'downloading',
  'downloaded',
  'installing',
]

export function shouldShowQClawNewVersionButton(
  status: Pick<QClawUpdateStatus, 'status' | 'availableVersion'> | null | undefined
): boolean {
  const availableVersion = String(status?.availableVersion || '').trim()
  if (!availableVersion) return false
  return VISIBLE_QCLAW_UPDATE_STATES.includes(status?.status || 'idle')
}
