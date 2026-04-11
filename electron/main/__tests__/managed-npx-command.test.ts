import { describe, expect, it, vi } from 'vitest'

import { resolveManagedNpxCommand, runManagedNpxCommand } from '../managed-npx-command'
import type { CommandCapabilityProbeResult } from '../command-capabilities'
import { buildTestEnv } from './test-env'

describe('resolveManagedNpxCommand', () => {
  it('returns the probed npx path when the capability probe resolves one', async () => {
    const capability: CommandCapabilityProbeResult = {
      id: 'npx',
      platform: 'darwin',
      command: 'npx',
      supported: true,
      available: true,
      source: 'named-command',
      message: '',
      resolvedPath: '/Users/demo/.nvm/versions/node/v24.9.0/bin/npx',
    }

    const result = await resolveManagedNpxCommand({
      buildEnv: () => buildTestEnv({ PATH: '/usr/bin:/bin' }),
      probeCapability: vi.fn(async () => capability),
      platform: 'darwin',
    })

    expect(result).toEqual({
      ok: true,
      command: '/Users/demo/.nvm/versions/node/v24.9.0/bin/npx',
    })
  })
})

describe('runManagedNpxCommand', () => {
  it('uses the probed npx path when invoking clawhub-style commands', async () => {
    const runShellImpl = vi.fn(async () => ({
      ok: true,
      stdout: 'done',
      stderr: '',
      code: 0,
    }))
    const capability: CommandCapabilityProbeResult = {
      id: 'npx',
      platform: 'darwin',
      command: 'npx',
      supported: true,
      available: true,
      source: 'named-command',
      message: '',
      resolvedPath: '/Users/demo/.nvm/versions/node/v24.9.0/bin/npx',
    }

    await runManagedNpxCommand(
      ['-y', 'clawhub', 'search', 'demo-skill'],
      {
        cwd: '/tmp/qclaw-skill-workdir',
        controlDomain: 'plugin-install',
      },
      {
        buildEnv: () => buildTestEnv({ PATH: '/usr/bin:/bin' }),
        probeCapability: vi.fn(async () => capability),
        runShellImpl,
        platform: 'darwin',
      }
    )

    expect(runShellImpl).toHaveBeenCalledWith(
      '/Users/demo/.nvm/versions/node/v24.9.0/bin/npx',
      ['-y', 'clawhub', 'search', 'demo-skill'],
      undefined,
      {
        cwd: '/tmp/qclaw-skill-workdir',
        controlDomain: 'plugin-install',
      }
    )
  })

  it('returns a clear error instead of invoking runShell when npx is unavailable', async () => {
    const runShellImpl = vi.fn()
    const capability: CommandCapabilityProbeResult = {
      id: 'npx',
      platform: 'darwin',
      command: 'npx',
      supported: true,
      available: false,
      source: 'named-command',
      message: 'npx command is unavailable. Install or repair Node.js before continuing.',
    }

    const result = await runManagedNpxCommand(
      ['-y', 'clawhub', 'install', 'demo-skill'],
      {
        controlDomain: 'plugin-install',
      },
      {
        buildEnv: () => buildTestEnv({ PATH: '/usr/bin:/bin' }),
        probeCapability: vi.fn(async () => capability),
        runShellImpl,
        platform: 'darwin',
      }
    )

    expect(result).toEqual({
      ok: false,
      stdout: '',
      stderr: 'npx command is unavailable. Install or repair Node.js before continuing.',
      code: 1,
    })
    expect(runShellImpl).not.toHaveBeenCalled()
  })
})
