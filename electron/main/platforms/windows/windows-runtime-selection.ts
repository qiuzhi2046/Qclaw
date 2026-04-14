import type { WindowsActiveRuntimeSnapshot } from './windows-runtime-policy'
import {
  resolveWindowsPrivateNodeRuntimePaths,
  resolveWindowsPrivateOpenClawRuntimePaths,
} from './windows-runtime-policy'

export type WindowsActiveRuntimeFamily = 'external' | 'private'

export interface WindowsActiveRuntimeDiscoveryCandidate {
  isPathActive?: boolean
  snapshot: WindowsActiveRuntimeSnapshot
}

function normalizeComparableWindowsPath(value: string): string {
  return String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase()
}

export function classifyWindowsActiveRuntimeSnapshotFamily(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
  options: {
    env?: NodeJS.ProcessEnv
  } = {}
): WindowsActiveRuntimeFamily {
  const candidate = snapshot || null
  if (!candidate) return 'external'

  const env = options.env || process.env
  const privateNodePaths = resolveWindowsPrivateNodeRuntimePaths({ env })
  const privateOpenClawPaths = resolveWindowsPrivateOpenClawRuntimePaths({ env })

  const privatePaths = [
    privateNodePaths.nodeExecutable,
    privateOpenClawPaths.openclawExecutable,
    privateOpenClawPaths.hostPackageRoot,
    privateOpenClawPaths.npmPrefix,
  ].map(normalizeComparableWindowsPath)

  const snapshotPaths = [
    candidate.nodePath,
    candidate.openclawPath,
    candidate.hostPackageRoot,
    candidate.npmPrefix,
  ].map(normalizeComparableWindowsPath)

  return snapshotPaths.some((value) => value && privatePaths.includes(value)) ? 'private' : 'external'
}

export function rankWindowsActiveRuntimeDiscoveryCandidates(
  candidates: WindowsActiveRuntimeDiscoveryCandidate[],
  options: {
    env?: NodeJS.ProcessEnv
    preferPrivate?: boolean
  } = {}
): WindowsActiveRuntimeDiscoveryCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftFamily = classifyWindowsActiveRuntimeSnapshotFamily(left.snapshot, options)
    const rightFamily = classifyWindowsActiveRuntimeSnapshotFamily(right.snapshot, options)

    if (leftFamily !== rightFamily) {
      const preferredFamily = options.preferPrivate ? 'private' : 'external'
      return leftFamily === preferredFamily ? -1 : 1
    }

    const leftActive = Boolean(left.isPathActive)
    const rightActive = Boolean(right.isPathActive)
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1
    }

    return String(left.snapshot.openclawPath || '').localeCompare(String(right.snapshot.openclawPath || ''))
  })
}
