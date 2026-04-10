import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenClawBinaryPath } from '../openclaw-package'
import { resetRuntimeOpenClawPathsCache, resolveRuntimeOpenClawPaths } from '../openclaw-runtime-paths'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import {
  clearSelectedWindowsActiveRuntimeSnapshot,
  setSelectedWindowsActiveRuntimeSnapshot,
} from '../windows-active-runtime'
import { buildTestEnv } from './test-env'

describe('selected Windows runtime binding', () => {
  afterEach(() => {
    clearSelectedWindowsActiveRuntimeSnapshot()
    resetRuntimeOpenClawPathsCache()
  })

  it('reuses the selected runtime snapshot when resolving the openclaw binary path', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'E:\\QclawRuntime\\npm\\openclaw.cmd',
      nodeExecutable: 'E:\\QclawRuntime\\node\\node.exe',
      npmPrefix: 'E:\\QclawRuntime\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    setSelectedWindowsActiveRuntimeSnapshot(snapshot)
    const commandPathResolver = vi.fn(async () => {
      throw new Error('unexpected command lookup')
    })

    const resolved = await resolveOpenClawBinaryPath({
      commandPathResolver,
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        PATH: '',
        USERPROFILE: 'C:\\Users\\alice',
      }),
      fileExists: (candidate: string) => candidate === snapshot.openclawPath,
    })

    expect(resolved).toBe(snapshot.openclawPath)
    expect(commandPathResolver).not.toHaveBeenCalled()
  })

  it('reuses the selected runtime snapshot for runtime path discovery without probing', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'E:\\QclawRuntime\\npm\\openclaw.cmd',
      nodeExecutable: 'E:\\QclawRuntime\\node\\node.exe',
      npmPrefix: 'E:\\QclawRuntime\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    setSelectedWindowsActiveRuntimeSnapshot(snapshot)
    const runCommand = vi.fn(async () => {
      throw new Error('should not probe when a selected snapshot exists')
    })

    const paths = await resolveRuntimeOpenClawPaths({
      platform: 'win32',
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
      runCommand,
    })

    expect(paths.homeDir).toBe('C:\\Users\\alice\\.openclaw')
    expect(paths.configFile).toBe('C:\\Users\\alice\\.openclaw\\openclaw.json')
    expect(runCommand).not.toHaveBeenCalled()
  })
})
