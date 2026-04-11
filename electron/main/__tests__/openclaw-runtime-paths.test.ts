import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRuntimeOpenClawPathsCache, resolveRuntimeOpenClawPaths } from '../openclaw-runtime-paths'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import { buildTestEnv } from './test-env'

const { EventEmitter } = process.getBuiltinModule('node:events') as typeof import('node:events')

function createMockSpawnedProcess(result: {
  code?: number
  error?: Error
  stderr?: string
  stdout?: string
} = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => void
    stderr: EventEmitter
    stdout: EventEmitter
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => {}

  queueMicrotask(() => {
    if (result.stdout) proc.stdout.emit('data', result.stdout)
    if (result.stderr) proc.stderr.emit('data', result.stderr)
    if (result.error) {
      proc.emit('error', result.error)
      return
    }
    proc.emit('close', result.code ?? 0)
  })

  return proc
}

describe('resolveRuntimeOpenClawPaths', () => {
  afterEach(() => {
    resetRuntimeOpenClawPathsCache()
  })

  it('uses the active Windows runtime snapshot without probing when provided', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    const runCommand = vi.fn(async () => {
      throw new Error('should not probe when snapshot is available')
    })

    const paths = await resolveRuntimeOpenClawPaths({
      activeRuntimeSnapshot: snapshot,
      platform: 'win32',
      env: buildTestEnv({
        USERPROFILE: 'C:\\Users\\alice',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      }),
      runCommand,
    })

    expect(paths.homeDir).toBe('C:\\Users\\alice\\.openclaw')
    expect(paths.configFile).toBe('C:\\Users\\alice\\.openclaw\\config.json')
    expect(paths.displayHomeDir).toBe('~\\.openclaw')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('prefers CLI-reported config and state paths over the default ~/.openclaw layout', async () => {
    const runCommand = async (_binaryPath: string, args: string[]) => {
      if (args.join(' ') === 'config file') {
        return {
          ok: true,
          stdout: '~/Library/Application Support/OpenClaw/profiles/main/openclaw.json\n',
          stderr: '',
          code: 0,
        }
      }

      if (args.join(' ') === 'backup create --dry-run --json') {
        return {
          ok: true,
          stdout: JSON.stringify({
            assets: [
              {
                kind: 'state',
                sourcePath: '/Users/alice/Library/Application Support/OpenClaw/profiles/main',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }
      }

      throw new Error(`Unexpected args: ${args.join(' ')}`)
    }

    const paths = await resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      cacheTtlMs: 0,
      runCommand,
    })

    expect(paths).toEqual({
      homeDir: '/Users/alice/Library/Application Support/OpenClaw/profiles/main',
      configFile: '/Users/alice/Library/Application Support/OpenClaw/profiles/main/openclaw.json',
      envFile: '/Users/alice/Library/Application Support/OpenClaw/profiles/main/.env',
      credentialsDir: '/Users/alice/Library/Application Support/OpenClaw/profiles/main/credentials',
      modelCatalogCacheFile:
        '/Users/alice/Library/Application Support/OpenClaw/profiles/main/qclaw-model-catalog-cache.json',
      displayHomeDir: '~/Library/Application Support/OpenClaw/profiles/main',
      displayConfigFile: '~/Library/Application Support/OpenClaw/profiles/main/openclaw.json',
      displayEnvFile: '~/Library/Application Support/OpenClaw/profiles/main/.env',
      displayCredentialsDir: '~/Library/Application Support/OpenClaw/profiles/main/credentials',
      displayModelCatalogCacheFile:
        '~/Library/Application Support/OpenClaw/profiles/main/qclaw-model-catalog-cache.json',
    })
  })

  it('ignores doctor noise before the reported config path', async () => {
    const runCommand = async (_binaryPath: string, args: string[]) => {
      if (args.join(' ') === 'config file') {
        return {
          ok: true,
          stdout: [
            '│',
            '◇  Doctor changes ────────────────────────────╮',
            '│                                             │',
            '│  feishu configured, enabled automatically.  │',
            '│                                             │',
            '├─────────────────────────────────────────────╯',
            '~/.openclaw/openclaw.json',
            '',
          ].join('\n'),
          stderr: '',
          code: 0,
        }
      }

      if (args.join(' ') === 'backup create --dry-run --json') {
        return {
          ok: true,
          stdout: JSON.stringify({
            assets: [
              {
                kind: 'state',
                sourcePath: '/Users/alice/.openclaw',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }
      }

      throw new Error(`Unexpected args: ${args.join(' ')}`)
    }

    const paths = await resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      cacheTtlMs: 0,
      runCommand,
    })

    expect(paths.homeDir).toBe('/Users/alice/.openclaw')
    expect(paths.configFile).toBe('/Users/alice/.openclaw/openclaw.json')
    expect(paths.displayConfigFile).toBe('~/.openclaw/openclaw.json')
  })

  it('falls back to default paths when runtime probing fails', async () => {
    const paths = await resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      cacheTtlMs: 0,
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'command failed',
        code: 1,
      }),
    })

    expect(paths.homeDir).toBe('/Users/alice/.openclaw')
    expect(paths.configFile).toBe('/Users/alice/.openclaw/openclaw.json')
  })

  it('reuses one in-flight probe for concurrent callers', async () => {
    let releaseProbe: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const runCommand = vi.fn(async (_binaryPath: string, args: string[]) => {
      await gate
      if (args.join(' ') === 'config file') {
        return {
          ok: true,
          stdout: '/Users/alice/.openclaw/openclaw.json\n',
          stderr: '',
          code: 0,
        }
      }
      if (args.join(' ') === 'backup create --dry-run --json') {
        return {
          ok: true,
          stdout: JSON.stringify({
            assets: [
              {
                kind: 'state',
                sourcePath: '/Users/alice/.openclaw',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`Unexpected args: ${args.join(' ')}`)
    })

    const first = resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      runCommand,
    })
    const second = resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      runCommand,
    })

    releaseProbe?.()

    const [firstPaths, secondPaths] = await Promise.all([first, second])
    expect(firstPaths).toEqual(secondPaths)
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('reuses the cached runtime paths within the ttl window', async () => {
    const runCommand = vi.fn(async (_binaryPath: string, args: string[]) => {
      if (args.join(' ') === 'config file') {
        return {
          ok: true,
          stdout: '/Users/alice/.openclaw/openclaw.json\n',
          stderr: '',
          code: 0,
        }
      }
      if (args.join(' ') === 'backup create --dry-run --json') {
        return {
          ok: true,
          stdout: JSON.stringify({
            assets: [
              {
                kind: 'state',
                sourcePath: '/Users/alice/.openclaw',
              },
            ],
          }),
          stderr: '',
          code: 0,
        }
      }
      throw new Error(`Unexpected args: ${args.join(' ')}`)
    })

    const first = await resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      cacheTtlMs: 15_000,
      runCommand,
    })
    const second = await resolveRuntimeOpenClawPaths({
      binaryPath: '/usr/local/bin/openclaw',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      cacheTtlMs: 15_000,
      runCommand,
    })

    expect(first).toEqual(second)
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('hides Windows console windows while probing runtime paths through child processes', async () => {
    vi.resetModules()
    vi.doMock('../windows-active-runtime', () => ({
      getSelectedWindowsActiveRuntimeSnapshot: () => null,
    }))

    const spawnCalls: Array<{
      args: string[]
      command: string
      options: Record<string, unknown>
    }> = []
    const originalGetBuiltinModule = process.getBuiltinModule.bind(process)
    const getBuiltinModuleSpy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id) => {
      if (id === 'node:child_process' || id === 'child_process') {
        const actual = originalGetBuiltinModule(id) as typeof import('node:child_process')
        return {
          ...actual,
          spawn: (command: string, args: string[], options: Record<string, unknown>) => {
            spawnCalls.push({ command, args, options })
            return createMockSpawnedProcess({ code: 1 })
          },
        }
      }

      return originalGetBuiltinModule(id)
    }) as typeof process.getBuiltinModule)

    try {
      const runtimePathsModule = await import('../openclaw-runtime-paths')

      await runtimePathsModule.resolveRuntimeOpenClawPaths({
        binaryPath: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
        cacheTtlMs: 0,
        env: buildTestEnv({
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
          PATH: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
          USERPROFILE: 'C:\\Users\\alice',
        }),
        platform: 'win32',
      })

      expect(spawnCalls).toHaveLength(2)
      expect(spawnCalls[0]?.options).toMatchObject({
        shell: true,
        windowsHide: true,
      })
      expect(spawnCalls[1]?.options).toMatchObject({
        shell: true,
        windowsHide: true,
      })
    } finally {
      getBuiltinModuleSpy.mockRestore()
      vi.doUnmock('../windows-active-runtime')
      vi.resetModules()
    }
  })
})
