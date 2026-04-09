import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverToWindowWhenReady, getLiveWindow, revealWindow, showOrCreateWindow } from '../window-lifecycle'

function createWindowMock(overrides: Partial<{
  destroyed: boolean
  minimized: boolean
  loadingMainFrame: boolean
}> = {}) {
  let destroyed = Boolean(overrides.destroyed)
  let minimized = Boolean(overrides.minimized)
  let loadingMainFrame = Boolean(overrides.loadingMainFrame)
  let didFinishLoadHandler: (() => void) | null = null

  return {
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(() => {
      minimized = false
    }),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isLoadingMainFrame: vi.fn(() => loadingMainFrame),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'did-finish-load') {
          didFinishLoadHandler = handler
        }
      }),
    },
    destroy: () => {
      destroyed = true
    },
    finishLoad: () => {
      loadingMainFrame = false
      didFinishLoadHandler?.()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getLiveWindow', () => {
  it('returns null for destroyed windows', () => {
    const browserWindow = createWindowMock({ destroyed: true })

    expect(getLiveWindow(browserWindow)).toBeNull()
  })

  it('keeps active windows intact', () => {
    const browserWindow = createWindowMock()

    expect(getLiveWindow(browserWindow)).toBe(browserWindow)
  })
})

describe('revealWindow', () => {
  it('restores minimized windows before showing them', () => {
    const browserWindow = createWindowMock({ minimized: true })
    const focusApp = vi.fn()

    revealWindow(browserWindow, focusApp)

    expect(browserWindow.restore).toHaveBeenCalledTimes(1)
    expect(browserWindow.show).toHaveBeenCalledTimes(1)
    expect(browserWindow.focus).toHaveBeenCalledTimes(1)
    expect(focusApp).toHaveBeenCalledWith({ steal: true })
  })

  it('does not restore windows that are already expanded', () => {
    const browserWindow = createWindowMock()

    revealWindow(browserWindow)

    expect(browserWindow.restore).not.toHaveBeenCalled()
    expect(browserWindow.show).toHaveBeenCalledTimes(1)
    expect(browserWindow.focus).toHaveBeenCalledTimes(1)
  })
})

describe('showOrCreateWindow', () => {
  it('creates a new window when there is no live window to reveal', () => {
    const createdWindow = createWindowMock()
    const createWindow = vi.fn(() => createdWindow)

    const result = showOrCreateWindow({
      browserWindow: null,
      createWindow,
    })

    expect(createWindow).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      window: createdWindow,
      created: true,
    })
    expect(createdWindow.show).not.toHaveBeenCalled()
  })

  it('reuses and reveals the existing window when it is still alive', () => {
    const browserWindow = createWindowMock({ minimized: true })
    const createWindow = vi.fn(() => createWindowMock())
    const focusApp = vi.fn()

    const result = showOrCreateWindow({
      browserWindow,
      createWindow,
      focusApp,
    })

    expect(createWindow).not.toHaveBeenCalled()
    expect(browserWindow.restore).toHaveBeenCalledTimes(1)
    expect(browserWindow.show).toHaveBeenCalledTimes(1)
    expect(browserWindow.focus).toHaveBeenCalledTimes(1)
    expect(focusApp).toHaveBeenCalledWith({ steal: true })
    expect(result).toEqual({
      window: browserWindow,
      created: false,
    })
  })
})

describe('deliverToWindowWhenReady', () => {
  it('runs immediately when the renderer main frame has already loaded', () => {
    const browserWindow = createWindowMock()
    const deliver = vi.fn()

    deliverToWindowWhenReady(browserWindow, deliver)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(browserWindow.webContents.once).not.toHaveBeenCalled()
  })

  it('waits for did-finish-load before delivering to a newly created window', () => {
    const browserWindow = createWindowMock({ loadingMainFrame: true })
    const deliver = vi.fn()

    deliverToWindowWhenReady(browserWindow, deliver)

    expect(deliver).not.toHaveBeenCalled()
    expect(browserWindow.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function))

    browserWindow.finishLoad()
    vi.advanceTimersByTime(49)
    expect(deliver).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
