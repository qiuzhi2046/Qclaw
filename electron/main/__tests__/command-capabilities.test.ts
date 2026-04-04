import { describe, expect, it } from 'vitest'
import {
  buildMissingCommandMessage,
  getNamedCommandLookupInvocation,
  probePlatformCommandCapability,
  resetCommandCapabilityCacheForTests,
} from '../command-capabilities'
import { buildTestEnv } from './test-env'

describe('getNamedCommandLookupInvocation', () => {
  it('uses where.exe on Windows', () => {
    const invocation = getNamedCommandLookupInvocation('openclaw', {
      platform: 'win32',
      env: buildTestEnv(),
    })

    expect(invocation).toEqual({
      command: 'where.exe',
      args: ['openclaw'],
      shell: false,
    })
  })

  it('uses the configured POSIX shell when available', () => {
    const invocation = getNamedCommandLookupInvocation('openclaw', {
      platform: 'darwin',
      env: buildTestEnv({ SHELL: '/bin/zsh' }),
    })

    expect(invocation.command).toBe('/bin/zsh')
    expect(invocation.args[0]).toBe('-lc')
    expect(invocation.args[1]).toContain('command -v')
    expect(invocation.shell).toBe(false)
  })
})

describe('probePlatformCommandCapability', () => {
  it('reports a clear message when the script PTY wrapper is unavailable', async () => {
    const result = await probePlatformCommandCapability('script', {
      platform: 'linux',
      env: buildTestEnv({ SHELL: '/bin/sh' }),
      commandPathResolver: async () => {
        throw new Error('script: command not found')
      },
    })

    expect(result.supported).toBe(true)
    expect(result.available).toBe(false)
    expect(result.message).toContain('交互式浏览器授权登录')
    expect(result.command).toBe('script')
  })

  it('reports a clear message when expect is unavailable for gemini prompt automation', async () => {
    const result = await probePlatformCommandCapability('expect', {
      platform: 'darwin',
      env: buildTestEnv({ SHELL: '/bin/zsh' }),
      commandPathResolver: async () => {
        throw new Error('expect: command not found')
      },
    })

    expect(result.supported).toBe(true)
    expect(result.available).toBe(false)
    expect(result.message).toContain('Gemini 浏览器授权登录')
    expect(result.command).toBe('expect')
  })

  it('treats Windows shell builtins as available on their supported platform', async () => {
    const result = await probePlatformCommandCapability('rmdir', {
      platform: 'win32',
      env: buildTestEnv(),
    })

    expect(result.available).toBe(true)
    expect(result.source).toBe('shell-builtin')
  })

  it('reports unsupported-platform for platform-locked commands', async () => {
    const result = await probePlatformCommandCapability('osascript', {
      platform: 'win32',
      env: buildTestEnv(),
    })

    expect(result.supported).toBe(false)
    expect(result.available).toBe(false)
    expect(result.message).toBe(buildMissingCommandMessage('osascript', 'win32', false))
  })

  it('reuses the in-flight probe result for concurrent lookups with the same resolver', async () => {
    resetCommandCapabilityCacheForTests()

    let calls = 0
    const resolver = async () => {
      calls += 1
      await Promise.resolve()
      return '/usr/bin/openclaw'
    }

    const runtime = {
      platform: 'darwin' as const,
      env: buildTestEnv({ SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }),
      commandPathResolver: resolver,
    }

    const [first, second] = await Promise.all([
      probePlatformCommandCapability('openclaw', runtime),
      probePlatformCommandCapability('openclaw', runtime),
    ])

    expect(first.available).toBe(true)
    expect(second.available).toBe(true)
    expect(calls).toBe(1)
  })

  it('re-probes unavailable named commands after installation on the same PATH', async () => {
    resetCommandCapabilityCacheForTests()

    let installed = false
    const resolver = async () => {
      if (!installed) {
        throw new Error('openclaw: command not found')
      }
      return '/usr/local/bin/openclaw'
    }

    const runtime = {
      platform: 'darwin' as const,
      env: buildTestEnv({ SHELL: '/bin/zsh', PATH: '/usr/local/bin:/usr/bin:/bin' }),
      commandPathResolver: resolver,
    }

    const first = await probePlatformCommandCapability('openclaw', runtime)
    expect(first.available).toBe(false)

    installed = true

    const second = await probePlatformCommandCapability('openclaw', runtime)
    expect(second.available).toBe(true)
    expect(second.resolvedPath).toBe('/usr/local/bin/openclaw')
  })
})
