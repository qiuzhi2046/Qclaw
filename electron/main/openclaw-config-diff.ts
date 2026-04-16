function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right)
}

function sortUnique(paths: string[]): string[] {
  return Array.from(new Set(paths.map((item) => String(item || '').trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
}

function collectChangedJsonPathsInternal(
  previousValue: unknown,
  nextValue: unknown,
  currentPath: string
): string[] {
  if (isSameValue(previousValue, nextValue)) {
    return []
  }

  if (Array.isArray(previousValue) && Array.isArray(nextValue)) {
    const nextPaths: string[] = []
    const maxLength = Math.max(previousValue.length, nextValue.length)
    for (let index = 0; index < maxLength; index += 1) {
      nextPaths.push(
        ...collectChangedJsonPathsInternal(previousValue[index], nextValue[index], `${currentPath}[${index}]`)
      )
    }
    return nextPaths
  }

  if (isPlainObject(previousValue) && isPlainObject(nextValue)) {
    const nextPaths: string[] = []
    const keys = new Set([...Object.keys(previousValue), ...Object.keys(nextValue)])
    for (const key of keys) {
      const nextPath = currentPath === '$' ? `$.${key}` : `${currentPath}.${key}`
      nextPaths.push(...collectChangedJsonPathsInternal(previousValue[key], nextValue[key], nextPath))
    }
    return nextPaths
  }

  return [currentPath]
}

export function collectChangedJsonPaths(
  previousConfig: Record<string, unknown> | null | undefined,
  nextConfig: Record<string, unknown> | null | undefined
): string[] {
  return sortUnique(collectChangedJsonPathsInternal(previousConfig || {}, nextConfig || {}, '$'))
}
