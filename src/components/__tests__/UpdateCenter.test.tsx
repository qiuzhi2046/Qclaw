import { describe, expect, it } from 'vitest'
import updateCenterSource from '../UpdateCenter.tsx?raw'

describe('UpdateCenter', () => {
  it('does not render the combined update option', () => {
    expect(updateCenterSource).toContain("label: 'OpenClaw'")
    expect(updateCenterSource).toContain("label: 'Qclaw'")
    expect(updateCenterSource).not.toContain("label: '组合更新'")
    expect(updateCenterSource).not.toContain("btnText: '查看组合更新'")
    expect(updateCenterSource).not.toContain('showCombinedDialog')
    expect(updateCenterSource).not.toContain('CombinedUpdateDialog')
  })
})
