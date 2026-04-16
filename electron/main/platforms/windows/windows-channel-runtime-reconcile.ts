import type { WindowsActiveRuntimeSnapshot } from './windows-runtime-policy'
import type {
  WindowsGatewayLauncherIntegrity,
} from './windows-platform-ops'
import { ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot } from './windows-plugin-runtime-bridge'
import {
  areWindowsChannelRuntimeSnapshotsEqual,
  normalizeWindowsChannelRuntimeSnapshot,
  type WindowsChannelRuntimeSnapshot,
} from './windows-channel-runtime-snapshot'
import { isAnyManagedChannelOperationBusy } from '../../managed-channel-ipc-guard'

export type BuildWindowsGatewayOwnerSnapshotFromLauncherIntegrity = (input: {
  launcherPath: string | null
  shouldReinstallService: boolean
  status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
  taskName: string | null
}) => WindowsChannelRuntimeSnapshot['gatewayOwner']

export interface BuildWindowsChannelRuntimeSnapshotDependencies {
  buildGatewayOwnerSnapshotFromLauncherIntegrity?: BuildWindowsGatewayOwnerSnapshotFromLauncherIntegrity
  inspectGatewayLauncherIntegrity?: (input: {
    homeDir: string
  }) => Promise<WindowsGatewayLauncherIntegrity>
  readSelectedRuntimeSnapshot?: () => Promise<WindowsActiveRuntimeSnapshot | null>
}

export interface ReconcileWindowsChannelRuntimeSelectionInput {
  nextSelectedRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
  previousSelectedRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
}

export interface ReconcileWindowsChannelRuntimeSelectionDependencies {
  buildGatewayOwnerSnapshotFromLauncherIntegrity?: BuildWindowsGatewayOwnerSnapshotFromLauncherIntegrity
  buildAuthoritativeSnapshot?: (
    existingSnapshot: WindowsChannelRuntimeSnapshot | null,
    dependencies?: BuildWindowsChannelRuntimeSnapshotDependencies
  ) => Promise<WindowsChannelRuntimeSnapshot | null>
  inspectGatewayLauncherIntegrity?: (input: {
    homeDir: string
  }) => Promise<WindowsGatewayLauncherIntegrity>
  platform?: NodeJS.Platform
  persistSnapshot?: boolean
  refreshRuntimeBridge?: (
    snapshot: WindowsActiveRuntimeSnapshot
  ) => Promise<unknown>
  isManagedChannelOperationBusy?: () => boolean
}

export interface WindowsChannelRuntimeReconcileResult {
  changed: boolean
  launcherIntegrity: WindowsGatewayLauncherIntegrity | null
  reconciled: boolean
  snapshot: WindowsChannelRuntimeSnapshot | null
  busy?: boolean
  message?: string
}

let cachedWindowsChannelRuntimeSnapshot: WindowsChannelRuntimeSnapshot | null = null

function cloneSnapshot(
  snapshot: WindowsChannelRuntimeSnapshot | null | undefined
): WindowsChannelRuntimeSnapshot | null {
  if (!snapshot) return null
  return normalizeWindowsChannelRuntimeSnapshot({
    ...snapshot,
    gatewayOwner: { ...snapshot.gatewayOwner },
    managedPlugin: { ...snapshot.managedPlugin },
    resolvedBinding: { ...snapshot.resolvedBinding },
  })
}

function normalizeComparablePath(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function haveSelectedRuntimeSnapshotsChanged(
  previous: WindowsActiveRuntimeSnapshot | null | undefined,
  next: WindowsActiveRuntimeSnapshot | null | undefined
): boolean {
  const previousSnapshot = previous || null
  const nextSnapshot = next || null
  if (!previousSnapshot && !nextSnapshot) return false
  if (!previousSnapshot || !nextSnapshot) return true

  return (
    normalizeComparablePath(previousSnapshot.nodePath) !== normalizeComparablePath(nextSnapshot.nodePath)
    || normalizeComparablePath(previousSnapshot.openclawPath) !== normalizeComparablePath(nextSnapshot.openclawPath)
    || normalizeComparablePath(previousSnapshot.hostPackageRoot) !== normalizeComparablePath(nextSnapshot.hostPackageRoot)
    || normalizeComparablePath(previousSnapshot.stateDir) !== normalizeComparablePath(nextSnapshot.stateDir)
  )
}

function writeCachedWindowsChannelRuntimeSnapshot(
  snapshot: WindowsChannelRuntimeSnapshot | null | undefined
): WindowsChannelRuntimeSnapshot | null {
  cachedWindowsChannelRuntimeSnapshot = cloneSnapshot(snapshot)
  return readCachedWindowsChannelRuntimeSnapshot()
}

export function replaceCachedWindowsChannelRuntimeSnapshot(
  snapshot: WindowsChannelRuntimeSnapshot | null | undefined
): WindowsChannelRuntimeSnapshot | null {
  return writeCachedWindowsChannelRuntimeSnapshot(snapshot)
}

export function readCachedWindowsChannelRuntimeSnapshot(): WindowsChannelRuntimeSnapshot | null {
  return cloneSnapshot(cachedWindowsChannelRuntimeSnapshot)
}

export function clearCachedWindowsChannelRuntimeSnapshot(): void {
  cachedWindowsChannelRuntimeSnapshot = null
}

export async function reconcileWindowsChannelRuntimeSelection(
  input: ReconcileWindowsChannelRuntimeSelectionInput,
  dependencies: ReconcileWindowsChannelRuntimeSelectionDependencies = {}
): Promise<WindowsChannelRuntimeReconcileResult> {
  const platform = dependencies.platform || process.platform
  const persistSnapshot = dependencies.persistSnapshot ?? true
  const previousSelectedRuntimeSnapshot = input.previousSelectedRuntimeSnapshot || null
  const nextSelectedRuntimeSnapshot = input.nextSelectedRuntimeSnapshot || null
  const changed = haveSelectedRuntimeSnapshotsChanged(
    previousSelectedRuntimeSnapshot,
    nextSelectedRuntimeSnapshot
  )

  if (platform !== 'win32') {
    return {
      changed,
      launcherIntegrity: null,
      reconciled: false,
      snapshot: null,
    }
  }

  if (!changed) {
    return {
      changed: false,
      launcherIntegrity: null,
      reconciled: false,
      snapshot: persistSnapshot ? readCachedWindowsChannelRuntimeSnapshot() : null,
    }
  }

  const previousSnapshot = readCachedWindowsChannelRuntimeSnapshot()
  const isOperationBusy =
    dependencies.isManagedChannelOperationBusy || isAnyManagedChannelOperationBusy
  if (isOperationBusy()) {
    return {
      changed: true,
      launcherIntegrity: null,
      reconciled: false,
      snapshot: persistSnapshot ? previousSnapshot : cloneSnapshot(previousSnapshot),
      busy: true,
      message: '官方消息渠道插件正在执行安装、修复或配置同步，暂不切换 Windows runtime。',
    }
  }

  if (!nextSelectedRuntimeSnapshot) {
    if (persistSnapshot) {
      clearCachedWindowsChannelRuntimeSnapshot()
    }
    return {
      changed: true,
      launcherIntegrity: null,
      reconciled: false,
      snapshot: null,
    }
  }

  await (
    dependencies.refreshRuntimeBridge || ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot
  )(nextSelectedRuntimeSnapshot)

  const inspectGatewayLauncherIntegrity =
    dependencies.inspectGatewayLauncherIntegrity
    || (async (launcherInput: { homeDir: string }) => {
      const platformOps = await import('./windows-platform-ops')
      return platformOps.inspectWindowsGatewayLauncherIntegrity(launcherInput)
    })
  const launcherIntegrity = await inspectGatewayLauncherIntegrity({
    homeDir: nextSelectedRuntimeSnapshot.stateDir,
  })

  const buildGatewayOwnerSnapshotFromLauncherIntegrity =
    dependencies.buildGatewayOwnerSnapshotFromLauncherIntegrity
    || (
      await import('./windows-platform-ops')
    ).buildWindowsGatewayOwnerSnapshotFromLauncherIntegrity

  const snapshot = await (
    dependencies.buildAuthoritativeSnapshot
    || (async () => null)
  )(previousSnapshot, {
    buildGatewayOwnerSnapshotFromLauncherIntegrity,
    inspectGatewayLauncherIntegrity: async () => launcherIntegrity,
    readSelectedRuntimeSnapshot: async () => nextSelectedRuntimeSnapshot,
  })
  const normalizedSnapshot = snapshot ? normalizeWindowsChannelRuntimeSnapshot(snapshot) : null
  const persistedSnapshot = persistSnapshot
    ? writeCachedWindowsChannelRuntimeSnapshot(normalizedSnapshot)
    : cloneSnapshot(normalizedSnapshot)

  return {
    changed: true,
    launcherIntegrity,
    reconciled: true,
    snapshot: persistedSnapshot,
  }
}

export function areCachedWindowsChannelRuntimeSnapshotsEqual(
  snapshot: WindowsChannelRuntimeSnapshot | null | undefined
): boolean {
  const cachedSnapshot = readCachedWindowsChannelRuntimeSnapshot()
  if (!cachedSnapshot && !snapshot) return true
  if (!cachedSnapshot || !snapshot) return false
  return areWindowsChannelRuntimeSnapshotsEqual(cachedSnapshot, snapshot)
}
