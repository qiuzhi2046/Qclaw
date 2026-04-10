import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'

let selectedWindowsActiveRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null = null

function cloneSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined
): WindowsActiveRuntimeSnapshot | null {
  if (!snapshot) return null
  return { ...snapshot }
}

export function getSelectedWindowsActiveRuntimeSnapshot(): WindowsActiveRuntimeSnapshot | null {
  return cloneSnapshot(selectedWindowsActiveRuntimeSnapshot)
}

export function setSelectedWindowsActiveRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined
): WindowsActiveRuntimeSnapshot | null {
  selectedWindowsActiveRuntimeSnapshot = cloneSnapshot(snapshot)
  return getSelectedWindowsActiveRuntimeSnapshot()
}

export function clearSelectedWindowsActiveRuntimeSnapshot(): void {
  selectedWindowsActiveRuntimeSnapshot = null
}
