import type { QClawUpdateStatus } from './openclaw-phase4'

export interface UpdateNotificationState {
  hasUpdate: boolean
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
}

export const EMPTY_UPDATE_NOTIFICATION_STATE: UpdateNotificationState = {
  hasUpdate: false,
  availableVersion: null,
  releaseNotes: null,
  releaseDate: null,
}

function hasAvailableUpdate(status: QClawUpdateStatus | null | undefined): status is QClawUpdateStatus {
  return Boolean(status?.status === 'available' && String(status.availableVersion || '').trim())
}

export function buildUpdateNotificationState(
  status: QClawUpdateStatus | null | undefined
): UpdateNotificationState {
  if (!hasAvailableUpdate(status)) {
    return { ...EMPTY_UPDATE_NOTIFICATION_STATE }
  }

  return {
    hasUpdate: true,
    availableVersion: status.availableVersion ?? null,
    releaseNotes: status.releaseNotes ?? null,
    releaseDate: status.releaseDate ?? null,
  }
}

export function resolveStartupUpdateReminderState(
  status: QClawUpdateStatus | null | undefined,
  skippedVersion: string | null | undefined
): {
  rememberedUpdate: QClawUpdateStatus | null
  shouldIntercept: boolean
} {
  if (!hasAvailableUpdate(status)) {
    return {
      rememberedUpdate: null,
      shouldIntercept: false,
    }
  }

  const normalizedSkippedVersion = String(skippedVersion || '').trim()
  return {
    rememberedUpdate: status,
    shouldIntercept: normalizedSkippedVersion !== status.availableVersion,
  }
}
