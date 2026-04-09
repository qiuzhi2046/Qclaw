import { describe, expect, it } from 'vitest'

import type { QClawUpdateStatus } from '../openclaw-phase4'
import {
  buildUpdateNotificationState,
  resolveStartupUpdateReminderState,
} from '../qclaw-update-reminder'

function createAvailableUpdateStatus(overrides: Partial<QClawUpdateStatus> = {}): QClawUpdateStatus {
  return {
    ok: true,
    supported: true,
    configured: true,
    currentVersion: '1.0.0',
    availableVersion: '1.0.1',
    status: 'available',
    progressPercent: null,
    downloaded: false,
    releaseDate: '2026-04-09',
    releaseNotes: 'Bug fixes',
    ...overrides,
  }
}

describe('qclaw update reminder state', () => {
  it('keeps the available update payload even when startup intercept should be skipped', () => {
    const status = createAvailableUpdateStatus()

    expect(
      resolveStartupUpdateReminderState(status, '1.0.1')
    ).toEqual({
      rememberedUpdate: status,
      shouldIntercept: false,
    })
  })

  it('intercepts startup when an available version has not been skipped yet', () => {
    const status = createAvailableUpdateStatus()

    expect(
      resolveStartupUpdateReminderState(status, null)
    ).toEqual({
      rememberedUpdate: status,
      shouldIntercept: true,
    })
  })

  it('builds a visible dashboard reminder from an available update payload', () => {
    expect(
      buildUpdateNotificationState(
        createAvailableUpdateStatus({
          availableVersion: '1.2.3',
          releaseNotes: 'notes',
          releaseDate: '2026-04-10',
        })
      )
    ).toEqual({
      hasUpdate: true,
      availableVersion: '1.2.3',
      releaseNotes: 'notes',
      releaseDate: '2026-04-10',
    })
  })

  it('returns an empty reminder state when no available update is present', () => {
    expect(buildUpdateNotificationState(null)).toEqual({
      hasUpdate: false,
      availableVersion: null,
      releaseNotes: null,
      releaseDate: null,
    })
  })
})
