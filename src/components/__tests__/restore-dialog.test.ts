import { describe, expect, it } from 'vitest'

import { scopeLabel } from '../RestoreDialog'

describe('restore dialog scope label', () => {
  it('keeps memory-only wording for full-home backups', () => {
    expect(scopeLabel('memory', 'full-home')).toBe('仅记忆数据')
  })

  it('shows state restore wording for essential-state backups', () => {
    expect(scopeLabel('memory', 'essential-state')).toBe('关键状态数据（含身份）')
  })
})
