import { describe, expect, it } from 'vitest'
import { canOpenExternalModelsPage } from '../../app-entry-gate'

describe('canOpenExternalModelsPage', () => {
  it('allows tray routing only for dashboard sessions', () => {
    expect(canOpenExternalModelsPage('dashboard')).toBe(true)
  })

  it('keeps tray routing closed for non-dashboard states', () => {
    expect(canOpenExternalModelsPage('startup-update')).toBe(false)
    expect(canOpenExternalModelsPage('welcome')).toBe(false)
    expect(canOpenExternalModelsPage('env-check')).toBe(false)
    expect(canOpenExternalModelsPage('setup')).toBe(false)
    expect(canOpenExternalModelsPage('gateway-bootstrap')).toBe(false)
  })
})
