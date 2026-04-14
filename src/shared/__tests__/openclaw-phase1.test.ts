import { describe, expect, it } from 'vitest'
import {
  applyBaselineBackupBypassToDiscovery,
  applyBaselineBackupRecordToDiscovery,
  buildManualBackupWarning,
  canSkipFailedBaselineBackup,
  classifyOpenClawPhase1,
  compareLooseVersions,
  hasInitializedOpenClawConfig,
  isQclawOwnedOpenClawSource,
  isUpgradeableInstallSource,
  requiresManualUserIntervention,
  resolveOpenClawInstallDecision,
  shouldEnsureBaselineBackup,
  shouldRouteToSetupAfterPhase1,
  supportsQclawAutoRepair,
  type OpenClawDiscoveryResult,
  type OpenClawInstallCandidate,
} from '../openclaw-phase1'

function createCandidate(overrides: Partial<OpenClawInstallCandidate> = {}): OpenClawInstallCandidate {
  return {
    candidateId: 'candidate-1',
    binaryPath: '/usr/local/bin/openclaw',
    resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.js',
    packageRoot: '/usr/local/lib/node_modules/openclaw',
    version: '2026.3.8',
    installSource: 'npm-global',
    isPathActive: true,
    configPath: '/Users/alice/.openclaw/openclaw.json',
    stateRoot: '/Users/alice/.openclaw',
    displayConfigPath: '~/.openclaw/openclaw.json',
    displayStateRoot: '~/.openclaw',
    ownershipState: 'external-preexisting',
    installFingerprint: 'fingerprint-1',
    baselineBackup: null,
    baselineBackupBypass: null,
    ...overrides,
  }
}

function createDiscovery(
  candidateOverrides: Partial<OpenClawInstallCandidate> = {}
): OpenClawDiscoveryResult {
  const candidate = createCandidate(candidateOverrides)
  return {
    status: 'installed',
    candidates: [candidate],
    activeCandidateId: candidate.candidateId,
    hasMultipleCandidates: false,
    historyDataCandidates: [],
    errors: [],
    warnings: [],
    defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
  }
}

describe('compareLooseVersions', () => {
  it('compares dotted numeric versions numerically', () => {
    expect(compareLooseVersions('2026.3.10', '2026.3.9')).toBe(1)
    expect(compareLooseVersions('2026.3.8', '2026.3.8')).toBe(0)
    expect(compareLooseVersions('2026.3.8', '2026.4.0')).toBe(-1)
  })

  it('ignores suffixes before comparing numeric version cores', () => {
    expect(compareLooseVersions('2026.3.22', '2026.3.22')).toBe(0)
    expect(compareLooseVersions('2026.3.22-2', '2026.3.22')).toBe(0)
    expect(compareLooseVersions('2026.3.23-2', '2026.3.22')).toBe(1)
    expect(compareLooseVersions('2026.3.21-9', '2026.3.22')).toBe(-1)
  })

  it('handles OpenClaw CLI version format with prefix and commit hash', () => {
    expect(compareLooseVersions('OpenClaw 2026.4.12 (cff6dc9)', '2026.4.12')).toBe(0)
    expect(compareLooseVersions('OpenClaw 2026.4.11 (abc1234)', '2026.4.12')).toBe(-1)
    expect(compareLooseVersions('OpenClaw 2026.4.13 (def5678)', '2026.4.12')).toBe(1)
    expect(compareLooseVersions('OpenClaw 2026.3.12', '2026.3.12')).toBe(0)
    expect(compareLooseVersions('OpenClaw 2026.4.12 (cff6dc9)', 'OpenClaw 2026.4.12 (abc1234)')).toBe(0)
    expect(compareLooseVersions('OpenClaw 2026.3.23-2 (7ffe7e4)', '2026.3.23')).toBe(0)
  })
})

describe('openclaw install source guards', () => {
  it('recognizes Qclaw-owned sources', () => {
    expect(isQclawOwnedOpenClawSource('qclaw-bundled')).toBe(true)
    expect(isQclawOwnedOpenClawSource('qclaw-managed')).toBe(true)
    expect(isQclawOwnedOpenClawSource('npm-global')).toBe(false)
    expect(isQclawOwnedOpenClawSource(null)).toBe(false)
  })

  it('marks only Qclaw-owned sources as Qclaw auto-repairable', () => {
    expect(supportsQclawAutoRepair('qclaw-bundled')).toBe(true)
    expect(supportsQclawAutoRepair('qclaw-managed')).toBe(true)
    expect(supportsQclawAutoRepair('custom')).toBe(false)
    expect(supportsQclawAutoRepair(undefined)).toBe(false)
  })

  it('keeps manual intervention limited to custom and unknown sources', () => {
    expect(requiresManualUserIntervention('custom')).toBe(true)
    expect(requiresManualUserIntervention('unknown')).toBe(true)
    expect(requiresManualUserIntervention('qclaw-managed')).toBe(false)
    expect(requiresManualUserIntervention('npm-global')).toBe(false)
  })

  it('treats Qclaw-owned sources as upgradeable install sources', () => {
    expect(isUpgradeableInstallSource('qclaw-bundled')).toBe(true)
    expect(isUpgradeableInstallSource('qclaw-managed')).toBe(true)
    expect(isUpgradeableInstallSource('unknown')).toBe(false)
    expect(isUpgradeableInstallSource('custom')).toBe(false)
  })
})

describe('classifyOpenClawPhase1', () => {
  it('returns equal when installed version matches latest', () => {
    const result = classifyOpenClawPhase1(createDiscovery(), {
      ok: true,
      latestVersion: '2026.3.8',
      checkedAt: new Date().toISOString(),
      source: 'npm-registry',
    })

    expect(result.versionStatus).toBe('equal')
    expect(result.canContinue).toBe(true)
  })

  it('returns outdated and upgradeable for recognized sources', () => {
    const result = classifyOpenClawPhase1(createDiscovery(), {
      ok: true,
      latestVersion: '2026.4.0',
      checkedAt: new Date().toISOString(),
      source: 'npm-registry',
    })

    expect(result.versionStatus).toBe('outdated')
    expect(result.canUpgradeInPlace).toBe(true)
  })

  it('returns latest-unknown when latest check fails', () => {
    const result = classifyOpenClawPhase1(createDiscovery(), {
      ok: false,
      latestVersion: '',
      checkedAt: new Date().toISOString(),
      source: 'npm-registry',
      error: 'timeout',
    })

    expect(result.versionStatus).toBe('latest-unknown')
    expect(result.warnings).toContain('最新版本检查失败，可以先继续使用，稍后再重试。')
    expect(result.warnings.join(' ')).not.toContain('timeout')
  })
})

describe('hasInitializedOpenClawConfig', () => {
  it('returns false for missing or empty configs', () => {
    expect(hasInitializedOpenClawConfig(null)).toBe(false)
    expect(hasInitializedOpenClawConfig({})).toBe(false)
    expect(hasInitializedOpenClawConfig({ channels: {}, plugins: { allow: [] } })).toBe(false)
  })

  it('returns true once shared config contains initialized values', () => {
    expect(
      hasInitializedOpenClawConfig({
        plugins: {
          allow: ['feishu-openclaw-plugin'],
        },
      })
    ).toBe(true)
  })
})

describe('shouldRouteToSetupAfterPhase1', () => {
  it('forces setup when the shared config is not initialized yet', () => {
    expect(
      shouldRouteToSetupAfterPhase1({
        hadOpenClawInstalled: true,
        installedOpenClawDuringCheck: false,
        gatewayRunning: false,
        sharedConfigInitialized: false,
      })
    ).toBe(true)
  })

  it('allows dashboard routing once the shared config is initialized', () => {
    expect(
      shouldRouteToSetupAfterPhase1({
        hadOpenClawInstalled: true,
        installedOpenClawDuringCheck: false,
        gatewayRunning: false,
        sharedConfigInitialized: true,
      })
    ).toBe(false)
  })
})

describe('resolveOpenClawInstallDecision', () => {
  it('allows fresh install only when machine-level discovery is absent', () => {
    expect(
      resolveOpenClawInstallDecision({
        discovery: {
          status: 'absent',
          candidates: [],
          activeCandidateId: null,
          hasMultipleCandidates: false,
          historyDataCandidates: [],
          errors: [],
          warnings: [],
          defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
        },
        cliInstalled: false,
      })
    ).toMatchObject({
      machineStatus: 'absent',
      hadOpenClawInstalled: false,
      shouldFreshInstall: true,
      requiresRecovery: false,
    })
  })

  it('blocks fresh install and marks recovery when only history data exists', () => {
    expect(
      resolveOpenClawInstallDecision({
        discovery: {
          status: 'history-only',
          candidates: [],
          activeCandidateId: null,
          hasMultipleCandidates: false,
          historyDataCandidates: [
            {
              path: '/Users/alice/.openclaw',
              displayPath: '~/.openclaw',
              reason: 'default-home-dir',
            },
          ],
          errors: [],
          warnings: [],
          defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
        },
        cliInstalled: false,
      })
    ).toMatchObject({
      machineStatus: 'history-only',
      hadOpenClawInstalled: false,
      shouldFreshInstall: false,
      requiresRecovery: true,
    })
  })

  it('treats detected installs as preexisting even when cli probing succeeds', () => {
    expect(
      resolveOpenClawInstallDecision({
        discovery: createDiscovery(),
        cliInstalled: true,
      })
    ).toMatchObject({
      machineStatus: 'installed',
      hadOpenClawInstalled: true,
      shouldFreshInstall: false,
      requiresRecovery: false,
    })
  })
})

describe('shouldEnsureBaselineBackup', () => {
  it('requires a baseline backup for preexisting external installs without a backup record', () => {
    expect(shouldEnsureBaselineBackup(createCandidate())).toBe(true)
  })

  it('skips backup for managed installs and already-backed-up installs', () => {
    expect(shouldEnsureBaselineBackup(createCandidate({ ownershipState: 'qclaw-installed' }))).toBe(false)
    expect(
      shouldEnsureBaselineBackup(
        createCandidate({
          baselineBackup: {
            backupId: 'baseline-1',
            createdAt: new Date().toISOString(),
            archivePath: '/tmp/baseline-1',
            installFingerprint: 'fingerprint-1',
          },
        })
      )
    ).toBe(false)
  })

  it('skips backup once the user has acknowledged manual backup after an auto-backup failure', () => {
    expect(
      shouldEnsureBaselineBackup(
        createCandidate({
          baselineBackupBypass: {
            installFingerprint: 'fingerprint-1',
            skippedAt: new Date().toISOString(),
            reason: 'manual-backup-required',
            sourcePath: '/Users/alice/.openclaw',
            displaySourcePath: '~/.openclaw',
            suggestedArchivePath: '/Users/alice/Documents/Qclaw Lite Backups/manual-baseline',
            displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/manual-baseline',
          },
        })
      )
    ).toBe(false)
  })
})

describe('baseline backup bypass helpers', () => {
  it('allows skip only for failed auto-backups that include manual backup guidance', () => {
    expect(
      canSkipFailedBaselineBackup({
        ok: false,
        created: false,
        backup: null,
        errorCode: 'backup_failed',
        manualBackupAction: {
          sourcePath: '/Users/alice/.openclaw',
          displaySourcePath: '~/.openclaw',
          suggestedArchivePath: '/Users/alice/Documents/Qclaw Lite Backups/manual-baseline',
          displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/manual-baseline',
        },
      })
    ).toBe(true)

    expect(
      canSkipFailedBaselineBackup({
        ok: false,
        created: false,
        backup: null,
        errorCode: 'invalid_candidate',
      })
    ).toBe(false)
  })

  it('builds a manual backup warning with both source and suggested destination', () => {
    expect(
      buildManualBackupWarning({
        sourcePath: '/Users/alice/.openclaw',
        displaySourcePath: '~/.openclaw',
        suggestedArchivePath: '/Users/alice/Documents/Qclaw Lite Backups/manual-baseline',
        displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/manual-baseline',
      })
    ).toContain('请将 ~/.openclaw 复制到 ~/Documents/Qclaw Lite Backups/manual-baseline')
  })

  it('applies a real backup record to the active discovery candidate', () => {
    const discovery = applyBaselineBackupRecordToDiscovery(createDiscovery(), {
      backupId: 'baseline-1',
      createdAt: '2026-03-14T06:00:00.000Z',
      archivePath: '/tmp/baseline-1',
      installFingerprint: 'fingerprint-1',
    })

    expect(discovery?.candidates[0]).toMatchObject({
      baselineBackup: {
        backupId: 'baseline-1',
      },
      baselineBackupBypass: null,
    })
  })

  it('applies a manual-backup bypass to the active discovery candidate and appends a warning', () => {
    const discovery = applyBaselineBackupBypassToDiscovery(createDiscovery(), {
      installFingerprint: 'fingerprint-1',
      skippedAt: '2026-03-14T06:00:00.000Z',
      reason: 'manual-backup-required',
      sourcePath: '/Users/alice/.openclaw',
      displaySourcePath: '~/.openclaw',
      suggestedArchivePath: '/Users/alice/Documents/Qclaw Lite Backups/manual-baseline',
      displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/manual-baseline',
    })

    expect(discovery?.candidates[0]).toMatchObject({
      baselineBackup: null,
      baselineBackupBypass: {
        installFingerprint: 'fingerprint-1',
      },
    })
    expect(discovery?.warnings[0]).toContain('自动备份失败，请手动备份')
    expect(discovery?.warnings[0]).toContain('~/Documents/Qclaw Lite Backups/manual-baseline')
  })
})
