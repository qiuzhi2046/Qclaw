import { describe, expect, it, vi } from 'vitest'

vi.mock('../cli', () => ({
  runShell: vi.fn(),
}))

import {
  buildWindowsGatewayPreflight,
  inspectWindowsGatewayLauncherIntegrity,
  probeWindowsPortOwner,
} from '../platforms/windows/windows-platform-ops'
import { MAIN_RUNTIME_POLICY } from '../runtime-policy'

describe('probeWindowsPortOwner', () => {
  it('returns classified owner details when PowerShell reports a listening OpenClaw process', async () => {
    const runShell = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"OwningProcess":4242,"LocalAddress":"127.0.0.1","LocalPort":3456,"State":"Listen"}',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"Name":"node.exe","CommandLine":"node.exe C:/Users/test/AppData/Roaming/npm/node_modules/openclaw/dist/cli.mjs gateway start"}',
        stderr: '',
        code: 0,
      })

    await expect(probeWindowsPortOwner(3456, { runShell })).resolves.toEqual({
      kind: 'openclaw',
      port: 3456,
      pid: 4242,
      processName: 'node.exe',
      command:
        'node.exe C:/Users/test/AppData/Roaming/npm/node_modules/openclaw/dist/cli.mjs gateway start',
      source: 'powershell',
    })
    expect(runShell).toHaveBeenNthCalledWith(
      1,
      'powershell',
      expect.any(Array),
      MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
      'gateway'
    )
    expect(runShell).toHaveBeenNthCalledWith(
      2,
      'powershell',
      expect.any(Array),
      MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
      'gateway'
    )
  })
})

describe('buildWindowsGatewayPreflight', () => {
  it('requests early port recovery when a foreign process already owns the managed port', () => {
    expect(
      buildWindowsGatewayPreflight({
        portOwner: {
          kind: 'foreign',
          port: 18789,
          pid: 2451,
          processName: 'python.exe',
          command: 'python.exe -m http.server',
          source: 'powershell',
        },
      })
    ).toEqual({
      shouldReinstallService: false,
      shouldAttemptPortRecovery: true,
    })
  })
})

describe('inspectWindowsGatewayLauncherIntegrity', () => {
  it('marks the service as stale when the scheduled task points to a missing gateway launcher', async () => {
    const runShell = vi.fn().mockResolvedValueOnce({
      ok: true,
      stdout: [
        'Folder: \\',
        'TaskName: \\OpenClaw Gateway',
        'Task To Run: C:\\Users\\demo\\.openclaw\\gateway.cmd ',
      ].join('\n'),
      stderr: '',
      code: 0,
    })

    await expect(
      inspectWindowsGatewayLauncherIntegrity({
        homeDir: 'C:\\Users\\demo\\.openclaw',
        runShell,
        fileExists: () => false,
      })
    ).resolves.toEqual({
      status: 'launcher-missing',
      taskName: '\\OpenClaw Gateway',
      launcherPath: 'C:\\Users\\demo\\.openclaw\\gateway.cmd',
      shouldReinstallService: true,
    })
  })

  it('treats a startup-folder login item with a missing launcher as stale when no scheduled task exists', async () => {
    const runShell = vi.fn().mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'ERROR: The system cannot find the path specified.',
      code: 1,
    })

    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'

    await expect(
      inspectWindowsGatewayLauncherIntegrity({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        runShell,
        fileExists: (targetPath) => targetPath === startupEntryPath,
        readFile: async (targetPath) =>
          targetPath === startupEntryPath
            ? [
                '@echo off',
                'rem OpenClaw Gateway (v2026.3.24)',
                `start "" /min cmd.exe /d /c ${launcherPath}`,
              ].join('\r\n')
            : '',
      })
    ).resolves.toEqual({
      status: 'launcher-missing',
      taskName: null,
      launcherPath,
      shouldReinstallService: true,
    })
  })

  it('accepts a healthy startup-folder login item when the launcher exists', async () => {
    const runShell = vi.fn().mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'ERROR: The system cannot find the path specified.',
      code: 1,
    })

    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'

    await expect(
      inspectWindowsGatewayLauncherIntegrity({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        runShell,
        fileExists: (targetPath) => targetPath === startupEntryPath || targetPath === launcherPath,
        readFile: async (targetPath) =>
          targetPath === startupEntryPath
            ? [
                '@echo off',
                'rem OpenClaw Gateway (v2026.3.24)',
                `start "" /min cmd.exe /d /c ${launcherPath}`,
              ].join('\r\n')
            : '',
      })
    ).resolves.toEqual({
      status: 'healthy',
      taskName: null,
      launcherPath,
      shouldReinstallService: false,
    })
  })
})
