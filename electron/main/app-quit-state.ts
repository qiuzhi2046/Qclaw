export interface UpdateQuitEmitter {
  on(event: 'before-quit-for-update', listener: () => void): unknown
}

export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  isQuitting: boolean
): boolean {
  return platform === 'darwin' && !isQuitting
}

export function registerQuitIntentFromUpdater(
  updater: UpdateQuitEmitter,
  markQuitting: () => void
): void {
  updater.on('before-quit-for-update', () => {
    markQuitting()
  })
}
