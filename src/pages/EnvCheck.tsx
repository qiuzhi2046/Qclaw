import { useState, useEffect } from 'react'
import { ActionIcon, Alert, Button, Loader, Modal, Text, Title, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconRefresh } from '@tabler/icons-react'
import { ENV_CHECK_UI_POLICY, getEnvCheckSupportActionsForIssueKind, type EnvCheckSupportAction } from '../shared/env-check-policy'
import {
  classifyMacGitToolsIssue,
  classifyMacNodeInstallerFailure,
  classifyNodeInstallerDownloadFailure,
  createNodeInstallerIssue,
  type NodeInstallerIssue,
  type NodeInstallerIssueKind,
} from '../shared/node-installer-issues'
import { UI_RUNTIME_DEFAULTS } from '../shared/runtime-policies'
import {
  applyBaselineBackupBypassToDiscovery,
  buildManualBackupWarning,
  compareLooseVersions,
  hasInitializedOpenClawConfig,
  isQclawOwnedOpenClawSource,
  resolveOpenClawInstallDecision,
  shouldEnsureBaselineBackup,
  type OpenClawBaselineBackupEnsureResult,
  type OpenClawDiscoveryResult,
  type OpenClawInstallCandidate,
  type OpenClawLatestVersionCheckResult,
  type WindowsGatewayOwnerState,
  type EnvCheckReadyPayload,
} from '../shared/openclaw-phase1'
import type { OpenClawUpgradeCheckResult } from '../shared/openclaw-phase4'
import type { OpenClawBackupRootInfo } from '../shared/openclaw-phase3'
import {
  MAX_SUPPORTED_OPENCLAW_VERSION,
  MIN_SUPPORTED_OPENCLAW_VERSION,
  PINNED_OPENCLAW_VERSION,
} from '../shared/openclaw-version-policy'
import logoSrc from '@/assets/logo.png'
import tooltips from '@/constants/tooltips.json'

const MIN_NODE_VERSION = '22.16.0'
const MAX_OPENCLAW_LATEST_CHECK_ATTEMPTS = 3
const ENV_CHECK_TOOLTIPS = tooltips.envCheck
const ENV_CHECK_STEP_TOOLTIPS: Record<string, string> = {
  node: ENV_CHECK_TOOLTIPS.nodeRuntime,
  openclaw: ENV_CHECK_TOOLTIPS.openClawCli,
  gateway: ENV_CHECK_TOOLTIPS.gatewayService,
}

function parseNodeVersion(version: string) {
  const match = String(version || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  }
}

function compareNodeVersions(left: string, right: string): number {
  const leftParsed = parseNodeVersion(left)
  const rightParsed = parseNodeVersion(right)
  if (!leftParsed || !rightParsed) return 0
  if (leftParsed.major !== rightParsed.major) return leftParsed.major - rightParsed.major
  if (leftParsed.minor !== rightParsed.minor) return leftParsed.minor - rightParsed.minor
  return leftParsed.patch - rightParsed.patch
}

function isNodeVersionAtLeast(version: string, minimumVersion: string): boolean {
  return compareNodeVersions(version, minimumVersion) >= 0
}

export function shouldOfferManualNodeUpgrade(version: string, minimumVersion: string = MIN_NODE_VERSION): boolean {
  return Boolean(String(version || '').trim()) && !isNodeVersionAtLeast(version, minimumVersion)
}

function resolveActiveOpenClawCandidate(
  discovery: OpenClawDiscoveryResult | null | undefined
): OpenClawInstallCandidate | null {
  if (!discovery) return null
  return discovery.candidates.find((candidate) => candidate.candidateId === discovery.activeCandidateId) || null
}

function applyBaselineBackupToCandidate(
  discovery: OpenClawDiscoveryResult,
  candidateId: string,
  backup: NonNullable<OpenClawInstallCandidate['baselineBackup']>
): OpenClawDiscoveryResult {
  return {
    ...discovery,
    candidates: discovery.candidates.map((candidate) =>
      candidate.candidateId === candidateId
        ? { ...candidate, baselineBackup: backup, baselineBackupBypass: null }
        : candidate
    ),
  }
}

function buildTakeoverFailure(
  candidate: OpenClawInstallCandidate,
  message?: string,
  manualBackupAction?: {
    displaySourcePath?: string
    displaySuggestedArchivePath?: string
  }
): OpenClawTakeoverFailure {
  return {
    candidateId: candidate.candidateId,
    displaySourcePath:
      String(manualBackupAction?.displaySourcePath || '').trim() ||
      String(candidate.displayStateRoot || '').trim() ||
      String(candidate.stateRoot || '').trim() ||
      '未知目录',
    displaySuggestedArchivePath: String(manualBackupAction?.displaySuggestedArchivePath || '').trim(),
    message: String(message || '').trim() || '自动备份失败，请稍后重试。',
  }
}

function shouldShowTakeoverNotice(candidate: OpenClawInstallCandidate): boolean {
  return candidate.ownershipState !== 'qclaw-installed'
}

interface OpenClawLatestRetryResult {
  result: OpenClawLatestVersionCheckResult
  attempts: number
}

interface RetryOpenClawLatestVersionCheckOptions {
  maxAttempts?: number
  delayMs?: number
  onAttemptStart?: (attempt: number) => void | Promise<void>
  onAttemptFailure?: (
    attempt: number,
    result: OpenClawLatestVersionCheckResult
  ) => void | Promise<void>
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function resolveEnvInstallProgressStep(options: {
  needNode: boolean
  shouldInstallOpenClawRuntime: boolean
}): 'node' | 'openclaw' | null {
  if (options.needNode) return 'node'
  if (options.shouldInstallOpenClawRuntime) return 'openclaw'
  return null
}

export function shouldRenderStartupIssueInline(
  issue: Pick<NodeInstallerIssue, 'kind'> | null | undefined
): boolean {
  return issue?.kind === 'xcode-clt-pending'
}

export async function retryOpenClawLatestVersionCheck(
  checkLatestVersion: () => Promise<OpenClawLatestVersionCheckResult>,
  options: RetryOpenClawLatestVersionCheckOptions = {}
): Promise<OpenClawLatestRetryResult> {
  const maxAttempts = Math.max(1, options.maxAttempts || MAX_OPENCLAW_LATEST_CHECK_ATTEMPTS)
  const delayMs = Math.max(0, options.delayMs || 0)

  let lastResult: OpenClawLatestVersionCheckResult = {
    ok: false,
    latestVersion: '',
    checkedAt: '',
    source: 'npm-registry',
    error: '最新版本检查未执行',
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await options.onAttemptStart?.(attempt)
    lastResult = await checkLatestVersion()
    if (lastResult.ok) {
      return { result: lastResult, attempts: attempt }
    }
    if (attempt < maxAttempts) {
      await options.onAttemptFailure?.(attempt, lastResult)
      if (delayMs > 0) {
        await wait(delayMs)
      }
    }
  }

  return { result: lastResult, attempts: maxAttempts }
}

type StepStatus = 'pending' | 'checking' | 'ok' | 'installing' | 'pending-install' | 'error' | 'canceled'

type NodeInstallStrategy = 'nvm' | 'installer'

export function shouldDownloadNodeInstallerBeforeInstall(options: {
  needNode: boolean
  installStrategy: NodeInstallStrategy
  platform: string
  nodeInstallPlan?: { artifactKind?: 'pkg' | 'zip' } | null
}): boolean {
  if (!options.needNode) return false
  if (options.installStrategy === 'nvm') return false
  if (options.platform === 'win32' && options.nodeInstallPlan?.artifactKind === 'zip') return false
  return true
}

export function shouldBootstrapNodeBeforeOpenClawCheck(options: {
  needNode: boolean
  installStrategy: NodeInstallStrategy
  platform: string
  nodeInstallPlan?: { artifactKind?: 'pkg' | 'zip' } | null
}): boolean {
  return (
    options.needNode &&
    options.installStrategy === 'installer' &&
    options.platform === 'win32' &&
    options.nodeInstallPlan?.artifactKind === 'zip'
  )
}

interface Step {
  id: string
  label: string
  description: string
  status: StepStatus
  version?: string
  error?: string
  progress?: number
}

interface FatalIssueState {
  message: string
  issueKind?: NodeInstallerIssueKind
}

interface EnvCheckRestartState {
  runAttempt: number
  steps: Step[]
  currentStep: number
  progress: number
  tipIndex: number
  fatalIssue: FatalIssueState | null
  startupIssuePrompt: NodeInstallerIssue | null
}

interface OpenClawVersionGateState {
  discovery: OpenClawDiscoveryResult | null
  activeCandidate: OpenClawInstallCandidate | null
  upgradeCheck: OpenClawUpgradeCheckResult | null
  canUpgrade: boolean
  canAutoCorrect: boolean
  blocksContinue: boolean
  statusLabel: string
  message: string
  manualHint?: string
}

export interface OpenClawTakeoverSummary {
  detected: boolean
  backupRootDirectory: string
  failures: OpenClawTakeoverFailure[]
}

type PluginRepairResult = Awaited<ReturnType<typeof window.api.repairIncompatiblePlugins>>

export function formatPluginRepairErrorSummaryForEnvCheck(options: {
  pluginRepairResult?: { ok?: boolean; summary?: string } | null
  nodeStepStatus?: StepStatus
}): string {
  if (
    options.nodeStepStatus === 'checking' ||
    options.nodeStepStatus === 'installing' ||
    options.nodeStepStatus === 'pending-install'
  ) {
    return ''
  }

  return options.pluginRepairResult && !options.pluginRepairResult.ok
    ? String(options.pluginRepairResult.summary || '').trim()
    : ''
}

export function kickoffStartupPluginRepair(
  startRepair?: () => Promise<PluginRepairResult | null>
): void {
  if (!startRepair) return

  // Startup plugin repair is best-effort and should not block the first env check render/update.
  void startRepair().catch(() => null)
}

export interface OpenClawTakeoverFailure {
  candidateId: string
  displaySourcePath: string
  displaySuggestedArchivePath: string
  message: string
}

export function resolveActiveTakeoverFailure(
  takeoverSummary: OpenClawTakeoverSummary | null | undefined,
  candidateId: string
): OpenClawTakeoverFailure | null {
  const normalizedCandidateId = String(candidateId || '').trim()
  if (!takeoverSummary || !normalizedCandidateId) return null
  return takeoverSummary.failures.find((item) => item.candidateId === normalizedCandidateId) || null
}

export function clearTakeoverFailure(
  takeoverSummary: OpenClawTakeoverSummary | null | undefined,
  candidateId: string
): OpenClawTakeoverSummary | null {
  if (!takeoverSummary) return null
  return {
    ...takeoverSummary,
    failures: takeoverSummary.failures.filter((item) => item.candidateId !== candidateId),
  }
}

export function formatTakeoverFailureManualBackupWarning(
  failure: Pick<OpenClawTakeoverFailure, 'displaySourcePath' | 'displaySuggestedArchivePath'> | null | undefined
): string {
  if (!failure) return '自动备份失败，请手动备份。'
  return buildManualBackupWarning({
    sourcePath: failure.displaySourcePath,
    displaySourcePath: failure.displaySourcePath,
    suggestedArchivePath: failure.displaySuggestedArchivePath,
    displaySuggestedArchivePath: failure.displaySuggestedArchivePath,
  })
}

interface HistoryOnlyRecoveryFailureState {
  candidate: OpenClawInstallCandidate
  failure: OpenClawTakeoverFailure
}

interface HistoryOnlyRecoveryResult {
  discovery: OpenClawDiscoveryResult
  activeCandidate: OpenClawInstallCandidate
}

export function canContinueHistoryOnlyRecovery(
  candidate:
    | Pick<OpenClawInstallCandidate, 'ownershipState' | 'baselineBackup' | 'baselineBackupBypass'>
    | null
    | undefined,
  backupResult:
    | Pick<OpenClawBaselineBackupEnsureResult, 'ok' | 'backup'>
    | null
    | undefined
): boolean {
  if (!candidate || !backupResult?.ok) return false
  if (backupResult.backup || candidate.baselineBackup || candidate.baselineBackupBypass) return true
  return !(
    candidate.ownershipState === 'external-preexisting' ||
    candidate.ownershipState === 'unknown-external'
  )
}

export function isSupportedOpenClawVersion(
  version: string,
  minimumVersion: string = MIN_SUPPORTED_OPENCLAW_VERSION,
  maximumVersion: string = MAX_SUPPORTED_OPENCLAW_VERSION
): boolean {
  const normalizedVersion = String(version || '').trim()
  if (!normalizedVersion) return false
  return (
    compareLooseVersions(normalizedVersion, minimumVersion) >= 0 &&
    compareLooseVersions(normalizedVersion, maximumVersion) <= 0
  )
}

export function buildOpenClawGateState(
  discovery: OpenClawDiscoveryResult | null,
  upgradeCheck: OpenClawUpgradeCheckResult | null
): OpenClawVersionGateState {
  const activeCandidate = resolveActiveOpenClawCandidate(discovery)
  if (!activeCandidate || !upgradeCheck) {
    return {
      discovery,
      activeCandidate: activeCandidate || null,
      upgradeCheck,
      canUpgrade: false,
      canAutoCorrect: false,
      blocksContinue: false,
      statusLabel: '',
      message: '',
    }
  }

  const needsTakeoverNotice = shouldShowTakeoverNotice(activeCandidate)
  const withTakeoverSuffix = (message: string): string =>
    needsTakeoverNotice ? `${message} 原配置数据不会被覆盖，并会额外备份后继续使用。` : message

  switch (upgradeCheck.enforcement) {
    case 'optional_upgrade':
      return {
        discovery,
        activeCandidate,
        upgradeCheck,
        canUpgrade: true,
        canAutoCorrect: false,
        blocksContinue: false,
        statusLabel: `可升级到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
        message: withTakeoverSuffix(
          `当前版本受支持，可按需升级到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`
        ),
      }
    case 'auto_correct':
      return {
        discovery,
        activeCandidate,
        upgradeCheck,
        canUpgrade: false,
        canAutoCorrect: true,
        blocksContinue: true,
        statusLabel:
          upgradeCheck.targetAction === 'downgrade'
            ? `需回退到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`
            : `需升级到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
        message:
          upgradeCheck.targetAction === 'downgrade'
            ? `检测到超出支持范围的 OpenClaw 版本，正在自动回退到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`
            : `检测到不受支持的 OpenClaw 版本，正在自动升级到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
      }
    case 'manual_block':
      if (!upgradeCheck.blocksContinue) {
        return {
          discovery,
          activeCandidate,
          upgradeCheck,
          canUpgrade: false,
          canAutoCorrect: false,
          blocksContinue: false,
          statusLabel: `如需升级请手动切换到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
          message:
            upgradeCheck.manualHint ||
            `当前版本受支持，可继续使用；如需升级到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}，请在原安装环境中手动处理。`,
          manualHint: upgradeCheck.manualHint,
        }
      }
      return {
        discovery,
        activeCandidate,
        upgradeCheck,
        canUpgrade: false,
        canAutoCorrect: false,
        blocksContinue: true,
        statusLabel: `需手动调整到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
        message:
          upgradeCheck.manualHint ||
          `当前 OpenClaw 版本不在支持范围内，且当前安装来源暂不支持程序内自动修复，请先手动调整到 ${upgradeCheck.targetVersion || PINNED_OPENCLAW_VERSION}`,
        manualHint: upgradeCheck.manualHint,
      }
    case 'none':
    default:
      return {
        discovery,
        activeCandidate,
        upgradeCheck,
        canUpgrade: false,
        canAutoCorrect: false,
        blocksContinue: false,
        statusLabel: '',
        message: withTakeoverSuffix('当前 OpenClaw 已是受支持上限版本'),
      }
  }
}

export function buildOpenClawAutoCorrectionConsentMessage(
  gateState:
    | Pick<OpenClawVersionGateState, 'activeCandidate' | 'upgradeCheck'>
    | null
    | undefined
): string {
  const currentVersion =
    String(gateState?.upgradeCheck?.currentVersion || '').trim() ||
    String(gateState?.activeCandidate?.version || '').trim() ||
    '未知版本'
  const targetVersion =
    String(gateState?.upgradeCheck?.targetVersion || '').trim() || PINNED_OPENCLAW_VERSION
  const action = gateState?.upgradeCheck?.targetAction === 'downgrade' ? '回退' : '升级'

  return [
    '检测到当前 OpenClaw 版本不在 Qclaw 的支持范围内。',
    `当前版本：${currentVersion}`,
    `目标版本：${targetVersion}`,
    `Qclaw 将自动${action} OpenClaw 到受支持版本后再继续。`,
    '如果你不接受本次自动处理，Qclaw 将立即退出。',
    '',
    '是否继续？',
  ].join('\n')
}

export function canContinueWithOpenClawGate(
  gateState: Pick<OpenClawVersionGateState, 'blocksContinue'> | null | undefined,
  activeTakeoverBackupBlocked: boolean
): boolean {
  if (activeTakeoverBackupBlocked) return false
  if (!gateState) return false
  return !gateState.blocksContinue
}

export function canShowOpenClawUpgradeAction(
  gateState: Pick<OpenClawVersionGateState, 'canUpgrade' | 'canAutoCorrect'> | null | undefined,
  activeTakeoverBackupBlocked: boolean
): boolean {
  return Boolean(gateState && !activeTakeoverBackupBlocked && (gateState.canUpgrade || gateState.canAutoCorrect))
}

export async function resolveTakeoverBackupRootDirectory(
  discovery: Pick<OpenClawDiscoveryResult, 'defaultBackupDirectory'> | null | undefined,
  getBackupRoot: () => Promise<Pick<OpenClawBackupRootInfo, 'displayRootDirectory'> | null | undefined>
): Promise<string> {
  const fallbackDirectory = String(discovery?.defaultBackupDirectory || '').trim()
  if (!fallbackDirectory) return ''

  try {
    const backupRoot = await getBackupRoot()
    const displayRootDirectory = String(backupRoot?.displayRootDirectory || '').trim()
    return displayRootDirectory || fallbackDirectory
  } catch {
    return fallbackDirectory
  }
}

function formatCancelDomainSummary(domains: string[]): string {
  if (!domains.length) return '无'
  return domains.join('、')
}

const INITIAL_STEPS: Step[] = [
  { id: 'node', label: 'Node.js', description: '检查 Node.js 是否已安装', status: 'pending' },
  { id: 'openclaw', label: 'OpenClaw 命令行工具', description: '检查或安装命令行工具', status: 'pending' },
  { id: 'gateway', label: '网关服务', description: '记录后续网关可用性确认时机', status: 'pending' },
]

function createInitialSteps(): Step[] {
  return INITIAL_STEPS.map((step) => ({ ...step }))
}

function resolveDeferredGatewayOwnerWarning(ownerState?: WindowsGatewayOwnerState | null): string | null {
  switch (ownerState) {
    case 'service-missing':
      return '已发现 Windows 网关后台启动器缺失，当前阶段不会自动安装。'
    case 'launcher-missing':
      return '已发现 Windows 网关后台启动器损坏或丢失，当前阶段不会自动安装。'
    default:
      return null
  }
}

type OpenClawEnvCheckPhase =
  | 'manual-refresh'
  | 'discovering-existing-install'
  | 'takeover-backup'
  | 'auto-correcting'
  | 'manual-upgrade'
  | 'history-recovery-discovery'
  | 'history-recovery-backup'
  | 'refreshing-environment'
  | 'verifying-install'
  | 'installed-recheck-complete'

function resolveOpenClawEnvCheckProgress(phase: OpenClawEnvCheckPhase): number {
  switch (phase) {
    case 'manual-refresh':
      return 96
    case 'discovering-existing-install':
      return 97
    case 'takeover-backup':
      return 98
    case 'auto-correcting':
      return 99
    case 'manual-upgrade':
      return 94
    case 'history-recovery-discovery':
      return 95
    case 'history-recovery-backup':
      return 97
    case 'refreshing-environment':
      return 86
    case 'verifying-install':
      return 90
    case 'installed-recheck-complete':
      return 94
    default:
      return 95
  }
}

export function shouldShowOpenClawManualHint(
  gateState:
    | Pick<OpenClawVersionGateState, 'activeCandidate' | 'blocksContinue' | 'canAutoCorrect' | 'manualHint'>
    | null
    | undefined,
  activeTakeoverBackupBlocked: boolean
): boolean {
  if (activeTakeoverBackupBlocked) return false
  if (!gateState?.manualHint || !gateState.blocksContinue || gateState.canAutoCorrect) return false
  return !isQclawOwnedOpenClawSource(gateState.activeCandidate?.installSource)
}

export function buildDeferredGatewayStepState(
  ownerState?: WindowsGatewayOwnerState | null
): Pick<Step, 'status' | 'version' | 'description' | 'progress'> {
  const ownerWarning = resolveDeferredGatewayOwnerWarning(ownerState)
  return {
    status: 'ok',
    version: '后续确认',
    description:
      ownerWarning
        ? `${ownerWarning} 后续在真正需要网关时会由生命周期统一修复。`
        : '认证和渠道配置完成后再确认网关可用性',
    progress: 100,
  }
}

export function createEnvCheckRestartState(currentRunAttempt: number): EnvCheckRestartState {
  return {
    runAttempt: currentRunAttempt + 1,
    steps: createInitialSteps(),
    currentStep: 0,
    progress: 0,
    tipIndex: 0,
    fatalIssue: null,
    startupIssuePrompt: null,
  }
}

function TakeoverNotification({
  backupRootDirectory,
  failures,
  retryingCandidateId,
  onRetry,
}: {
  backupRootDirectory: string
  failures: OpenClawTakeoverFailure[]
  retryingCandidateId: string | null
  onRetry: (candidateId: string) => void
}) {
  useEffect(() => {
    const id = 'takeover-notice'
    notifications.show({
      id,
      title: '检测到已有 OpenClaw',
      message: `Qclaw 将额外备份配置数据，继续使用原有 OpenClaw。备份目录：${backupRootDirectory}`,
      color: 'brand',
      autoClose: 8000,
    })
    return () => { notifications.hide(id) }
  }, [backupRootDirectory])

  useEffect(() => {
    for (const failure of failures) {
      notifications.show({
        id: `takeover-fail-${failure.candidateId}`,
        title: '自动备份失败',
        message: formatTakeoverFailureManualBackupWarning(failure),
        color: 'red',
        autoClose: false,
      })
    }
  }, [failures])

  return null
}

function StartupIssueDialog({
  issue,
  supportActions,
  onClose,
  onRestart,
}: {
  issue: NodeInstallerIssue
  supportActions: EnvCheckSupportAction[]
  onClose: () => void
  onRestart: () => void
}) {
  const restartLabel = issue.kind === 'xcode-clt-pending' ? '重试识别' : '继续安装'
  const restartColor = issue.kind === 'xcode-clt-pending' ? 'brand' : 'red'
  const showXcodeInstallHint = issue.kind === 'xcode-clt-pending'

  return (
    <Modal
      opened
      onClose={onClose}
      title={issue.title}
      size="md"
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <div className="space-y-4">
        <Text size="sm">{issue.message}</Text>
        {showXcodeInstallHint && (
          <div
            className="rounded-lg p-4"
            style={{
              backgroundColor: 'var(--app-bg-inset)',
              border: '1px solid var(--app-border)',
            }}
          >
            <div className="flex items-end justify-center gap-6">
              <div className="flex flex-col items-center gap-2">
                <div
                  className="h-20 w-20 rounded-3xl flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(180deg, #d9d9db 0%, #c5c5c7 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
                  }}
                >
                  <img src={logoSrc} alt="Qclaw" className="h-11 w-11 object-contain" />
                </div>
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--app-text-primary)' }} />
              </div>
              <div className="flex flex-col items-center gap-2">
                <div
                  className="relative h-20 w-20 rounded-3xl flex items-center justify-center"
                  style={{
                    background:
                      'linear-gradient(180deg, rgba(73,210,255,0.95) 0%, rgba(42,145,255,0.95) 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)',
                  }}
                >
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 4V14.5"
                      stroke="#f5fbff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M7.5 11.5L12 16L16.5 11.5"
                      stroke="#f5fbff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M6 19.5H18"
                      stroke="#f5fbff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--app-text-primary)' }} />
              </div>
            </div>
          </div>
        )}
        {!showXcodeInstallHint && issue.details && (
          <div
            className="rounded-lg p-3 text-xs whitespace-pre-wrap"
            style={{
              backgroundColor: 'var(--app-bg-inset)',
              border: '1px solid var(--app-border)',
              color: 'var(--app-text-secondary)',
            }}
          >
            {issue.details}
          </div>
        )}
        <div className="flex flex-wrap gap-2 justify-end">
          {supportActions.map((action) => (
            <Button
              key={`${action.kind}:${action.href}`}
              component="a"
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              color="brand"
            >
              {action.label}
            </Button>
          ))}
          <Button variant="default" onClick={onClose}>
            我知道了
          </Button>
          <Button color={restartColor} onClick={onRestart}>
            {restartLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default function EnvCheck({
  onReady,
  pluginRepairRunning = false,
  pluginRepairResult = null,
  onRepairPlugins,
  onEnsurePluginRepairReady,
}: {
  onReady: (payload: EnvCheckReadyPayload) => void
  pluginRepairRunning?: boolean
  pluginRepairResult?: PluginRepairResult | null
  onRepairPlugins?: () => Promise<PluginRepairResult | null>
  onEnsurePluginRepairReady?: () => Promise<PluginRepairResult | null>
}) {
  const envCheckTiming = UI_RUNTIME_DEFAULTS.envCheck
  const loadingTips = ENV_CHECK_UI_POLICY.loadingTips
  const [steps, setSteps] = useState<Step[]>(() => createInitialSteps())
  const [currentStep, setCurrentStep] = useState(0)
  const [fatalIssue, setFatalIssue] = useState<FatalIssueState | null>(null)
  const [tipIndex, setTipIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [runAttempt, setRunAttempt] = useState(0)
  const [startupIssuePrompt, setStartupIssuePrompt] = useState<NodeInstallerIssue | null>(null)
  const [latestNodeVersion, setLatestNodeVersion] = useState('')
  const [nodeRequiredVersion, setNodeRequiredVersion] = useState(MIN_NODE_VERSION)
  const [nodeInstallStrategy, setNodeInstallStrategy] = useState<NodeInstallStrategy>('installer')
  const [openClawGateState, setOpenClawGateState] = useState<OpenClawVersionGateState | null>(null)
  const [isRefreshingOpenClawVersion, setIsRefreshingOpenClawVersion] = useState(false)
  const [isUpgradingOpenClaw, setIsUpgradingOpenClaw] = useState(false)
  const [openClawUpgradeError, setOpenClawUpgradeError] = useState('')
  const [readyPayload, setReadyPayload] = useState<EnvCheckReadyPayload | null>(null)
  const [takeoverSummary, setTakeoverSummary] = useState<OpenClawTakeoverSummary | null>(null)
  const [retryingTakeoverCandidateId, setRetryingTakeoverCandidateId] = useState<string | null>(null)
  const [acknowledgingManualBackup, setAcknowledgingManualBackup] = useState(false)
  const [historyOnlyRecoveryFailure, setHistoryOnlyRecoveryFailure] =
    useState<HistoryOnlyRecoveryFailureState | null>(null)
  const [historyOnlyRecoveryConfirmOpened, setHistoryOnlyRecoveryConfirmOpened] = useState(false)

  const updateStep = (id: string, update: Partial<Step>) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...update } : s))
  }

  const activeTakeoverFailureCandidateId = openClawGateState?.activeCandidate?.candidateId || ''
  const activeTakeoverFailure = resolveActiveTakeoverFailure(
    takeoverSummary,
    activeTakeoverFailureCandidateId
  )
  const activeTakeoverBackupBlocked = Boolean(activeTakeoverFailure)
  const nodeStepStatus = steps.find((step) => step.id === 'node')?.status
  const pluginRepairErrorSummary = formatPluginRepairErrorSummaryForEnvCheck({
    pluginRepairResult,
    nodeStepStatus,
  })
  const [pluginRepairNoticeVisible, setPluginRepairNoticeVisible] = useState(Boolean(pluginRepairResult?.repaired))
  const [pluginRepairErrorVisible, setPluginRepairErrorVisible] = useState(Boolean(pluginRepairErrorSummary))

  useEffect(() => {
    setPluginRepairNoticeVisible(Boolean(pluginRepairResult?.repaired))
    setPluginRepairErrorVisible(Boolean(pluginRepairErrorSummary))
  }, [pluginRepairResult, pluginRepairErrorSummary])

  const resetEnvCheck = (nextRunAttempt = runAttempt) => {
    const restartState = createEnvCheckRestartState(nextRunAttempt)
    setFatalIssue(restartState.fatalIssue)
    setStartupIssuePrompt(restartState.startupIssuePrompt)
    setSteps(restartState.steps)
    setCurrentStep(restartState.currentStep)
    setProgress(restartState.progress)
    setTipIndex(restartState.tipIndex)
    setLatestNodeVersion('')
    setNodeRequiredVersion(MIN_NODE_VERSION)
    setNodeInstallStrategy('installer')
    setOpenClawGateState(null)
    setIsRefreshingOpenClawVersion(false)
    setIsUpgradingOpenClaw(false)
    setOpenClawUpgradeError('')
    setReadyPayload(null)
    setTakeoverSummary(null)
    setRetryingTakeoverCandidateId(null)
    setAcknowledgingManualBackup(false)
    setHistoryOnlyRecoveryFailure(null)
    setHistoryOnlyRecoveryConfirmOpened(false)
    setRunAttempt(restartState.runAttempt)
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex(prev => (prev + 1) % loadingTips.length)
    }, envCheckTiming.loadingTipRotateMs)
    return () => clearInterval(timer)
  }, [envCheckTiming.loadingTipRotateMs, loadingTips.length])

  useEffect(() => {
    const targetProgress = ((currentStep + 1) / steps.length) * 100
    const timer = setInterval(() => {
      setProgress(prev => {
        if (prev >= targetProgress) return prev
        return Math.min(prev + envCheckTiming.progressStep, targetProgress)
      })
    }, envCheckTiming.progressTickMs)
    return () => clearInterval(timer)
  }, [currentStep, envCheckTiming.progressStep, envCheckTiming.progressTickMs, steps.length])

  useEffect(() => {
    // 使用 setTimeout(..., 0) 延迟启动，防止 StrictMode 双重执行
    // 第一次假挂载会在卸载前被清理掉，只有真实挂载会执行
    const timeoutId = setTimeout(() => {
      void appendEnvCheckDiag('renderer-run-checks-scheduled', {
        startupDelayMs: envCheckTiming.startupDelayMs,
        runAttempt,
      })
      void runChecks()
    }, envCheckTiming.startupDelayMs)
    return () => clearTimeout(timeoutId)
  }, [envCheckTiming.startupDelayMs, runAttempt])

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  const discoverOpenClawDuringEnvCheck = async () => {
    return window.api.discoverOpenClawForEnvCheck().catch(() => null)
  }

  const appendEnvCheckDiag = async (
    event: string,
    fields: Record<string, unknown> = {}
  ) => {
    await window.api.appendEnvCheckDiagnostic(event, fields).catch(() => undefined)
  }

  const markInstalledOpenClawAsManagedDuringEnvCheck = async (
    discovery: OpenClawDiscoveryResult | null | undefined
  ) => {
    if (window.api.platform !== 'win32') return
    const activeCandidate = resolveActiveOpenClawCandidate(discovery)
    if (!activeCandidate?.installFingerprint) {
      await window.api.appendEnvCheckDiagnostic('renderer-managed-mark-skipped', {
        reason: 'missing-active-candidate',
      }).catch(() => undefined)
      return
    }
    await window.api.appendEnvCheckDiagnostic('renderer-managed-mark-requested', {
      candidateId: activeCandidate.candidateId,
      installFingerprint: activeCandidate.installFingerprint,
      ownershipState: activeCandidate.ownershipState,
    }).catch(() => undefined)
    const marked = await window.api.markManagedOpenClawInstall(activeCandidate.installFingerprint).catch((error) => {
      void window.api.appendEnvCheckDiagnostic('renderer-managed-mark-failed', {
        candidateId: activeCandidate.candidateId,
        installFingerprint: activeCandidate.installFingerprint,
        error: error instanceof Error ? error.message : String(error || 'unknown'),
      }).catch(() => undefined)
      return false
    })
    await window.api.appendEnvCheckDiagnostic('renderer-managed-mark-result', {
      candidateId: activeCandidate.candidateId,
      installFingerprint: activeCandidate.installFingerprint,
      marked,
    }).catch(() => undefined)
  }

  const showStartupIssue = (issue: NodeInstallerIssue) => {
    setStartupIssuePrompt(issue)
  }

  const closeStartupIssue = () => {
    setStartupIssuePrompt(null)
  }

  const showFatalIssue = (issue: Pick<NodeInstallerIssue, 'kind' | 'message'>) => {
    setFatalIssue({ message: issue.message, issueKind: issue.kind })
  }

  const showFatalMessage = (message: string, issueKind?: NodeInstallerIssueKind) => {
    setFatalIssue({ message, issueKind })
  }

  const handleRestartEnvCheck = () => {
    closeStartupIssue()
    resetEnvCheck(runAttempt)
  }

  const inspectExistingOpenClaw = async (
    progress: number,
    options: { manualRefresh?: boolean } = {}
  ): Promise<OpenClawVersionGateState | null> => {
    const currentProgress = options.manualRefresh
      ? resolveOpenClawEnvCheckProgress('manual-refresh')
      : progress
    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-start', {
      progress: currentProgress,
      manualRefresh: Boolean(options.manualRefresh),
    })
    setIsRefreshingOpenClawVersion(true)
    setOpenClawUpgradeError('')
    updateStep('openclaw', {
      status: 'checking',
      description: options.manualRefresh ? '正在刷新 OpenClaw 版本与运行时状态...' : '正在识别已有 OpenClaw 安装...',
      progress: currentProgress,
    })

    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-discover-requested', {
      progress: currentProgress,
      manualRefresh: Boolean(options.manualRefresh),
    })
    const discovery = await discoverOpenClawDuringEnvCheck()
    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-discover-result', {
      status: discovery?.status ?? null,
      activeCandidateId: discovery?.activeCandidateId ?? null,
      candidateCount: discovery?.candidates?.length ?? 0,
    })
    const activeCandidate = resolveActiveOpenClawCandidate(discovery)
    if (!activeCandidate) {
      await appendEnvCheckDiag('renderer-inspect-existing-openclaw-no-active-candidate', {
        status: discovery?.status ?? null,
        candidateCount: discovery?.candidates?.length ?? 0,
      })
      setIsRefreshingOpenClawVersion(false)
      setOpenClawGateState(null)
      setTakeoverSummary(null)
      return null
    }

    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-upgrade-check-requested', {
      candidateId: activeCandidate.candidateId,
      candidateVersion: activeCandidate.version,
      platform: window.api.platform,
    })
    const upgradeCheck =
      window.api.platform === 'win32'
        ? await window.api.checkOpenClawUpgradeForEnvCheck(discovery)
        : await window.api.checkOpenClawUpgrade()
    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-upgrade-check', {
      candidateId: activeCandidate.candidateId,
      candidateVersion: activeCandidate.version,
      ok: upgradeCheck.ok,
      currentVersion: upgradeCheck.currentVersion ?? null,
      targetVersion: upgradeCheck.targetVersion ?? null,
      blocksContinue: upgradeCheck.blocksContinue,
      canAutoUpgrade: upgradeCheck.canAutoUpgrade,
    })
    const gateState = buildOpenClawGateState(discovery, upgradeCheck)
    let nextDiscovery = gateState.discovery
    const takeoverNoticeCandidates = (gateState.discovery?.candidates || []).filter((candidate) =>
      shouldShowTakeoverNotice(candidate)
    )
    const takeoverCandidates = (gateState.discovery?.candidates || []).filter((candidate) =>
      shouldEnsureBaselineBackup(candidate)
    )
    const takeoverFailures: OpenClawTakeoverFailure[] = []

    if (takeoverCandidates.length > 0 && nextDiscovery) {
      await appendEnvCheckDiag('renderer-inspect-existing-openclaw-backup-start', {
        takeoverCandidateCount: takeoverCandidates.length,
      })
      updateStep('openclaw', {
        status: 'checking',
        description: `正在为 ${takeoverCandidates.length} 个 OpenClaw 安装执行接管备份...`,
        progress: Math.max(currentProgress, resolveOpenClawEnvCheckProgress('takeover-backup')),
      })

      for (const candidate of takeoverCandidates) {
        const backupResult = await window.api.ensureOpenClawBaselineBackup(candidate)
        if (backupResult.ok && backupResult.backup) {
          nextDiscovery = applyBaselineBackupToCandidate(
            nextDiscovery,
            candidate.candidateId,
            backupResult.backup
          )
          continue
        }

        takeoverFailures.push(
          buildTakeoverFailure(
            candidate,
            backupResult.message,
            backupResult.manualBackupAction
          )
        )
      }
    }

    const nextGateState = {
      ...gateState,
      discovery: nextDiscovery,
      activeCandidate: resolveActiveOpenClawCandidate(nextDiscovery),
    }

    const takeoverBackupRootDirectory =
      nextGateState.discovery && takeoverNoticeCandidates.length > 0
        ? await resolveTakeoverBackupRootDirectory(nextGateState.discovery, () => window.api.getOpenClawBackupRoot())
        : nextGateState.discovery?.defaultBackupDirectory || ''
    const nextTakeoverSummary =
      nextGateState.discovery
        ? {
            detected: takeoverNoticeCandidates.length > 0,
            backupRootDirectory: takeoverBackupRootDirectory,
            failures: takeoverFailures,
          }
        : null

    setTakeoverSummary(nextTakeoverSummary)

    const activeTakeoverFailure = resolveActiveTakeoverFailure(
      nextTakeoverSummary,
      nextGateState.activeCandidate?.candidateId || ''
    )

    if (nextGateState.canAutoCorrect && !activeTakeoverFailure) {
      const acceptedAutoCorrection = window.confirm(
        buildOpenClawAutoCorrectionConsentMessage(nextGateState)
      )
      if (!acceptedAutoCorrection) {
        setOpenClawGateState(nextGateState)
        setIsRefreshingOpenClawVersion(false)
      updateStep('openclaw', {
          status: 'pending-install',
          version: nextGateState.activeCandidate?.version || activeCandidate.version,
          description: '你未接受 OpenClaw 自动版本调整，Qclaw 即将退出。',
          progress: 100,
        })
        void window.api.quitApp().catch(() => null)
        return nextGateState
      }

      updateStep('openclaw', {
        status: 'installing',
        description: nextGateState.message,
        progress: resolveOpenClawEnvCheckProgress('auto-correcting'),
      })

      const correctionResult = await window.api.runOpenClawUpgrade()
      if (!correctionResult.ok) {
        const failureMessage = correctionResult.message || 'OpenClaw 版本自动修复失败'
        setOpenClawUpgradeError(failureMessage)
        setOpenClawGateState(nextGateState)
        setIsRefreshingOpenClawVersion(false)
        updateStep('openclaw', {
          status: 'pending-install',
          version: nextGateState.activeCandidate?.version || activeCandidate.version,
          description: failureMessage,
          progress: 100,
        })
        return nextGateState
      }

      await window.api.refreshEnvironment().catch(() => null)
      return inspectExistingOpenClaw(currentProgress, { manualRefresh: true })
    }

    setOpenClawGateState(nextGateState)
    setIsRefreshingOpenClawVersion(false)
    await appendEnvCheckDiag('renderer-inspect-existing-openclaw-result', {
      candidateId: nextGateState.activeCandidate?.candidateId ?? null,
      version: nextGateState.activeCandidate?.version ?? null,
      blocksContinue: nextGateState.blocksContinue,
      canAutoCorrect: nextGateState.canAutoCorrect,
      message: nextGateState.message,
    })
    updateStep('openclaw', {
      status: nextGateState.blocksContinue ? 'pending-install' : 'ok',
      version: nextGateState.activeCandidate?.version || activeCandidate.version,
      description: nextGateState.message,
      progress: 100,
    })
    return nextGateState
  }

  const handleContinue = () => {
    if (!readyPayload) return
    onReady({
      ...readyPayload,
      discoveryResult: openClawGateState?.discovery || readyPayload.discoveryResult || null,
    })
  }

  const handleOpenClawRefresh = async () => {
    if (isRunning || isRefreshingOpenClawVersion || isUpgradingOpenClaw || acknowledgingManualBackup) return
    await inspectExistingOpenClaw(resolveOpenClawEnvCheckProgress('manual-refresh'), { manualRefresh: true })
  }

  const handleRetryTakeoverBackup = async (candidateId: string) => {
    if (isRunning || isRefreshingOpenClawVersion || isUpgradingOpenClaw || acknowledgingManualBackup) return
    if (!openClawGateState?.discovery) return

    const candidate =
      openClawGateState.discovery.candidates.find((item) => item.candidateId === candidateId) || null
    if (!candidate) return

    setRetryingTakeoverCandidateId(candidateId)
    try {
      const backupResult = await window.api.ensureOpenClawBaselineBackup(candidate)
      if (backupResult.ok && backupResult.backup) {
        const ensuredBackup = backupResult.backup
        setOpenClawGateState((current) => {
          if (!current?.discovery) return current
          const nextDiscovery = applyBaselineBackupToCandidate(
            current.discovery,
            candidateId,
            ensuredBackup
          )
          return {
            ...current,
            discovery: nextDiscovery,
            activeCandidate: resolveActiveOpenClawCandidate(nextDiscovery),
          }
        })
        setTakeoverSummary((current) => {
          if (!current) return current
          return clearTakeoverFailure(current, candidateId)
        })
        notifications.hide(`takeover-fail-${candidateId}`)
        return
      }

      setTakeoverSummary((current) => {
        if (!current) return current
        const nextFailure = buildTakeoverFailure(
          candidate,
          backupResult.message,
          backupResult.manualBackupAction
        )
        return {
          ...current,
          failures: current.failures.map((item) =>
            item.candidateId === candidateId ? nextFailure : item
          ),
        }
      })
    } finally {
      setRetryingTakeoverCandidateId(null)
    }
  }

  const handleAcknowledgeManualBackup = async () => {
    if (isRunning || isRefreshingOpenClawVersion || isUpgradingOpenClaw || acknowledgingManualBackup) return
    const activeCandidate = openClawGateState?.activeCandidate
    if (!activeCandidate || !activeTakeoverFailure) return

    setAcknowledgingManualBackup(true)
    try {
      const skipResult = await window.api.skipOpenClawBaselineBackup(activeCandidate)
      if (!skipResult.ok || !skipResult.bypass) {
        throw new Error(skipResult.message || '记录手动备份确认失败')
      }

      setOpenClawGateState((current) => {
        if (!current) return current
        const nextDiscovery = applyBaselineBackupBypassToDiscovery(current.discovery, skipResult.bypass)
        return {
          ...current,
          discovery: nextDiscovery,
          activeCandidate: resolveActiveOpenClawCandidate(nextDiscovery) || current.activeCandidate,
        }
      })
      setTakeoverSummary((current) => clearTakeoverFailure(current, activeCandidate.candidateId))
      notifications.hide(`takeover-fail-${activeCandidate.candidateId}`)
      notifications.show({
        title: '已记录手动备份确认',
        message: '你可以继续进入控制面板，后续数据治理会保留这条手动备份提醒。',
        color: 'brand',
        autoClose: 5000,
      })
    } catch (error) {
      console.error('record manual backup acknowledgment failed', error)
      notifications.show({
        title: '继续接管失败',
        message: '未能记录手动备份确认，请稍后重试。',
        color: 'red',
        autoClose: 6000,
      })
    } finally {
      setAcknowledgingManualBackup(false)
    }
  }

  const handleConfirmHistoryOnlyManualBackup = async () => {
    if (isRunning || isRefreshingOpenClawVersion || isUpgradingOpenClaw || acknowledgingManualBackup) return
    if (!historyOnlyRecoveryFailure) return

    setAcknowledgingManualBackup(true)
    try {
      const skipResult = await window.api.skipOpenClawBaselineBackup(historyOnlyRecoveryFailure.candidate)
      if (!skipResult.ok || !skipResult.bypass) {
        throw new Error(skipResult.message || '记录手动备份确认失败')
      }

      setHistoryOnlyRecoveryConfirmOpened(false)
      notifications.show({
        title: '已记录手动备份确认',
        message: '将重新执行环境检查，并继续恢复历史 OpenClaw 环境。',
        color: 'brand',
        autoClose: 5000,
      })
      resetEnvCheck(runAttempt)
    } catch (error) {
      console.error('record history recovery manual backup acknowledgment failed', error)
      notifications.show({
        title: '继续恢复失败',
        message: '未能记录手动备份确认，请稍后重试。',
        color: 'red',
        autoClose: 6000,
      })
    } finally {
      setAcknowledgingManualBackup(false)
    }
  }

  const handleOpenClawUpgrade = async () => {
    if (isRunning || isRefreshingOpenClawVersion || isUpgradingOpenClaw || activeTakeoverBackupBlocked) return
    setIsUpgradingOpenClaw(true)
    setOpenClawUpgradeError('')
    updateStep('openclaw', {
      status: 'installing',
      description: '正在升级 OpenClaw 命令行工具...',
      progress: resolveOpenClawEnvCheckProgress('manual-upgrade'),
    })

    try {
      const upgradeResult = await window.api.runOpenClawUpgrade()
      if (!upgradeResult.ok) {
        throw new Error(upgradeResult.message || 'OpenClaw 升级失败')
      }

      await window.api.refreshEnvironment()
      resetEnvCheck(runAttempt)
    } catch (error) {
      console.error('openclaw upgrade failed', error)
      setOpenClawUpgradeError('OpenClaw 升级失败，请稍后重试。')
      updateStep('openclaw', {
        status: openClawGateState?.blocksContinue ? 'pending-install' : 'ok',
        description: openClawGateState?.message || 'OpenClaw 升级失败，请稍后重试',
        error: '',
      })
      setIsUpgradingOpenClaw(false)
      return
    }

    setIsUpgradingOpenClaw(false)
  }

  const recoverHistoryOnlyOpenClaw = async (progress: number): Promise<HistoryOnlyRecoveryResult | null> => {
    updateStep('openclaw', {
      status: 'checking',
      description: '正在重新识别历史 OpenClaw 数据...',
      progress: Math.max(progress, resolveOpenClawEnvCheckProgress('history-recovery-discovery')),
    })

    const recoveredDiscovery = await window.api.discoverOpenClaw().catch(() => null)
    const recoveredCandidate = resolveActiveOpenClawCandidate(recoveredDiscovery)
    if (!recoveredDiscovery || !recoveredCandidate) {
      showFatalMessage('历史 OpenClaw 环境补装后，仍无法识别可接管的安装。请重试或检查旧数据目录是否完整。')
      return null
    }

    updateStep('openclaw', {
      status: 'checking',
      description: '正在备份历史 OpenClaw 数据...',
      progress: resolveOpenClawEnvCheckProgress('history-recovery-backup'),
    })

    const backupResult = await window.api.ensureOpenClawBaselineBackup(recoveredCandidate)
    if (!canContinueHistoryOnlyRecovery(recoveredCandidate, backupResult)) {
      const failure = buildTakeoverFailure(
        recoveredCandidate,
        backupResult.message,
        backupResult.manualBackupAction
      )
      const warning = backupResult.manualBackupAction
        ? buildManualBackupWarning(backupResult.manualBackupAction)
        : backupResult.message || '历史 OpenClaw 数据备份失败，请稍后重试。'
      setHistoryOnlyRecoveryFailure({
        candidate: recoveredCandidate,
        failure,
      })
      showFatalMessage(`历史数据恢复前备份失败。${warning}`)
      return null
    }

    setHistoryOnlyRecoveryFailure(null)
    await window.api.appendEnvCheckDiagnostic('renderer-history-recovery-managed-mark-requested', {
      candidateId: recoveredCandidate.candidateId,
      installFingerprint: recoveredCandidate.installFingerprint,
      ownershipState: recoveredCandidate.ownershipState,
    }).catch(() => undefined)
    const recoveryMarked = await window.api.markManagedOpenClawInstall(recoveredCandidate.installFingerprint).catch((error) => {
      void window.api.appendEnvCheckDiagnostic('renderer-history-recovery-managed-mark-failed', {
        candidateId: recoveredCandidate.candidateId,
        installFingerprint: recoveredCandidate.installFingerprint,
        error: error instanceof Error ? error.message : String(error || 'unknown'),
      }).catch(() => undefined)
      throw error
    })
    await window.api.appendEnvCheckDiagnostic('renderer-history-recovery-managed-mark-result', {
      candidateId: recoveredCandidate.candidateId,
      installFingerprint: recoveredCandidate.installFingerprint,
      marked: recoveryMarked,
    }).catch(() => undefined)
    const managedDiscovery = await window.api.discoverOpenClaw().catch(() => recoveredDiscovery)
    const managedCandidate = resolveActiveOpenClawCandidate(managedDiscovery) || recoveredCandidate

    const takeoverBackupRootDirectory = await resolveTakeoverBackupRootDirectory(
      managedDiscovery,
      () => window.api.getOpenClawBackupRoot()
    )

    setTakeoverSummary({
      detected: true,
      backupRootDirectory: takeoverBackupRootDirectory,
      failures: [],
    })

    updateStep('openclaw', {
      status: 'ok',
      version: managedCandidate.version,
      description: '已恢复历史 OpenClaw 环境，并完成备份后继续使用',
      progress: 100,
    })
    setCurrentStep(2)

    return {
      discovery: managedDiscovery,
      activeCandidate: managedCandidate,
    }
  }

  // 取消当前操作
  const handleCancel = async () => {
    if (isRunning) {
      const cancelResult = await window.api.cancelCommandDetailed()
      const canceled = cancelResult.canceledDomains.length > 0
      const canceledSummary = formatCancelDomainSummary(cancelResult.canceledDomains)
      const failedSummary = formatCancelDomainSummary(cancelResult.failedDomains)
      if (cancelResult.failedDomains.length > 0) {
        console.warn('cancel command partially failed', { canceledSummary, failedSummary, cancelResult })
        showFatalMessage('已停止部分操作，但仍有任务未能停止，请稍后重试。')
        return
      }

      if (canceled) {
        // 标记当前步骤为已取消
        setSteps(prev => prev.map(s => s.id === steps[currentStep]?.id ? { ...s, status: 'canceled' } : s))
      }
      setIsRunning(false)

      if (canceled) {
        console.warn('cancel command stopped active work', { canceledSummary, cancelResult })
        showFatalMessage('已停止当前操作。')
        return
      }

      showFatalMessage('当前没有正在进行的操作。')
    }
  }

  // 手动升级 Node.js
  const handleNodeUpgrade = async () => {
    setIsRunning(true)
    updateStep('node', { status: 'installing', description: '正在准备升级...', progress: 0 })

    try {
      // 1. 获取安装计划（会自动选官方最新稳定版）
      const plan = await window.api.resolveNodeInstallPlan()
      const shouldUseNvmInstall = nodeInstallStrategy === 'nvm'
      setLatestNodeVersion(plan.version)

      let installerPath: string | undefined
      const shouldDownloadInstaller = shouldDownloadNodeInstallerBeforeInstall({
        needNode: true,
        installStrategy: nodeInstallStrategy,
        platform: window.api.platform,
        nodeInstallPlan: plan,
      })
      if (shouldUseNvmInstall) {
        updateStep('node', { description: `正在通过 nvm 准备 Node.js ${plan.version}...`, progress: 15 })
      } else if (shouldDownloadInstaller) {
        // 2. 下载安装包
        updateStep('node', { description: `正在下载 Node.js ${plan.version}...`, progress: 10 })
        const downloadResult = await window.api.downloadNodeInstaller(plan)

        if (!downloadResult.ok) {
          throw new Error(downloadResult.error || '下载失败')
        }

        installerPath = downloadResult.path

        // 3. macOS 安装前校验
        if (window.api.platform === 'darwin') {
          updateStep('node', { description: '正在校验安装包...', progress: 40 })
          const inspection = await window.api.inspectNodeInstaller(installerPath)
          if (!inspection.ok && inspection.issue) {
            throw new Error(inspection.issue.message || '安装包校验失败')
          }
        }
      } else {
        updateStep('node', { description: `正在准备 Node.js ${plan.version}...`, progress: 15 })
      }

      // 4. 执行安装
      updateStep('node', { description: shouldUseNvmInstall ? '正在通过 nvm 安装 Node.js...' : '正在安装 Node.js...', progress: 50 })
      const installResult = await window.api.installEnv({
        needNode: true,
        needOpenClaw: false,
        nodeInstallerPath: installerPath,
        nodeInstallPlan: plan,
      })

      if (!installResult.ok) {
        throw new Error(installResult.stderr || '安装失败')
      }

      // 5. 刷新环境变量
      updateStep('node', { description: '正在刷新环境变量...', progress: 80 })
      await window.api.refreshEnvironment()

      // 6. 重新检测
      updateStep('node', { description: '正在验证安装...', progress: 90 })
      const recheckResult = await window.api.checkNode()
      const requiredNodeVersion = recheckResult.requiredVersion || nodeRequiredVersion

      if (recheckResult.installed && isNodeVersionAtLeast(recheckResult.version, requiredNodeVersion)) {
        setLatestNodeVersion(recheckResult.targetVersion || plan.version)
        setNodeRequiredVersion(requiredNodeVersion)
        setIsRunning(false)
        resetEnvCheck(runAttempt)
      } else {
        throw new Error(`升级后版本仍低于要求（当前: ${recheckResult.version}，要求: >= ${requiredNodeVersion}）`)
      }
    } catch (error) {
      console.error('manual node upgrade failed', error)
      updateStep('node', {
        status: 'pending-install',
        error: '升级失败，请稍后重试。'
      })
      setIsRunning(false)
    }
  }

  // 清理函数 - 组件卸载时取消正在运行的命令
  useEffect(() => {
    return () => {
      // 直接调用 API 取消命令，不依赖组件状态
      window.api?.cancelCommands(['env-setup', 'upgrade', 'gateway', 'env']).then(() => {
        setIsRunning(false)
      })
    }
  }, [])

  const runChecks = async () => {
    // 双重检查：防止并发执行
    if (isRunning) {
      await appendEnvCheckDiag('renderer-run-checks-skipped', { reason: 'already-running' })
      return
    }
    if (!window.api) {
      await appendEnvCheckDiag('renderer-run-checks-skipped', { reason: 'missing-window-api' })
      setFatalIssue({ message: '桌面运行环境初始化失败，请重启应用后重试。' })
      return
    }
    await appendEnvCheckDiag('renderer-run-checks-start', {
      platform: window.api.platform,
      runAttempt,
    })
    setIsRunning(true)
    setFatalIssue(null)
    setStartupIssuePrompt(null)
    setLatestNodeVersion('')
    setOpenClawGateState(null)
    setOpenClawUpgradeError('')
    setReadyPayload(null)
    setTakeoverSummary(null)
    setRetryingTakeoverCandidateId(null)
    setAcknowledgingManualBackup(false)
    setHistoryOnlyRecoveryFailure(null)
    setHistoryOnlyRecoveryConfirmOpened(false)
    setIsRefreshingOpenClawVersion(false)
    setIsUpgradingOpenClaw(false)

    try {
      kickoffStartupPluginRepair(onEnsurePluginRepairReady)
      if (window.api.platform === 'darwin') {
        updateStep('node', {
          status: 'checking',
          description: '正在检查 Git 与 Xcode Command Line Tools...',
          progress: 5,
        })
        await delay(envCheckTiming.transitionShortMs)
        const macGitToolsResult = await window.api.prepareMacGitTools()
        if (!macGitToolsResult.ok) {
          const issue = classifyMacGitToolsIssue(macGitToolsResult)
          updateStep('node', issue.kind === 'xcode-clt-pending'
            ? {
                status: 'pending-install',
                description: '请先完成 Xcode Command Line Tools 安装，再点击“重试识别”刷新状态',
                progress: 5,
                error: undefined,
              }
            : {
                status: 'error',
                description: issue.message,
                error: issue.title,
                progress: 5,
              })
          showStartupIssue(issue)
          setIsRunning(false)
          return
        }
      }

    // 第一步：检测 Node.js
    updateStep('node', { status: 'checking', description: '正在检查 Node.js...', progress: 10 })
    await delay(envCheckTiming.transitionStandardMs)
    await appendEnvCheckDiag('renderer-check-node-requested', { runAttempt })
    let nodeResult = await window.api.checkNode()
    await appendEnvCheckDiag('renderer-check-node-result', {
      installed: nodeResult.installed,
      needsUpgrade: nodeResult.needsUpgrade,
      version: nodeResult.version ?? null,
      installStrategy: nodeResult.installStrategy ?? null,
    })
    const requiredNodeVersion = nodeResult.requiredVersion || MIN_NODE_VERSION
    setNodeRequiredVersion(requiredNodeVersion)
    setNodeInstallStrategy(nodeResult.installStrategy)
    const nodeNeedsUpgrade = nodeResult.installed && nodeResult.needsUpgrade
    let needNode = !nodeResult.installed
    let nodeInstallPlan = null
    if (needNode) {
      try {
        nodeInstallPlan = await window.api.resolveNodeInstallPlan()
      } catch (error) {
        console.error('resolve latest Node install info failed', error)
        updateStep('node', { status: 'error', error: '无法获取最新版本' })
        showFatalMessage('暂时无法获取 Node.js 安装信息，请检查网络后重试。', 'download-failed')
        setIsRunning(false)
        return
      }
    }
    const targetNodeVersion = nodeInstallPlan?.version || nodeResult.targetVersion

    // 显示检测结果（无论是否安装，都先显示检测结果）
    if (!nodeResult.installed) {
      setLatestNodeVersion(targetNodeVersion || '')
      updateStep('node', {
        status: 'pending-install',
        description: '未检测到 Node.js，系统将自动安装官方最新稳定版',
        progress: 20,
      })
    } else if (nodeNeedsUpgrade) {
      setLatestNodeVersion(targetNodeVersion || '')
      updateStep('node', {
        status: 'pending-install',
        version: nodeResult.version,
        description: `OpenClaw 需要 Node.js ${requiredNodeVersion} 或更高版本。 当前版本过低，请手动升级后再继续。`,
        progress: 20,
      })
      setIsRunning(false)
      return
    } else {
      setLatestNodeVersion('')
      updateStep('node', {
        status: 'ok',
        version: nodeResult.version,
        description: '已安装',
        progress: 100
      })
      setCurrentStep(1)
    }

    // 第二步：检测 OpenClaw 命令行工具
    if (
      shouldBootstrapNodeBeforeOpenClawCheck({
        needNode,
        installStrategy: nodeResult.installStrategy,
        platform: window.api.platform,
        nodeInstallPlan,
      })
    ) {
      updateStep('node', {
        status: 'installing',
        description: `正在安装 Node.js ${targetNodeVersion}...`,
        progress: 45,
      })

      const nodeBootstrapResult = await window.api.installEnv({
        needNode: true,
        needOpenClaw: false,
        nodeInstallPlan: nodeInstallPlan || undefined,
      })

      if (!nodeBootstrapResult.ok) {
        const errDetail = nodeBootstrapResult.stderr || nodeBootstrapResult.stdout || '未知错误'
        const issue = createNodeInstallerIssue('installer-failed', errDetail)
        updateStep('node', { status: 'error', error: '安装失败' })
        showFatalIssue(issue)
        showStartupIssue(issue)
        setIsRunning(false)
        return
      }

      updateStep('node', { status: 'checking', description: '重新检测 Node.js...', progress: 85 })
      await window.api.refreshEnvironment()
      await delay(envCheckTiming.transitionShortMs)
      const bootstrappedNodeResult = await window.api.checkNode()
      if (!bootstrappedNodeResult.installed) {
        updateStep('node', {
          status: 'error',
          error: '安装后仍无法检测到',
        })
        showFatalMessage(
          'Node.js 安装后仍无法检测到。请重启应用或手动安装。',
          'installer-failed'
        )
        setIsRunning(false)
        return
      }

      nodeResult = bootstrappedNodeResult
      needNode = false
      nodeInstallPlan = null
      setLatestNodeVersion('')
      setNodeInstallStrategy(nodeResult.installStrategy)
      updateStep('node', { status: 'ok', version: nodeResult.version, description: '已安装', progress: 100 })
      setCurrentStep(1)
    }

    updateStep('openclaw', { status: 'checking', description: '正在检查 OpenClaw 命令行工具...', progress: needNode ? 25 : 20 })
    await delay(envCheckTiming.transitionShortMs)
    await appendEnvCheckDiag('renderer-check-openclaw-requested', { runAttempt })
    const openclawResult = await window.api.checkOpenClaw()
    await appendEnvCheckDiag('renderer-check-openclaw-result', {
      installed: openclawResult.installed,
      version: openclawResult.version ?? null,
    })
    await appendEnvCheckDiag('renderer-discover-openclaw-requested', { runAttempt })
    const initialDiscovery = await discoverOpenClawDuringEnvCheck()
    await appendEnvCheckDiag('renderer-discover-openclaw-result', {
      activeCandidateId: initialDiscovery?.activeCandidateId ?? null,
      installationCount: initialDiscovery?.candidates?.length ?? 0,
      status: initialDiscovery?.status ?? null,
    })
    const installDecision = resolveOpenClawInstallDecision({
      discovery: initialDiscovery,
      cliInstalled: openclawResult.installed,
    })
    await appendEnvCheckDiag('renderer-openclaw-install-decision', {
      hadOpenClawInstalled: installDecision.hadOpenClawInstalled,
      shouldFreshInstall: installDecision.shouldFreshInstall,
      requiresRecovery: installDecision.requiresRecovery,
    })
    const hadOpenClawInstalled = installDecision.hadOpenClawInstalled
    const needOpenClawInstall = installDecision.shouldFreshInstall
    const needOpenClawRuntimeRecovery = installDecision.requiresRecovery
    const shouldInstallOpenClawRuntime = needOpenClawInstall || needOpenClawRuntimeRecovery
    const installProgressStepId = resolveEnvInstallProgressStep({
      needNode,
      shouldInstallOpenClawRuntime,
    })
    const readSharedConfigInitialized = async (configPath?: string | null) => {
      try {
        await appendEnvCheckDiag('renderer-shared-config-read-requested', {
          configPath: configPath || null,
        })
        const config = await window.api.readConfig({ configPath: configPath || undefined })
        const initialized = hasInitializedOpenClawConfig(config)
        await appendEnvCheckDiag('renderer-shared-config-read-result', {
          configPath: configPath || null,
          initialized,
          topLevelKeys: config && typeof config === 'object' ? Object.keys(config).length : 0,
        })
        return initialized
      } catch {
        await appendEnvCheckDiag('renderer-shared-config-read-result', {
          configPath: configPath || null,
          initialized: false,
          errored: true,
        })
        return false
      }
    }

    // 显示检测结果
    if (installDecision.requiresRecovery) {
      updateStep('openclaw', {
        status: 'pending-install',
        description: '检测到历史 OpenClaw 数据，待恢复 OpenClaw 环境',
        progress: needNode ? 30 : 25,
      })
    } else if (needOpenClawInstall) {
      updateStep('openclaw', {
        status: 'pending-install',
        description: '未检测到 OpenClaw 命令行工具，待安装',
        progress: needNode ? 30 : 25,
      })
    } else {
      updateStep('openclaw', { status: 'ok', version: openclawResult.version, description: '已安装', progress: 100 })
      setCurrentStep(2)
    }

    // 如果都已安装，直接记录网关会在后续配置完成后再确认
    if (!needNode && !shouldInstallOpenClawRuntime) {
      await appendEnvCheckDiag('renderer-openclaw-enter-existing-install-branch', {
        needNode,
        shouldInstallOpenClawRuntime,
      })
      const gateState = await inspectExistingOpenClaw(55)
      await delay(envCheckTiming.transitionStandardMs)
      updateStep('gateway', {
        status: 'checking',
        description: '当前阶段跳过网关运行状态检查，后续流程会自动确认...',
        progress: 0,
      })
      await delay(envCheckTiming.transitionStandardMs)
      const sharedConfigInitialized = await readSharedConfigInitialized(
        resolveActiveOpenClawCandidate(gateState?.discovery || initialDiscovery || null)?.configPath
      )
      updateStep(
        'gateway',
        buildDeferredGatewayStepState(
          (gateState?.discovery || initialDiscovery || null)?.windowsGatewayOwnerState || null
        )
      )
      setProgress(100)
      await delay(envCheckTiming.transitionSettleMs)
      setIsRunning(false)
      await appendEnvCheckDiag('renderer-openclaw-ready-payload', {
        installedOpenClawDuringCheck: false,
        gatewayRunning: false,
        sharedConfigInitialized,
        discoveryStatus: (gateState?.discovery || initialDiscovery || null)?.status ?? null,
      })
      setReadyPayload({
        hadOpenClawInstalled,
        installedOpenClawDuringCheck: false,
        gatewayRunning: false,
        sharedConfigInitialized,
        discoveryResult: gateState?.discovery || initialDiscovery || null,
      })
      return
    }

    // 需要安装，准备安装参数
    let nodeInstallerPath: string | undefined
    const shouldDownloadNodeInstaller = shouldDownloadNodeInstallerBeforeInstall({
      needNode,
      installStrategy: nodeResult.installStrategy,
      platform: window.api.platform,
      nodeInstallPlan,
    })

    if (needNode) {
      if (shouldDownloadNodeInstaller) {
        updateStep('node', {
          status: 'installing',
          description: `正在下载 Node.js ${targetNodeVersion}...`,
          progress: 35,
        })
        const downloadResult = await window.api.downloadNodeInstaller(nodeInstallPlan || undefined)
        if (!downloadResult.ok) {
          const issue = classifyNodeInstallerDownloadFailure(downloadResult.error || '')
          updateStep('node', { status: 'error', error: '下载失败' })
          showFatalIssue(issue)
          showStartupIssue(issue)
          setIsRunning(false)
          return
        }
        nodeInstallerPath = downloadResult.path

        if (window.api.platform === 'darwin') {
          const readiness = await window.api.inspectNodeInstaller(nodeInstallerPath)
          if (!readiness.ok && readiness.issue) {
            updateStep('node', { status: 'error', error: readiness.issue.title })
            showFatalIssue(readiness.issue)
            showStartupIssue(readiness.issue)
            setIsRunning(false)
            return
          }
        }

        updateStep('node', { status: 'installing', description: '等待安装...', progress: 45 })
      } else {
        updateStep('node', {
          status: 'installing',
          description: `正在通过 nvm 准备 Node.js ${targetNodeVersion}...`,
          progress: 45,
        })
      }
    }

    if (shouldInstallOpenClawRuntime) {
      updateStep('openclaw', {
        status: 'installing',
        description: needOpenClawRuntimeRecovery ? '正在恢复 OpenClaw 环境...' : '等待安装...',
        progress: needNode ? 55 : 45,
      })
    }

    // 一次性安装所有需要的组件（只弹一次权限弹窗）
    if (installProgressStepId === 'node') {
      updateStep('node', { status: 'installing', description: '正在安装组件...', progress: 60 })
    } else if (installProgressStepId === 'openclaw') {
      updateStep('openclaw', {
        status: 'installing',
        description: needOpenClawRuntimeRecovery ? '正在恢复 OpenClaw 环境...' : '正在安装 OpenClaw 命令行工具...',
        progress: 60,
      })
    }

    const installResult = await window.api.installEnv({
      needNode,
      needOpenClaw: shouldInstallOpenClawRuntime,
      nodeInstallerPath,
      nodeInstallPlan: nodeInstallPlan || undefined,
    })

    if (!installResult.ok) {
      const errDetail = installResult.stderr || installResult.stdout || '未知错误'
      if (needNode) {
        const issue =
          window.api.platform === 'darwin'
            ? classifyMacNodeInstallerFailure(errDetail)
            : createNodeInstallerIssue('installer-failed', errDetail)
        updateStep('node', { status: 'error', error: '安装失败' })
        showFatalIssue(issue)
        showStartupIssue(issue)
      }
      if (shouldInstallOpenClawRuntime) {
        updateStep('openclaw', { status: 'error', error: '安装失败' })
      }
      if (!needNode) {
        console.error('installer failed', errDetail)
        showFatalMessage('安装失败，请稍后重试。')
      }
      setIsRunning(false)
      return
    }

    if (installProgressStepId === 'node') {
      updateStep('node', { status: 'installing', description: '安装完成', progress: 75 })
    }

    // 重新检测
    if (needNode) {
      // 先刷新环境变量，获取最新的 PATH
      updateStep('node', { status: 'checking', description: '刷新环境变量...', progress: 80 })
      await window.api.refreshEnvironment()
      await delay(envCheckTiming.transitionStandardMs)

      updateStep('node', { status: 'checking', description: '重新检测 Node.js...', progress: 85 })
      const newNodeResult = await window.api.checkNode()
      if (!newNodeResult.installed) {
        updateStep('node', {
          status: 'error',
          error: '安装后仍无法检测到',
        })
        showFatalMessage(
          'Node.js 安装后仍无法检测到。请重启应用或手动安装。',
          'installer-failed'
        )
        setIsRunning(false)
        return
      }
      updateStep('node', { status: 'ok', version: newNodeResult.version, description: '已安装', progress: 90 })
      setCurrentStep(1)
    }

    if (shouldInstallOpenClawRuntime) {
      updateStep('openclaw', { status: 'checking', description: '刷新环境变量...', progress: 85 })
      await window.api.refreshEnvironment()
      await delay(envCheckTiming.transitionStandardMs)

      updateStep('openclaw', {
        status: 'checking',
        description: needOpenClawRuntimeRecovery ? '正在验证 OpenClaw 环境...' : '重新检测 OpenClaw 命令行工具...',
        progress: resolveOpenClawEnvCheckProgress('verifying-install'),
      })
      const newOpenclawResult = await window.api.checkOpenClaw()
      if (!newOpenclawResult.installed) {
        updateStep('openclaw', { status: 'error', error: '安装后仍无法检测到' })
        showFatalMessage('OpenClaw 未能正常识别，请重启应用后重试')
        setIsRunning(false)
        return
      }
      updateStep('openclaw', {
        status: 'ok',
        version: newOpenclawResult.version,
        description: '已安装，正在接管运行时...',
        progress: resolveOpenClawEnvCheckProgress('installed-recheck-complete'),
      })
      setCurrentStep(2)
    }

    let finalDiscoveryResult: OpenClawDiscoveryResult | null =
      shouldInstallOpenClawRuntime ? await discoverOpenClawDuringEnvCheck() : initialDiscovery

    if (shouldInstallOpenClawRuntime) {
      await markInstalledOpenClawAsManagedDuringEnvCheck(finalDiscoveryResult)
      finalDiscoveryResult = await discoverOpenClawDuringEnvCheck()
    }

    if (needOpenClawRuntimeRecovery) {
      const recoveryResult = await recoverHistoryOnlyOpenClaw(
        resolveOpenClawEnvCheckProgress('history-recovery-discovery')
      )
      if (!recoveryResult) {
        setIsRunning(false)
        return
      }
      finalDiscoveryResult = recoveryResult.discovery
    }

    const finalGateState = await inspectExistingOpenClaw(
      resolveOpenClawEnvCheckProgress('discovering-existing-install')
    )
    finalDiscoveryResult = finalGateState?.discovery || finalDiscoveryResult

    await delay(envCheckTiming.transitionShortMs)

    // 第三步：记录网关会在后续配置完成后再确认
    updateStep('gateway', {
      status: 'checking',
      description: '当前阶段跳过网关运行状态检查，后续流程会自动确认...',
      progress: 0,
    })
    await delay(envCheckTiming.transitionStandardMs)

    const sharedConfigInitialized = await readSharedConfigInitialized(
      resolveActiveOpenClawCandidate(finalGateState?.discovery || finalDiscoveryResult || null)?.configPath
    )
    updateStep(
      'gateway',
      buildDeferredGatewayStepState(finalDiscoveryResult?.windowsGatewayOwnerState || null)
    )

    setProgress(100)
    await delay(envCheckTiming.transitionSettleMs)
    setIsRunning(false)
    setReadyPayload({
      hadOpenClawInstalled,
      installedOpenClawDuringCheck: shouldInstallOpenClawRuntime,
      gatewayRunning: false,
      sharedConfigInitialized,
      discoveryResult: finalDiscoveryResult,
    })
    } catch (err) {
      console.error('env check failed', err)
      showFatalMessage('环境检查失败，请稍后重试。')
      setIsRunning(false)
    }
  }

  const fatalSupportActions = getEnvCheckSupportActionsForIssueKind(fatalIssue?.issueKind)
  const startupSupportActions = getEnvCheckSupportActionsForIssueKind(startupIssuePrompt?.kind)
  const showInlineStartupIssue = shouldRenderStartupIssueInline(startupIssuePrompt)
  const StatusIcon = ({ status }: { status: StepStatus }) => {
    switch (status) {
      case 'pending':
        return (
          <div className="w-8 h-8 rounded-full app-bg-tertiary flex items-center justify-center">
            <div className="w-2 h-2 rounded-full app-bg-tertiary" />
          </div>
        )
      case 'pending-install':
        return (
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--app-border)' }}>
            <svg className="w-4 h-4 app-text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
        )
      case 'checking':
      case 'installing':
        return (
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--app-bg-inset)' }}>
            <Loader size={18} color="brand" />
          </div>
        )
      case 'ok':
        return (
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--mantine-color-brand-5)' }}>
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )
      case 'error':
        return (
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--mantine-color-red-6)' }}>
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )
      case 'canceled':
        return (
          <div className="w-8 h-8 rounded-full app-bg-tertiary flex items-center justify-center">
            <svg className="w-4 h-4 app-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-3">
        <div className="flex items-center justify-center gap-2.5 mb-1">
          <img src={logoSrc} alt="Qclaw" style={{ width: 48, height: 48, userSelect: 'none', pointerEvents: 'none' }} />
          <Title order={3} fw={400}>Qclaw</Title>
        </div>
        <Text size="xs" c="dimmed" className="h-4 transition-opacity duration-500">
          {steps[currentStep]?.status === 'checking' || steps[currentStep]?.status === 'installing'
            ? steps[currentStep].description
            : loadingTips[tipIndex]}
        </Text>
        <div className="mt-2 flex items-center justify-center gap-2">
          <Tooltip label={ENV_CHECK_TOOLTIPS.repairPluginEnvironment} withArrow>
            <Button
              size="compact-xs"
              variant="subtle"
              color="yellow"
              loading={pluginRepairRunning}
              onClick={() => { void onRepairPlugins?.() }}
            >
              修复损坏插件环境
            </Button>
          </Tooltip>
        </div>
      </div>

      {pluginRepairResult?.repaired && pluginRepairNoticeVisible && (
        <Alert
          color="yellow"
          variant="light"
          mb="sm"
          title="已自动隔离异常插件"
          withCloseButton
          onClose={() => setPluginRepairNoticeVisible(false)}
        >
          <Text size="xs" className="leading-5">
            {pluginRepairResult.summary}
          </Text>
        </Alert>
      )}

      {pluginRepairErrorSummary && pluginRepairErrorVisible && (
        <Alert
          color="red"
          variant="light"
          mb="sm"
          title="插件问题修复失败"
          withCloseButton
          onClose={() => setPluginRepairErrorVisible(false)}
        >
          <Text size="xs" className="leading-5">
            {pluginRepairErrorSummary}
          </Text>
        </Alert>
      )}

      <div className="mb-5">
        <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--app-bg-inset)' }}>
          <div
            className="h-full rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%`, backgroundColor: 'var(--mantine-color-brand-5)' }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <Text size="xs" c="dimmed">准备中</Text>
          <Text size="xs" c="dimmed">{Math.round(progress)}%</Text>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        {steps.map((step) => (
          <Tooltip
            key={step.id}
            label={ENV_CHECK_STEP_TOOLTIPS[step.id] || step.label}
            withArrow
            multiline
            maw={280}
          >
            <div
              className="flex items-center gap-3 p-3"
              style={{
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--app-border)',
                borderRadius: 'var(--mantine-radius-lg)',
                backgroundColor: 'var(--app-bg-input)',
                transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                ...(step.status === 'checking' || step.status === 'installing'
                  ? { borderColor: 'var(--app-hover-border)', boxShadow: '0 0 8px var(--app-hover-glow)' }
                  : {}),
              }}
            >
              <StatusIcon status={step.status} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${
                  step.status === 'pending' ? 'app-text-muted' : 'app-text-primary'
                }`}>
                  {step.label}
                </div>
                <div className={`text-xs truncate ${
                  step.status === 'error' ? 'app-text-warning' :
                  step.status === 'ok' ? 'app-text-secondary' :
                  step.status === 'pending-install' ? 'app-text-warning' :
                  step.status === 'canceled' ? 'app-text-muted' :
                  step.status === 'checking' || step.status === 'installing' ? 'app-text-secondary' :
                  'app-text-muted'
                }`}>
                  {step.error || step.description}
                </div>
              </div>
              {step.id === 'openclaw' && openClawGateState?.activeCandidate && !isRunning && (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => void handleOpenClawRefresh()}
                  disabled={isRefreshingOpenClawVersion || isUpgradingOpenClaw}
                  title="刷新 OpenClaw 版本"
                >
                  <IconRefresh size={14} />
                </ActionIcon>
              )}
              {step.version && step.status === 'ok' && (
                <div className="text-xs app-text-muted app-bg-tertiary px-2 py-1 rounded">
                  {step.version}
                </div>
              )}
              {step.id === 'openclaw' && step.version && step.status === 'pending-install' && (
                <div className="text-xs app-text-muted app-bg-tertiary px-2 py-1 rounded">
                  {step.version}
                </div>
              )}
              {step.id === 'node' && step.version && step.status === 'pending-install' && (
                <div className="text-xs app-text-muted app-bg-tertiary px-2 py-1 rounded">
                  {step.version}
                </div>
              )}
              {step.progress !== undefined && (step.status === 'installing' || step.status === 'checking') && (
                <div className="text-xs app-text-muted app-bg-tertiary px-2 py-1 rounded min-w-[3rem]">
                  {step.progress}%
                </div>
              )}
              {step.id === 'node' && step.version && step.status === 'pending-install' && shouldOfferManualNodeUpgrade(step.version, nodeRequiredVersion) && (
                <Button
                  size="xs"
                  variant="light"
                  color="blue"
                  onClick={handleNodeUpgrade}
                  disabled={isRunning}
                >
                  手动升级
                </Button>
              )}
              {step.id === 'openclaw' && openClawGateState?.statusLabel && !isRunning && (
                <div className="text-xs app-text-muted">
                  {openClawGateState.statusLabel}
                </div>
              )}
              {step.id === 'openclaw' && openClawGateState?.activeCandidate && !isRunning && canShowOpenClawUpgradeAction(openClawGateState, activeTakeoverBackupBlocked) && (
                <Button
                  size="xs"
                  variant="light"
                  color="green"
                  onClick={() => void handleOpenClawUpgrade()}
                  disabled={isRefreshingOpenClawVersion || isUpgradingOpenClaw}
                  loading={isUpgradingOpenClaw}
                >
                  {openClawGateState.canAutoCorrect ? '重试修复' : '一键升级'}
                </Button>
              )}
            </div>
          </Tooltip>
        ))}
      </div>

      {openClawUpgradeError && (
        <div className="mb-4 rounded-lg p-3" style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--mantine-color-red-5)' }}>
          <Text size="xs" c="red">{openClawUpgradeError}</Text>
        </div>
      )}

      {!isRunning && !fatalIssue && !startupIssuePrompt && readyPayload && shouldShowOpenClawManualHint(openClawGateState, activeTakeoverBackupBlocked) && (
        <Alert
          color="yellow"
          variant="light"
          title="OpenClaw 需要手动调整版本"
          mb="sm"
        >
          <Text size="xs" c="dimmed">{openClawGateState?.manualHint}</Text>
        </Alert>
      )}

      {showInlineStartupIssue && startupIssuePrompt && (
        <div
          className="mb-4 rounded-lg p-3"
          style={{
            backgroundColor: 'var(--app-bg-inset)',
            border: '1px solid var(--app-hover-border)',
          }}
        >
          <Text size="sm" fw={500}>{startupIssuePrompt.title}</Text>
          <Text size="xs" c="dimmed" mt="xs">{startupIssuePrompt.message}</Text>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" color="brand" radius="md" onClick={handleRestartEnvCheck}>
              重试识别
            </Button>
            {startupSupportActions.map((action) => (
              <Button
                key={`${action.kind}:${action.href}`}
                component="a"
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
                variant="light"
                color="brand"
                size="sm"
                radius="md"
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {!isRunning && !fatalIssue && !startupIssuePrompt && readyPayload && takeoverSummary?.detected && (
        <TakeoverNotification
          backupRootDirectory={takeoverSummary.backupRootDirectory}
          failures={takeoverSummary.failures}
          retryingCandidateId={retryingTakeoverCandidateId}
          onRetry={handleRetryTakeoverBackup}
        />
      )}

      {fatalIssue && (
        <div className="rounded-lg p-3" style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--mantine-color-red-5)' }}>
          <Text size="xs" c="red" mb="xs">{fatalIssue.message}</Text>
          <Button
          onClick={() => {
              resetEnvCheck(runAttempt)
            }}
            fullWidth
            size="sm"
            variant="light"
            color="red"
            radius="md"
          >
            继续安装
          </Button>
          {historyOnlyRecoveryFailure && (
            <Button
              onClick={() => setHistoryOnlyRecoveryConfirmOpened(true)}
              fullWidth
              size="sm"
              color="orange"
              radius="md"
              mt="xs"
              disabled={acknowledgingManualBackup}
            >
              已手动备份，确认继续
            </Button>
          )}
          {fatalSupportActions.map((action) => (
            <Button
              key={`${action.kind}:${action.href}`}
              component="a"
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              variant="light"
              color="brand"
              size="xs"
              radius="md"
              mt="xs"
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {startupIssuePrompt && !showInlineStartupIssue && (
        <StartupIssueDialog
          issue={startupIssuePrompt}
          supportActions={startupSupportActions}
          onClose={closeStartupIssue}
          onRestart={handleRestartEnvCheck}
        />
      )}

      {historyOnlyRecoveryFailure && (
        <Modal
          opened={historyOnlyRecoveryConfirmOpened}
          onClose={() => {
            if (acknowledgingManualBackup) return
            setHistoryOnlyRecoveryConfirmOpened(false)
          }}
          title="确认已完成手动备份"
          size="md"
          closeOnClickOutside={!acknowledgingManualBackup}
          closeOnEscape={!acknowledgingManualBackup}
        >
          <div className="space-y-4">
            <Text size="sm">
              请确认你已经完成手动备份，再继续恢复历史 OpenClaw 环境。
            </Text>
            <Text size="xs" c="dimmed">
              {formatTakeoverFailureManualBackupWarning(historyOnlyRecoveryFailure.failure)}
            </Text>
            <Text size="xs" c="dimmed">
              确认后会重新执行环境检查，并继续后续流程。
            </Text>
            <div className="flex justify-end gap-2">
              <Button
                variant="default"
                onClick={() => setHistoryOnlyRecoveryConfirmOpened(false)}
                disabled={acknowledgingManualBackup}
              >
                取消
              </Button>
              <Button
                color="orange"
                onClick={() => void handleConfirmHistoryOnlyManualBackup()}
                loading={acknowledgingManualBackup}
              >
                确认继续
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {!isRunning && !fatalIssue && !startupIssuePrompt && readyPayload && activeTakeoverFailure && (
        <Alert
          color="yellow"
          variant="light"
          title="历史 OpenClaw 自动备份失败"
          mb="sm"
          styles={{ title: { fontSize: 'var(--mantine-font-size-sm)' } }}
        >
          <Text size="xs" c="dimmed">
            {formatTakeoverFailureManualBackupWarning(activeTakeoverFailure)}
          </Text>
          <Text size="xs" c="dimmed" mt="xs">
            为了避免在没有备份的情况下直接接管旧安装，Qclaw 暂时不会继续。你可以重试自动备份；如果已经按上面的路径完成手动备份，也可以继续。
          </Text>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="light"
              color="brand"
              onClick={() => void handleRetryTakeoverBackup(activeTakeoverFailure.candidateId)}
              loading={retryingTakeoverCandidateId === activeTakeoverFailure.candidateId}
              disabled={acknowledgingManualBackup}
            >
              重试备份
            </Button>
            <Button
              size="xs"
              color="orange"
              onClick={() => void handleAcknowledgeManualBackup()}
              loading={acknowledgingManualBackup}
              disabled={retryingTakeoverCandidateId === activeTakeoverFailure.candidateId}
            >
              我已手动备份，继续
            </Button>
          </div>
        </Alert>
      )}

      {!isRunning && !fatalIssue && !startupIssuePrompt && readyPayload && (
        <Button
          onClick={handleContinue}
          fullWidth
          size="sm"
          color="success"
          radius="md"
          disabled={!canContinueWithOpenClawGate(openClawGateState, activeTakeoverBackupBlocked)}
        >
          {readyPayload.sharedConfigInitialized ? '进入控制面板' : '开始配置'}
        </Button>
      )}

      {isRunning && !startupIssuePrompt && (
        <Button
          onClick={handleCancel}
          fullWidth
          size="sm"
          variant="default"
          radius="md"
        >
          取消操作
        </Button>
      )}
    </div>
  )
}
