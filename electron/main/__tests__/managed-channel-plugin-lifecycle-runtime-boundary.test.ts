import { describe, expect, it, vi } from 'vitest'

const runtimeLoadState = vi.hoisted(() => ({
  dingtalkLoaded: false,
  rendererBridgeLoaded: false,
}))

vi.mock('../dingtalk-official-channel', () => {
  runtimeLoadState.dingtalkLoaded = true
  return {
    dingtalkPreflightHook: vi.fn(async () => ({ ok: true })),
  }
})

vi.mock('../renderer-notification-bridge', () => {
  runtimeLoadState.rendererBridgeLoaded = true
  return {
    sendRepairProgress: vi.fn(),
  }
})

describe('managed channel lifecycle runtime boundary', () => {
  it('does not load runtime-specific modules when constructing a factory with explicit dependencies', async () => {
    const { createManagedChannelPluginLifecycleService } = await import('../managed-channel-plugin-lifecycle')

    createManagedChannelPluginLifecycleService({})

    expect(runtimeLoadState.dingtalkLoaded).toBe(false)
    expect(runtimeLoadState.rendererBridgeLoaded).toBe(false)
  })
})
