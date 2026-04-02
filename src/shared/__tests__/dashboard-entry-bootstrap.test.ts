import { describe, expect, it } from 'vitest'
import {
  createDashboardEntryBootstrapState,
  resolveDashboardEntryBootstrapCopy,
  resolveDashboardEntryBootstrapProgress,
} from '../dashboard-entry-bootstrap'

describe('dashboard-entry-bootstrap', () => {
  it('starts from a low baseline and reaches 100 once all tasks are settled', () => {
    const initial = createDashboardEntryBootstrapState()
    const inFlight = {
      ...initial,
      gateway: 'active' as const,
      config: 'active' as const,
      pairing: 'active' as const,
    }
    const done = {
      gateway: 'done' as const,
      config: 'done' as const,
      pairing: 'done' as const,
    }

    expect(resolveDashboardEntryBootstrapProgress(initial)).toBe(8)
    expect(resolveDashboardEntryBootstrapProgress(inFlight)).toBeGreaterThan(20)
    expect(resolveDashboardEntryBootstrapProgress(done)).toBe(100)
  })

  it('prefers the heaviest active stage copy', () => {
    const copy = resolveDashboardEntryBootstrapCopy({
      gateway: 'active',
      config: 'active',
      pairing: 'active',
    })

    expect(copy.title).toBe('整理配对状态')
    expect(copy.detail).toContain('配对')
  })

  it('describes gateway work as a soft snapshot instead of a hard gate', () => {
    const copy = resolveDashboardEntryBootstrapCopy({
      gateway: 'active',
      config: 'pending',
      pairing: 'pending',
    })

    expect(copy.title).toBe('读取网关状态')
    expect(copy.detail).toContain('当前网关状态')
  })

  it('returns a completion message after all tasks finish or degrade softly', () => {
    const copy = resolveDashboardEntryBootstrapCopy({
      gateway: 'done',
      config: 'done',
      pairing: 'warning',
    })

    expect(copy.title).toBe('控制面板准备完成')
    expect(copy.detail).toContain('渲染')
  })
})
