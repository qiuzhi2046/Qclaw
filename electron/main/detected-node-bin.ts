let detectedNodeBinDir: string | null = null

function normalizeRuntimePathForCompare(value: string | null | undefined): string {
  const trimmed = String(value || '').trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export function getDetectedNodeBinDir(): string | null {
  return detectedNodeBinDir
}

export function setDetectedNodeBinDir(nextBinDir: string | null | undefined): string | null {
  detectedNodeBinDir = String(nextBinDir || '').trim() || null
  return detectedNodeBinDir
}

export function detectedNodeBinDirChanged(
  nextBinDir: string | null | undefined
): boolean {
  const normalizedNext = String(nextBinDir || '').trim() || null
  return (
    normalizeRuntimePathForCompare(detectedNodeBinDir) !==
    normalizeRuntimePathForCompare(normalizedNext)
  )
}

export function clearDetectedNodeBinDir(): void {
  detectedNodeBinDir = null
}
