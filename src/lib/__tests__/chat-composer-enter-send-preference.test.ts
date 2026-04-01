import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY,
  readChatComposerEnterSendMode,
  writeChatComposerEnterSendMode,
} from '../chat-composer-enter-send-preference'
import type { ChatComposerEnterSendMode } from '../chat-composer-enter-send-preference'

function createStorageMock() {
  const storage = new Map<string, string>()

  return {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null
    },
    setItem(key: string, value: string) {
      storage.set(key, value)
    },
    removeItem(key: string) {
      storage.delete(key)
    },
    clear() {
      storage.clear()
    },
  }
}

describe('chat-composer-enter-send-preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to enter when no value has been stored', () => {
    vi.stubGlobal('localStorage', createStorageMock())
    expect(readChatComposerEnterSendMode()).toBe('enter')
  })

  it('persists stored mode', () => {
    const storage = createStorageMock()
    vi.stubGlobal('localStorage', storage)

    const nextMode: ChatComposerEnterSendMode = 'shiftEnter'
    writeChatComposerEnterSendMode(nextMode)

    expect(storage.getItem(CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY)).toBe(nextMode)
    expect(readChatComposerEnterSendMode()).toBe(nextMode)
  })

  it('falls back to default when stored value is invalid', () => {
    const storage = createStorageMock()
    vi.stubGlobal('localStorage', storage)
    storage.setItem(CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY, 'no-such-mode')

    expect(readChatComposerEnterSendMode()).toBe('enter')
  })
})

