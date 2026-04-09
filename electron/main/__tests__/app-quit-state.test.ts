import { describe, expect, it, vi } from 'vitest'

import {
  registerQuitIntentFromUpdater,
  shouldHideWindowOnClose,
} from '../app-quit-state'

describe('shouldHideWindowOnClose', () => {
  it('hides macOS windows when the app is not quitting yet', () => {
    expect(shouldHideWindowOnClose('darwin', false)).toBe(true)
  })

  it('does not hide macOS windows once quit has already started', () => {
    expect(shouldHideWindowOnClose('darwin', true)).toBe(false)
  })

  it('never hides non-macOS windows on close', () => {
    expect(shouldHideWindowOnClose('win32', false)).toBe(false)
  })
})

describe('registerQuitIntentFromUpdater', () => {
  it('marks the app as quitting before the updater closes windows for install', () => {
    const on = vi.fn()
    const markQuitting = vi.fn()

    registerQuitIntentFromUpdater({ on }, markQuitting)

    expect(on).toHaveBeenCalledWith('before-quit-for-update', expect.any(Function))

    const handler = on.mock.calls[0]?.[1]
    expect(typeof handler).toBe('function')

    handler()

    expect(markQuitting).toHaveBeenCalledTimes(1)
  })
})
