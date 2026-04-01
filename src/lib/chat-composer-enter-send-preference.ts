export type ChatComposerEnterSendMode = 'enter' | 'shiftEnter' | 'altEnter'

const CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY = 'qclaw-chat-composer-enter-send-mode'
const DEFAULT_ENTER_SEND_MODE: ChatComposerEnterSendMode = 'enter'

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readChatComposerEnterSendMode(): ChatComposerEnterSendMode {
  const storage = getLocalStorage()
  if (!storage) return DEFAULT_ENTER_SEND_MODE

  try {
    const raw = storage.getItem(CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY)
    if (raw === 'enter' || raw === 'shiftEnter' || raw === 'altEnter') return raw
    return DEFAULT_ENTER_SEND_MODE
  } catch {
    return DEFAULT_ENTER_SEND_MODE
  }
}

export function writeChatComposerEnterSendMode(mode: ChatComposerEnterSendMode): void {
  const storage = getLocalStorage()
  if (!storage) return

  try {
    storage.setItem(CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY, mode)
  } catch {}
}

export { CHAT_COMPOSER_ENTER_SEND_MODE_STORAGE_KEY }

