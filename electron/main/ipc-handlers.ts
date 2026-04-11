/**
 * IPC handlers — bridge between renderer and CLI
 */
import { app, ipcMain, shell } from 'electron'
import {
  checkNode,
  checkOpenClaw,
  type CliResult,
  type RepairIncompatibleExtensionPluginsOptions,
  getOpenClawPaths,
  installOpenClaw,
  installNode,
  downloadNodeInstaller,
  resolveNodeInstallPlan,
  inspectNodeInstaller,
  installEnv,
  uninstallAll,
  runOnboard,
  gatewayHealth,
  gatewayForceRestart,
  getStatus,
  readConfig,
  readEnvFile,
  writeEnvFile,
  runDoctor,
  pairingApprove,
  pairingAddAllowFrom,
  pairingAllowFromUsers,
  pairingFeishuStatus,
  getFeishuBotRuntimeStatuses,
  pairingFeishuAccounts,
  pairingRemoveAllowFrom,
  validateFeishuCredentials,
  installPlugin,
  installPluginNpx,
  repairIncompatibleExtensionPlugins,
  isPluginInstalledOnDisk,
  uninstallPlugin,
  channelsAdd,
  runCli,
  runShell,
  runDirect,
  openDashboard,
  checkOAuthComplete,
  getLatestOAuthUrl,
  openOAuthUrl,
  refreshEnvironment,
  waitForCommandAvailable,
  cancelActiveCommand,
  cancelActiveCommands,
  prepareMacGitTools,
  buildCommandCapabilityEnv,
} from './cli'
import { getModelCatalog, type ModelCatalogQuery } from './openclaw-model-catalog'
import {
  applyModelConfigAction,
  getModelStatus,
  scanLocalModels,
  validateProviderCredential,
  type ModelConfigAction,
  type ModelStatusOptions,
  type LocalModelScanInput,
  type ValidateProviderCredentialInput,
} from './openclaw-model-config'
import {
  testLocalConnection,
  ensureLocalAuthProfile,
  clearModelAuthProfilesByProvider,
  inspectModelAuthProfilesByProvider,
  type LocalConnectionTestInput,
  type EnsureLocalAuthProfileInput,
  type ClearModelAuthProfilesInput,
  type InspectModelAuthProfilesInput,
} from './local-model-probe'
import {
  clearExternalProviderAuth,
  type ClearExternalProviderAuthInput,
} from './external-provider-auth'
import { getOpenClawUpstreamModelState } from './openclaw-upstream-model-state'
import { applyModelConfigViaUpstreamControlUi } from './openclaw-upstream-model-write'
import { getModelVerificationState, recordModelVerification, syncModelVerificationState } from './model-verification-store'
import { runAuthAction, type AuthAction } from './openclaw-auth-orchestrator'
import { appendModelAuthDiagnosticLog } from './model-auth-diagnostic-log'
import { startModelOAuthFlow, type StartModelOAuthRequest } from './model-oauth'
import {
  getModelCenterCapabilities,
  refreshModelData,
  withModelCenterCapabilitiesInvalidatedOnSuccess,
} from './model-center-capabilities'
import {
  inspectOAuthDependencyForAuthChoice,
  installOAuthExternalDependency,
  type InstallOAuthExternalDependencyRequest,
} from './openclaw-oauth-dependencies'
import { discoverOpenClawInstallations, markManagedOpenClawInstall } from './openclaw-install-discovery'
import { checkOpenClawLatestVersion } from './openclaw-latest-version-service'
import {
  ensureBaselineBackup,
  getBaselineBackupStatus,
  skipBaselineBackup,
} from './openclaw-baseline-backup-gate'
import {
  getDataGuardSummary,
  getOwnershipDetails,
  guardedWriteConfig,
  listOwnershipDetailChanges,
  prepareManagedConfigWrite,
} from './openclaw-config-guard'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { guardedWriteEnvFileWithGatewayApply } from './openclaw-env-write-service'
import { listOpenClawBackups, resolveOpenClawBackupDirectoryToOpen } from './openclaw-backup-index'
import { deleteAllOpenClawBackups, deleteOpenClawBackup } from './openclaw-backup-index'
import { getOpenClawEffectiveBackupRootInfo } from './openclaw-backup-roots'
import { runOpenClawManualBackup } from './openclaw-manual-backup-service'
import { buildOpenClawCleanupPreview } from './openclaw-cleanup-planner'
import { prepareQClawUninstall, runOpenClawCleanup } from './openclaw-cleanup-service'
import { runOpenClawDataCleanup } from './openclaw-data-cleanup-service'
import { previewOpenClawRestore, runOpenClawRestore } from './openclaw-restore-service'
import { checkOpenClawUpgrade, runOpenClawUpgrade } from './openclaw-upgrade-service'
import { readOpenClawRuntimeReconcileStore } from './openclaw-runtime-reconcile'
import { withManagedOperationLock } from './managed-operation-lock'
import { probePlatformCommandCapability } from './command-capabilities'
import { buildAppleScriptDoShellScript } from './node-runtime'
import type { FeishuBotDiagnosticSendRequest } from '../../src/shared/feishu-diagnostics'
import {
  checkQClawUpdate,
  downloadQClawUpdate,
  getQClawUpdateStatus,
  installQClawUpdate,
  openQClawUpdateDownloadUrl,
} from './qclaw-update-service'
import { checkCombinedUpdate, runCombinedUpdate } from './combined-update-orchestrator'
import { wecomQrGenerate, wecomQrCheckResult } from './wecom-qr'
import {
  ensureGatewayReady,
  reloadGatewayForConfigChange,
} from './gateway-lifecycle-controller'
import {
  answerFeishuInstallerSessionPrompt,
  getFeishuInstallerSessionSnapshot,
  isFeishuOfficialPluginInstalledOnDisk,
  startFeishuInstallerSession,
  stopFeishuInstallerSession,
  writeFeishuInstallerSessionInput,
} from './feishu-installer-session'
import {
  cancelFeishuBotDiagnosticListen,
  listenForFeishuBotDiagnosticActivity,
  sendFeishuDiagnosticMessage,
} from './feishu-diagnostics'
import {
  getWeixinInstallerSessionSnapshot,
  startWeixinInstallerSession,
  stopWeixinInstallerSession,
} from './weixin-installer-session'
import {
  listWeixinAccountState,
  removeWeixinAccountState,
} from './weixin-account-state'
import {
  ensureFeishuOfficialPluginReady,
  getFeishuOfficialPluginState,
} from './feishu-official-plugin-state'
import { setupDingtalkOfficialChannel } from './dingtalk-official-channel'
import {
  getOfficialChannelStatus,
  repairOfficialChannel,
} from './official-channel-adapters'
import {
  getManagedChannelPluginStatus,
  prepareManagedChannelPluginForSetup,
  repairManagedChannelPlugin,
} from './managed-channel-plugin-lifecycle'
import {
  clearChatTranscript,
  createChatSession,
  createLocalChatSession,
  getChatCapabilitySnapshot,
  getChatSessionDebugSnapshot,
  getChatTranscript,
  getDashboardChatAvailability,
  listChatSessions,
  listChatTraceEntries,
  patchChatSessionModel,
  sendChatMessage,
} from './openclaw-chat-service'
import { parseJsonFromCommandResult, parseJsonFromOutput } from './openclaw-command-output'
import {
  buildBundledFallbackSkillsPayload,
  findBundledManifestSkillByNameOrKey,
  findNormalizedSkillByNameOrKey,
  isUnsupportedSkillsCommand,
  normalizeSkillConfigKey,
  normalizeSkillInfoCliResult,
  normalizeOpenClawSkillsPayload,
  normalizeSkillsPayloadCliResult,
} from './openclaw-skills'
import {
  buildClawHubInstallArgs,
  buildClawHubUninstallArgs,
  resolveClawHubLockFilePath,
  resolveOpenClawSkillLocations,
} from './skills-paths'
import {
  buildManagedSkillNameSet,
  findVisibleInstalledSkillName,
  resolveInstalledSkillVerificationState,
} from './skills-visibility'
import {
  findExactSafeSkillSlugMatch,
  normalizeSafeSkillSlug,
} from './skills-uninstall-safety'
import { removeManagedSkillLocally, removeSkillDirectoryLocally } from './skills-managed-uninstall'
import { withExclusiveSkillMutation } from './skill-mutation-guard'

const { randomUUID } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
const { appendFile, readFile, rm } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

function resolveGatewayRequestId(requestId?: string): string {
  const normalized = String(requestId || '').trim()
  return normalized || randomUUID()
}

const DEFAULT_CANCEL_DOMAINS = [
  'env-setup',
  'oauth',
  'chat',
  'plugin-install',
  'config-write',
  'gateway',
  'upgrade',
  'models',
  'capabilities',
  'env',
  'feishu-installer',
  'weixin-installer',
  'global',
] as const

let ipcHandlersRegistered = false

function normalizeSafeInstallPackageName(raw: string): string | null {
  const normalized = String(raw || '').trim()
  if (!normalized || normalized.length > 120) return null
  if (normalized.startsWith('-')) return null
  if (!/^[A-Za-z0-9@/+._-]+$/.test(normalized)) return null
  if (normalized.includes('..') || normalized.includes('//')) return null
  return normalized
}

function normalizeSafeInstallBinName(raw: string): string | null {
  const normalized = String(raw || '').trim()
  if (!normalized || normalized.length > 80) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) return null
  return normalized
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function setConfigPathValue(target: Record<string, any>, path: string, value: unknown): void {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0) return

  let cursor: Record<string, any> = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, any>
  }

  cursor[segments[segments.length - 1]] = value
}

function buildBundledFallbackSkillsCliResult(
  config?: Record<string, unknown> | null,
  baseResult?: Partial<CliResult>
): CliResult {
  return {
    ok: true,
    stdout: JSON.stringify(buildBundledFallbackSkillsPayload(config)),
    stderr: baseResult?.stderr || '',
    code: 0,
  }
}

async function runSkillsListCli(): Promise<CliResult> {
  const config = (await readConfig().catch(() => null)) as Record<string, unknown> | null
  const listResult = normalizeSkillsPayloadCliResult(
    await runCli(['skills', 'list', '--json'], undefined, 'plugin-install')
  )
  if (listResult.ok) {
    if (!listResult.stdout && !listResult.stderr) {
      return buildBundledFallbackSkillsCliResult(config, listResult)
    }
    try {
      const payload = parseJsonFromCommandResult<Record<string, unknown>>(listResult)
      return {
        ...listResult,
        stdout: JSON.stringify(normalizeOpenClawSkillsPayload(payload, { config })),
      }
    } catch {
      return listResult
    }
  }

  if (isUnsupportedSkillsCommand(listResult)) {
    const statusResult = normalizeSkillsPayloadCliResult(
      await runCli(['skills', 'status', '--json'], undefined, 'plugin-install')
    )
    if (statusResult.ok && (statusResult.stdout || statusResult.stderr)) {
      try {
        const payload = parseJsonFromCommandResult<Record<string, unknown>>(statusResult)
        return {
          ...statusResult,
          stdout: JSON.stringify(normalizeOpenClawSkillsPayload(payload, { config })),
        }
      } catch {
        return statusResult
      }
    }

    if (isUnsupportedSkillsCommand(statusResult)) {
      return buildBundledFallbackSkillsCliResult(config, statusResult)
    }

    return statusResult
  }

  return listResult
}

async function resolveSkillConfigKeyFromIdentifier(skillIdentifier: string): Promise<string | null> {
  const payload = await getOpenClawSkillsListPayload({ attempts: 2, retryDelayMs: 250 })
  const matchedSkill = findNormalizedSkillByNameOrKey(payload, skillIdentifier)
  return normalizeSkillConfigKey(matchedSkill?.skillKey || skillIdentifier)
}

async function updateSkillConfigEntry(input: {
  skillKey: string
  enabled?: boolean
  apiKey?: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const skillKey = await resolveSkillConfigKeyFromIdentifier(input.skillKey)
    if (!skillKey) {
      return { ok: false, error: 'skill key 无效' }
    }

    const config = await readConfig()
    if (!config) return { ok: false, error: 'config not found' }
    const beforeConfig = JSON.parse(JSON.stringify(config)) as Record<string, any>
    const payload = await getOpenClawSkillsListPayload({ attempts: 2, retryDelayMs: 250 })
    const matchedSkill = findNormalizedSkillByNameOrKey(payload, skillKey)
    const configKeys = matchedSkill?.configKeys || []

    if (typeof input.enabled === 'boolean' && configKeys.length > 0) {
      for (const configKey of configKeys) {
        setConfigPathValue(config, configKey, input.enabled)
      }
    } else {
      if (!config.skills) config.skills = {}
      if (!config.skills.entries) config.skills.entries = {}
      if (!config.skills.entries[skillKey]) config.skills.entries[skillKey] = {}
      const entry = config.skills.entries[skillKey] as Record<string, any>
      if (typeof input.enabled === 'boolean') {
        entry.enabled = input.enabled
      }
      if (typeof input.apiKey === 'string') {
        entry.apiKey = input.apiKey
      }
    }

    if (typeof input.apiKey === 'string') {
      if (!config.skills) config.skills = {}
      if (!config.skills.entries) config.skills.entries = {}
      if (!config.skills.entries[skillKey]) config.skills.entries[skillKey] = {}
      const entry = config.skills.entries[skillKey] as Record<string, any>
      entry.apiKey = input.apiKey
    }

    const writeResult = await applyConfigPatchGuarded({
      beforeConfig,
      afterConfig: config,
      reason: 'unknown',
    })
    if (!writeResult.ok) {
      return {
        ok: false,
        error: writeResult.message || 'skills update 写入失败',
      }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

async function installSkillWithOfficialFallback(skillSlug: string): Promise<CliResult> {
  const safeName = normalizeSafeSkillSlug(skillSlug)
  if (!safeName) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Invalid skill slug. Only letters, numbers, dot, underscore, and hyphen are allowed.',
      code: 1,
    }
  }

  const nativeResult = await runCli(['skills', 'install', safeName], 120_000, 'plugin-install')
  if (nativeResult.ok || !isUnsupportedSkillsCommand(nativeResult)) {
    return nativeResult
  }

  const locations = resolveOpenClawSkillLocations(await getOpenClawSkillsListPayload())
  return runShell(
    'npx',
    ['-y', 'clawhub', '--workdir', locations.workspaceDir, '--dir', 'skills', 'install', safeName],
    120_000,
    { cwd: locations.workspaceDir, controlDomain: 'plugin-install' }
  )
}

function shouldFallbackAfterNativeSkillUninstall(result: CliResult): boolean {
  if (isUnsupportedSkillsCommand(result)) return true
  const corpus = `${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase()
  return /not found|not installed|no installed/i.test(corpus)
}

async function getOpenClawSkillsListPayload(options?: {
  attempts?: number
  retryDelayMs?: number
}): Promise<Record<string, unknown> | null> {
  const attempts = Math.max(1, options?.attempts ?? 1)
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250)

  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runSkillsListCli()
    if (result.ok && result.stdout) {
      try {
        return JSON.parse(result.stdout) as Record<string, unknown>
      } catch {
        // Try again below.
      }
    }

    if (attempt < attempts - 1) {
      await wait(retryDelayMs)
    }
  }

  return null
}

async function waitForInstalledSkillVisibility(params: {
  slug: string
  beforeManagedSkillNames: Set<string>
  allowDiffDetection: boolean
  timeoutMs?: number
  intervalMs?: number
}): Promise<{ visibleName: string; payload: Record<string, unknown> | null } | null> {
  const timeoutMs = params.timeoutMs ?? 8_000
  const intervalMs = params.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  let lastPayload: Record<string, unknown> | null = null

  while (Date.now() <= deadline) {
    const payload = await getOpenClawSkillsListPayload()
    lastPayload = payload
    const visibleName = findVisibleInstalledSkillName({
      slug: params.slug,
      beforeManagedSkillNames: params.beforeManagedSkillNames,
      allowDiffDetection: params.allowDiffDetection,
      payload,
    })
    if (visibleName) {
      return { visibleName, payload }
    }

    if (Date.now() + intervalMs > deadline) break
    await wait(intervalMs)
  }

  return lastPayload
    ? {
        visibleName: '',
        payload: lastPayload,
      }
    : null
}

export function registerIpcHandlers() {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

  ipcMain.handle('app:quit', () => {
    setImmediate(() => app.quit())
    return true
  })

  ipcMain.handle('paths:openclaw:get', () => getOpenClawPaths())

  // Environment checks
  ipcMain.handle('env:checkNode', () => checkNode())
  ipcMain.handle('env:checkOpenClaw', () => checkOpenClaw())
  ipcMain.handle('env:prepareMacGitTools', () => prepareMacGitTools())
  ipcMain.handle('env:installNode', () => installNode())
  ipcMain.handle('env:resolveNodeInstallPlan', () => resolveNodeInstallPlan())
  ipcMain.handle('env:downloadNodeInstaller', (_e, plan) => downloadNodeInstaller(plan))
  ipcMain.handle('env:inspectNodeInstaller', (_e, installerPath: string) => inspectNodeInstaller(installerPath))
  ipcMain.handle('env:installEnv', (_e, opts) =>
    withModelCenterCapabilitiesInvalidatedOnSuccess(() => installEnv(opts))
  )

  // Environment refresh
  ipcMain.handle('env:refresh', () => withModelCenterCapabilitiesInvalidatedOnSuccess(() => refreshEnvironment()))
  ipcMain.handle('env:waitForCommand', (_e, command: string, args?: string[]) =>
    waitForCommandAvailable(command, args, undefined, undefined, 'env-setup')
  )

  // Command control
  ipcMain.handle('command:cancel', async () => {
    const result = await cancelActiveCommands([...DEFAULT_CANCEL_DOMAINS])
    return result.canceledDomains.length > 0
  })
  ipcMain.handle('command:cancel-detailed', () => cancelActiveCommands([...DEFAULT_CANCEL_DOMAINS]))
  ipcMain.handle('command:cancel-domain', (_e, domain: string) => {
    const normalizedDomain = String(domain || '').trim()
    if (!normalizedDomain) return false
    return cancelActiveCommand(normalizedDomain)
  })
  ipcMain.handle('command:cancel-batch', (_e, domains: string[]) => {
    const normalizedDomains = Array.from(
      new Set(
        (domains || [])
          .map((domain) => String(domain || '').trim())
          .filter(Boolean)
      )
    )
    if (normalizedDomains.length === 0) {
      return {
        canceledDomains: [],
        failedDomains: [],
        untouchedDomains: [],
      }
    }
    return cancelActiveCommands(normalizedDomains)
  })

  // Install
  ipcMain.handle('install:openclaw', () =>
    withModelCenterCapabilitiesInvalidatedOnSuccess(() => installOpenClaw())
  )
  ipcMain.handle('openclaw:discover', () => discoverOpenClawInstallations())
  ipcMain.handle('openclaw:latest:check', () => checkOpenClawLatestVersion())
  ipcMain.handle('openclaw:baseline-backup:ensure', (_e, candidate) => ensureBaselineBackup(candidate))
  ipcMain.handle('openclaw:baseline-backup:skip', (_e, candidate) => skipBaselineBackup(candidate))
  ipcMain.handle('openclaw:baseline-backup:get-status', (_e, installFingerprint: string) =>
    getBaselineBackupStatus(installFingerprint)
  )
  ipcMain.handle('openclaw:managed:mark', (_e, installFingerprint: string) =>
    markManagedOpenClawInstall(installFingerprint)
  )
  ipcMain.handle('openclaw:data-guard:get', (_e, candidate) => getDataGuardSummary(candidate))
  ipcMain.handle('openclaw:config:prepare', (_e, candidate) => prepareManagedConfigWrite(candidate))
  ipcMain.handle('openclaw:config:guarded-write', (_e, request, candidate) =>
    guardedWriteConfig(request, candidate)
  )
  ipcMain.handle('openclaw:config:apply-patch', (_e, request, candidate) =>
    applyConfigPatchGuarded(request, candidate)
  )
  ipcMain.handle('openclaw:env:guarded-write', (_e, request, candidate) =>
    guardedWriteEnvFileWithGatewayApply(request, candidate)
  )
  ipcMain.handle('openclaw:ownership:get', (_e, installFingerprint: string) =>
    getOwnershipDetails(installFingerprint)
  )
  ipcMain.handle('openclaw:ownership:list-changes', (_e, installFingerprint: string) =>
    listOwnershipDetailChanges(installFingerprint)
  )
  ipcMain.handle('openclaw:cleanup:preview', (_e, request) => buildOpenClawCleanupPreview(request))
  ipcMain.handle('openclaw:cleanup:run', (_e, request) => runOpenClawCleanup(request))
  ipcMain.handle('openclaw:data-cleanup:run', (_e, request) => runOpenClawDataCleanup(request))
  ipcMain.handle('qclaw:uninstall:preview', (_e, request) => buildOpenClawCleanupPreview(request))
  ipcMain.handle('qclaw:uninstall:prepare', (_e, request) => prepareQClawUninstall(request))
  ipcMain.handle('openclaw:backup:list', () => listOpenClawBackups())
  ipcMain.handle('openclaw:backup:get-root', () => getOpenClawEffectiveBackupRootInfo())
  ipcMain.handle('openclaw:backup:delete', (_e, backupId: string) => deleteOpenClawBackup(backupId))
  ipcMain.handle('openclaw:backup:delete-all', () => deleteAllOpenClawBackups())
  ipcMain.handle('openclaw:backup:run-manual', () => runOpenClawManualBackup())
  ipcMain.handle('openclaw:backup:open-dir', async (_e, targetPath?: string) => {
    const resolvedPath = await resolveOpenClawBackupDirectoryToOpen(targetPath)
    const error = await shell.openPath(resolvedPath)
    return {
      ok: !error,
      path: resolvedPath,
      error: error || '',
    }
  })
  ipcMain.handle('openclaw:open-workspace', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const workspacePath = path.join(os.homedir(), '.openclaw')
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true })
    }
    const error = await shell.openPath(workspacePath)
    return { ok: !error, path: workspacePath, error: error || '' }
  })
  ipcMain.handle('openclaw:restore:preview', (_e, backupId: string) => previewOpenClawRestore(backupId))
  ipcMain.handle('openclaw:restore:run', (_e, backupId: string, scope) => runOpenClawRestore(backupId, scope))
  ipcMain.handle('openclaw:upgrade:check', () => checkOpenClawUpgrade())
  ipcMain.handle('openclaw:upgrade:run', () =>
    withModelCenterCapabilitiesInvalidatedOnSuccess(() => runOpenClawUpgrade())
  )
  ipcMain.handle('qclaw:update:status', () => getQClawUpdateStatus())
  ipcMain.handle('qclaw:update:check', () => checkQClawUpdate())
  ipcMain.handle('qclaw:update:check-on-startup', () => checkQClawUpdate())
  ipcMain.handle('qclaw:update:download', () => downloadQClawUpdate())
  ipcMain.handle('qclaw:update:install', () => installQClawUpdate())
  ipcMain.handle('qclaw:update:open-download-url', () => openQClawUpdateDownloadUrl())
  ipcMain.handle('combined:update:check', () => checkCombinedUpdate())
  ipcMain.handle('combined:update:run', () =>
    withModelCenterCapabilitiesInvalidatedOnSuccess(() => runCombinedUpdate())
  )

  // Onboard
  ipcMain.handle('setup:onboard', (_e, opts) => runOnboard(opts))

  // Gateway
  ipcMain.handle('gateway:health', () => gatewayHealth())
  ipcMain.handle('gateway:runtime-reconcile:state:get', () => readOpenClawRuntimeReconcileStore())
  ipcMain.handle('gateway:force-restart', () => gatewayForceRestart())
  ipcMain.handle('gateway:reload-after-model-change', () =>
    reloadGatewayForConfigChange('model-change', { preferEnsureWhenNotRunning: true })
  )
  ipcMain.handle('gateway:reload-after-channel-change', () =>
    reloadGatewayForConfigChange('channel-change', { preferEnsureWhenNotRunning: true })
  )
  ipcMain.handle('gateway:reload-manual', () =>
    reloadGatewayForConfigChange('manual-reload', { preferEnsureWhenNotRunning: true })
  )
  ipcMain.handle(
    'gateway:ensure-running',
    async (event, options?: { skipRuntimePrecheck?: boolean; requestId?: string }) => {
      const requestId = resolveGatewayRequestId(options?.requestId)
      const result = await ensureGatewayReady(
        {
          onStateChange: (state) => {
            event.sender.send('gateway:bootstrap:state', {
              ...state,
              requestId,
            })
          },
          skipRuntimePrecheck: options?.skipRuntimePrecheck,
        },
        'ipc-gateway-ensure-running'
      )
      return {
        ...result,
        requestId,
      }
    }
  )

  // Status
  ipcMain.handle('status:get', () => getStatus())

  // Config
  ipcMain.handle('config:read', () => readConfig())

  // Env file
  ipcMain.handle('env:read', () => readEnvFile())

  // Doctor
  ipcMain.handle('doctor:run', (_e, options?: { fix?: boolean; nonInteractive?: boolean }) => runDoctor(options))

  // Pairing
  ipcMain.handle('pairing:approve', (_e, channel: string, code: string, accountId?: string) =>
    pairingApprove(channel, code, accountId)
  )
  ipcMain.handle('pairing:addAllowFrom', (_e, channel: string, senderId: string, accountId?: string) =>
    pairingAddAllowFrom(channel, senderId, accountId)
  )
  ipcMain.handle('pairing:allowFromUsers', (_e, channel: string, accountId?: string) =>
    pairingAllowFromUsers(channel, accountId)
  )
  ipcMain.handle('pairing:feishuStatus', (_e, accountIds: string[]) => pairingFeishuStatus(accountIds))
  ipcMain.handle('feishu:runtime-status', () => getFeishuBotRuntimeStatuses())
  ipcMain.handle('pairing:feishuAccounts', (_e, accountId?: string) => pairingFeishuAccounts(accountId))
  ipcMain.handle('pairing:removeAllowFrom', (_e, channel: string, senderId: string, accountId?: string) =>
    pairingRemoveAllowFrom(channel, senderId, accountId)
  )

  // Plugins
  ipcMain.handle('plugins:install', (_e, name: string, expectedPluginIds?: string[]) => installPlugin(name, expectedPluginIds))
  ipcMain.handle('plugins:installNpx', (_e, url: string, expectedPluginIds?: string[]) => installPluginNpx(url, expectedPluginIds))
  ipcMain.handle('plugins:repair-incompatible', (_e, options?: RepairIncompatibleExtensionPluginsOptions) =>
    repairIncompatibleExtensionPlugins(options || {})
  )
  ipcMain.handle('plugins:installed-on-disk', (_e, pluginId: string) => isPluginInstalledOnDisk(pluginId))
  ipcMain.handle('plugins:uninstall', (_e, name: string) => uninstallPlugin(name))
  ipcMain.handle('plugins:feishu-installed', () => isFeishuOfficialPluginInstalledOnDisk())
  ipcMain.handle('plugins:feishu-state', () => getFeishuOfficialPluginState())
  ipcMain.handle('plugins:feishu-ensure-ready', () => ensureFeishuOfficialPluginReady())
  ipcMain.handle('feishu:credentials:validate', (_e, appId: string, appSecret: string, domain?: string) =>
    validateFeishuCredentials(appId, appSecret, domain)
  )
  ipcMain.handle('feishu:installer:state:get', () => getFeishuInstallerSessionSnapshot())
  ipcMain.handle('feishu:installer:start', (event) =>
    startFeishuInstallerSession((payload) => {
      event.sender.send('feishu:installer:event', payload)
    })
  )
  ipcMain.handle('feishu:installer:input', (_e, sessionId: string, input: string) =>
    writeFeishuInstallerSessionInput(sessionId, input)
  )
  ipcMain.handle('feishu:installer:prompt:answer', (_e, sessionId: string, promptId: string, resolution: 'confirm' | 'cancel') =>
    answerFeishuInstallerSessionPrompt(sessionId, promptId, resolution)
  )
  ipcMain.handle('feishu:installer:stop', () => stopFeishuInstallerSession())
  ipcMain.handle('feishu:diagnostics:listen', (_e, accountId?: string, timeoutMs?: number, requestId?: string) =>
    listenForFeishuBotDiagnosticActivity({ accountId, timeoutMs, requestId })
  )
  ipcMain.handle('feishu:diagnostics:cancel-listen', (_e, requestId: string) =>
    cancelFeishuBotDiagnosticListen(requestId)
  )
  ipcMain.handle('feishu:diagnostics:send', (_e, request: FeishuBotDiagnosticSendRequest) =>
    sendFeishuDiagnosticMessage(request)
  )
  ipcMain.handle('weixin:installer:state:get', () => getWeixinInstallerSessionSnapshot())
  ipcMain.handle('weixin:installer:start', (event) =>
    startWeixinInstallerSession((payload) => {
      event.sender.send('weixin:installer:event', payload)
    })
  )
  ipcMain.handle('weixin:installer:stop', () => stopWeixinInstallerSession())
  ipcMain.handle('weixin:accounts:list', () => listWeixinAccountState())
  ipcMain.handle('weixin:accounts:remove', (_e, accountId: string) => removeWeixinAccountState(accountId))

  // Repair progress (stub — real data wired in a later stage)
  ipcMain.handle('managed-plugin:repair:active', () => [])

  // Channels
  ipcMain.handle('channels:add', (_e, channel: string, token: string) => channelsAdd(channel, token))
  ipcMain.handle('channels:dingtalk:setup-official', (_e, formData: Record<string, string>) =>
    setupDingtalkOfficialChannel(formData)
  )
  ipcMain.handle('channels:official:status', (_e, channelId: 'feishu' | 'dingtalk') =>
    getOfficialChannelStatus(channelId)
  )
  ipcMain.handle('channels:official:repair', (_e, channelId: 'feishu' | 'dingtalk') =>
    repairOfficialChannel(channelId)
  )
  ipcMain.handle('channels:managed:status', (_e, channelId: string) =>
    getManagedChannelPluginStatus(channelId)
  )
  ipcMain.handle('channels:managed:prepare', (_e, channelId: string) =>
    prepareManagedChannelPluginForSetup(channelId)
  )
  ipcMain.handle('channels:managed:repair', (_e, channelId: string) =>
    repairManagedChannelPlugin(channelId)
  )

  // Dashboard
  ipcMain.handle('dashboard:open', () => openDashboard())
  ipcMain.handle('chat:availability:get', () => getDashboardChatAvailability())
  ipcMain.handle('chat:sessions:list', () => listChatSessions())
  ipcMain.handle('chat:session:create', () => createChatSession())
  ipcMain.handle('chat:session:create:local', () => createLocalChatSession())
  ipcMain.handle('chat:capabilities:get', () => getChatCapabilitySnapshot())
  ipcMain.handle('chat:debug-snapshot:get', (_e, sessionId: string) => getChatSessionDebugSnapshot(sessionId))
  ipcMain.handle('chat:trace:list', (_e, limit?: number) => listChatTraceEntries(limit))
  ipcMain.handle('chat:session:model:patch', (_e, request) => patchChatSessionModel(request))
  ipcMain.handle('chat:transcript:get', (_e, sessionId: string) => getChatTranscript(sessionId))
  ipcMain.handle('chat:send', (event, request) =>
    sendChatMessage(request, {
      emit: (payload) => {
        event.sender.send('chat:stream', payload)
      },
    })
  )
  ipcMain.handle('chat:cancel', () => cancelActiveCommand('chat'))
  ipcMain.handle('chat:transcript:clear', (_e, sessionId: string) => clearChatTranscript(sessionId))

  // Uninstall
  ipcMain.handle('uninstall:all', () => uninstallAll())

  // OAuth
  ipcMain.handle('check-oauth-complete', (_e, providerKey: string) => checkOAuthComplete(providerKey))
  ipcMain.handle('oauth:latest-url:get', () => getLatestOAuthUrl())
  ipcMain.handle('oauth:url:open', (_e, url?: string) => openOAuthUrl(url))
  ipcMain.handle('oauth:dependency:inspect', (_e, authChoice: string) =>
    inspectOAuthDependencyForAuthChoice(authChoice)
  )
  ipcMain.handle('oauth:dependency:install', (_e, request: InstallOAuthExternalDependencyRequest) =>
    installOAuthExternalDependency(request)
  )

  // Models center
  ipcMain.handle('models:capabilities:get', () => getModelCenterCapabilities())
  ipcMain.handle('models:catalog:list', (_e, query?: ModelCatalogQuery) => getModelCatalog({ query }))
  ipcMain.handle('models:status:get', (_e, options?: ModelStatusOptions) => getModelStatus(options || {}))
  ipcMain.handle('models:upstream-state:get', (_e, options?: { timeoutMs?: number; loadTimeoutMs?: number }) =>
    getOpenClawUpstreamModelState(options || {})
  )
  ipcMain.handle('models:verification:sync', (_e, input?: { statusData?: Record<string, any> | null }) =>
    syncModelVerificationState(input || {})
  )
  ipcMain.handle('models:verification:record', (_e, input: {
    modelKey: string
    verificationState: 'verified-available' | 'verified-unavailable'
  }) => recordModelVerification(input))
  ipcMain.handle('models:upstream-write:apply', (_e, request) => applyModelConfigViaUpstreamControlUi(request))
  ipcMain.handle('models:provider:validate', (_e, input: ValidateProviderCredentialInput) => validateProviderCredential(input))
  ipcMain.handle('models:config:apply', (_e, action: ModelConfigAction) => applyModelConfigAction(action))
  ipcMain.handle('models:auth:run', (_e, action: AuthAction) => runAuthAction(action))
  ipcMain.handle('model-auth:diagnostic:append', async (_e, entry: Record<string, any>) => {
    await appendModelAuthDiagnosticLog({
      source: String(entry?.source || '').trim(),
      event: String(entry?.event || '').trim(),
      providerId: String(entry?.providerId || '').trim() || undefined,
      methodId: String(entry?.methodId || '').trim() || undefined,
      attemptId: entry?.attemptId,
      details:
        entry?.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
          ? entry.details
          : undefined,
    })
    return true
  })
  ipcMain.handle('models:oauth:start', (event, request: StartModelOAuthRequest) =>
    startModelOAuthFlow(request, {
      emit: (channel, payload) => {
        event.sender.send(channel, payload)
      },
    })
  )
  ipcMain.handle('models:oauth:cancel', () => cancelActiveCommand('oauth'))
  ipcMain.handle(
    'models:refresh',
    async (
      _e,
      payload?: {
        includeCapabilities?: boolean
        includeStatus?: boolean
        includeCatalog?: boolean
        fullCatalog?: boolean
        forceCapabilitiesRefresh?: boolean
        catalogQuery?: ModelCatalogQuery
        statusOptions?: ModelStatusOptions
      }
    ) =>
      refreshModelData({
        includeCapabilities: payload?.includeCapabilities,
        includeStatus: payload?.includeStatus,
        includeCatalog: payload?.includeCatalog,
        fullCatalog: payload?.fullCatalog,
        forceCapabilitiesRefresh: payload?.forceCapabilitiesRefresh,
        catalogQuery: payload?.catalogQuery,
        statusOptions: payload?.statusOptions,
      })
  )

  // Local model support
  ipcMain.handle('local-models:test-connection', (_e, input: LocalConnectionTestInput) =>
    testLocalConnection(input)
  )
  ipcMain.handle('local-models:scan', (_e, input: LocalModelScanInput) =>
    scanLocalModels(input)
  )
  ipcMain.handle('local-models:write-env', (_e, updates: Record<string, string | undefined>) =>
    writeEnvFile(updates)
  )
  ipcMain.handle('local-models:ensure-auth', (_e, input: EnsureLocalAuthProfileInput) =>
    ensureLocalAuthProfile(input)
  )
  ipcMain.handle('local-models:clear-auth-profiles', (_e, input: ClearModelAuthProfilesInput) =>
    clearModelAuthProfilesByProvider(input)
  )
  ipcMain.handle('local-models:inspect-auth-profiles', (_e, input: InspectModelAuthProfilesInput) =>
    inspectModelAuthProfilesByProvider(input)
  )
  ipcMain.handle('local-models:clear-external-auth', (_e, input: ClearExternalProviderAuthInput) =>
    clearExternalProviderAuth(input)
  )

  // WeChat Work QR binding
  ipcMain.handle('wecom:qr:generate', () => wecomQrGenerate())
  ipcMain.handle('wecom:qr:check', (_e, scode: string) => wecomQrCheckResult(scode))

  // Skills 管理
  ipcMain.handle('skills:list', async () => {
    return runSkillsListCli()
  })

  ipcMain.handle('skills:info', async (_e, name: string) => {
    const result = await runCli(['skills', 'info', name, '--json'], undefined, 'plugin-install')
    const normalized = normalizeSkillInfoCliResult(result)
    if (normalized.ok || !isUnsupportedSkillsCommand(normalized)) {
      return normalized
    }

    const config = (await readConfig().catch(() => null)) as Record<string, unknown> | null
    const bundledSkill = findBundledManifestSkillByNameOrKey(name, config)
    if (!bundledSkill) {
      return normalized
    }

    return {
      ok: true,
      stdout: JSON.stringify(bundledSkill),
      stderr: '',
      code: 0,
    }
  })

  ipcMain.handle(
    'skills:update',
    (
      _e,
      input: {
        skillKey: string
        enabled?: boolean
        apiKey?: string
      }
    ) => updateSkillConfigEntry(input)
  )

  ipcMain.handle('skills:toggle', async (_e, name: string, enabled: boolean) => {
    return updateSkillConfigEntry({
      skillKey: name,
      enabled,
    })
  })

  const getOpenClawSkillLocations = async () => {
    const payload = await getOpenClawSkillsListPayload()
    return resolveOpenClawSkillLocations(payload)
  }

  ipcMain.handle('skills:uninstall', async (_e, name: string) => {
    const normalizedName = String(name || '').trim()
    if (!normalizedName) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Invalid skill name.',
        code: 1,
      }
    }

    return withExclusiveSkillMutation('uninstall', normalizedName, async () => {
      const nativeResult = await runCli(['skills', 'uninstall', normalizedName], undefined, 'plugin-install')
      if (nativeResult.ok || !shouldFallbackAfterNativeSkillUninstall(nativeResult)) {
        return nativeResult
      }

      const payload = await getOpenClawSkillsListPayload()
      const matchedSkill = findNormalizedSkillByNameOrKey(payload, normalizedName)
      const safeName = normalizeSafeSkillSlug(matchedSkill?.skillKey || normalizedName)
      if (!safeName) {
        return nativeResult
      }

      const locations = resolveOpenClawSkillLocations(payload)
      if (matchedSkill?.source === 'openclaw-workspace') {
        const workspaceRemovalResult = await removeSkillDirectoryLocally(safeName, locations.workspaceSkillsDir)
        if (workspaceRemovalResult) {
          return workspaceRemovalResult
        }
      }

      const localRemovalResult = await removeManagedSkillLocally(safeName, locations)
      if (localRemovalResult) {
        return localRemovalResult
      }

      // Try clawhub uninstall with the exact name
      const r1 = await runShell(
        'npx',
        buildClawHubUninstallArgs(safeName, locations),
        undefined,
        { cwd: locations.clawhubWorkdir, controlDomain: 'plugin-install' }
      )
      if (r1.ok) return r1
      // Try clawhub uninstall by scanning lock file for matching slug
      try {
        const lock = JSON.parse(await readFile(resolveClawHubLockFilePath(locations), 'utf8'))
        const slugs = Object.keys(lock.skills || {})
        const safeMatch = findExactSafeSkillSlugMatch(safeName, slugs)
        if (safeMatch && safeMatch !== safeName) {
          const r2 = await runShell(
            'npx',
            buildClawHubUninstallArgs(safeMatch, locations),
            undefined,
            { cwd: locations.clawhubWorkdir, controlDomain: 'plugin-install' }
          )
          if (r2.ok) return r2
        }
      } catch {
        /* ignore parse/read error */
      }
      const fallbackLocalRemovalResult = await removeManagedSkillLocally(safeName, locations)
      if (fallbackLocalRemovalResult) {
        return fallbackLocalRemovalResult
      }
      // Last resort: openclaw plugins uninstall
      return runCli(['plugins', 'uninstall', safeName], undefined, 'plugin-install')
    })
  })

  ipcMain.handle('skills:install', async (_e, name: string) => {
    return withExclusiveSkillMutation('install', name, async () => installSkillWithOfficialFallback(name))
  })

  ipcMain.handle('clawhub:search', async (_e, query: string, limit = 10) => {
    const locations = await getOpenClawSkillLocations()
    const result = await runShell(
      'npx',
      ['-y', 'clawhub', 'search', query, '--limit', String(limit), '--registry', 'https://mirror-cn.clawhub.com'],
      undefined,
      { cwd: locations.clawhubWorkdir, controlDomain: 'plugin-install' }
    )
    if (!result.ok) return { ok: false, skills: [], error: result.stderr }
    const skills: { slug: string; name: string; score: number }[] = []
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\S+)\s{2,}(.+?)\s{2,}\(([0-9.]+)\)/)
      if (match) {
        skills.push({ slug: match[1], name: match[2].trim(), score: parseFloat(match[3]) })
      }
    }
    return { ok: true, skills }
  })

  ipcMain.handle('clawhub:install', async (_e, slug: string) => {
    return withExclusiveSkillMutation('install', slug, async () => installSkillWithOfficialFallback(slug))
  })

  // 检查 brew 是否可用
  const isBrewAvailable = async (): Promise<boolean> => {
    const defaultProbe = await runShell('brew', ['--version'], 10_000, 'env-setup')
    if (defaultProbe.ok) return true
    const optHomebrewProbe = await runShell('/opt/homebrew/bin/brew', ['--version'], 10_000, 'env-setup')
    if (optHomebrewProbe.ok) return true
    const usrLocalProbe = await runShell('/usr/local/bin/brew', ['--version'], 10_000, 'env-setup')
    return usrLocalProbe.ok
  }

  ipcMain.handle('deps:installBin', async (_e, bin: string) => {
    return withManagedOperationLock('runtime-install', async () => {
      const safePackage = normalizeSafeInstallPackageName(bin)
      if (!safePackage) {
        return {
          ok: false,
          stdout: '',
          stderr: '依赖名非法。仅允许字母、数字、@、/、+、点、下划线、短横线。',
          code: 1,
        }
      }

      // Try npm first, fall back to brew on macOS
      const npmResult = await runShell('npm', ['install', '-g', safePackage], undefined, 'env-setup')
      if (npmResult.ok) return npmResult
      if (process.platform === 'darwin') {
        const brewResult = await runShell('brew', ['install', safePackage], undefined, 'env-setup')
        if (brewResult.ok) return brewResult
      }
      return npmResult
    })
  })

  // 按 skill 维度安装依赖：npx → brew → 提示用户
  ipcMain.handle('deps:installSkillDeps', async (event, skillName: string) => {
    return withManagedOperationLock('runtime-install', async () => {
      const log = (msg: string) => event.sender.send('deps:install:log', msg)

      const verifyBin = async (bin: string): Promise<boolean> => {
        const check = await runShell(
          process.platform === 'win32' ? 'where' : 'which',
          [bin],
          undefined,
          'env-setup'
        )
        return check.ok
      }

      const checkAllResolved = async (bins: string[]): Promise<boolean> => {
        for (const bin of bins) {
          if (!await verifyBin(bin)) return false
        }
        return true
      }

      // 获取 skill 信息
      log(`获取 ${skillName} 的安装信息...`)
      const infoResult = await runCli(['skills', 'info', skillName, '--json'], undefined, 'plugin-install')
      if (!infoResult.ok || !infoResult.stdout) {
        log(`无法获取 ${skillName} 的安装信息`)
        return { ok: false, stdout: '', stderr: '无法获取 skill 安装信息', code: 1 }
      }

      let skillInfo: any
      try {
        const jsonStart = infoResult.stdout.indexOf('{')
        if (jsonStart >= 0) {
          let depth = 0, jsonEnd = jsonStart
          for (let i = jsonStart; i < infoResult.stdout.length; i++) {
            if (infoResult.stdout[i] === '{') depth++
            else if (infoResult.stdout[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
          }
          skillInfo = JSON.parse(infoResult.stdout.slice(jsonStart, jsonEnd))
        }
      } catch { /* ignore */ }

      if (!skillInfo) {
        log('解析 skill 信息失败')
        return { ok: false, stdout: '', stderr: '解析 skill 信息失败', code: 1 }
      }

      const missingBinsRaw: string[] = skillInfo.missing?.bins || []
      const invalidBins = missingBinsRaw.filter((bin) => !normalizeSafeInstallBinName(bin))
      if (invalidBins.length > 0) {
        log(`检测到非法依赖名称: ${invalidBins.join(', ')}`)
        return { ok: false, stdout: '', stderr: '依赖列表包含非法命令名，已阻止执行。', code: 1 }
      }
      const missingBins = missingBinsRaw.map((bin) => normalizeSafeInstallBinName(bin) as string)
      if (missingBins.length === 0) {
        log(`${skillName} 无缺失依赖`)
        return { ok: true, stdout: '', stderr: '', code: 0 }
      }

      // 1. 尝试 npx（部分工具是 npm 包）
      const capability = await probePlatformCommandCapability('npx', {
        platform: process.platform,
        env: buildCommandCapabilityEnv(),
      })
      const npxCommand = capability.available
        ? String(capability.resolvedPath || '').trim() || 'npx'
        : ''
      for (const bin of missingBins) {
        if (await verifyBin(bin)) continue
        if (!npxCommand) break
        log(`尝试 npx -y ${bin} ...`)
        await runShell(npxCommand, ['-y', bin, '--version'], 60_000, 'env-setup')
        if (await verifyBin(bin)) {
          log(`${bin} 已通过 npx 安装`)
        }
      }
      if (await checkAllResolved(missingBins)) {
        log('所有依赖安装完成')
        return { ok: true, stdout: '', stderr: '', code: 0 }
      }

      // 2. 尝试 brew install
      if (process.platform === 'darwin') {
        if (await isBrewAvailable()) {
          for (const bin of missingBins) {
            if (await verifyBin(bin)) continue
            log(`通过 Homebrew 安装 ${bin} ...`)
            await runShell('brew', ['install', bin], undefined, 'env-setup')
            if (await verifyBin(bin)) {
              log(`${bin} 已通过 Homebrew 安装`)
            }
          }
          if (await checkAllResolved(missingBins)) {
            log('所有依赖安装完成')
            return { ok: true, stdout: '', stderr: '', code: 0 }
          }
        } else {
          const remaining = []
          for (const bin of missingBins) {
            if (!await verifyBin(bin)) remaining.push(bin)
          }
          log(`未检测到 Homebrew，无法安装: ${remaining.join(', ')}`)
          log('请先在终端安装 Homebrew:')
          log('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"')
          return { ok: false, stdout: '', stderr: `需要 Homebrew 来安装依赖，请先安装 Homebrew`, code: 1 }
        }
      }

      const stillMissing = []
      for (const bin of missingBins) {
        if (!await verifyBin(bin)) stillMissing.push(bin)
      }
      log(`依赖安装失败: ${stillMissing.join(', ')}`)
      return { ok: false, stdout: '', stderr: '部分依赖安装失败', code: 1 }
    })
  })


  ipcMain.handle('deps:checkBrew', async () => {
    const defaultResult = await runShell('brew', ['--version'], undefined, 'env-setup')
    if (defaultResult.ok) return { installed: true }
    const optHomebrewResult = await runShell('/opt/homebrew/bin/brew', ['--version'], undefined, 'env-setup')
    if (optHomebrewResult.ok) return { installed: true }
    const usrLocalResult = await runShell('/usr/local/bin/brew', ['--version'], undefined, 'env-setup')
    return { installed: usrLocalResult.ok }
  })

  ipcMain.handle('deps:installBrew', async () => {
    // 先检查是否已安装（包括 /opt/homebrew/bin/brew）
    const checkResult = await runShell('brew', ['--version'], 10_000, 'env-setup')
    if (checkResult.ok) return checkResult
    const optHomebrewResult = await runShell('/opt/homebrew/bin/brew', ['--version'], 10_000, 'env-setup')
    if (optHomebrewResult.ok) return optHomebrewResult
    const usrLocalResult = await runShell('/usr/local/bin/brew', ['--version'], 10_000, 'env-setup')
    if (usrLocalResult.ok) return usrLocalResult

    if (process.platform === 'darwin') {
      // 下载安装脚本到临时文件，再通过 osascript 弹出系统密码对话框以管理员权限执行
      const tmpScript = '/tmp/homebrew_install.sh'
      const downloadResult = await runShell(
        'curl',
        ['-fsSL', 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh', '-o', tmpScript],
        60_000,
        'env-setup'
      )
      if (!downloadResult.ok) return downloadResult
      const chmodResult = await runShell('chmod', ['+x', tmpScript], 10_000, 'env-setup')
      if (!chmodResult.ok) return chmodResult

      // osascript 弹出系统授权对话框，用户输入管理员密码后执行
      const sudoResult = await runDirect(
        'osascript',
        ['-e', buildAppleScriptDoShellScript(`NONINTERACTIVE=1 /bin/bash ${tmpScript}`)],
        600_000,
        'env-setup'
      )

      // 清理临时文件
      await runShell('rm', ['-f', tmpScript], undefined, 'env-setup')

      if (sudoResult.ok) {
        // 将 brew 加入 shell profile
        const homeDir = String(process.env.HOME || '').trim()
        if (homeDir) {
          await appendFile(
            `${homeDir}/.zprofile`,
            `\n\neval "$(/opt/homebrew/bin/brew shellenv zsh)"\n`,
            'utf8'
          ).catch(() => {})
        }
        return sudoResult
      }

      // osascript 失败，回退到用户目录安装（无需管理员权限）
      const homeBrewDir = `${process.env.HOME}/homebrew`
      const userInstall = await runDirect(
        '/bin/bash',
        [
          '-lc',
          `mkdir -p "${homeBrewDir}" && curl -L https://github.com/Homebrew/brew/tarball/master | tar xz --strip 1 -C "${homeBrewDir}"`,
        ],
        600_000,
        'env-setup'
      )
      if (userInstall.ok) {
        const homeDir = String(process.env.HOME || '').trim()
        if (homeDir) {
          await appendFile(
            `${homeDir}/.zprofile`,
            `\nexport PATH="${homeBrewDir}/bin:$PATH"\n`,
            'utf8'
          ).catch(() => {})
        }
        return userInstall
      }
      return sudoResult
    }

    // 非 macOS 直接尝试
    return runDirect(
      '/bin/bash',
      ['-lc', 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
      600_000,
      'env-setup'
    )
  })
}
