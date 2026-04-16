const lockTails = new Map<string, Promise<void>>()

export interface ManagedOperationLease {
  key: string
  release: () => void
}

function normalizeLockKey(key: string): string {
  return String(key || '').trim() || 'default'
}

function createLockTail(key: string): {
  chainedTail: Promise<void>
  previousTail: Promise<void>
  releaseCurrent: () => void
} {
  const normalizedKey = normalizeLockKey(key)
  const previousTail = lockTails.get(normalizedKey) || Promise.resolve()

  let releaseCurrent: () => void = () => {}
  const currentTail = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const chainedTail = previousTail.then(() => currentTail)
  lockTails.set(normalizedKey, chainedTail)

  return {
    chainedTail,
    previousTail,
    releaseCurrent,
  }
}

function releaseLockTail(key: string, chainedTail: Promise<void>, releaseCurrent: () => void): void {
  releaseCurrent()
  if (lockTails.get(key) === chainedTail) {
    lockTails.delete(key)
  }
}

function createManagedOperationLease(
  normalizedKey: string,
  chainedTail: Promise<void>,
  releaseCurrent: () => void
): ManagedOperationLease {
  let released = false
  return {
    key: normalizedKey,
    release: () => {
      if (released) return
      released = true
      releaseLockTail(normalizedKey, chainedTail, releaseCurrent)
    },
  }
}

export async function withManagedOperationLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const normalizedKey = normalizeLockKey(key)
  const { chainedTail, previousTail, releaseCurrent } = createLockTail(normalizedKey)

  await previousTail
  try {
    return await operation()
  } finally {
    releaseLockTail(normalizedKey, chainedTail, releaseCurrent)
  }
}

export async function acquireManagedOperationLease(key: string): Promise<ManagedOperationLease> {
  const normalizedKey = normalizeLockKey(key)
  const { chainedTail, previousTail, releaseCurrent } = createLockTail(normalizedKey)

  await previousTail
  return createManagedOperationLease(normalizedKey, chainedTail, releaseCurrent)
}

export function tryAcquireManagedOperationLease(key: string): ManagedOperationLease | null {
  const normalizedKey = normalizeLockKey(key)
  if (lockTails.has(normalizedKey)) {
    return null
  }

  const { chainedTail, releaseCurrent } = createLockTail(normalizedKey)
  return createManagedOperationLease(normalizedKey, chainedTail, releaseCurrent)
}

export function tryAcquireManagedOperationLeases(keys: string[]): ManagedOperationLease[] | null {
  const normalizedKeys = Array.from(
    new Set(keys.map((key) => normalizeLockKey(key)).filter(Boolean))
  )
  const leases: ManagedOperationLease[] = []

  for (const key of normalizedKeys) {
    const lease = tryAcquireManagedOperationLease(key)
    if (!lease) {
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        leases[index].release()
      }
      return null
    }
    leases.push(lease)
  }

  return leases
}

export function isManagedOperationLockBusy(key: string): boolean {
  return lockTails.has(normalizeLockKey(key))
}

export function resetManagedOperationLocksForTests(): void {
  lockTails.clear()
}
