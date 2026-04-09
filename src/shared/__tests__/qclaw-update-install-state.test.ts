import { describe, expect, it } from 'vitest'

import type { QClawUpdateActionResult, QClawUpdateStatus } from '../openclaw-phase4'
import { shouldKeepInstallingState } from '../qclaw-update-install-state'

function createStatus(): QClawUpdateStatus {
  return {
    ok: true,
    supported: true,
    configured: true,
    currentVersion: '1.0.0',
    availableVersion: '1.0.1',
    status: 'installing',
    progressPercent: null,
    downloaded: true,
  }
}

function createResult(overrides: Partial<QClawUpdateActionResult> = {}): QClawUpdateActionResult {
  return {
    ok: true,
    status: createStatus(),
    ...overrides,
  }
}

describe('shouldKeepInstallingState', () => {
  it('keeps the installing state when the updater will quit and install immediately', () => {
    expect(
      shouldKeepInstallingState(
        createResult({ willQuitAndInstall: true })
      )
    ).toBe(true)
  })

  it('clears the installing state when installation finishes without a quit-and-install handoff', () => {
    expect(
      shouldKeepInstallingState(
        createResult({ willQuitAndInstall: false })
      )
    ).toBe(false)
  })

  it('clears the installing state when installation fails', () => {
    expect(
      shouldKeepInstallingState(
        createResult({ ok: false, error: 'install failed' })
      )
    ).toBe(false)
  })
})
