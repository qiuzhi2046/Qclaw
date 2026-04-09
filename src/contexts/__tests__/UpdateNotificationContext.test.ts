import { describe, expect, it } from 'vitest'

import source from '../UpdateNotificationContext.tsx?raw'

describe('UpdateNotificationContext source', () => {
  it('exposes dev-only console hooks for mocking the update reminder', () => {
    expect(source).toContain('import.meta.env.DEV')
    expect(source).toContain('__qclawSetMockUpdate')
    expect(source).toContain('__qclawClearMockUpdate')
  })
})
