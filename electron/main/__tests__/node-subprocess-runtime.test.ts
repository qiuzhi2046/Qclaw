import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandCapabilityProbeResult } from '../command-capabilities'
import type { NodeInstallPlan } from '../node-installation-policy'
import {
  buildNodeSubprocessInstallPlanOptions,
  resolveQualifiedNodeRuntime,
  runNodeEvalWithQualifiedRuntime,
} from '../node-subprocess-runtime'

const originalExecPath = process.execPath
const TEST_ENV = {
  APP_ROOT: '/tmp/qclaw-test-app-root',
  VITE_PUBLIC: '/tmp/qclaw-test-public',
} as NodeJS.ProcessEnv

function makeNodeCapability(
  overrides: Partial<CommandCapabilityProbeResult> = {}
): CommandCapabilityProbeResult {
  return {
    id: 'node',
    platform: 'darwin',
    command: 'node',
    supported: true,
    available: true,
    source: 'named-command',
    message: '',
    resolvedPath: '/usr/local/bin/node',
    ...overrides,
  }
}

function makeInstallPlan(overrides: Partial<NodeInstallPlan> = {}): NodeInstallPlan {
  return {
    version: '24.14.0',
    requiredVersion: '22.16.0',
    requirementSource: 'bundled-fallback',
    source: 'bundled-fallback',
    platform: 'darwin',
    detectedArch: 'arm64',
    installerArch: 'arm64',
    artifactKind: 'pkg',
    distBaseUrl: 'https://nodejs.org/dist',
    url: 'https://nodejs.org/dist/v24.14.0/node-v24.14.0.pkg',
    filename: 'node-v24.14.0.pkg',
    ...overrides,
  }
}

afterEach(() => {
  Object.defineProperty(process, 'execPath', {
    value: originalExecPath,
    configurable: true,
  })
})

describe('resolveQualifiedNodeRuntime', () => {
  it('uses a bounded install plan lookup for Windows subprocess runtime probing', () => {
    expect(buildNodeSubprocessInstallPlanOptions('win32')).toEqual({
      skipDynamicOpenClawRequirementProbe: true,
    })
    expect(buildNodeSubprocessInstallPlanOptions('darwin')).toEqual({})
  })

  it('prefers a healthy nvm runtime over an older shell node', async () => {
    const result = await resolveQualifiedNodeRuntime(
      {
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () => makeNodeCapability()),
        probeVersion: vi.fn(async (executablePath: string) => {
          const p = executablePath.replace(/\\/g, '/')
          if (p === '/usr/local/bin/node') return 'v20.11.1'
          if (p === '/Users/alice/.nvm/versions/node/v24.14.0/bin/node') return 'v24.14.0'
          return null
        }),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => '/Users/alice/.nvm'),
        listInstalledNvmNodeBinDirs: vi.fn(async () => ['/Users/alice/.nvm/versions/node/v24.14.0/bin']),
        listExecutablePathCandidates: vi.fn(() => []),
      }
    )

    expect(result).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        executablePath: expect.stringMatching(/nvm[/\\]versions[/\\]node[/\\]v24\.14\.0[/\\]bin[/\\]node$/),
        version: 'v24.14.0',
        installStrategy: 'nvm',
        source: 'nvm',
        requiredVersion: '22.16.0',
        targetVersion: '24.14.0',
      }),
    })
  })

  it('falls back to a later executable candidate when the shell node is too old', async () => {
    const result = await resolveQualifiedNodeRuntime(
      {
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () => makeNodeCapability()),
        probeVersion: vi.fn(async (executablePath: string) => {
          if (executablePath === '/usr/local/bin/node') return 'v20.11.1'
          if (executablePath === '/opt/homebrew/bin/node') return 'v24.14.0'
          return null
        }),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => null),
        listExecutablePathCandidates: vi.fn(() => ['/usr/local/bin/node', '/opt/homebrew/bin/node']),
      }
    )

    expect(result).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        executablePath: '/opt/homebrew/bin/node',
        version: 'v24.14.0',
        source: 'candidate',
      }),
    })
  })

  it('detects nvm-windows Node on Windows when NVM_HOME is set', async () => {
    const result = await resolveQualifiedNodeRuntime(
      {
        env: {
          ...TEST_ENV,
          NVM_HOME: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm',
        },
        platform: 'win32',
      },
      {
        probeCapability: vi.fn(async () =>
          makeNodeCapability({
            platform: 'win32',
            available: false,
            resolvedPath: undefined,
          })
        ),
        probeVersion: vi.fn(async (executablePath: string) => {
          if (
            executablePath ===
            'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.14.0\\node.exe'
          )
            return 'v24.14.0'
          return null
        }),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () =>
          makeInstallPlan({ platform: 'win32', url: 'https://nodejs.org/dist/v24.14.0/node-v24.14.0-x64.msi', filename: 'node-v24.14.0-x64.msi' })
        ),
        detectNvmWindowsDir: vi.fn(async () => 'C:\\Users\\Jason\\AppData\\Roaming\\nvm'),
        listInstalledNvmWindowsNodeExePaths: vi.fn(async () => [
          'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.14.0\\node.exe',
        ]),
        listExecutablePathCandidates: vi.fn(() => []),
      }
    )

    expect(result).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        executablePath: 'C:\\Users\\Jason\\AppData\\Roaming\\nvm\\v24.14.0\\node.exe',
        version: 'v24.14.0',
        installStrategy: 'nvm',
        source: 'nvm',
      }),
    })
  })

  it('returns a version failure when only unsupported Node runtimes are available', async () => {
    const result = await resolveQualifiedNodeRuntime(
      {
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () => makeNodeCapability()),
        probeVersion: vi.fn(async (executablePath: string) => {
          if (executablePath === '/usr/local/bin/node') return 'v20.11.1'
          return null
        }),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => null),
        listExecutablePathCandidates: vi.fn(() => ['/usr/local/bin/node']),
      }
    )

    expect(result).toEqual({
      ok: false,
      reason: 'node-version-unsupported',
      message: '已发现 Node (v20.11.1)，但没有版本满足当前 OpenClaw 最低要求 22.16.0。',
      requiredVersion: '22.16.0',
      targetVersion: '24.14.0',
      detectedVersions: ['v20.11.1'],
    })
  })
})

describe('runNodeEvalWithQualifiedRuntime', () => {
  it('returns executor-unavailable when no qualified Node runtime can be resolved', async () => {
    const result = await runNodeEvalWithQualifiedRuntime(
      {
        script: 'console.log("hi")',
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () =>
          makeNodeCapability({
            available: false,
            message: 'missing node',
            resolvedPath: undefined,
          })
        ),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => null),
        listExecutablePathCandidates: vi.fn(() => []),
      }
    )

    expect(result.kind).toBe('executor-unavailable')
    expect(result.ok).toBe(false)
    expect(result.runtimeFailure?.reason).toBe('node-unavailable')
  })

  it('executes the eval script with the resolved qualified Node runtime', async () => {
    const execFile = vi.fn(
      (
        command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(command).toBe('/opt/homebrew/bin/node')
        expect(args).toEqual(['--input-type=module', '--eval', 'console.log(process.argv[1])', 'entry.js'])
        callback(null, 'entry.js\n', '')
      }
    )

    const result = await runNodeEvalWithQualifiedRuntime(
      {
        script: 'console.log(process.argv[1])',
        args: ['entry.js'],
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () =>
          makeNodeCapability({
            resolvedPath: '/opt/homebrew/bin/node',
          })
        ),
        probeVersion: vi.fn(async () => 'v24.14.0'),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => null),
        listExecutablePathCandidates: vi.fn(() => []),
        execFile: execFile as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      kind: 'completed',
      stdout: 'entry.js\n',
      stderr: '',
      code: 0,
      runtime: expect.objectContaining({
        executablePath: '/opt/homebrew/bin/node',
        version: 'v24.14.0',
      }),
    })
  })

  it('does not fall back to Electron process.execPath when the host runtime is Electron', async () => {
    Object.defineProperty(process, 'execPath', {
      value: '/Applications/Qclaw.app/Contents/MacOS/Qclaw',
      configurable: true,
    })

    const execFile = vi.fn(
      (
        command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(command).toBe('/opt/homebrew/bin/node')
        expect(command).not.toBe(process.execPath)
        expect(args).toEqual(['--input-type=module', '--eval', 'console.log("ok")'])
        callback(null, 'ok\n', '')
      }
    )

    const result = await runNodeEvalWithQualifiedRuntime(
      {
        script: 'console.log("ok")',
        env: TEST_ENV,
        platform: 'darwin',
      },
      {
        probeCapability: vi.fn(async () =>
          makeNodeCapability({
            resolvedPath: '/opt/homebrew/bin/node',
          })
        ),
        probeVersion: vi.fn(async () => 'v24.14.0'),
        resolveRequirement: vi.fn(async () => ({
          minVersion: '22.16.0',
          source: 'bundled-fallback' as const,
        })),
        resolveInstallPlan: vi.fn(async () => makeInstallPlan()),
        detectNvmDir: vi.fn(async () => null),
        listExecutablePathCandidates: vi.fn(() => []),
        execFile: execFile as any,
      }
    )

    expect(result.ok).toBe(true)
    expect(result.runtime?.executablePath).toBe('/opt/homebrew/bin/node')
  })
})
