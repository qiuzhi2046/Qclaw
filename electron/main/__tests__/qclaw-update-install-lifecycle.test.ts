import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearQClawUpdateInstallInProgress,
  markQClawUpdateInstallInProgress,
  runQClawUpdateInstall,
  shouldBypassAppExitCleanupOnQuit,
} from '../qclaw-update-install-lifecycle'

describe('qclaw update install lifecycle', () => {
  afterEach(() => {
    clearQClawUpdateInstallInProgress()
    vi.useRealTimers()
  })

  it('bypasses app exit cleanup for installer handoff platforms', () => {
    expect(shouldBypassAppExitCleanupOnQuit()).toBe(false)

    markQClawUpdateInstallInProgress('win32')

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(true)

    clearQClawUpdateInstallInProgress()

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(false)

    markQClawUpdateInstallInProgress('darwin')

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(true)

    clearQClawUpdateInstallInProgress()

    markQClawUpdateInstallInProgress('linux')

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(false)
  })

  it('auto-resets the Windows bypass flag if installer handoff leaves the app alive', () => {
    vi.useFakeTimers()

    markQClawUpdateInstallInProgress('win32')

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(true)

    vi.advanceTimersByTime(30_000)

    expect(shouldBypassAppExitCleanupOnQuit()).toBe(false)
  })

  it('forces app relaunch for Windows installer handoff', () => {
    const updater = {
      autoRunAppAfterInstall: false,
      quitAndInstall: vi.fn(),
    }

    runQClawUpdateInstall(updater, 'win32')

    expect(updater.autoRunAppAfterInstall).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(shouldBypassAppExitCleanupOnQuit()).toBe(true)
  })

  it('does not force run-after on non-Windows platforms', () => {
    const updater = {
      autoRunAppAfterInstall: false,
      quitAndInstall: vi.fn(),
    }

    runQClawUpdateInstall(updater, 'darwin')

    expect(updater.autoRunAppAfterInstall).toBe(false)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, false)
    expect(shouldBypassAppExitCleanupOnQuit()).toBe(true)
  })

  it('clears bypass state if installer handoff throws synchronously', () => {
    const updater = {
      autoRunAppAfterInstall: false,
      quitAndInstall: vi.fn(() => {
        throw new Error('install failed')
      }),
    }

    expect(() => runQClawUpdateInstall(updater, 'win32')).toThrow('install failed')
    expect(shouldBypassAppExitCleanupOnQuit()).toBe(false)
  })
})
