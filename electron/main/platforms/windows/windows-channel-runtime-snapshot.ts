import type {
  WindowsChannelRuntimeSnapshotView,
  WindowsGatewayOwnerSnapshotView,
  WindowsManagedPluginSnapshotView,
  WindowsResolvedChannelBindingView,
} from '../../../../src/shared/openclaw-phase1'

export interface WindowsManagedPluginSnapshot extends WindowsManagedPluginSnapshotView {}

export interface WindowsResolvedChannelBinding extends WindowsResolvedChannelBindingView {}

export interface WindowsGatewayOwnerSnapshot extends WindowsGatewayOwnerSnapshotView {}

export interface WindowsChannelRuntimeSnapshot extends WindowsChannelRuntimeSnapshotView {}

export interface WindowsChannelRuntimeDrift {
  changed: boolean
  changedFields: string[]
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function normalizeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item)) as T
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeValue(item)
    }
    return result as T
  }

  if (typeof value === 'string') {
    return normalizeText(value) as T
  }

  return value
}

function normalizeSnapshot(snapshot: WindowsChannelRuntimeSnapshot): WindowsChannelRuntimeSnapshot {
  return {
    ...snapshot,
    hostPackageRoot: normalizeText(snapshot.hostPackageRoot),
    nodePath: normalizeText(snapshot.nodePath),
    openclawPath: normalizeText(snapshot.openclawPath),
    stateDir: normalizeText(snapshot.stateDir),
    gatewayOwner: normalizeValue(snapshot.gatewayOwner),
    managedPlugin: normalizeValue(snapshot.managedPlugin),
    resolvedBinding: normalizeValue(snapshot.resolvedBinding),
  }
}

function areValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => areValuesEqual(item, right[index]))
  }

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftEntries = Object.entries(left as Record<string, unknown>)
    const rightEntries = Object.entries(right as Record<string, unknown>)
    if (leftEntries.length !== rightEntries.length) return false

    for (const [key, leftValue] of leftEntries) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false
      if (!areValuesEqual(leftValue, (right as Record<string, unknown>)[key])) return false
    }

    return true
  }

  return false
}

function collectDriftFields(
  previous: WindowsChannelRuntimeSnapshot,
  next: WindowsChannelRuntimeSnapshot
): string[] {
  const fields = new Set<string>()
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])

  for (const key of keys) {
    if (
      !areValuesEqual(
        (previous as unknown as Record<string, unknown>)[key],
        (next as unknown as Record<string, unknown>)[key]
      )
    ) {
      fields.add(key)
    }
  }

  return [...fields]
}

export function normalizeWindowsChannelRuntimeSnapshot(
  snapshot: WindowsChannelRuntimeSnapshot
): WindowsChannelRuntimeSnapshot {
  return normalizeSnapshot(snapshot)
}

export function areWindowsChannelRuntimeSnapshotsEqual(
  previous: WindowsChannelRuntimeSnapshot,
  next: WindowsChannelRuntimeSnapshot
): boolean {
  return areValuesEqual(normalizeSnapshot(previous), normalizeSnapshot(next))
}

export function classifyWindowsChannelRuntimeDrift(
  previous: WindowsChannelRuntimeSnapshot,
  next: WindowsChannelRuntimeSnapshot
): WindowsChannelRuntimeDrift {
  const normalizedPrevious = normalizeSnapshot(previous)
  const normalizedNext = normalizeSnapshot(next)
  const changedFields = collectDriftFields(normalizedPrevious, normalizedNext)

  return {
    changed: changedFields.length > 0,
    changedFields,
  }
}
