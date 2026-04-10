import { describe, expect, it, vi } from 'vitest'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import { resolveBoundOpenClawCommand } from '../openclaw-runtime-invocation'

describe('resolveBoundOpenClawCommand', () => {
  it('uses the selected Windows node runtime and package entrypoint when available', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    const resolveEntrypointPath = vi.fn(async () => 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs')

    const resolved = await resolveBoundOpenClawCommand(['plugins', 'list'], {
      platform: 'win32',
      activeRuntimeSnapshot: snapshot,
      resolveEntrypointPath,
    })

    expect(resolved).toEqual({
      command: snapshot.nodePath,
      args: ['C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs', 'plugins', 'list'],
      shell: false,
    })
    expect(resolveEntrypointPath).toHaveBeenCalledOnce()
  })

  it('respects an explicit binary path instead of rebinding through node', async () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      nodeExecutable: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      npmPrefix: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\alice\\.openclaw\\openclaw.json',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      extensionsDir: 'C:\\Users\\alice\\.openclaw\\extensions',
    })
    const resolveEntrypointPath = vi.fn(async () => 'C:\\ignored\\openclaw.mjs')

    const resolved = await resolveBoundOpenClawCommand(['plugins', 'list'], {
      platform: 'win32',
      activeRuntimeSnapshot: snapshot,
      commandPath: 'D:\\portable\\openclaw.cmd',
      resolveEntrypointPath,
    })

    expect(resolved).toEqual({
      command: 'D:\\portable\\openclaw.cmd',
      args: ['plugins', 'list'],
      shell: true,
    })
    expect(resolveEntrypointPath).not.toHaveBeenCalled()
  })
})
