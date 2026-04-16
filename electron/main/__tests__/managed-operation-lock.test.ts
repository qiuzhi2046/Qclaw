import { describe, expect, it } from 'vitest'
import {
  isManagedOperationLockBusy,
  tryAcquireManagedOperationLease,
  tryAcquireManagedOperationLeases,
  resetManagedOperationLocksForTests,
  withManagedOperationLock,
} from '../managed-operation-lock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('managed-operation-lock', () => {
  it('serializes operations that share the same lock key', async () => {
    resetManagedOperationLocksForTests()
    const trace: string[] = []

    const first = withManagedOperationLock('runtime-install', async () => {
      trace.push('first:start')
      await delay(30)
      trace.push('first:end')
    })
    const second = withManagedOperationLock('runtime-install', async () => {
      trace.push('second:start')
      trace.push('second:end')
    })

    await Promise.all([first, second])
    expect(trace).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('allows operations with different lock keys to run in parallel', async () => {
    resetManagedOperationLocksForTests()
    let active = 0
    let maxActive = 0

    const runWithKey = (key: string) =>
      withManagedOperationLock(key, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(30)
        active -= 1
      })

    await Promise.all([runWithKey('runtime-install'), runWithKey('oauth-install')])
    expect(maxActive).toBe(2)
  })

  it('supports atomic try-acquire for a single key', () => {
    resetManagedOperationLocksForTests()

    const lease = tryAcquireManagedOperationLease('runtime-install')
    const duplicate = tryAcquireManagedOperationLease('runtime-install')

    expect(lease?.key).toBe('runtime-install')
    expect(duplicate).toBeNull()
    expect(isManagedOperationLockBusy('runtime-install')).toBe(true)

    lease?.release()
    expect(isManagedOperationLockBusy('runtime-install')).toBe(false)
  })

  it('rolls back earlier keys when multi-key try-acquire fails', () => {
    resetManagedOperationLocksForTests()

    const held = tryAcquireManagedOperationLease('managed-channel-plugin:feishu')
    const leases = tryAcquireManagedOperationLeases([
      'managed-channel-plugin:dingtalk',
      'managed-channel-plugin:feishu',
    ])

    expect(leases).toBeNull()
    expect(isManagedOperationLockBusy('managed-channel-plugin:dingtalk')).toBe(false)
    expect(isManagedOperationLockBusy('managed-channel-plugin:feishu')).toBe(true)

    held?.release()
  })
})
