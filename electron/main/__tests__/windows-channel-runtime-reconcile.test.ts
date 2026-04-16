// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearCachedWindowsChannelRuntimeSnapshot,
  readCachedWindowsChannelRuntimeSnapshot,
  reconcileWindowsChannelRuntimeSelection,
} from '../platforms/windows/windows-channel-runtime-reconcile'
import { normalizeWindowsChannelRuntimeSnapshot } from '../platforms/windows/windows-channel-runtime-snapshot'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'

function createRuntimeSnapshot(label: string) {
  return buildWindowsActiveRuntimeSnapshot({
    configPath: `C:\\Users\\alice\\${label}\\openclaw.json`,
    extensionsDir: `C:\\Users\\alice\\${label}\\extensions`,
    hostPackageRoot: `C:\\Users\\alice\\${label}\\node_modules\\openclaw`,
    nodeExecutable: `C:\\Users\\alice\\${label}\\node.exe`,
    npmPrefix: `C:\\Users\\alice\\${label}`,
    openclawExecutable: `C:\\Users\\alice\\${label}\\openclaw.cmd`,
    stateDir: `C:\\Users\\alice\\${label}`,
  })
}

function createChannelRuntimeSnapshot(input: {
  agentId: string
  ownerLauncherPath?: string
  ownerTaskName?: string
  runtime: ReturnType<typeof createRuntimeSnapshot>
}) {
  return normalizeWindowsChannelRuntimeSnapshot({
    hostPackageRoot: input.runtime.hostPackageRoot,
    nodePath: input.runtime.nodePath,
    openclawPath: input.runtime.openclawPath,
    stateDir: input.runtime.stateDir,
    gatewayOwner: {
      ownerKind: 'scheduled-task',
      ownerLauncherPath: input.ownerLauncherPath || '',
      ownerTaskName: input.ownerTaskName || '',
    },
    managedPlugin: {
      allowedInConfig: true,
      configured: true,
      installedOnDisk: true,
      loaded: true,
      ready: true,
      registered: true,
    },
    resolvedBinding: {
      accountId: 'default',
      agentId: input.agentId,
      channelId: 'feishu',
      source: 'config-binding',
    },
  })
}

function buildGatewayOwnerSnapshotFromLauncherIntegrity(input: {
  launcherPath: string | null
  shouldReinstallService: boolean
  status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
  taskName: string | null
}) {
  if (input.status === 'service-missing') {
    return {
      ownerKind: 'none',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  if (input.shouldReinstallService || input.status !== 'healthy') {
    return {
      ownerKind: 'unknown',
      ownerLauncherPath: '',
      ownerTaskName: '',
    }
  }

  return {
    ownerKind: input.launcherPath || input.taskName ? 'scheduled-task' : 'none',
    ownerLauncherPath: String(input.launcherPath || ''),
    ownerTaskName: String(input.taskName || ''),
  }
}

afterEach(() => {
  clearCachedWindowsChannelRuntimeSnapshot()
  vi.restoreAllMocks()
})

describe('windows channel runtime reconcile', () => {
  it('selected runtime changes and triggers exactly one reconcile', async () => {
    const initialRuntime = createRuntimeSnapshot('runtime-a')
    const buildAuthoritativeSnapshot = vi.fn(async () =>
      createChannelRuntimeSnapshot({
        agentId: 'feishu-runtime-a',
        runtime: initialRuntime,
      })
    )
    const inspectGatewayLauncherIntegrity = vi.fn(async () => ({
      launcherPath: 'C:\\Users\\alice\\runtime-a\\gateway.cmd',
      shouldReinstallService: false,
      status: 'healthy' as const,
      taskName: '\\OpenClaw Gateway',
    }))
    const refreshRuntimeBridge = vi.fn(async () => ({ ok: true }))

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: initialRuntime,
        previousSelectedRuntimeSnapshot: null,
      },
      {
        buildAuthoritativeSnapshot,
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity,
        platform: 'win32',
        refreshRuntimeBridge,
      }
    )

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: initialRuntime,
        previousSelectedRuntimeSnapshot: initialRuntime,
      },
      {
        buildAuthoritativeSnapshot,
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity,
        platform: 'win32',
        refreshRuntimeBridge,
      }
    )

    expect(buildAuthoritativeSnapshot).toHaveBeenCalledTimes(1)
    expect(inspectGatewayLauncherIntegrity).toHaveBeenCalledTimes(1)
    expect(refreshRuntimeBridge).toHaveBeenCalledTimes(1)
  })

  it('reconcile refreshes the plugin host bridge', async () => {
    const previousRuntime = createRuntimeSnapshot('runtime-a')
    const nextRuntime = createRuntimeSnapshot('runtime-b')
    const refreshRuntimeBridge = vi.fn(async () => ({ ok: true }))

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: nextRuntime,
        previousSelectedRuntimeSnapshot: previousRuntime,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-b',
            runtime: nextRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge,
      }
    )

    expect(refreshRuntimeBridge).toHaveBeenCalledTimes(1)
    expect(refreshRuntimeBridge).toHaveBeenCalledWith(nextRuntime)
  })

  it('reconcile records gateway owner and service launcher state', async () => {
    const previousRuntime = createRuntimeSnapshot('runtime-a')
    const nextRuntime = createRuntimeSnapshot('runtime-b')

    const result = await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: nextRuntime,
        previousSelectedRuntimeSnapshot: previousRuntime,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-b',
            ownerLauncherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
            ownerTaskName: '\\OpenClaw Gateway',
            runtime: nextRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
          shouldReinstallService: true,
          status: 'launcher-missing',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )

    expect(result.snapshot?.gatewayOwner).toEqual({
      ownerKind: 'scheduled-task',
      ownerLauncherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
      ownerTaskName: '\\OpenClaw Gateway',
    })
    expect(result.launcherIntegrity).toEqual({
      launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
      shouldReinstallService: true,
      status: 'launcher-missing',
      taskName: '\\OpenClaw Gateway',
    })
  })

  it('reconcile invalidates stale cached snapshot data', async () => {
    const previousRuntime = createRuntimeSnapshot('runtime-a')
    const nextRuntime = createRuntimeSnapshot('runtime-b')

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: previousRuntime,
        previousSelectedRuntimeSnapshot: null,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-a',
            runtime: previousRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-a\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )

    expect(readCachedWindowsChannelRuntimeSnapshot()?.resolvedBinding.agentId).toBe('feishu-runtime-a')

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: nextRuntime,
        previousSelectedRuntimeSnapshot: previousRuntime,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-b',
            runtime: nextRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )

    expect(readCachedWindowsChannelRuntimeSnapshot()).toMatchObject({
      nodePath: nextRuntime.nodePath,
      resolvedBinding: {
        agentId: 'feishu-runtime-b',
      },
    })
    expect(readCachedWindowsChannelRuntimeSnapshot()?.nodePath).not.toBe(previousRuntime.nodePath)
  })

  it('can stage a reconcile without mutating the authoritative snapshot cache', async () => {
    const previousRuntime = createRuntimeSnapshot('runtime-a')
    const nextRuntime = createRuntimeSnapshot('runtime-b')

    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: previousRuntime,
        previousSelectedRuntimeSnapshot: null,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-a',
            runtime: previousRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-a\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )

    const cachedBeforeStage = readCachedWindowsChannelRuntimeSnapshot()

    const stagedResult = await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: nextRuntime,
        previousSelectedRuntimeSnapshot: previousRuntime,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-b',
            runtime: nextRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        persistSnapshot: false,
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )

    expect(stagedResult.snapshot).toMatchObject({
      nodePath: nextRuntime.nodePath,
      resolvedBinding: {
        agentId: 'feishu-runtime-b',
      },
    })
    expect(readCachedWindowsChannelRuntimeSnapshot()).toEqual(cachedBeforeStage)
  })

  it('returns busy without switching cache when a managed channel operation is active', async () => {
    const previousRuntime = createRuntimeSnapshot('runtime-a')
    const nextRuntime = createRuntimeSnapshot('runtime-b')
    const cachedSnapshot = createChannelRuntimeSnapshot({
      agentId: 'feishu-runtime-a',
      runtime: previousRuntime,
    })
    await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: previousRuntime,
        previousSelectedRuntimeSnapshot: null,
      },
      {
        buildAuthoritativeSnapshot: async () => cachedSnapshot,
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-a\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        platform: 'win32',
        refreshRuntimeBridge: async () => ({ ok: true }),
      }
    )
    const refreshRuntimeBridge = vi.fn(async () => ({ ok: true }))

    const result = await reconcileWindowsChannelRuntimeSelection(
      {
        nextSelectedRuntimeSnapshot: nextRuntime,
        previousSelectedRuntimeSnapshot: previousRuntime,
      },
      {
        buildAuthoritativeSnapshot: async () =>
          createChannelRuntimeSnapshot({
            agentId: 'feishu-runtime-b',
            runtime: nextRuntime,
          }),
        buildGatewayOwnerSnapshotFromLauncherIntegrity,
        inspectGatewayLauncherIntegrity: async () => ({
          launcherPath: 'C:\\Users\\alice\\runtime-b\\gateway.cmd',
          shouldReinstallService: false,
          status: 'healthy',
          taskName: '\\OpenClaw Gateway',
        }),
        isManagedChannelOperationBusy: () => true,
        platform: 'win32',
        refreshRuntimeBridge,
      }
    )

    expect(result).toMatchObject({
      busy: true,
      changed: true,
      reconciled: false,
      snapshot: cachedSnapshot,
    })
    expect(refreshRuntimeBridge).not.toHaveBeenCalled()
    expect(readCachedWindowsChannelRuntimeSnapshot()).toEqual(cachedSnapshot)
  })
})
