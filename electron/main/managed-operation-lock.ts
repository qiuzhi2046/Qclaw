const lockTails = new Map<string, Promise<void>>()

const DEFAULT_LOCK_TIMEOUT_MS = 300_000

export class ManagedOperationLockTimeoutError extends Error {
  readonly key: string
  readonly timeoutMs: number
  constructor(key: string, timeoutMs: number) {
    super(`Managed operation lock timed out after ${timeoutMs}ms for key: ${key}`)
    this.name = 'ManagedOperationLockTimeoutError'
    this.key = key
    this.timeoutMs = timeoutMs
  }
}

export interface ManagedOperationLockOptions {
  /** Timeout in milliseconds. Defaults to 300_000 (5 minutes). Set 0 to disable. */
  timeoutMs?: number
}

export async function withManagedOperationLock<T>(
  key: string,
  operation: () => Promise<T>,
  options?: ManagedOperationLockOptions
): Promise<T> {
  const normalizedKey = String(key || '').trim() || 'default'
  const previousTail = lockTails.get(normalizedKey) || Promise.resolve()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS

  let releaseCurrent: () => void = () => {}
  const currentTail = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const chainedTail = previousTail.then(() => currentTail)
  lockTails.set(normalizedKey, chainedTail)

  if (timeoutMs > 0) {
    const waitPromise = previousTail
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs)
    )
    const raceResult = await Promise.race([
      waitPromise.then(() => 'acquired' as const),
      timeoutPromise,
    ])
    if (raceResult === 'timeout') {
      releaseCurrent()
      if (lockTails.get(normalizedKey) === chainedTail) {
        lockTails.delete(normalizedKey)
      }
      throw new ManagedOperationLockTimeoutError(normalizedKey, timeoutMs)
    }
  } else {
    await previousTail
  }

  try {
    return await operation()
  } finally {
    releaseCurrent()
    if (lockTails.get(normalizedKey) === chainedTail) {
      lockTails.delete(normalizedKey)
    }
  }
}

export function resetManagedOperationLocksForTests(): void {
  lockTails.clear()
}
