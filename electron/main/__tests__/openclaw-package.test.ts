import { afterEach, describe, expect, it, vi } from 'vitest'
import * as openClawPackage from '../openclaw-package'
import {
  getCommandPathLookupInvocation,
  readOpenClawPackageInfo,
  resolveOpenClawBinaryPath,
  resolveOpenClawPackageRoot,
} from '../openclaw-package'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import { buildTestEnv } from './test-env'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const { EventEmitter } = process.getBuiltinModule('node:events') as typeof import('node:events')
const os = process.getBuiltinModule('os') as typeof import('node:os')
const path = process.getBuiltinModule('path') as typeof import('node:path')

const tempDirs: string[] = []
const itOnWindows = process.platform === 'win32' ? it : it.skip

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-openclaw-package-'))
  tempDirs.push(dir)
  return dir
}

function createFakeOpenClawInstall(): {
  tempDir: string
  commandPath: string
  npmShimPath: string
  packageRoot: string
  packageJsonPath: string
} {
  const tempDir = makeTempDir()
  const packageRoot = path.join(tempDir, 'lib', 'node_modules', 'openclaw')
  const binDir = path.join(tempDir, 'bin')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  const packageJsonPath = path.join(packageRoot, 'package.json')
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.8',
        bin: { openclaw: 'openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(packageRoot, 'openclaw.mjs'), '#!/usr/bin/env node\nconsole.log("openclaw")\n')

  const npmShimPath = path.join(binDir, 'openclaw')
  const commandPath =
    process.platform === 'win32' ? path.join(packageRoot, 'openclaw.mjs') : npmShimPath

  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(packageRoot, 'openclaw.mjs'), commandPath)
  }

  return { tempDir, commandPath, npmShimPath, packageRoot, packageJsonPath }
}

function createNestedBinaryOpenClawInstall(): {
  tempDir: string
  commandPath: string
  packageRoot: string
  packageJsonPath: string
} {
  const tempDir = makeTempDir()
  const packageRoot = path.join(tempDir, 'lib', 'node_modules', 'openclaw')
  const nestedBinDir = path.join(packageRoot, 'bin')
  const shimDir = path.join(tempDir, 'bin')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(nestedBinDir, { recursive: true })
  fs.mkdirSync(shimDir, { recursive: true })

  const packageJsonPath = path.join(packageRoot, 'package.json')
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.8',
        bin: { openclaw: 'bin/openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(nestedBinDir, 'openclaw.mjs'), '#!/usr/bin/env node\nconsole.log("openclaw")\n')

  const commandPath =
    process.platform === 'win32' ? path.join(nestedBinDir, 'openclaw.mjs') : path.join(shimDir, 'openclaw')
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(nestedBinDir, 'openclaw.mjs'), commandPath)
  }

  return { tempDir, commandPath, packageRoot, packageJsonPath }
}

function createPluginPollutionLayout(): {
  pollutedPackageRoot: string
  pluginEntryPath: string
  selectedHostPackageRoot: string
} {
  const tempDir = makeTempDir()
  const pluginDir = path.join(tempDir, 'extensions', 'openclaw-lark')
  const pollutedPackageRoot = path.join(pluginDir, 'node_modules', 'openclaw')
  const selectedHostPackageRoot = path.join(tempDir, 'selected-runtime', 'node_modules', 'openclaw')
  const pluginEntryPath = path.join(pluginDir, 'index.js')

  fs.mkdirSync(path.join(pollutedPackageRoot, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(selectedHostPackageRoot, 'dist'), { recursive: true })
  fs.writeFileSync(pluginEntryPath, 'module.exports = {}\n')
  fs.writeFileSync(
    path.join(pollutedPackageRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.4.5',
        bin: { openclaw: 'dist/openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(pollutedPackageRoot, 'dist', 'openclaw.mjs'), '#!/usr/bin/env node\n')
  fs.writeFileSync(
    path.join(selectedHostPackageRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.24',
        bin: { openclaw: 'dist/openclaw.mjs' },
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(selectedHostPackageRoot, 'dist', 'openclaw.mjs'), '#!/usr/bin/env node\n')

  return {
    pollutedPackageRoot,
    pluginEntryPath,
    selectedHostPackageRoot,
  }
}

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveOpenClawBinaryPath', () => {
  it('resolves the binary path via command lookup', async () => {
    const install = createFakeOpenClawInstall()

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async (commandName) => {
        expect(commandName).toBe('openclaw')
        return install.commandPath
      },
    })

    expect(resolved).toBe(install.commandPath)
  })

  it('falls back to the Windows APPDATA npm shim when where.exe lookup fails', async () => {
    const fallbackBinary = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd'

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => {
        throw new Error('INFO: Could not find files for the given pattern(s).')
      },
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      }),
      fileExists: (candidate: string) => candidate === fallbackBinary,
    })

    expect(resolved).toBe(fallbackBinary)
  })

  it('hides Windows console windows for command lookup and npm prefix fallback probes', async () => {
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

            if (spawnCalls.length === 1) {
              return createMockSpawnedProcess({
                code: 1,
                stderr: 'INFO: Could not find files for the given pattern(s).',
              })
            }
            if (spawnCalls.length === 2) {
              return createMockSpawnedProcess({
                code: 0,
                stdout: 'C:\\Program Files\\nodejs\\npm.cmd\n',
              })
            }
            return createMockSpawnedProcess({
              code: 0,
              stdout: 'C:\\Users\\alice\\AppData\\Roaming\\npm\n',
            })
          },
        }
      }

      return originalGetBuiltinModule(id)
    }) as typeof process.getBuiltinModule)

    try {
      const packageModule = await import('../openclaw-package')

      const resolved = await packageModule.resolveOpenClawBinaryPath({
        commandLookupTimeoutMs: 1_000,
        env: buildTestEnv({
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
          PATH: 'C:\\Program Files\\nodejs;C:\\Users\\alice\\AppData\\Roaming\\npm',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          USERPROFILE: 'C:\\Users\\alice',
        }),
        fileExists: (candidatePath: string) =>
          candidatePath.toLowerCase() === 'c:\\users\\alice\\appdata\\roaming\\npm\\openclaw.cmd',
        platform: 'win32',
      })

      expect(resolved.toLowerCase()).toBe('c:\\users\\alice\\appdata\\roaming\\npm\\openclaw.cmd')
      expect(spawnCalls).toHaveLength(3)
      expect(spawnCalls[0]?.options).toMatchObject({
        windowsHide: true,
      })
      expect(spawnCalls[1]?.options).toMatchObject({
        windowsHide: true,
      })
      expect(spawnCalls[2]?.options).toMatchObject({
        windowsHide: true,
      })
    } finally {
      getBuiltinModuleSpy.mockRestore()
      vi.doUnmock('../windows-active-runtime')
      vi.resetModules()
    }
  })

  it('prefers the Windows private runtime openclaw shim before the roaming npm shim when command lookup fails', async () => {
    const privateRuntimeBinary =
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd'
    const roamingBinary = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd'

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => {
        throw new Error('INFO: Could not find files for the given pattern(s).')
      },
      platform: 'win32',
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        PATH: '',
      }),
      fileExists: (candidate: string) => candidate === privateRuntimeBinary || candidate === roamingBinary,
    })

    expect(resolved).toBe(privateRuntimeBinary)
  })

  it('falls back when command path lookup does not resolve in time', async () => {
    const npmPrefix = makeTempDir()
    const fallbackBinary = path.join(npmPrefix, 'openclaw.cmd')
    fs.writeFileSync(fallbackBinary, '@echo off\n')

    const resolved = resolveOpenClawBinaryPath({
      commandPathResolver: async () =>
        new Promise<string>(() => {
          // Simulate a stuck command lookup caused by a broken Node/npm shim.
        }),
      commandLookupTimeoutMs: 10,
      npmPrefixResolver: async () => npmPrefix,
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        PATH: '',
      }),
      fileExists: (candidate: string) => candidate === fallbackBinary,
    })

    await expect(Promise.race([
      resolved,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('timed-out'), 100)
      }),
    ])).resolves.toBe(fallbackBinary)
  })

  it('returns an actionable message when command lookup cannot find openclaw', async () => {
    await expect(
      resolveOpenClawBinaryPath({
        commandPathResolver: async () => {
          throw new Error('INFO: Could not find files for the given pattern(s).')
        },
        platform: 'win32',
        env: buildTestEnv(),
        fileExists: () => false,
      })
    ).rejects.toThrow('无法定位 openclaw 命令。请先在环境检查中完成 OpenClaw 命令行工具安装，然后重启 Qclaw。')
  })

  it('prefers npm prefix bins before static fallback directories when command lookup misses', async () => {
    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => {
        throw new Error('openclaw: command not found')
      },
      npmPrefixResolver: async () => '/Users/alice/.volta/tools/image',
      platform: 'darwin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
      fileExists: (candidate: string) => candidate === '/Users/alice/.volta/tools/image/bin/openclaw',
    })

    expect(resolved).toBe('/Users/alice/.volta/tools/image/bin/openclaw')
  })

  it('prefers the active Windows runtime snapshot binary path before command lookup', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    const commandPathResolver = vi.fn(async () => {
      throw new Error('unexpected command lookup')
    })

    const resolved = await resolveOpenClawBinaryPath({
      activeRuntimeSnapshot: snapshot,
      commandPathResolver,
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
      fileExists: (candidate: string) => candidate === snapshot.openclawPath,
    })

    expect(resolved).toBe(snapshot.openclawPath)
    expect(commandPathResolver).not.toHaveBeenCalled()
  })

  itOnWindows('normalizes an extensionless Windows runtime snapshot openclaw path to the .cmd shim', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    const commandPathResolver = vi.fn(async () => {
      throw new Error('unexpected command lookup')
    })

    const resolved = await resolveOpenClawBinaryPath({
      activeRuntimeSnapshot: snapshot,
      commandPathResolver,
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
      fileExists: (candidate: string) =>
        candidate === 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
    })

    expect(resolved).toBe('C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd')
    expect(commandPathResolver).not.toHaveBeenCalled()
  })

  it('derives a deterministic openclaw binary path directly from an npm global prefix', async () => {
    const install = createFakeOpenClawInstall()
    const targetPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
    const expectedBinaryPath =
      targetPlatform === 'win32' ? path.join(install.tempDir, 'openclaw.cmd') : install.commandPath

    const resolved = await (openClawPackage as any).resolveOpenClawBinaryPathFromNpmPrefix({
      npmPrefix: install.tempDir,
      platform: targetPlatform,
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        HOME: '/Users/alice',
      }),
      fileExists: (candidate: string) => candidate === expectedBinaryPath,
    })

    expect(resolved).toBe(expectedBinaryPath)
  })

  itOnWindows('prefers the .cmd shim when command lookup returns an extensionless Windows openclaw path', async () => {
    const tempDir = makeTempDir()
    const barePath = path.join(tempDir, 'openclaw')
    const cmdPath = `${barePath}.cmd`
    fs.writeFileSync(barePath, '')
    fs.writeFileSync(cmdPath, '@echo off\r\n')

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver: async () => barePath,
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
      fileExists: (candidate: string) => candidate === barePath || candidate === cmdPath,
    })

    expect(resolved).toBe(cmdPath)
  })
})

describe('getCommandPathLookupInvocation', () => {
  it('uses where.exe on Windows instead of /bin/sh', () => {
    const invocation = getCommandPathLookupInvocation('openclaw', 'win32')
    expect(invocation).toEqual({
      command: 'where.exe',
      args: ['openclaw'],
      shell: false,
    })
  })

  it('uses POSIX shell command lookup on non-Windows platforms', () => {
    const invocation = getCommandPathLookupInvocation('openclaw', {
      platform: 'darwin',
      env: buildTestEnv({ SHELL: '/bin/zsh' }),
    })
    expect(invocation.command).toBe('/bin/zsh')
    expect(invocation.args[0]).toBe('-lc')
    expect(invocation.args[1]).toContain('command -v')
    expect(invocation.shell).toBe(false)
  })
})

describe('resolveOpenClawPackageRoot', () => {
  it('resolves the package root from the actual openclaw binary path', async () => {
    const install = createFakeOpenClawInstall()

    const packageRoot = await resolveOpenClawPackageRoot({
      binaryPath: install.commandPath,
    })

    expect(packageRoot).toBe(fs.realpathSync(install.packageRoot))
  })

  it('walks parent directories when the resolved binary lives under a package bin subdirectory', async () => {
    const install = createNestedBinaryOpenClawInstall()

    const packageRoot = await resolveOpenClawPackageRoot({
      binaryPath: install.commandPath,
    })

    expect(packageRoot).toBe(fs.realpathSync(install.packageRoot))
  })

  it('rejects malformed layouts that do not contain an adjacent openclaw package.json', async () => {
    const tempDir = makeTempDir()
    const fakeBinary = path.join(tempDir, 'openclaw')
    fs.writeFileSync(fakeBinary, '#!/usr/bin/env node\n')

    await expect(
      resolveOpenClawPackageRoot({
        binaryPath: fakeBinary,
      })
    ).rejects.toThrow(/package\.json/i)
  })

  itOnWindows('prefers the selected Windows runtime snapshot host package root over plugin-local node_modules/openclaw', async () => {
    const install = createPluginPollutionLayout()
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      configPath: 'C:\\Users\\alice\\.openclaw\\config.json',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
      hostPackageRoot: install.selectedHostPackageRoot,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      stateDir: 'C:\\Users\\alice\\.openclaw',
    })

    const packageRoot = await resolveOpenClawPackageRoot({
      activeRuntimeSnapshot: snapshot,
      binaryPath: install.pluginEntryPath,
    })

    expect(packageRoot).toBe(fs.realpathSync(install.selectedHostPackageRoot))
    expect(packageRoot).not.toBe(fs.realpathSync(install.pollutedPackageRoot))
  })
})

describe('readOpenClawPackageInfo', () => {
  it('reads version information from the resolved package.json', async () => {
    const install = createFakeOpenClawInstall()

    const info = await readOpenClawPackageInfo({
      binaryPath: install.commandPath,
    })

    const resolvedPackageRoot = fs.realpathSync(install.packageRoot)
    const resolvedPackageJsonPath = fs.realpathSync(install.packageJsonPath)

    expect(info).toMatchObject({
      name: 'openclaw',
      version: '2026.3.8',
      packageRoot: resolvedPackageRoot,
      packageJsonPath: resolvedPackageJsonPath,
      binaryPath: install.commandPath,
      resolvedBinaryPath: path.join(resolvedPackageRoot, 'openclaw.mjs'),
    })
  })
})
