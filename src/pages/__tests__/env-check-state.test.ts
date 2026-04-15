import { describe, expect, it } from 'vitest'
import * as EnvCheckModule from '../EnvCheck'
import envCheckSource from '../EnvCheck.tsx?raw'
import {
  buildDeferredGatewayStepState,
  buildOpenClawAutoCorrectionConsentMessage,
  buildOpenClawGateState,
  canContinueWithOpenClawGate,
  canContinueHistoryOnlyRecovery,
  canShowOpenClawUpgradeAction,
  clearTakeoverFailure,
  createEnvCheckRestartState,
  formatPluginRepairErrorSummaryForEnvCheck,
  formatTakeoverFailureManualBackupWarning,
  resolveTakeoverBackupRootDirectory,
  resolveEnvInstallProgressStep,
  resolveActiveTakeoverFailure,
  retryOpenClawLatestVersionCheck,
  shouldDownloadNodeInstallerBeforeInstall,
  shouldOfferManualNodeUpgrade,
  shouldRenderStartupIssueInline,
  shouldShowOpenClawManualHint,
} from '../EnvCheck'

const normalizedEnvCheckSource = envCheckSource.replace(/\r\n/g, '\n')

describe('createEnvCheckRestartState', () => {
  it('resets env-check UI state and advances the run token for a real retry', () => {
    const state = createEnvCheckRestartState(2)

    expect(state.runAttempt).toBe(3)
    expect(state.currentStep).toBe(0)
    expect(state.progress).toBe(0)
    expect(state.tipIndex).toBe(0)
    expect(state.fatalIssue).toBeNull()
    expect(state.startupIssuePrompt).toBeNull()
    expect(state.steps.map((step) => ({ id: step.id, status: step.status }))).toEqual([
      { id: 'node', status: 'pending' },
      { id: 'openclaw', status: 'pending' },
      { id: 'gateway', status: 'pending' },
    ])
  })

  it('retries latest OpenClaw version checks up to the configured cap', async () => {
    let callCount = 0

    const result = await retryOpenClawLatestVersionCheck(async () => {
      callCount += 1
      if (callCount < 3) {
        return {
          ok: false,
          latestVersion: '',
          checkedAt: `attempt-${callCount}`,
          source: 'npm-registry',
          error: 'network down',
        }
      }

      return {
        ok: true,
        latestVersion: '2026.3.13',
        checkedAt: 'attempt-3',
        source: 'npm-registry',
      }
    })

    expect(callCount).toBe(3)
    expect(result.attempts).toBe(3)
    expect(result.result.ok).toBe(true)
    expect(result.result.latestVersion).toBe('2026.3.13')
  })

  it('keeps shared install progress on OpenClaw when Node is already installed', () => {
    expect(
      resolveEnvInstallProgressStep({
        needNode: false,
        shouldInstallOpenClawRuntime: true,
      })
    ).toBe('openclaw')

    expect(
      resolveEnvInstallProgressStep({
        needNode: true,
        shouldInstallOpenClawRuntime: true,
      })
    ).toBe('node')
  })

  it('lets the main process install the Windows private Node zip instead of predownloading it in the renderer', () => {
    expect(
      shouldDownloadNodeInstallerBeforeInstall({
        needNode: true,
        installStrategy: 'installer',
        platform: 'win32',
        nodeInstallPlan: {
          artifactKind: 'zip',
        },
      })
    ).toBe(false)
  })

  it('bootstraps the Windows private Node zip before probing OpenClaw commands', () => {
    const shouldBootstrapNodeBeforeOpenClawCheck = (
      EnvCheckModule as typeof EnvCheckModule & {
        shouldBootstrapNodeBeforeOpenClawCheck?: (options: {
          installStrategy: 'nvm' | 'installer'
          needNode: boolean
          nodeInstallPlan?: { artifactKind?: 'pkg' | 'zip' } | null
          platform: string
        }) => boolean
      }
    ).shouldBootstrapNodeBeforeOpenClawCheck

    expect(shouldBootstrapNodeBeforeOpenClawCheck).toBeTypeOf('function')
    expect(
      shouldBootstrapNodeBeforeOpenClawCheck?.({
        needNode: true,
        installStrategy: 'installer',
        platform: 'win32',
        nodeInstallPlan: {
          artifactKind: 'zip',
        },
      })
    ).toBe(true)
    expect(
      shouldBootstrapNodeBeforeOpenClawCheck?.({
        needNode: true,
        installStrategy: 'installer',
        platform: 'darwin',
        nodeInstallPlan: {
          artifactKind: 'pkg',
        },
      })
    ).toBe(false)

    const source = normalizedEnvCheckSource
    const bootstrapIndex = source.indexOf('shouldBootstrapNodeBeforeOpenClawCheck({')
    const openClawCheckIndex = source.indexOf('const openclawResult = await window.api.checkOpenClaw()')
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0)
    expect(openClawCheckIndex).toBeGreaterThan(bootstrapIndex)
    expect(source.slice(bootstrapIndex, openClawCheckIndex)).toContain('needOpenClaw: false')
  })

  it('uses env-check-specific OpenClaw discovery instead of whole-machine discovery during the Windows check flow', () => {
    const source = normalizedEnvCheckSource
    expect(source).toContain('const discoverOpenClawDuringEnvCheck = async () => {')
    expect(source).toContain('window.api.discoverOpenClawForEnvCheck().catch(() => null)')

    const initialDiscoveryIndex = source.indexOf('const initialDiscovery = await discoverOpenClawDuringEnvCheck()')
    const finalDiscoveryIndex = source.indexOf('shouldInstallOpenClawRuntime ? await discoverOpenClawDuringEnvCheck() : initialDiscovery')
    const historyRecoveryDiscoveryIndex = source.indexOf('const recoveredDiscovery = await window.api.discoverOpenClaw().catch(() => null)')

    expect(initialDiscoveryIndex).toBeGreaterThan(-1)
    expect(finalDiscoveryIndex).toBeGreaterThan(initialDiscoveryIndex)
    expect(historyRecoveryDiscoveryIndex).toBeGreaterThan(-1)
  })

  it('keeps the Windows upgrade check on the env-check discovery instead of rediscovering installs', () => {
    const source = normalizedEnvCheckSource
    expect(source).toContain("window.api.platform === 'win32'")
    expect(source).toContain('window.api.checkOpenClawUpgradeForEnvCheck(discovery)')
    expect(source).toContain('window.api.checkOpenClawUpgrade()')
  })

  it('shows a non-blocking gateway owner warning when Windows owner artifacts are missing', () => {
    expect(buildDeferredGatewayStepState('service-missing').description).toContain('后台启动器缺失')
    expect(buildDeferredGatewayStepState('service-missing').description).toContain('不会自动安装')
    expect(buildDeferredGatewayStepState('launcher-missing').description).toContain('启动器损坏')
    expect(buildDeferredGatewayStepState('healthy').description).toContain('认证和渠道配置完成后再确认网关可用性')
  })

  it('derives shared config readiness from the active candidate config path during env-check', () => {
    const source = normalizedEnvCheckSource

    expect(source).toContain('const readSharedConfigInitialized = async (configPath?: string | null) => {')
    expect(source).toContain('const config = await window.api.readConfig({ configPath: configPath || undefined })')
    expect(source).toContain('await readSharedConfigInitialized(')
    expect(source).toContain('resolveActiveOpenClawCandidate(')
    expect(source).toContain('?.configPath')
  })

  it('marks a freshly installed Windows OpenClaw runtime as managed before takeover inspection reruns', () => {
    const source = normalizedEnvCheckSource
    expect(source).toContain('const markInstalledOpenClawAsManagedDuringEnvCheck = async (')
    expect(source).toContain("if (window.api.platform !== 'win32') return")
    expect(source).toContain('await window.api.markManagedOpenClawInstall(activeCandidate.installFingerprint)')

    const postInstallDiscoveryIndex = source.indexOf(
      'shouldInstallOpenClawRuntime ? await discoverOpenClawDuringEnvCheck() : initialDiscovery'
    )
    const managedMarkIndex = source.indexOf(
      'await markInstalledOpenClawAsManagedDuringEnvCheck(finalDiscoveryResult)'
    )
    const finalInspectionIndex = source.indexOf(
      "const finalGateState = await inspectExistingOpenClaw(\n      resolveOpenClawEnvCheckProgress('discovering-existing-install')\n    )"
    )

    expect(postInstallDiscoveryIndex).toBeGreaterThan(-1)
    expect(managedMarkIndex).toBeGreaterThan(postInstallDiscoveryIndex)
    expect(finalInspectionIndex).toBeGreaterThan(managedMarkIndex)
  })

  it('keeps renderer predownload for macOS Node pkg installers', () => {
    expect(
      shouldDownloadNodeInstallerBeforeInstall({
        needNode: true,
        installStrategy: 'installer',
        platform: 'darwin',
        nodeInstallPlan: {
          artifactKind: 'pkg',
        },
      })
    ).toBe(true)

    expect(
      shouldDownloadNodeInstallerBeforeInstall({
        needNode: true,
        installStrategy: 'nvm',
        platform: 'darwin',
        nodeInstallPlan: {
          artifactKind: 'pkg',
        },
      })
    ).toBe(false)
  })

  it('renders Xcode pending issues inline so users can retry recognition from the page', () => {
    expect(shouldRenderStartupIssueInline({ kind: 'xcode-clt-pending' })).toBe(true)
    expect(shouldRenderStartupIssueInline({ kind: 'git-unavailable' })).toBe(false)
    expect(shouldRenderStartupIssueInline(null)).toBe(false)
  })

  it('only offers the manual Node upgrade action when the installed version is below the minimum requirement', () => {
    expect(shouldOfferManualNodeUpgrade('v22.15.0')).toBe(true)
    expect(shouldOfferManualNodeUpgrade('v22.16.0')).toBe(false)
    expect(shouldOfferManualNodeUpgrade('v24.14.0')).toBe(false)
  })

  it('tracks the active takeover failure and clears it once manual backup is acknowledged', () => {
    const summary = {
      detected: true,
      backupRootDirectory: '~/Documents/Qclaw Lite Backups',
      failures: [
        {
          candidateId: 'candidate-1',
          displaySourcePath: '~/.openclaw',
          displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/baseline-manual',
          message: 'backup failed',
        },
      ],
    }

    expect(resolveActiveTakeoverFailure(summary, 'candidate-1')).toMatchObject({
      candidateId: 'candidate-1',
    })

    expect(formatTakeoverFailureManualBackupWarning(summary.failures[0])).toContain(
      '请将 ~/.openclaw 复制到 ~/Documents/Qclaw Lite Backups/baseline-manual'
    )

    expect(clearTakeoverFailure(summary, 'candidate-1')).toMatchObject({
      failures: [],
    })
  })

  it('allows history-only recovery to continue after manual backup bypass is recorded', () => {
    expect(
      canContinueHistoryOnlyRecovery(
        {
          ownershipState: 'external-preexisting',
          baselineBackup: null,
          baselineBackupBypass: {
            installFingerprint: 'fingerprint-1',
            skippedAt: '2026-03-22T10:00:00.000Z',
            reason: 'manual-backup-required',
            sourcePath: '/Users/test/.openclaw',
            displaySourcePath: '~/.openclaw',
            suggestedArchivePath: '/Users/test/Documents/Qclaw Lite Backups/manual-baseline',
            displaySuggestedArchivePath: '~/Documents/Qclaw Lite Backups/manual-baseline',
          },
        },
        {
          ok: true,
          backup: null,
        }
      )
    ).toBe(true)

    expect(
      canContinueHistoryOnlyRecovery(
        {
          ownershipState: 'external-preexisting',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        {
          ok: true,
          backup: null,
        }
      )
    ).toBe(false)
  })

  it('uses the effective backup root for takeover prompts when backup lookup resolves a fallback root', async () => {
    await expect(
      resolveTakeoverBackupRootDirectory(
        { defaultBackupDirectory: '~/Documents/Qclaw Lite Backups' },
        async () => ({ displayRootDirectory: '~/Library/Application Support/Qclaw Lite/Backups' })
      )
    ).resolves.toBe('~/Library/Application Support/Qclaw Lite/Backups')
  })

  it('falls back to the discovery backup directory when backup lookup fails', async () => {
    await expect(
      resolveTakeoverBackupRootDirectory(
        { defaultBackupDirectory: '~/Documents/Qclaw Lite Backups' },
        async () => {
          throw new Error('backup root unavailable')
        }
      )
    ).resolves.toBe('~/Documents/Qclaw Lite Backups')
  })

  it('starts startup plugin repair without blocking env checks', async () => {
    const kickoffStartupPluginRepair = (
      EnvCheckModule as typeof EnvCheckModule & {
        kickoffStartupPluginRepair?: (startRepair?: () => Promise<unknown>) => void
      }
    ).kickoffStartupPluginRepair

    expect(kickoffStartupPluginRepair).toBeTypeOf('function')

    const events: string[] = []
    let resolveRepair: () => void = () => {
      throw new Error('repair resolver not initialized')
    }
    const repairPromise = new Promise<void>((resolve) => {
      resolveRepair = () => {
        events.push('repair-settled')
        resolve()
      }
    })

    kickoffStartupPluginRepair?.(() => {
      events.push('repair-started')
      return repairPromise
    })
    events.push('after-kickoff')

    expect(events).toEqual(['repair-started', 'after-kickoff'])

    resolveRepair()
    await repairPromise
    expect(events).toEqual(['repair-started', 'after-kickoff', 'repair-settled'])
  })

  it('defers plugin repair errors while Node bootstrap is still in progress', () => {
    const pluginRepairResult = {
      ok: false,
      repaired: false,
      summary: 'plugin repair failed because node is unavailable',
    }

    expect(
      formatPluginRepairErrorSummaryForEnvCheck({
        pluginRepairResult,
        nodeStepStatus: 'checking',
      })
    ).toBe('')

    expect(
      formatPluginRepairErrorSummaryForEnvCheck({
        pluginRepairResult,
        nodeStepStatus: 'installing',
      })
    ).toBe('')

    expect(
      formatPluginRepairErrorSummaryForEnvCheck({
        pluginRepairResult,
        nodeStepStatus: 'ok',
      })
    ).toBe('plugin repair failed because node is unavailable')
  })

  it('treats 2026.4.12 as the minimum supported openclaw version after stripping suffixes', () => {
    const isSupportedOpenClawVersion = (
      EnvCheckModule as typeof EnvCheckModule & {
        isSupportedOpenClawVersion?: (version: string) => boolean
      }
    ).isSupportedOpenClawVersion

    expect(isSupportedOpenClawVersion).toBeTypeOf('function')
    expect(isSupportedOpenClawVersion?.('2026.4.12')).toBe(true)
    expect(isSupportedOpenClawVersion?.('2026.4.12-2')).toBe(true)
    expect(isSupportedOpenClawVersion?.('2026.4.10')).toBe(false)
    expect(isSupportedOpenClawVersion?.('2026.4.13')).toBe(false)
    expect(isSupportedOpenClawVersion?.('2026.3.21')).toBe(false)
    expect(isSupportedOpenClawVersion?.('2026.3.25')).toBe(false)
  })

  it('maps the pinned version into a non-blocking passing gate', () => {
    const gateState = buildOpenClawGateState(
      {
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.4.12',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-1',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
      },
      {
        ok: true,
        activeCandidate: {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.4.12',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-1',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        currentVersion: '2026.4.12',
        targetVersion: null,
        latestCheck: null,
        policyState: 'supported_target',
        enforcement: 'none',
        targetAction: 'none',
        blocksContinue: false,
        canSelfHeal: false,
        canAutoUpgrade: false,
        upToDate: true,
        gatewayRunning: false,
        warnings: [],
      }
    )

    expect(gateState.canUpgrade).toBe(false)
    expect(gateState.canAutoCorrect).toBe(false)
    expect(gateState.blocksContinue).toBe(false)
    expect(gateState.statusLabel).toBe('')
  })

  it('maps unsupported high versions into a manual blocker when the source cannot self-heal', () => {
    const gateState = buildOpenClawGateState(
      {
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/opt/tools/openclaw/bin/openclaw',
            resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
            packageRoot: '/opt/tools/openclaw',
            version: '2026.3.25',
            installSource: 'custom',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-1',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
      },
      {
        ok: false,
        activeCandidate: {
          candidateId: 'candidate-1',
          binaryPath: '/opt/tools/openclaw/bin/openclaw',
          resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
          packageRoot: '/opt/tools/openclaw',
          version: '2026.3.25',
          installSource: 'custom',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-1',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        currentVersion: '2026.3.25',
        targetVersion: '2026.4.12',
        latestCheck: null,
        policyState: 'above_max',
        enforcement: 'manual_block',
        targetAction: 'downgrade',
        blocksContinue: true,
        canSelfHeal: false,
        canAutoUpgrade: false,
        upToDate: false,
        gatewayRunning: false,
        warnings: [],
        manualHint: '请在原安装位置手动切换到 2026.4.12',
        errorCode: 'manual_only',
      }
    )

    expect(gateState.canUpgrade).toBe(false)
    expect(gateState.canAutoCorrect).toBe(false)
    expect(gateState.blocksContinue).toBe(true)
    expect(gateState.manualHint).toContain('2026.4.12')
  })

  it('builds a clear consent message before automatic openclaw correction runs', () => {
    const message = buildOpenClawAutoCorrectionConsentMessage({
      activeCandidate: {
        candidateId: 'candidate-1',
        binaryPath: '/usr/local/bin/openclaw',
        resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
        packageRoot: '/usr/local/lib/node_modules/openclaw',
        version: '2026.3.28',
        installSource: 'npm-global',
        isPathActive: true,
        configPath: '/Users/test/.openclaw/openclaw.json',
        stateRoot: '/Users/test/.openclaw',
        displayConfigPath: '~/.openclaw/openclaw.json',
        displayStateRoot: '~/.openclaw',
        ownershipState: 'qclaw-installed',
        installFingerprint: 'fingerprint-1',
        baselineBackup: null,
        baselineBackupBypass: null,
      },
      upgradeCheck: {
        ok: false,
        activeCandidate: null,
        currentVersion: '2026.3.28',
        targetVersion: '2026.4.12',
        latestCheck: null,
        policyState: 'above_max',
        enforcement: 'auto_correct',
        targetAction: 'downgrade',
        blocksContinue: true,
        canSelfHeal: true,
        canAutoUpgrade: true,
        upToDate: false,
        gatewayRunning: false,
        warnings: [],
      },
    })

    expect(message).toContain('当前版本：2026.3.28')
    expect(message).toContain('目标版本：2026.4.12')
    expect(message).toContain('自动回退 OpenClaw')
    expect(message).toContain('Qclaw 将立即退出')
  })

  it('blocks below-min custom installs and requires manual upgrade outside the app', () => {
    const gateState = buildOpenClawGateState(
      {
        status: 'installed',
        candidates: [
          {
            candidateId: 'candidate-1',
            binaryPath: '/opt/tools/openclaw/bin/openclaw',
            resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
            packageRoot: '/opt/tools/openclaw',
            version: '2026.4.10',
            installSource: 'custom',
            isPathActive: true,
            configPath: '/Users/test/.openclaw/openclaw.json',
            stateRoot: '/Users/test/.openclaw',
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-1',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        activeCandidateId: 'candidate-1',
        hasMultipleCandidates: false,
        historyDataCandidates: [],
        errors: [],
        warnings: [],
        defaultBackupDirectory: '~/Documents/Qclaw Lite Backups',
      },
      {
        ok: false,
        activeCandidate: {
          candidateId: 'candidate-1',
          binaryPath: '/opt/tools/openclaw/bin/openclaw',
          resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
          packageRoot: '/opt/tools/openclaw',
          version: '2026.4.10',
          installSource: 'custom',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-1',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        currentVersion: '2026.4.10',
        targetVersion: '2026.4.12',
        latestCheck: null,
        policyState: 'below_min',
        enforcement: 'manual_block',
        targetAction: 'upgrade',
        blocksContinue: true,
        canSelfHeal: false,
        canAutoUpgrade: false,
        upToDate: false,
        gatewayRunning: false,
        warnings: [],
        manualHint: '请在原安装位置手动切换到 2026.4.12',
        errorCode: 'manual_only',
      }
    )

    expect(gateState.canUpgrade).toBe(false)
    expect(gateState.canAutoCorrect).toBe(false)
    expect(gateState.blocksContinue).toBe(true)
    expect(gateState.manualHint).toContain('2026.4.12')
  })

  it('shows manual openclaw hints for blocking external installs while suppressing qclaw-owned runtimes', () => {
    expect(
      shouldShowOpenClawManualHint(
        {
          activeCandidate: {
            installSource: 'custom',
          } as any,
          blocksContinue: true,
          canAutoCorrect: false,
          manualHint: '请手动切换版本',
        },
        false
      )
    ).toBe(true)

    expect(
      shouldShowOpenClawManualHint(
        {
          activeCandidate: {
            installSource: 'homebrew',
          } as any,
          blocksContinue: true,
          canAutoCorrect: false,
          manualHint: '请在 Homebrew 环境中手动切换版本',
        },
        false
      )
    ).toBe(true)

    expect(
      shouldShowOpenClawManualHint(
        {
          activeCandidate: {
            installSource: 'custom',
          } as any,
          blocksContinue: false,
          canAutoCorrect: false,
          manualHint: '请手动切换版本',
        },
        false
      )
    ).toBe(false)

    expect(
      shouldShowOpenClawManualHint(
        {
          activeCandidate: {
            installSource: 'qclaw-managed',
          } as any,
          blocksContinue: true,
          canAutoCorrect: false,
          manualHint: '请手动切换版本',
        },
        false
      )
    ).toBe(false)
  })

  it('hides the openclaw action button when takeover backup is still blocking auto-correction', () => {
    expect(
      canShowOpenClawUpgradeAction(
        {
          canUpgrade: false,
          canAutoCorrect: true,
        },
        true
      )
    ).toBe(false)

    expect(
      canShowOpenClawUpgradeAction(
        {
          canUpgrade: true,
          canAutoCorrect: false,
        },
        false
      )
    ).toBe(true)
  })

  it('keeps the continue button disabled for openclaw blockers and for takeover backup blockers', () => {
    expect(
      canContinueWithOpenClawGate(
        {
          blocksContinue: true,
        },
        false
      )
    ).toBe(false)

    expect(
      canContinueWithOpenClawGate(
        {
          blocksContinue: false,
        },
        false
      )
    ).toBe(true)

    expect(
      canContinueWithOpenClawGate(
        null,
        false
      )
    ).toBe(false)

    expect(
      canContinueWithOpenClawGate(
        {
          blocksContinue: true,
        },
        true
      )
    ).toBe(false)
  })
})
