import { describe, expect, it } from 'vitest'

import {
  hasOwnedFeishuManagerCreateSession,
  shouldRetainExitedOwnedFeishuManagerCreateSession,
  shouldRetainOwnedFeishuManagerCreateSessionWhileHidden,
} from '../FeishuBotManagerModal'

describe('FeishuBotManagerModal session retention helpers', () => {
  it('recognizes owned create sessions only when both id and source exist', () => {
    expect(
      hasOwnedFeishuManagerCreateSession({
        ownedSessionId: 'session-1',
        ownerSource: 'started-here',
      })
    ).toBe(true)

    expect(
      hasOwnedFeishuManagerCreateSession({
        ownedSessionId: 'session-1',
        ownerSource: null,
      })
    ).toBe(false)

    expect(
      hasOwnedFeishuManagerCreateSession({
        ownedSessionId: '',
        ownerSource: 'resumed-running',
      })
    ).toBe(false)
  })

  it('keeps owned create sessions while hidden if they are still running or exited successfully', () => {
    expect(
      shouldRetainOwnedFeishuManagerCreateSessionWhileHidden({
        setupMode: 'create',
        ownedSessionId: 'session-1',
        ownerSource: 'started-here',
        installerRunning: true,
        installerExitCode: null,
        installerCanceled: false,
      })
    ).toBe(true)

    expect(
      shouldRetainOwnedFeishuManagerCreateSessionWhileHidden({
        setupMode: 'create',
        ownedSessionId: 'session-1',
        ownerSource: 'started-here',
        installerRunning: false,
        installerExitCode: 0,
        installerCanceled: false,
      })
    ).toBe(true)

    expect(
      shouldRetainOwnedFeishuManagerCreateSessionWhileHidden({
        setupMode: 'create',
        ownedSessionId: 'session-1',
        ownerSource: 'started-here',
        installerRunning: false,
        installerExitCode: 1,
        installerCanceled: false,
      })
    ).toBe(false)

    expect(
      shouldRetainOwnedFeishuManagerCreateSessionWhileHidden({
        setupMode: 'link',
        ownedSessionId: 'session-1',
        ownerSource: 'started-here',
        installerRunning: true,
        installerExitCode: null,
        installerCanceled: false,
      })
    ).toBe(false)
  })

  it('retains only matched successful exits on refresh so reopen can finish post-create work', () => {
    expect(
      shouldRetainExitedOwnedFeishuManagerCreateSession({
        snapshotMatchesOwnedSession: true,
        installerRunning: false,
        installerExitCode: 0,
        installerCanceled: false,
      })
    ).toBe(true)

    expect(
      shouldRetainExitedOwnedFeishuManagerCreateSession({
        snapshotMatchesOwnedSession: true,
        installerRunning: false,
        installerExitCode: 1,
        installerCanceled: false,
      })
    ).toBe(false)

    expect(
      shouldRetainExitedOwnedFeishuManagerCreateSession({
        snapshotMatchesOwnedSession: true,
        installerRunning: false,
        installerExitCode: 0,
        installerCanceled: true,
      })
    ).toBe(false)

    expect(
      shouldRetainExitedOwnedFeishuManagerCreateSession({
        snapshotMatchesOwnedSession: false,
        installerRunning: false,
        installerExitCode: 0,
        installerCanceled: false,
      })
    ).toBe(false)
  })
})
