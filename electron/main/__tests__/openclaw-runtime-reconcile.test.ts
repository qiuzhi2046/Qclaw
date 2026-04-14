import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  confirmRuntimeReconcile,
  issueDesiredRuntimeRevision,
  markRuntimeRevisionInProgress,
  markRuntimeRevisionApplied,
  readOpenClawRuntimeReconcileStore,
  recordObservedOpenClawVersion,
  resolveGatewayBlockingReasonFromState,
  resolveOpenClawRuntimeReconcileStorePath,
} from '../openclaw-runtime-reconcile'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('openclaw runtime reconcile store', () => {
  const originalUserDataDir = process.env.QCLAW_USER_DATA_DIR
  let userDataDir = ''

  beforeEach(async () => {
    userDataDir = path.join(
      '/tmp',
      `qclaw-runtime-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}`
    )
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    await fs.rm(userDataDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true })
    if (originalUserDataDir === undefined) {
      delete process.env.QCLAW_USER_DATA_DIR
      return
    }
    process.env.QCLAW_USER_DATA_DIR = originalUserDataDir
  })

  it('returns a default store when no persisted state exists', async () => {
    const store = await readOpenClawRuntimeReconcileStore()

    expect(store.version).toBe(1)
    expect(store.runtime.desiredRevision).toBe(0)
    expect(store.runtime.blockingDetail).toBeNull()
    expect(store.lastCompatibility.status).toBe('not_evaluated')
  })

  it('persists observed versions and upgrade assessments', async () => {
    await recordObservedOpenClawVersion('2026.3.11', {
      seenAt: '2026-03-23T10:00:00.000Z',
    })
    const store = await recordObservedOpenClawVersion('v2026.4.12', {
      seenAt: '2026-03-23T10:05:00.000Z',
    })

    expect(store.lastSeenOpenClawVersion).toBe('2026.4.12')
    expect(store.lastSeenVersionBand).toBe('openclaw_2026_4_11')
    expect(store.lastCompatibility.status).toBe('upgrade_detected')
    expect(store.lastCompatibility.previousVersion).toBe('2026.3.11')
  })

  it('tracks desired and applied runtime revisions', async () => {
    const pending = await issueDesiredRuntimeRevision('config', 'config_changed', {
      requestedAt: '2026-03-23T12:00:00.000Z',
      actions: [
        {
          kind: 'migration',
          action: 'issue-revision',
          outcome: 'scheduled',
        },
      ],
    })

    expect(pending.runtime.stateCode).toBe('pending')
    expect(pending.runtime.desiredRevision).toBe(1)
    expect(pending.runtime.appliedRevision).toBe(0)
    expect(pending.runtime.pendingReasons).toEqual(['config_changed'])

    const inProgress = await markRuntimeRevisionInProgress(1, {
      startedAt: '2026-03-23T12:00:30.000Z',
      summary: '正在重载 Gateway 以消费最新配置。',
    })

    expect(inProgress.runtime.stateCode).toBe('in_progress')
    expect(inProgress.runtime.desiredRevision).toBe(1)

    const applied = await markRuntimeRevisionApplied(1, {
      appliedAt: '2026-03-23T12:01:00.000Z',
      summary: 'Gateway 已确认消费最新配置。',
      actions: [
        {
          kind: 'probe',
          action: 'gateway-health',
          outcome: 'succeeded',
        },
      ],
    })

    expect(applied.runtime.stateCode).toBe('ready')
    expect(applied.runtime.appliedRevision).toBe(1)
    expect(applied.runtime.pendingReasons).toEqual([])
    expect(applied.runtime.blockingReason).toBe('none')
  })

  it('keeps pending revisions blocked until the runtime can confirm machine-local auth', async () => {
    const pending = await issueDesiredRuntimeRevision('auth', 'gateway_token_rotated', {
      requestedAt: '2026-03-23T13:00:00.000Z',
    })

    const blocked = await confirmRuntimeReconcile({
      confirmed: false,
      revision: pending.runtime.desiredRevision,
      confirmedAt: '2026-03-23T13:01:00.000Z',
      blockingReason: 'machine_local_auth_missing',
      blockingDetail: {
        source: 'control-ui-app',
        code: 'device_token_mismatch',
        message: '控制界面与本地 Gateway 的 device token 不一致',
        rawMessage: 'device_token_mismatch',
      },
      safeToRetry: false,
      summary: 'Gateway 尚未确认本机认证可用。',
    })

    expect(blocked.runtime.stateCode).toBe('blocked')
    expect(blocked.runtime.desiredRevision).toBe(1)
    expect(blocked.runtime.appliedRevision).toBe(0)
    expect(blocked.runtime.pendingReasons).toEqual(['gateway_token_rotated'])
    expect(blocked.runtime.blockingReason).toBe('machine_local_auth_missing')
    expect(blocked.runtime.blockingDetail).toMatchObject({
      source: 'control-ui-app',
      code: 'device_token_mismatch',
    })
    expect(blocked.runtime.safeToRetry).toBe(false)
  })

  it('maps gateway runtime states into structured blocking reasons', () => {
    expect(resolveGatewayBlockingReasonFromState({ gatewayStateCode: 'auth_missing' })).toBe(
      'machine_local_auth_missing'
    )
    expect(resolveGatewayBlockingReasonFromState({ gatewayStateCode: 'token_mismatch' })).toBe(
      'runtime_token_stale'
    )
    expect(resolveGatewayBlockingReasonFromState({ gatewayStateCode: 'service_loaded_but_stale' })).toBe(
      'service_generation_stale'
    )
    expect(resolveGatewayBlockingReasonFromState({ gatewayStateCode: 'plugin_load_failure' })).toBe(
      'provider_plugin_not_ready'
    )
  })

  it('recovers cleanly when the persisted json is invalid', async () => {
    const storePath = resolveOpenClawRuntimeReconcileStorePath()
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(storePath, '{not-valid-json', 'utf8')

    const store = await readOpenClawRuntimeReconcileStore()
    expect(store.version).toBe(1)
    expect(store.runtime.desiredRevision).toBe(0)
  })

  it('passes launcherMode through confirmRuntimeReconcile when confirmed', async () => {
    await issueDesiredRuntimeRevision('gateway-bootstrap', 'service_install', {
      requestedAt: '2026-04-14T10:00:00.000Z',
    })

    const confirmed = await confirmRuntimeReconcile({
      confirmed: true,
      revision: 1,
      confirmedAt: '2026-04-14T10:01:00.000Z',
      blockingReason: 'none',
      safeToRetry: true,
      summary: '网关已通过 Startup 启动器恢复运行。',
      launcherMode: 'startup-fallback',
    })

    expect(confirmed.runtime.stateCode).toBe('ready')
    expect(confirmed.runtime.launcherMode).toBe('startup-fallback')
  })

  it('passes launcherMode through confirmRuntimeReconcile when not confirmed', async () => {
    await issueDesiredRuntimeRevision('gateway-bootstrap', 'service_install', {
      requestedAt: '2026-04-14T10:00:00.000Z',
    })

    const failed = await confirmRuntimeReconcile({
      confirmed: false,
      revision: 1,
      confirmedAt: '2026-04-14T10:01:00.000Z',
      blockingReason: 'service_generation_stale',
      safeToRetry: false,
      summary: '网关后台服务重建失败',
      launcherMode: null,
    })

    expect(failed.runtime.stateCode).toBe('blocked')
    expect(failed.runtime.launcherMode).toBeNull()
  })

  it('preserves existing launcherMode when not provided in params', async () => {
    await issueDesiredRuntimeRevision('gateway-bootstrap', 'service_install', {
      requestedAt: '2026-04-14T10:00:00.000Z',
    })
    await confirmRuntimeReconcile({
      confirmed: true,
      revision: 1,
      confirmedAt: '2026-04-14T10:01:00.000Z',
      blockingReason: 'none',
      safeToRetry: true,
      launcherMode: 'startup-fallback',
    })

    const store = await readOpenClawRuntimeReconcileStore()
    expect(store.runtime.launcherMode).toBe('startup-fallback')

    await issueDesiredRuntimeRevision('config', 'config_changed', {
      requestedAt: '2026-04-14T10:02:00.000Z',
    })
    const confirmed = await confirmRuntimeReconcile({
      confirmed: true,
      revision: 2,
      confirmedAt: '2026-04-14T10:03:00.000Z',
      blockingReason: 'none',
      safeToRetry: true,
    })

    expect(confirmed.runtime.launcherMode).toBe('startup-fallback')
  })

  it('sanitizes invalid launcherMode values to null', async () => {
    const storePath = resolveOpenClawRuntimeReconcileStorePath()
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        lastSeenOpenClawVersion: null,
        runtime: { launcherMode: 'bogus-value' },
      }),
      'utf8'
    )

    const store = await readOpenClawRuntimeReconcileStore()
    expect(store.runtime.launcherMode).toBeNull()
  })

  it('persists blockingDetail with service-install source', async () => {
    await issueDesiredRuntimeRevision('gateway-bootstrap', 'service_install', {
      requestedAt: '2026-04-14T10:00:00.000Z',
    })

    const failed = await confirmRuntimeReconcile({
      confirmed: false,
      revision: 1,
      confirmedAt: '2026-04-14T10:01:00.000Z',
      blockingReason: 'service_generation_stale',
      blockingDetail: {
        source: 'service-install',
        code: 'access_denied',
        message: '创建 Windows 计划任务被拒绝，需要管理员权限',
      },
      safeToRetry: false,
      summary: '网关后台服务重建失败',
    })

    expect(failed.runtime.blockingDetail).toMatchObject({
      source: 'service-install',
      code: 'access_denied',
    })
  })
})
