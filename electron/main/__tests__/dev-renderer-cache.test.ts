import { describe, expect, it, vi } from 'vitest'
import { clearDevRendererCache } from '../dev-renderer-cache'

function createSessionMock() {
  return {
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearCodeCaches: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
  }
}

describe('clearDevRendererCache', () => {
  it('clears renderer caches for the active dev-server origin', async () => {
    const session = createSessionMock()

    await clearDevRendererCache(session, 'http://localhost:5173/')

    expect(session.clearCache).toHaveBeenCalledTimes(1)
    expect(session.clearCodeCaches).toHaveBeenCalledWith({})
    expect(session.clearStorageData).toHaveBeenCalledWith({
      origin: 'http://localhost:5173',
      storages: ['serviceworkers'],
    })
  })
})
