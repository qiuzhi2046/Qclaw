import { describe, expect, it } from 'vitest'
import { shouldShowQClawNewVersionButton } from '../qclaw-update-visibility'

describe('shouldShowQClawNewVersionButton', () => {
  it('shows the button when an available version is detected', () => {
    expect(
      shouldShowQClawNewVersionButton({
        status: 'available',
        availableVersion: '2.3.0',
      })
    ).toBe(true)
  })

  it('keeps the button visible while the update is in progress', () => {
    expect(
      shouldShowQClawNewVersionButton({
        status: 'downloaded',
        availableVersion: '2.3.0',
      })
    ).toBe(true)
  })

  it('hides the button when there is no detected update', () => {
    expect(
      shouldShowQClawNewVersionButton({
        status: 'unavailable',
        availableVersion: null,
      })
    ).toBe(false)
  })
})
