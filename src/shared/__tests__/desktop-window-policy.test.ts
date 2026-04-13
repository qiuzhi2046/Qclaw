import { describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOW_POLICY,
  resolveMainWindowBrowserWindowOptions,
  resolveMainWindowBounds,
  shouldDisableHardwareAccelerationForPlatform,
} from '../desktop-window-policy'

describe('desktop-window-policy', () => {
  it('centralizes default window sizing, background color, and compatibility prefixes', () => {
    expect(DESKTOP_WINDOW_POLICY).toMatchObject({
      defaultWidth: 800,
      defaultHeight: 630,
      minimumWidth: 640,
      minimumHeight: 480,
      backgroundColor: '#09090b',
      safeMargin: 32,
    })
    expect(DESKTOP_WINDOW_POLICY.disableHardwareAccelerationWindowsReleasePrefixes).toContain('6.1')
  })

  it('disables hardware acceleration only for configured legacy Windows releases', () => {
    expect(shouldDisableHardwareAccelerationForPlatform('win32', '6.1.7601')).toBe(true)
    expect(shouldDisableHardwareAccelerationForPlatform('win32', '10.0.22631')).toBe(false)
    expect(shouldDisableHardwareAccelerationForPlatform('darwin', '6.1.7601')).toBe(false)
  })

  it('uses content-size sizing on Windows so frame chrome does not shrink the viewport', () => {
    expect(resolveMainWindowBrowserWindowOptions('win32')).toEqual({
      useContentSize: true,
    })
    expect(resolveMainWindowBrowserWindowOptions('darwin')).toEqual({
      useContentSize: false,
    })
  })

  it('keeps default bounds on normal displays', () => {
    expect(resolveMainWindowBounds({ width: 1440, height: 900 })).toEqual({
      width: 800,
      height: 630,
      minWidth: 640,
      minHeight: 480,
    })
  })

  it('uses a taller default height on Windows without changing macOS defaults', () => {
    expect(resolveMainWindowBounds({ width: 1440, height: 900 }, 'win32')).toEqual({
      width: 800,
      height: 660,
      minWidth: 640,
      minHeight: 480,
    })
    expect(resolveMainWindowBounds({ width: 1440, height: 900 }, 'darwin')).toEqual({
      width: 800,
      height: 630,
      minWidth: 640,
      minHeight: 480,
    })
  })

  it('clamps initial bounds to the current work area on tighter screens', () => {
    expect(resolveMainWindowBounds({ width: 700, height: 520 })).toEqual({
      width: 640,
      height: 480,
      minWidth: 640,
      minHeight: 480,
    })
  })

  it('shrinks minimum bounds when the available work area is smaller than legacy defaults', () => {
    expect(resolveMainWindowBounds({ width: 560, height: 430 })).toEqual({
      width: 560,
      height: 430,
      minWidth: 560,
      minHeight: 430,
    })
  })
})
