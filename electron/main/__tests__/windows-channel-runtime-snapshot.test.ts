import { describe, expect, it } from 'vitest'
import {
  areWindowsChannelRuntimeSnapshotsEqual,
  classifyWindowsChannelRuntimeDrift,
  normalizeWindowsChannelRuntimeSnapshot,
  type WindowsChannelRuntimeSnapshot,
} from '../platforms/windows/windows-channel-runtime-snapshot'

function createSnapshot(
  overrides: Partial<WindowsChannelRuntimeSnapshot> = {}
): WindowsChannelRuntimeSnapshot {
  return {
    nodePath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
    openclawPath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
    hostPackageRoot:
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
    stateDir: 'C:\\Users\\alice\\.openclaw',
    gatewayOwner: {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: 'C:\\Windows\\System32\\schtasks.exe',
      ownerTaskName: 'Qclaw OpenClaw Gateway',
    },
    managedPlugin: {
      configured: true,
      installedOnDisk: true,
      allowedInConfig: true,
      registered: true,
      loaded: true,
      ready: true,
    },
    resolvedBinding: {
      channelId: 'feishu',
      accountId: 'default',
      agentId: 'feishu-default',
      source: 'managed-plugin-registry',
    },
    ...overrides,
  }
}

describe('normalizeWindowsChannelRuntimeSnapshot', () => {
  it('trims string fields while preserving the runtime shape', () => {
    const normalized = normalizeWindowsChannelRuntimeSnapshot(
      createSnapshot({
        nodePath: '  C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe  ',
        gatewayOwner: {
          ownerKind: '  scheduled-task  ',
          ownerLauncherPath: '  C:\\Windows\\System32\\schtasks.exe  ',
          ownerTaskName: '  Qclaw OpenClaw Gateway  ',
        },
        resolvedBinding: {
          channelId: '  feishu  ',
          accountId: '  default  ',
          agentId: '  feishu-default  ',
          source: '  managed-plugin-registry  ',
        },
      })
    )

    expect(normalized).toEqual({
      nodePath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe',
      openclawPath:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
      hostPackageRoot:
        'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
      stateDir: 'C:\\Users\\alice\\.openclaw',
      gatewayOwner: {
        ownerKind: 'scheduled-task',
        ownerLauncherPath: 'C:\\Windows\\System32\\schtasks.exe',
        ownerTaskName: 'Qclaw OpenClaw Gateway',
      },
      managedPlugin: {
        configured: true,
        installedOnDisk: true,
        allowedInConfig: true,
        registered: true,
        loaded: true,
        ready: true,
      },
      resolvedBinding: {
        channelId: 'feishu',
        accountId: 'default',
        agentId: 'feishu-default',
        source: 'managed-plugin-registry',
      },
    })
  })
})

describe('areWindowsChannelRuntimeSnapshotsEqual', () => {
  it('treats matching normalized snapshots as equal', () => {
    expect(
      areWindowsChannelRuntimeSnapshotsEqual(
        createSnapshot({
          nodePath: '  C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe  ',
        }),
        createSnapshot()
      )
    ).toBe(true)
  })
})

describe('classifyWindowsChannelRuntimeDrift', () => {
  it('reports drift in the changed top-level sections', () => {
    const drift = classifyWindowsChannelRuntimeDrift(
      createSnapshot(),
      createSnapshot({
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        managedPlugin: {
          configured: true,
          installedOnDisk: true,
          allowedInConfig: false,
          registered: true,
          loaded: true,
          ready: false,
        },
      })
    )

    expect(drift).toEqual({
      changed: true,
      changedFields: ['nodePath', 'managedPlugin'],
    })
  })

  it('treats unexpected top-level fields as drift instead of ignoring them', () => {
    const previous = createSnapshot()
    const next = {
      ...createSnapshot(),
      gatewayLauncherPid: 4242,
    } as WindowsChannelRuntimeSnapshot & { gatewayLauncherPid: number }

    const drift = classifyWindowsChannelRuntimeDrift(
      previous,
      next as WindowsChannelRuntimeSnapshot
    )

    expect(drift.changed).toBe(true)
    expect(drift.changedFields).toContain('gatewayLauncherPid')
  })
})
