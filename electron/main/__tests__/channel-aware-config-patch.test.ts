import { describe, expect, it, vi } from 'vitest'

vi.mock('../openclaw-config-coordinator', () => ({
  applyConfigPatchGuarded: vi.fn(),
}))

import {
  applyChannelAwareConfigPatchGuarded,
  classifyManagedChannelConfigPatch,
} from '../channel-aware-config-patch'

function createOkWriteResult(changedJsonPaths: string[] = []) {
  return {
    ok: true,
    blocked: false,
    wrote: true,
    target: 'config' as const,
    snapshotCreated: false,
    snapshot: null,
    changedJsonPaths,
    ownershipSummary: null,
    message: 'ok',
  }
}

describe('channel-aware config patch', () => {
  it('classifies managed channel paths without treating ordinary settings as channel writes', () => {
    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          models: {
            openai: {
              enabled: false,
            },
          },
        },
        afterConfig: {
          models: {
            openai: {
              enabled: true,
            },
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        },
        afterConfig: {
          channels: {
            feishu: {
              enabled: false,
            },
          },
        },
        reason: 'channel-connect-configure',
      }).targets
    ).toEqual([
      {
        channelId: 'feishu',
        lockKey: 'managed-channel-plugin:feishu',
      },
    ])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          plugins: {
            allow: ['third-party-plugin'],
          },
        },
        afterConfig: {
          plugins: {
            allow: ['third-party-plugin', 'openclaw-lark'],
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([
      {
        channelId: 'feishu',
        lockKey: 'managed-channel-plugin:feishu',
      },
    ])
  })

  it('locks plugin allow-list edits when an official managed plugin is already present', () => {
    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          plugins: {
            allow: ['third-party-a', 'openclaw-lark'],
          },
        },
        afterConfig: {
          plugins: {
            allow: ['third-party-b', 'openclaw-lark'],
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([
      {
        channelId: 'feishu',
        lockKey: 'managed-channel-plugin:feishu',
      },
    ])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          plugins: {
            allow: ['third-party-a'],
          },
        },
        afterConfig: {
          plugins: {
            allow: ['third-party-b'],
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([])
  })

  it('locks Feishu 4.12 routing edits that live outside channels and plugins', () => {
    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
            },
          },
          session: {},
        },
        afterConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
            },
          },
          session: {
            dmScope: 'per-account-channel-peer',
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([
      {
        channelId: 'feishu',
        lockKey: 'managed-channel-plugin:feishu',
      },
    ])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          agents: {
            list: [
              {
                id: 'feishu-default',
                model: 'old',
              },
            ],
          },
        },
        afterConfig: {
          agents: {
            list: [
              {
                id: 'feishu-default',
                model: 'new',
              },
            ],
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([
      {
        channelId: 'feishu',
        lockKey: 'managed-channel-plugin:feishu',
      },
    ])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          session: {},
        },
        afterConfig: {
          session: {
            dmScope: 'per-account-channel-peer',
          },
        },
        reason: 'unknown',
      }).targets
    ).toEqual([])

    expect(
      classifyManagedChannelConfigPatch({
        beforeConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
            },
          },
          agentsBackup: [],
        },
        afterConfig: {
          channels: {
            feishu: {
              appId: 'cli_default',
            },
          },
          agentsBackup: [{ id: 'custom-agent' }],
        },
        reason: 'unknown',
      }).targets
    ).toEqual([])
  })

  it('wraps managed channel config patches in the channel lock', async () => {
    const trace: string[] = []
    const applyConfigPatchGuardedImpl = vi.fn(async () => createOkWriteResult(['$.channels.feishu.enabled']))
    const release = vi.fn(() => {
      trace.push('lock:managed-channel-plugin:feishu:end')
    })
    const tryAcquireManagedOperationLeasesImpl = vi.fn((keys: string[]) => {
      trace.push(`lock:${keys.join(',')}:start`)
      return [
        {
          key: 'managed-channel-plugin:feishu',
          release,
        },
      ]
    })

    const result = await applyChannelAwareConfigPatchGuarded(
      {
        beforeConfig: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        },
        afterConfig: {
          channels: {
            feishu: {
              enabled: false,
            },
          },
        },
        reason: 'channel-connect-configure',
      },
      undefined,
      {
        applyConfigPatchGuardedImpl,
        tryAcquireManagedOperationLeasesImpl,
      }
    )

    expect(result.ok).toBe(true)
    expect(applyConfigPatchGuardedImpl).toHaveBeenCalledTimes(1)
    expect(tryAcquireManagedOperationLeasesImpl).toHaveBeenCalledWith(['managed-channel-plugin:feishu'])
    expect(release).toHaveBeenCalledTimes(1)
    expect(trace).toEqual([
      'lock:managed-channel-plugin:feishu:start',
      'lock:managed-channel-plugin:feishu:end',
    ])
  })

  it('returns busy without writing when a managed channel lock is already held', async () => {
    const applyConfigPatchGuardedImpl = vi.fn(async () => createOkWriteResult(['$.plugins.allow[0]']))

    const result = await applyChannelAwareConfigPatchGuarded(
      {
        beforeConfig: {
          plugins: {
            allow: [],
          },
        },
        afterConfig: {
          plugins: {
            allow: ['openclaw-weixin'],
          },
        },
        reason: 'unknown',
      },
      undefined,
      {
        applyConfigPatchGuardedImpl,
        tryAcquireManagedOperationLeasesImpl: () => null,
      }
    )

    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      wrote: false,
      errorCode: 'managed_channel_busy',
    })
    expect(result.changedJsonPaths).toContain('$.plugins.allow[0]')
    expect(result.message).toContain('openclaw-weixin')
    expect(applyConfigPatchGuardedImpl).not.toHaveBeenCalled()
  })

  it('does not lock config patches that only change third-party plugin config', async () => {
    const applyConfigPatchGuardedImpl = vi.fn(async () => createOkWriteResult(['$.plugins.entries.third-party.enabled']))
    const tryAcquireManagedOperationLeasesImpl = vi.fn()

    await applyChannelAwareConfigPatchGuarded(
      {
        beforeConfig: {
          plugins: {
            entries: {
              'third-party': {
                enabled: true,
              },
            },
          },
        },
        afterConfig: {
          plugins: {
            entries: {
              'third-party': {
                enabled: false,
              },
            },
          },
        },
        reason: 'unknown',
      },
      undefined,
      {
        applyConfigPatchGuardedImpl,
        tryAcquireManagedOperationLeasesImpl,
      }
    )

    expect(applyConfigPatchGuardedImpl).toHaveBeenCalledTimes(1)
    expect(tryAcquireManagedOperationLeasesImpl).not.toHaveBeenCalled()
  })
})
