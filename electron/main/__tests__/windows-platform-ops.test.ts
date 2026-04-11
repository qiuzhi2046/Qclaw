import { describe, expect, it, vi } from 'vitest'

vi.mock('../cli', () => ({
  runShell: vi.fn(),
}))

import {
  buildHiddenWindowsStartupLauncherScript,
  buildWindowsGatewayPreflight,
  classifyWindowsStartupLauncherScript,
  cleanupWindowsStartupLauncherIfScheduledTaskHealthy,
  ensureWindowsStartupLauncherHidden,
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
      shouldAttachToExistingOwner: false,
      shouldReinstallService: false,
      shouldAttemptPortRecovery: true,
    })
  })
})

describe('classifyWindowsStartupLauncherScript', () => {
  it('classifies the legacy minimized cmd startup launcher as patchable', () => {
    const script = [
      '@echo off',
      'rem OpenClaw Gateway (v2026.3.24)',
      'start "" /min cmd.exe /d /c C:\\Users\\demo\\.openclaw\\gateway.cmd',
    ].join('\r\n')

    expect(
      classifyWindowsStartupLauncherScript(script, 'C:\\Users\\demo\\.openclaw\\gateway.cmd')
    ).toEqual({
      managed: true,
      mode: 'legacy-minimized-cmd',
    })
  })

  it('classifies the QClaw hidden launcher as already patched', () => {
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    const script = [
      '@echo off',
      'rem OpenClaw Gateway (v2026.3.24)',
      'rem QClaw patched: keep Startup fallback compatible while hiding the long-lived shell window.',
      `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptPath = '${launcherPath}'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$scriptPath -WindowStyle Hidden" || start "" /min cmd.exe /d /c "${launcherPath}"`,
      `rem QClaw startup launcher target: ${launcherPath}`,
    ].join('\r\n')

    expect(classifyWindowsStartupLauncherScript(script, launcherPath)).toEqual({
      managed: true,
      mode: 'hidden-powershell',
    })
  })

  it('treats an unknown wrapper shape that still points to gateway.cmd as unmanaged', () => {
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    const script = [
      '@echo off',
      'rem custom user wrapper',
      `call ${launcherPath}`,
    ].join('\r\n')

    expect(classifyWindowsStartupLauncherScript(script, launcherPath)).toEqual({
      managed: false,
      mode: 'unknown',
    })
  })

  it('treats unrelated startup scripts as unmanaged', () => {
    expect(
      classifyWindowsStartupLauncherScript(
        '@echo off\r\nstart calc.exe\r\n',
        'C:\\Users\\demo\\.openclaw\\gateway.cmd'
      )
    ).toEqual({
      managed: false,
      mode: 'unknown',
    })
  })

  it('recognizes a patched launcher even when batch-safe percent escaping is present', () => {
    const launcherPath = 'C:\\Users\\100%demo\\.openclaw\\gateway.cmd'
    const script = [
      '@echo off',
      'rem OpenClaw Gateway',
      'rem QClaw patched: keep Startup fallback compatible while hiding the long-lived shell window.',
      `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptPath = 'C:\\Users\\100%%demo\\.openclaw\\gateway.cmd'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$scriptPath -WindowStyle Hidden" || start "" /min cmd.exe /d /c "C:\\Users\\100%%demo\\.openclaw\\gateway.cmd"`,
      `rem QClaw startup launcher target: ${launcherPath}`,
    ].join('\r\n')

    expect(classifyWindowsStartupLauncherScript(script, launcherPath)).toEqual({
      managed: true,
      mode: 'hidden-powershell',
    })
  })
})

describe('buildHiddenWindowsStartupLauncherScript', () => {
  it('builds a hidden launcher with fallback and an explicit target marker', () => {
    const script = buildHiddenWindowsStartupLauncherScript({
      description: 'OpenClaw Gateway (v2026.3.24)',
      scriptPath: 'C:\\Users\\demo\\.openclaw\\gateway.cmd',
    })

    expect(script).toContain('WindowStyle Hidden')
    expect(script).toContain('|| start "" /min cmd.exe /d /c "C:\\Users\\demo\\.openclaw\\gateway.cmd"')
    expect(script).toContain(
      'rem QClaw startup launcher target: C:\\Users\\demo\\.openclaw\\gateway.cmd'
    )
  })
})

describe('ensureWindowsStartupLauncherHidden', () => {
  it('patches a legacy OpenClaw startup launcher to the hidden form', async () => {
    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    let written = ''

    const result = await ensureWindowsStartupLauncherHidden({
      appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
      homeDir: 'C:\\Users\\demo\\.openclaw',
      fileExists: (targetPath) => targetPath === startupEntryPath || targetPath === launcherPath,
      readFile: async (targetPath) =>
        targetPath === startupEntryPath
          ? ['@echo off', 'rem OpenClaw Gateway (v2026.3.24)', `start "" /min cmd.exe /d /c ${launcherPath}`].join('\r\n')
          : '',
      writeFile: async (_targetPath, content) => {
        written = content
      },
    })

    expect(result).toEqual({
      changed: true,
      reason: 'patched',
      startupEntryPath,
      launcherPath,
    })
    expect(written).toContain('WindowStyle Hidden')
    expect(written).toContain(`rem QClaw startup launcher target: ${launcherPath}`)
    expect(written).toContain(launcherPath)
  })

  it('does not rewrite an already-hidden launcher', async () => {
    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    const writeFile = vi.fn()

    await expect(
      ensureWindowsStartupLauncherHidden({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        fileExists: () => true,
        readFile: async () =>
          [
            '@echo off',
            'rem OpenClaw Gateway (v2026.3.24)',
            'rem QClaw patched: keep Startup fallback compatible while hiding the long-lived shell window.',
            `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptPath = '${launcherPath}'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$scriptPath -WindowStyle Hidden" || start "" /min cmd.exe /d /c "${launcherPath}"`,
            `rem QClaw startup launcher target: ${launcherPath}`,
          ].join('\r\n'),
        writeFile,
      })
    ).resolves.toEqual({
      changed: false,
      reason: 'already-hidden',
      startupEntryPath,
      launcherPath,
    })

    expect(writeFile).not.toHaveBeenCalled()
  })

  it('refuses to patch unmanaged startup content', async () => {
    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    const writeFile = vi.fn()

    await expect(
      ensureWindowsStartupLauncherHidden({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        fileExists: () => true,
        readFile: async () => '@echo off\r\nstart calc.exe\r\n',
        writeFile,
      })
    ).resolves.toEqual({
      changed: false,
      reason: 'unmanaged',
      startupEntryPath,
      launcherPath,
    })

    expect(writeFile).not.toHaveBeenCalled()
  })

  it('refuses to patch a custom wrapper that still points at the same gateway.cmd', async () => {
    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const launcherPath = 'C:\\Users\\demo\\.openclaw\\gateway.cmd'
    const writeFile = vi.fn()

    await expect(
      ensureWindowsStartupLauncherHidden({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        fileExists: (targetPath) => targetPath === startupEntryPath || targetPath === launcherPath,
        readFile: async () =>
          ['@echo off', `call ${launcherPath}`, 'rem custom user-owned wrapper'].join('\r\n'),
        writeFile,
      })
    ).resolves.toEqual({
      changed: false,
      reason: 'unmanaged',
      startupEntryPath,
      launcherPath,
    })

    expect(writeFile).not.toHaveBeenCalled()
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

  it('requests a full service reinstall when neither the scheduled task nor the startup launcher exists', async () => {
    const runShell = vi.fn().mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'ERROR: The system cannot find the file specified.',
      code: 1,
    })

    await expect(
      inspectWindowsGatewayLauncherIntegrity({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        runShell,
        fileExists: () => false,
      })
    ).resolves.toEqual({
      status: 'service-missing',
      taskName: null,
      launcherPath: null,
      shouldReinstallService: true,
    })
  })

  it('treats the QClaw hidden startup launcher as healthy and still resolves gateway.cmd as the launcher path', async () => {
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
        readFile: async () =>
          [
            '@echo off',
            'rem OpenClaw Gateway (v2026.3.24)',
            'rem QClaw patched: keep Startup fallback compatible while hiding the long-lived shell window.',
            `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptPath = '${launcherPath}'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',$scriptPath -WindowStyle Hidden" || start "" /min cmd.exe /d /c "${launcherPath}"`,
            `rem QClaw startup launcher target: ${launcherPath}`,
          ].join('\r\n'),
      })
    ).resolves.toEqual({
      status: 'healthy',
      taskName: null,
      launcherPath,
      shouldReinstallService: false,
    })
  })
})

describe('cleanupWindowsStartupLauncherIfScheduledTaskHealthy', () => {
  it('removes the startup launcher when the scheduled task owner is already healthy', async () => {
    const startupEntryPath = 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const unlinkFile = vi.fn().mockResolvedValue(undefined)

    await expect(
      cleanupWindowsStartupLauncherIfScheduledTaskHealthy({
        appDataDir: 'C:\\Users\\demo\\AppData\\Roaming',
        homeDir: 'C:\\Users\\demo\\.openclaw',
        launcherIntegrity: {
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
          launcherPath: 'C:\\Users\\demo\\.openclaw\\gateway.cmd',
          shouldReinstallService: false,
        },
        fileExists: (targetPath) => targetPath === startupEntryPath,
        unlinkFile,
      })
    ).resolves.toBe(true)

    expect(unlinkFile).toHaveBeenCalledWith(startupEntryPath)
  })

  it('removes the derived startup launcher for non-dot-openclaw state roots when appDataDir is provided', async () => {
    const homeDir = 'C:\\Temp\\qclaw-gateway-home'
    const startupEntryPath = 'C:\\Temp\\qclaw-gateway-home\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd'
    const unlinkFile = vi.fn().mockResolvedValue(undefined)

    await expect(
      cleanupWindowsStartupLauncherIfScheduledTaskHealthy({
        appDataDir: `${homeDir}\\AppData\\Roaming`,
        homeDir,
        launcherIntegrity: {
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
          launcherPath: `${homeDir}\\gateway.cmd`,
          shouldReinstallService: false,
        },
        fileExists: (targetPath) => targetPath === startupEntryPath,
        unlinkFile,
      })
    ).resolves.toBe(true)

    expect(unlinkFile).toHaveBeenCalledWith(startupEntryPath)
  })
})
