import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  classifyManagedPluginIpcTarget,
  runManagedPluginIpcOperation,
  runManagedPluginRepairIpcOperation,
} from '../managed-channel-ipc-guard'
import {
  acquireManagedOperationLease,
  resetManagedOperationLocksForTests,
  withManagedOperationLock,
} from '../managed-operation-lock'

async function holdLock(key: string): Promise<{ release: () => void; promise: Promise<void> }> {
  let release: () => void = () => {}
  let markAcquired: () => void = () => {}
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve
  })
  const promise = withManagedOperationLock(key, async () => {
    markAcquired()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await acquired
  return { release, promise }
}

afterEach(() => {
  resetManagedOperationLocksForTests()
  vi.restoreAllMocks()
})

describe('managed channel IPC guard', () => {
  it('does not lock or rewrite expected ids for ordinary third-party plugin install', async () => {
    const operation = vi.fn(async (expectedPluginIds: string[]) => ({
      ok: true,
      stdout: 'installed',
      stderr: '',
      code: 0,
      expectedPluginIds,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({ spec: 'third-party-plugin' }),
      operation
    )

    expect(operation).toHaveBeenCalledWith([])
    expect(result.ok).toBe(true)
  })

  it('does not treat unrelated local paths as managed only because a directory matches a channel alias', async () => {
    const operation = vi.fn(async (expectedPluginIds: string[]) => ({
      ok: true,
      stdout: expectedPluginIds.join(','),
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({ spec: 'file:///tmp/feishu/plugin.tgz' }),
      operation
    )

    expect(operation).toHaveBeenCalledWith([])
    expect(result.ok).toBe(true)
  })

  it('synthesizes the managed expected plugin id for registry-classified package specs', async () => {
    const operation = vi.fn(async (expectedPluginIds: string[]) => ({
      ok: true,
      stdout: expectedPluginIds.join(','),
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({ spec: '@tencent-weixin/openclaw-weixin' }),
      operation
    )

    expect(operation).toHaveBeenCalledWith(['openclaw-weixin'])
    expect(result.stdout).toBe('openclaw-weixin')
  })

  it('classifies managed tarball specifiers through the registry before running installNpx', async () => {
    const operation = vi.fn(async (expectedPluginIds: string[]) => ({
      ok: true,
      stdout: expectedPluginIds.join(','),
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({
        spec: 'https://registry.npmjs.org/%40tencent-weixin%2Fopenclaw-weixin-cli/-/openclaw-weixin-cli-1.2.3.tgz',
      }),
      operation
    )

    expect(operation).toHaveBeenCalledWith(['openclaw-weixin'])
    expect(result.stdout).toBe('openclaw-weixin')
  })

  it('classifies managed local file specifiers and still validates expected plugin ids', async () => {
    const operation = vi.fn(async () => ({
      ok: true,
      stdout: 'should-not-run',
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({
        spec: 'file:///tmp/openclaw-lark-tools-1.2.3.tgz',
        expectedPluginIds: ['openclaw-weixin'],
      }),
      operation
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('expectedPluginIds 与 package spec 不匹配')
    expect(operation).not.toHaveBeenCalled()
  })

  it('classifies managed git specifiers by their resolved package identity', async () => {
    const operation = vi.fn(async (expectedPluginIds: string[]) => ({
      ok: true,
      stdout: expectedPluginIds.join(','),
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({
        spec: 'git+https://github.com/TencentConnect/openclaw-qqbot.git',
      }),
      operation
    )

    expect(operation).toHaveBeenCalledWith(['openclaw-qqbot'])
    expect(result.stdout).toBe('openclaw-qqbot')
  })

  it('returns busy when a managed plugin install hits an active channel operation', async () => {
    const held = await holdLock('managed-channel-plugin:feishu')
    const operation = vi.fn(async () => ({
      ok: true,
      stdout: 'should-not-run',
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({ spec: 'openclaw-lark' }),
      operation
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('官方消息渠道插件正在执行')
    expect(operation).not.toHaveBeenCalled()
    held.release()
    await held.promise
  })

  it('returns busy while a long-running managed channel lease is active', async () => {
    const lease = await acquireManagedOperationLease('managed-channel-plugin:openclaw-weixin')
    const operation = vi.fn(async () => ({
      ok: true,
      stdout: 'should-not-run',
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({ spec: '@tencent-weixin/openclaw-weixin' }),
      operation
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('官方消息渠道插件正在执行')
    expect(operation).not.toHaveBeenCalled()
    lease.release()
  })

  it('blocks managed package specs with mismatched expected plugin ids', async () => {
    const operation = vi.fn(async () => ({
      ok: true,
      stdout: 'should-not-run',
      stderr: '',
      code: 0,
    }))

    const result = await runManagedPluginIpcOperation(
      classifyManagedPluginIpcTarget({
        spec: '@tencent-weixin/openclaw-weixin',
        expectedPluginIds: ['openclaw-lark'],
      }),
      operation
    )

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('expectedPluginIds 与 package spec 不匹配')
    expect(operation).not.toHaveBeenCalled()
  })

  it('makes global plugin repair mutually exclusive with active managed channel operations', async () => {
    const held = await holdLock('managed-channel-plugin:openclaw-weixin')
    const operation = vi.fn(async () => ({
      ok: true,
      repaired: true,
      summary: 'repaired',
      stderr: '',
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      orphanedPluginIds: [],
    }))

    const result = await runManagedPluginRepairIpcOperation({}, operation)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('官方消息渠道插件正在执行')
    expect(operation).not.toHaveBeenCalled()
    held.release()
    await held.promise
  })

  it('does not block scoped repair for ordinary third-party plugins', async () => {
    const held = await holdLock('managed-channel-plugin:openclaw-weixin')
    const operation = vi.fn(async () => ({
      ok: true,
      repaired: true,
      summary: 'repaired',
      stderr: '',
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      orphanedPluginIds: [],
    }))

    const result = await runManagedPluginRepairIpcOperation(
      { scopePluginIds: ['third-party-plugin'] },
      operation
    )

    expect(result.ok).toBe(true)
    expect(operation).toHaveBeenCalledTimes(1)
    held.release()
    await held.promise
  })
})
