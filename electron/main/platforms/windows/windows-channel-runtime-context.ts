import { getSelectedWindowsActiveRuntimeSnapshot } from '../../windows-active-runtime'
import { resolveWindowsActiveRuntimeSnapshotForRead } from '../../openclaw-runtime-readonly'
import type { WindowsActiveRuntimeSnapshot } from './windows-runtime-policy'
import {
  ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot,
  type WindowsPluginHostRuntimeBridgeCaller,
  type WindowsPluginHostRuntimeBridgeResult,
} from './windows-plugin-runtime-bridge'

export interface WindowsChannelRuntimeContext {
  bridge: WindowsPluginHostRuntimeBridgeResult
  configPath: string
  homeDir: string
  hostPackageRoot: string
  nodePath: string
  npmPrefix: string
  openclawPath: string
  openclawVersion: string | null
  privateNodeEnv: {
    pathPrefix: string
  }
  snapshot: WindowsActiveRuntimeSnapshot
  stateDir: string
}

export interface ResolveWindowsChannelRuntimeContextOptions {
  caller?: WindowsPluginHostRuntimeBridgeCaller
  platform?: NodeJS.Platform
  snapshot?: WindowsActiveRuntimeSnapshot | null
}

export type ResolveWindowsChannelRuntimeContextResult =
  | {
      ok: true
      context: WindowsChannelRuntimeContext
    }
  | {
      ok: false
      bridge: WindowsPluginHostRuntimeBridgeResult
      context: null
      message: string
    }

function cloneSnapshot(snapshot: WindowsActiveRuntimeSnapshot): WindowsActiveRuntimeSnapshot {
  return { ...snapshot }
}

function collectMissingRuntimeContextFields(snapshot: WindowsActiveRuntimeSnapshot): string[] {
  return [
    ['stateDir', snapshot.stateDir],
    ['configPath', snapshot.configPath],
    ['hostPackageRoot', snapshot.hostPackageRoot],
    ['nodePath', snapshot.nodePath],
    ['npmPrefix', snapshot.npmPrefix],
    ['openclawPath', snapshot.openclawPath],
  ]
    .filter(([, value]) => !String(value || '').trim())
    .map(([key]) => key)
}

export async function resolveWindowsChannelRuntimeContext(
  options: ResolveWindowsChannelRuntimeContextOptions = {}
): Promise<ResolveWindowsChannelRuntimeContextResult> {
  const snapshot =
    options.snapshot
    || await resolveWindowsActiveRuntimeSnapshotForRead({
      platform: options.platform || process.platform,
      getCachedRuntimeSnapshot: getSelectedWindowsActiveRuntimeSnapshot,
    })
  const bridge = await ensureWindowsPluginHostRuntimeBridgeForRuntimeSnapshot(snapshot, {
    caller: options.caller,
    platform: options.platform,
  })

  if (!snapshot || !bridge.ok) {
    return {
      ok: false,
      bridge,
      context: null,
      message: bridge.message || 'Windows OpenClaw runtime context is unavailable.',
    }
  }

  const missingFields = collectMissingRuntimeContextFields(snapshot)
  if (missingFields.length > 0) {
    return {
      ok: false,
      bridge,
      context: null,
      message: `Windows OpenClaw runtime snapshot is incomplete: ${missingFields.join(', ')}.`,
    }
  }

  const clonedSnapshot = cloneSnapshot(snapshot)
  return {
    ok: true,
    context: {
      bridge,
      configPath: clonedSnapshot.configPath,
      homeDir: clonedSnapshot.stateDir,
      hostPackageRoot: clonedSnapshot.hostPackageRoot,
      nodePath: clonedSnapshot.nodePath,
      npmPrefix: clonedSnapshot.npmPrefix,
      openclawPath: clonedSnapshot.openclawPath,
      openclawVersion: bridge.packageVersion,
      privateNodeEnv: {
        pathPrefix: clonedSnapshot.npmPrefix,
      },
      snapshot: clonedSnapshot,
      stateDir: clonedSnapshot.stateDir,
    },
  }
}
