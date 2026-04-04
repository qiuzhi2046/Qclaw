function parseNumericPart(value: string): string | null {
  const match = value.match(/v?(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)
  if (![major, minor, patch].every(Number.isFinite)) return null

  return `${major}.${minor}.${patch}`
}

export function normalizeOpenClawVersionDisplay(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null

  const numericPart = parseNumericPart(normalized)
  if (numericPart) return numericPart

  const withoutPrefix = normalized.replace(/^openclaw\s+/i, '').trim()
  return withoutPrefix || null
}

export function formatOpenClawVersionLabel(value: string | null | undefined): string {
  const normalized = normalizeOpenClawVersionDisplay(value)
  return normalized ? `OpenClaw ${normalized}` : 'OpenClaw 运行状态'
}
