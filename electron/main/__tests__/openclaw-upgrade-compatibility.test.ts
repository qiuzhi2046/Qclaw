import { describe, expect, it } from 'vitest'
import {
  assessOpenClawUpgradeCompatibility,
  compareOpenClawVersions,
  detectOpenClawVersionBand,
  normalizeOpenClawVersion,
} from '../openclaw-upgrade-compatibility'

describe('openclaw upgrade compatibility', () => {
  it('normalizes release tags into stable version strings', () => {
    expect(normalizeOpenClawVersion('v2026.3.13-1')).toBe('2026.3.13')
    expect(normalizeOpenClawVersion('2026.3.22')).toBe('2026.3.22')
    expect(normalizeOpenClawVersion('not-a-version')).toBeNull()
  })

  it('compares normalized versions in chronological order', () => {
    expect(compareOpenClawVersions('2026.3.7', '2026.3.6')).toBeGreaterThan(0)
    expect(compareOpenClawVersions('2026.3.13-1', '2026.3.13')).toBe(0)
    expect(compareOpenClawVersions('invalid', '2026.3.13')).toBeLessThan(0)
  })

  it('maps audited versions into the expected bands', () => {
    expect(detectOpenClawVersionBand('2026.3.6')).toBe('pre_2026_3_7')
    expect(detectOpenClawVersionBand('2026.3.8')).toBe('openclaw_2026_3_7_to_2026_3_11')
    expect(detectOpenClawVersionBand('2026.3.13-1')).toBe('openclaw_2026_3_12_to_2026_3_13')
    expect(detectOpenClawVersionBand('2026.3.20')).toBe('openclaw_2026_3_14_to_2026_3_21')
    expect(detectOpenClawVersionBand('2026.3.22')).toBe('openclaw_2026_3_22')
    expect(detectOpenClawVersionBand('2026.3.23')).toBe('openclaw_2026_3_23_to_2026_3_24')
    expect(detectOpenClawVersionBand('2026.3.24')).toBe('openclaw_2026_3_23_to_2026_3_24')
  })

  it('marks unaudited future versions as conservative mode', () => {
    const assessment = assessOpenClawUpgradeCompatibility({
      currentVersion: '2026.4.13',
      previousVersion: '2026.3.22',
      assessedAt: '2026-03-23T10:00:00.000Z',
    })

    expect(assessment.status).toBe('unknown_future_version')
    expect(assessment.conservativeMode).toBe(true)
    expect(assessment.warningCodes).toEqual(['version_unknown_future'])
  })

  it('captures upgrade transitions for later reconcile flows', () => {
    const assessment = assessOpenClawUpgradeCompatibility({
      currentVersion: 'v2026.3.22',
      previousVersion: '2026.3.11',
      assessedAt: '2026-03-23T11:00:00.000Z',
    })

    expect(assessment.status).toBe('upgrade_detected')
    expect(assessment.currentVersion).toBe('2026.3.22')
    expect(assessment.previousVersion).toBe('2026.3.11')
    expect(assessment.summary).toContain('2026.3.11')
    expect(assessment.summary).toContain('2026.3.22')
    expect(assessment.warningCodes).toContain('runtime_reconcile_required')
    expect(assessment.warningCodes).toContain('legacy_env_alias_removed_in_2026_3_22')
    expect(assessment.warningCodes).toContain('bundled_plugin_runtime_changed_in_2026_3_22')
    expect(assessment.warningCodes).toContain('clawhub_resolution_changed_in_2026_3_22')
    expect(assessment.warningCodes).toContain('official_doctor_fix_migration_prioritized_in_2026_3_22')
    expect(assessment.summary).toContain('不能把 alias 漂移误判成单一 gateway 故障')
    expect(assessment.summary).toContain('doctor --fix')
  })

  it('treats the pinned 2026.4.12 target as an audited downgrade destination', () => {
    const assessment = assessOpenClawUpgradeCompatibility({
      currentVersion: '2026.4.12',
      previousVersion: '2026.4.13',
      assessedAt: '2026-03-29T10:00:00.000Z',
    })

    expect(assessment.status).toBe('downgrade_detected')
    expect(assessment.currentBand).toBe('openclaw_2026_4_12')
    expect(assessment.conservativeMode).toBe(false)
    expect(assessment.warningCodes).toContain('runtime_reconcile_required')
    expect(assessment.summary).toContain('2026.4.13')
    expect(assessment.summary).toContain('2026.4.12')
  })
})
