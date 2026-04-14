import type { OpenClawRuntimeReconcileStore } from '../shared/gateway-runtime-reconcile-state'
import type { DingtalkOfficialSetupResult } from '../shared/dingtalk-official-setup'
import type {
  OfficialChannelActionResult,
  OfficialChannelStatusView,
} from '../shared/official-channel-integration'
import type {
  ManagedChannelPluginPrepareResult,
  ManagedChannelPluginRepairResult,
  ManagedChannelPluginStatusView,
} from '../shared/managed-channel-plugin-lifecycle'
import type {
  FeishuBotDiagnosticListenRequest,
  FeishuBotDiagnosticListenResult,
  FeishuBotDiagnosticSendRequest,
  FeishuBotDiagnosticSendResult,
} from '../shared/feishu-diagnostics'
import type {
  FeishuInstallerPendingPrompt,
  FeishuInstallerPromptResolution,
} from '../shared/feishu-installer-session'
import type { OpenClawBackupRootInfo } from '../shared/openclaw-phase3'
import type {
  OpenClawInstallCandidate as SharedOpenClawInstallCandidate,
  WindowsActiveRuntimeSnapshot as SharedWindowsActiveRuntimeSnapshot,
} from '../shared/openclaw-phase1'
import type {
  OpenClawVersionEnforcement,
  OpenClawVersionPolicyState,
  OpenClawVersionTargetAction,
} from '../shared/openclaw-version-policy'
import type {
  ModelUiSnapshotRequest,
  ModelUiSnapshotResult,
} from '../shared/model-ui-snapshot'

interface CliResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  canceled?: boolean
  npmRegistryAttempts?: Array<{
    mirrorId: string
    label: string
    registryUrl: string | null
    ok: boolean
    canceled?: boolean
  }>
}

interface IncompatibleExtensionPlugin {
  pluginId: string
  packageName: string
  installPath: string
  displayInstallPath: string
  reason: string
}

interface RepairIncompatiblePluginsResult {
  ok: boolean
  repaired: boolean
  incompatiblePlugins: IncompatibleExtensionPlugin[]
  quarantinedPluginIds: string[]
  prunedPluginIds: string[]
  failureKind?: 'permission-denied' | 'filesystem-write-failed' | 'partial-quarantine'
  failedPluginIds?: string[]
  failedPaths?: string[]
  summary: string
  stderr: string
}

interface RepairIncompatiblePluginsOptions {
  scopePluginIds?: string[]
  quarantineOfficialManagedPlugins?: boolean
  restoreConfiguredManagedChannels?: boolean
}

interface ScanIncompatiblePluginsOptions {
  scopePluginIds?: string[]
  quarantineOfficialManagedPlugins?: boolean
}

type GatewayRuntimeStateCode =
  | 'healthy'
  | 'service_missing'
  | 'service_install_failed'
  | 'service_loaded_but_stale'
  | 'gateway_not_running'
  | 'port_conflict_same_gateway'
  | 'port_conflict_foreign_process'
  | 'token_mismatch'
  | 'websocket_1006'
  | 'auth_missing'
  | 'plugin_allowlist_warning'
  | 'plugin_load_failure'
  | 'config_invalid'
  | 'network_blocked'
  | 'unknown_runtime_failure'

type GatewayRecoveryAction =
  | 'prepare-runtime'
  | 'install-plugin'
  | 'install-service'
  | 'start-gateway'
  | 'restart-gateway'
  | 'stop-gateway'
  | 'migrate-port'
  | 'wait-ready'
  | 'run-doctor'

type GatewayRecoveryOutcome = 'not-needed' | 'recovered' | 'blocked' | 'failed' | 'degraded'

type GatewayPortOwnerKind = 'none' | 'gateway' | 'openclaw' | 'foreign' | 'unknown'

interface GatewayPortOwner {
  kind: GatewayPortOwnerKind
  port: number
  pid?: number | null
  processName?: string
  command?: string
  source: 'lsof' | 'powershell' | 'unknown'
}

interface GatewayControlUiAppDiagnostics {
  source: 'control-ui-app'
  connected: boolean
  hasClient: boolean
  lastError?: string
  appKeys: string[]
}

interface GatewayRuntimeReasonDetail {
  source: 'control-ui-app'
  code: string
  message: string
  rawMessage?: string
}

interface GatewayRuntimeEvidence {
  source: 'health' | 'start' | 'restart' | 'doctor' | 'port-owner' | 'config' | 'service' | 'control-ui-app'
  message: string
  detail?: string
  port?: number
  owner?: GatewayPortOwner | null
}

type OnboardErrorCode =
  | 'already_initialized'
  | 'gateway_closed'
  | 'websocket_1006'
  | 'windows_task_conflict'
  | 'windows_access_denied'
  | 'unknown'

interface OnboardResult extends CliResult {
  errorCode?: OnboardErrorCode
}

type PairingApproveErrorCode = 'no_pending_request' | 'expired' | 'already_paired' | 'unknown'

interface PairingApproveResult extends CliResult {
  errorCode?: PairingApproveErrorCode
}

interface FeishuBotRuntimeStatus {
  accountId: string
  agentId: string
  workspace: string
  enabled: boolean
  credentialsComplete: boolean
  gatewayRunning: boolean
  runtimeState: 'online' | 'offline' | 'degraded' | 'disabled'
  summary: string
  issues: string[]
}

interface WecomQrGenerateResult {
  ok: boolean
  scode?: string
  authUrl?: string
  error?: string
}

interface WecomQrCheckResult {
  ok: boolean
  status: 'pending' | 'success' | 'error'
  botId?: string
  secret?: string
  error?: string
}

interface CommandProgress {
  step: string
  message?: string
  percent?: number
  done?: boolean
}

interface CliResultExtended extends CliResult {
  progress?: CommandProgress
}

type MacGitToolsPrepareErrorCode =
  | 'xcode_clt_pending'
  | 'git_unavailable'
  | 'prepare_failed'

interface MacGitToolsPrepareResult extends CliResult {
  errorCode?: MacGitToolsPrepareErrorCode
}

interface FeishuInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  pendingPrompt: FeishuInstallerPendingPrompt | null
}

interface FeishuInstallerSessionEvent {
  sessionId: string
  type: 'started' | 'output' | 'prompt' | 'exit'
  stream?: 'stdout' | 'stderr'
  chunk?: string
  phase?: FeishuInstallerSessionSnapshot['phase']
  code?: number | null
  ok?: boolean
  canceled?: boolean
  command?: string[]
  pendingPrompt?: FeishuInstallerPendingPrompt | null
}

interface WeixinInstallerSessionSnapshot {
  active: boolean
  sessionId: string | null
  phase: 'idle' | 'running' | 'exited'
  output: string
  code: number | null
  ok: boolean
  canceled: boolean
  command: string[]
  beforeAccountIds: string[]
  afterAccountIds: string[]
  newAccountIds: string[]
}

interface WeixinInstallerSessionEvent {
  sessionId: string
  type: 'started' | 'output' | 'exit'
  stream?: 'stdout' | 'stderr'
  chunk?: string
  phase?: WeixinInstallerSessionSnapshot['phase']
  code?: number | null
  ok?: boolean
  canceled?: boolean
  command?: string[]
  beforeAccountIds?: string[]
  afterAccountIds?: string[]
  newAccountIds?: string[]
}

interface WeixinAccountState {
  accountId: string
  configured: boolean
  baseUrl?: string
  userId?: string
  enabled: boolean
  name?: string
}

interface PairingAllowFromUser {
  senderId: string
  displayName: string
}

interface FeishuOfficialPluginState {
  pluginId: string
  installedOnDisk: boolean
  installPath: string
  officialPluginConfigured: boolean
  legacyPluginIdsPresent: string[]
  configChanged: boolean
  normalizedConfig: Record<string, any>
}

interface EnsureFeishuOfficialPluginReadyResult extends CliResult {
  installedThisRun: boolean
  state: FeishuOfficialPluginState
  message?: string
}

type CommandControlDomain =
  | 'global'
  | 'gateway'
  | 'config-write'
  | 'chat'
  | 'oauth'
  | 'capabilities'
  | 'env'
  | 'env-setup'
  | 'models'
  | 'plugin-install'
  | 'feishu-installer'
  | 'weixin-installer'
  | 'upgrade'
  | (string & {})

interface CancelActiveProcessesResult {
  canceledDomains: CommandControlDomain[]
  failedDomains: CommandControlDomain[]
  untouchedDomains: CommandControlDomain[]
}

interface GatewayEnsureRunningResult extends CliResult {
  running: boolean
  autoInstalledNode: boolean
  autoInstalledOpenClaw: boolean
  autoInstalledGatewayService: boolean
  autoPortMigrated: boolean
  effectivePort: number
  stateCode: GatewayRuntimeStateCode
  summary: string
  attemptedCommands: string[][]
  evidence: GatewayRuntimeEvidence[]
  repairActionsTried: GatewayRecoveryAction[]
  repairOutcome: GatewayRecoveryOutcome
  safeToRetry: boolean
  reasonDetail?: GatewayRuntimeReasonDetail | null
  diagnostics?: GatewayEnsureRunningDiagnostics
}

interface GatewayReloadResult extends CliResult {
  running?: boolean
  summary?: string
  stateCode?: GatewayRuntimeStateCode
  autoPortMigrated?: boolean
  effectivePort?: number
}

type GatewayBootstrapPhase =
  | 'runtime-check'
  | 'probe'
  | 'service-install'
  | 'port-recovery'
  | 'restart'
  | 'start-command'
  | 'waiting-ready'
  | 'doctor-check'
  | 'blocked'
  | 'done'

interface GatewayHealthCheckResult {
  running: boolean
  raw?: string
  stderr?: string
  code?: number | null
  stateCode?: GatewayRuntimeStateCode
  summary?: string
}

interface GatewayBootstrapProgressState {
  phase: GatewayBootstrapPhase
  title: string
  detail: string
  progress: number
  attempt?: number
  elapsedMs?: number
}

interface GatewayBootstrapStateEvent extends GatewayBootstrapProgressState {
  requestId?: string
}

interface GatewayEnsureRunningDiagnostics {
  lastHealth: GatewayHealthCheckResult | null
  doctor: CliResult | null
  portOwner?: GatewayPortOwner | null
  controlUiApp?: GatewayControlUiAppDiagnostics | null
}

type AuthMethodType = 'apiKey' | 'oauth' | 'token' | 'custom' | 'unknown'

interface AuthChoiceCapability {
  id: string
  providerId: string
  methodType: AuthMethodType
  source: 'auth-registry' | 'onboard-help' | 'fallback'
}

type AuthRouteKind =
  | 'models-auth-login'
  | 'models-auth-login-github-copilot'
  | 'models-auth-setup-token'
  | 'models-auth-paste-token'
  | 'onboard'
  | 'onboard-custom'
  | 'unsupported'

type OpenClawAuthRegistrySource =
  | 'openclaw-public-json'
  | 'openclaw-public-export'
  | 'openclaw-internal-registry'
  | 'unsupported-openclaw-layout'
  | 'unknown'

interface OpenClawAuthExtraOptionDescriptor {
  id: string
  label: string
  hint?: string
}

interface OpenClawAuthRouteDescriptor {
  kind: AuthRouteKind
  providerId?: string
  methodId?: string
  pluginId?: string
  cliFlag?: string
  requiresSecret?: boolean
  requiresBrowser?: boolean
  extraOptions?: OpenClawAuthExtraOptionDescriptor[]
}

interface OpenClawAuthMethodDescriptor {
  authChoice: string
  label: string
  hint?: string
  kind: AuthMethodType
  route: OpenClawAuthRouteDescriptor
}

type CustomProviderCompatibility = 'openai' | 'anthropic'

interface CustomProviderConfigInput {
  baseUrl: string
  modelId: string
  providerId?: string
  compatibility?: CustomProviderCompatibility
}

interface OpenClawAuthProviderDescriptor {
  id: string
  label: string
  hint?: string
  methods: OpenClawAuthMethodDescriptor[]
}

interface OpenClawAuthRegistry {
  ok: boolean
  source: OpenClawAuthRegistrySource
  providers: OpenClawAuthProviderDescriptor[]
  message?: string
}

interface OpenClawCapabilities {
  version: string
  discoveredAt: string
  authRegistry: OpenClawAuthRegistry
  authRegistrySource: OpenClawAuthRegistrySource
  authChoices: AuthChoiceCapability[]
  onboardFlags: string[]
  modelsCommands: string[]
  supports: {
    onboard: boolean
    plugins: boolean
    pluginsInstall: boolean
    pluginsEnable: boolean
    chatAgentModelFlag: boolean
    chatGatewaySendModel: boolean
    chatInThreadModelSwitch: boolean
    modelsListAllJson: boolean
    modelsStatusJson: boolean
    modelsAuthLogin: boolean
    modelsAuthAdd: boolean
    modelsAuthPasteToken: boolean
    modelsAuthSetupToken: boolean
    modelsAuthOrder: boolean
    modelsAuthLoginGitHubCopilot: boolean
    aliases: boolean
    fallbacks: boolean
    imageFallbacks: boolean
    modelsScan: boolean
  }
}

interface ModelCatalogItem {
  key: string
  name: string
  provider: string
  input?: string
  contextWindow?: number
  local: boolean
  available: boolean
  tags: string[]
  missing: string[]
}

interface ModelCatalogQuery {
  provider?: string
  search?: string
  page?: number
  pageSize?: number
  localOnly?: boolean
  includeUnavailable?: boolean
  bypassCache?: boolean
}

interface ModelCatalogResult {
  total: number
  items: ModelCatalogItem[]
  providers: string[]
  updatedAt: string
  source: 'live' | 'cache'
  stale: boolean
}

type ModelConfigAction =
  | { kind: 'set-default-model'; model: string }
  | { kind: 'set-image-model'; model: string }
  | { kind: 'alias-add'; alias: string; model: string }
  | { kind: 'alias-remove'; alias: string }
  | { kind: 'alias-list' }
  | { kind: 'fallback-add'; model: string }
  | { kind: 'fallback-remove'; model: string }
  | { kind: 'fallback-list' }
  | { kind: 'fallback-clear' }
  | { kind: 'image-fallback-add'; model: string }
  | { kind: 'image-fallback-remove'; model: string }
  | { kind: 'image-fallback-list' }
  | { kind: 'image-fallback-clear' }
  | {
      kind: 'scan-models'
      provider?: string
      json?: boolean
      yes?: boolean
      noProbe?: boolean
      setDefault?: boolean
      setImage?: boolean
      maxCandidates?: number
      timeoutMs?: number
      concurrency?: number
      maxAgeDays?: number
      minParams?: number
      noInput?: boolean
    }

type ModelConfigErrorCode = 'command_failed' | 'parse_error' | 'invalid_action'

interface ModelConfigCommandResult<T = unknown> {
  ok: boolean
  action: ModelConfigAction['kind'] | 'status'
  command: string[]
  stdout: string
  stderr: string
  code: number | null
  data?: T
  errorCode?: ModelConfigErrorCode
  message?: string
}

interface ModelStatusOptions {
  agentId?: string
  probe?: boolean
  probeProvider?: string
  probeTimeoutMs?: number
  probeConcurrency?: number
  probeMaxTokens?: number
  probeProfile?: string | string[]
  check?: boolean
}

interface ValidateProviderCredentialInput {
  providerId: string
  methodId?: string
  secret: string
  timeoutMs?: number
}

interface ValidateProviderCredentialResult {
  ok: boolean
  validated: boolean
  stdout: string
  stderr: string
  code: number | null
  message?: string
  data?: Record<string, any>
}

type ModelAuthAction =
  | {
      kind: 'login'
      providerId: string
      methodId: string
      selectedExtraOption?: string
      secret?: string
      customConfig?: CustomProviderConfigInput
      setDefault?: boolean
      fallbackAuthChoice?: string
      fallbackInteractive?: boolean
      fallbackAcceptRisk?: boolean
      fallbackInstallDaemon?: boolean
      fallbackSkipChannels?: boolean
      fallbackSkipSkills?: boolean
      fallbackSkipSearch?: boolean
      fallbackSkipUi?: boolean
    }
  | {
      kind: 'paste-token'
      providerId: string
      profileId?: string
      expiresIn?: string
    }
  | {
      kind: 'setup-token'
      providerId: string
      yes?: boolean
    }
  | {
      kind: 'auth-add'
    }
  | {
      kind: 'login-github-copilot'
      profileId?: string
      yes?: boolean
    }
  | {
      kind: 'auth-order-get'
      providerId: string
      agentId?: string
      json?: boolean
    }
  | {
      kind: 'auth-order-set'
      providerId: string
      profileIds: string[]
      agentId?: string
    }
  | {
      kind: 'auth-order-clear'
      providerId: string
      agentId?: string
    }
  | {
      kind: 'onboard-fallback'
      authChoice: string
      interactive?: boolean
      acceptRisk?: boolean
      installDaemon?: boolean
      skipChannels?: boolean
      skipSkills?: boolean
      skipUi?: boolean
      secret?: string
      cliFlag?: string
    }

type AuthErrorCode = 'auth_busy' | 'invalid_input' | 'command_failed' | 'unsupported_capability'

interface RunModelAuthResult {
  ok: boolean
  action: ModelAuthAction['kind']
  attemptedCommands: string[][]
  stdout: string
  stderr: string
  code: number | null
  fallbackUsed: boolean
  errorCode?: AuthErrorCode
  message?: string
}

interface StartModelOAuthRequest {
  providerId: string
  methodId: string
  selectedExtraOption?: string
  setDefault?: boolean
}

type OAuthExternalDependencyId = 'gemini-cli'

type OAuthExternalDependencyInstallMethod = 'brew' | 'npm'

interface OAuthExternalDependencyInstallOption {
  method: OAuthExternalDependencyInstallMethod
  label: string
  commandPreview: string
}

type OAuthExternalDependencyWarningId = 'google-cloud-project-missing'

interface OAuthExternalDependencyWarning {
  id: OAuthExternalDependencyWarningId
  title: string
  message: string
}

interface OAuthExternalDependencyPreflightAction {
  dependencyId: OAuthExternalDependencyId
  title: string
  message: string
  commandName: string
  recommendedMethod?: OAuthExternalDependencyInstallMethod
  installOptions: OAuthExternalDependencyInstallOption[]
}

interface OAuthExternalDependencyInspectionResult {
  ready: boolean
  satisfiedBy?: 'env' | 'command'
  action?: OAuthExternalDependencyPreflightAction
  warnings?: OAuthExternalDependencyWarning[]
}

interface StartModelOAuthResult extends CliResult {
  providerId: string
  methodId: string
  loginProviderId: string
  pluginId?: string
  message?: string
  preflightAction?: OAuthExternalDependencyPreflightAction
  preflightWarnings?: OAuthExternalDependencyWarning[]
}

interface OAuthStateEventPayload {
  providerId: string
  methodId: string
  state: 'preparing' | 'plugin-ready' | 'opening-browser' | 'waiting-for-approval' | 'browser-open-failed'
}

interface OAuthCodeEventPayload {
  providerId: string
  methodId: string
  verificationUri: string
  userCode?: string
  browserOpened: boolean
}

interface OAuthResultEventPayload {
  providerId: string
  methodId: string
  loginProviderId: string
  stdout: string
  stderr: string
  code: number | null
}

interface RefreshModelDataPayload {
  forceCapabilitiesRefresh?: boolean
  includeCapabilities?: boolean
  includeStatus?: boolean
  includeCatalog?: boolean
  fullCatalog?: boolean
  catalogQuery?: ModelCatalogQuery
  statusOptions?: ModelStatusOptions
}

interface RefreshModelDataResult {
  capabilities?: OpenClawCapabilities
  catalog?: ModelCatalogResult
  status?: ModelConfigCommandResult<Record<string, any>>
}

interface InstallOAuthExternalDependencyRequest {
  dependencyId: OAuthExternalDependencyId
  method?: OAuthExternalDependencyInstallMethod
}

interface InstallOAuthExternalDependencyResult extends CliResult {
  dependencyId: OAuthExternalDependencyId
  method?: OAuthExternalDependencyInstallMethod
  message?: string
}

interface NodeCheckResult {
  installed: boolean
  version: string
  needsUpgrade: boolean
  meetsRequirement: boolean
  requiredVersion: string
  targetVersion: string
  installStrategy: 'nvm' | 'installer'
}

interface NodeInstallPlan {
  version: string
  requiredVersion: string
  requirementSource:
    | 'env-override'
    | 'installed-openclaw-package'
    | 'openclaw-registry'
    | 'bundled-fallback'
  source: 'env-override' | 'official-dist-index'
  platform: 'darwin' | 'win32'
  detectedArch: 'x64' | 'arm64' | 'x86'
  installerArch: 'x64' | 'arm64' | 'x86' | 'universal'
  artifactKind: 'pkg' | 'zip'
  distBaseUrl: string
  url: string
  filename: string
}

interface NodeInstallerIssue {
  kind:
    | 'missing-installer'
    | 'corrupted-installer'
    | 'missing-system-command'
    | 'not-admin-user'
    | 'blocked-by-policy'
    | 'unsupported-macos'
    | 'user-cancelled'
    | 'permission-denied'
    | 'download-failed'
    | 'installer-failed'
  title: string
  message: string
  details?: string
}

interface NodeInstallerReadinessResult {
  ok: boolean
  issue?: NodeInstallerIssue
}

interface OpenClawPaths {
  homeDir: string
  configFile: string
  envFile: string
  credentialsDir: string
  modelCatalogCacheFile: string
  displayHomeDir: string
  displayConfigFile: string
  displayEnvFile: string
  displayCredentialsDir: string
  displayModelCatalogCacheFile: string
}

type WindowsActiveRuntimeSnapshot = SharedWindowsActiveRuntimeSnapshot

type OpenClawInstallSource =
  | 'npm-global'
  | 'homebrew'
  | 'nvm'
  | 'fnm'
  | 'asdf'
  | 'mise'
  | 'volta'
  | 'custom'
  | 'unknown'

type OpenClawOwnershipState =
  | 'external-preexisting'
  | 'qclaw-installed'
  | 'mixed-managed'
  | 'unknown-external'

interface OpenClawBaselineBackupRecord {
  backupId: string
  createdAt: string
  archivePath: string
  installFingerprint: string
}

interface OpenClawBaselineBackupManualAction {
  sourcePath: string
  displaySourcePath: string
  suggestedArchivePath: string
  displaySuggestedArchivePath: string
}

interface OpenClawBaselineBackupBypassRecord extends OpenClawBaselineBackupManualAction {
  installFingerprint: string
  skippedAt: string
  reason: 'manual-backup-required'
}

type OpenClawInstallCandidate = SharedOpenClawInstallCandidate

interface OpenClawHistoryDataCandidate {
  path: string
  displayPath: string
  reason: 'default-home-dir' | 'runtime-state-root'
}

type WindowsGatewayOwnerState =
  | 'healthy'
  | 'service-missing'
  | 'launcher-missing'
  | 'unknown'

interface OpenClawDiscoveryResult {
  status: 'installed' | 'history-only' | 'absent'
  candidates: OpenClawInstallCandidate[]
  activeCandidateId: string | null
  hasMultipleCandidates: boolean
  historyDataCandidates: OpenClawHistoryDataCandidate[]
  errors: string[]
  warnings: string[]
  defaultBackupDirectory: string
  windowsGatewayOwnerState?: WindowsGatewayOwnerState | null
}

interface OpenClawLatestVersionCheckResult {
  ok: boolean
  latestVersion: string
  checkedAt: string
  source: 'npm-registry'
  error?: string
}

interface OpenClawBaselineBackupEnsureResult {
  ok: boolean
  created: boolean
  backup: OpenClawBaselineBackupRecord | null
  errorCode?: 'backup_failed' | 'invalid_candidate' | 'not_required'
  message?: string
  manualBackupAction?: OpenClawBaselineBackupManualAction
}

interface OpenClawBaselineBackupSkipResult {
  ok: boolean
  bypass: OpenClawBaselineBackupBypassRecord | null
  errorCode?: 'invalid_candidate' | 'not_required' | 'skip_failed'
  message?: string
}

interface EnvCheckReadyPayload {
  hadOpenClawInstalled: boolean
  installedOpenClawDuringCheck: boolean
  gatewayRunning: boolean
  sharedConfigInitialized: boolean
}

type OpenClawManagedFileKind = 'config' | 'env' | 'credentials' | 'backup-manifest'

interface OpenClawManagedFileRecord {
  filePath: string
  kind: OpenClawManagedFileKind
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

interface OpenClawJsonPathOwnershipRecord {
  filePath: string
  jsonPath: string
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

interface OpenClawConfigSnapshotRecord {
  snapshotId: string
  createdAt: string
  archivePath: string
  installFingerprint: string
  snapshotType: 'config-snapshot'
}

interface OpenClawShellManagedBlockRecord {
  filePath: string
  blockId: string
  blockType: 'openclaw-shell-init'
  startMarker: string
  endMarker: string
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

interface OpenClawOwnershipEntry {
  installFingerprint: string
  createdAt: string
  updatedAt: string
  candidate: {
    candidateId: string
    version: string
    binaryPath: string
    resolvedBinaryPath: string
    packageRoot: string
    installSource: string
    configPath: string
    stateRoot: string
  }
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  files: OpenClawManagedFileRecord[]
  jsonPaths: OpenClawJsonPathOwnershipRecord[]
  shellBlocks: OpenClawShellManagedBlockRecord[]
}

interface OpenClawOwnershipSummary {
  fileCount: number
  jsonPathCount: number
  shellBlockCount: number
  managedFiles: string[]
  managedJsonPaths: string[]
  managedShellBlockFiles: string[]
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  updatedAt: string
}

interface OpenClawOwnershipChangeList {
  installFingerprint: string
  filePaths: string[]
  jsonPaths: string[]
  shellBlockFiles: string[]
  updatedAt: string
}

interface OpenClawDataGuardSummary {
  ok: boolean
  activeCandidate: OpenClawInstallCandidate | null
  baselineBackup: OpenClawBaselineBackupRecord | null
  backupDirectory: string
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  ownershipSummary: OpenClawOwnershipSummary | null
  managedScopes: string[]
  untouchedScopes: string[]
  warnings: string[]
  message?: string
}

type OpenClawGuardedWriteReason =
  | 'channel-connect-sanitize'
  | 'channel-connect-onboard-prepare'
  | 'channel-connect-configure'
  | 'channel-connect-feishu-sync-config'
  | 'channel-connect-feishu-auto-recovery-heal'
  | 'channel-connect-feishu-manual-binding-sync'
  | 'channel-connect-feishu-finish-create'
  | 'channel-connect-feishu-finish-link'
  | 'channels-remove-channel'
  | 'dashboard-remove-linked-model'
  | 'dashboard-add-feishu-bot'
  | 'dashboard-delete-feishu-bot'
  | 'managed-channel-plugin-repair'
  | 'pairing-allowfrom-sync'
  | 'gateway-port-recovery'
  | 'unknown'

interface OpenClawGuardPrepareResult {
  ok: boolean
  blocked: boolean
  prepared: boolean
  snapshotCreated: boolean
  snapshot: OpenClawConfigSnapshotRecord | null
  ownershipSummary: OpenClawOwnershipSummary | null
  message?: string
  errorCode?: 'no_active_install' | 'baseline_backup_required' | 'snapshot_failed'
}

interface OpenClawGuardedConfigWriteRequest {
  config: Record<string, any>
  reason?: OpenClawGuardedWriteReason
}

interface OpenClawConfigPatchWriteRequest {
  beforeConfig: Record<string, any> | null
  afterConfig: Record<string, any>
  reason?: OpenClawGuardedWriteReason
}

interface OpenClawGuardedEnvWriteRequest {
  updates: Record<string, string>
  reason?: OpenClawGuardedWriteReason
}

interface OpenClawGuardedWriteResult {
  ok: boolean
  blocked: boolean
  wrote: boolean
  target: 'config' | 'env'
  snapshotCreated: boolean
  snapshot: OpenClawConfigSnapshotRecord | null
  changedJsonPaths: string[]
  ownershipSummary: OpenClawOwnershipSummary | null
  message?: string
  errorCode?: 'no_active_install' | 'baseline_backup_required' | 'snapshot_failed' | 'write_failed'
  gatewayApply?: {
    ok: boolean
    requestedAction: 'none' | 'hot-reload' | 'restart'
    appliedAction: 'none' | 'hot-reload' | 'restart'
    note?: string
  }
}

type OpenClawBackupType =
  | 'baseline-backup'
  | 'manual-backup'
  | 'config-snapshot'
  | 'cleanup-backup'
  | 'restore-preflight'
  | 'upgrade-preflight'
  | 'unknown'

type OpenClawBackupStrategyId =
  | 'full-state'
  | 'config-only'
  | 'takeover-safeguard'
  | 'unknown'

type OpenClawBackupHomeCaptureMode = 'none' | 'essential-state' | 'full-home'

interface OpenClawBackupScopeAvailability {
  hasConfigData: boolean
  hasMemoryData: boolean
  hasEnvData: boolean
  hasCredentialsData: boolean
}

interface OpenClawBackupEntry {
  backupId: string
  createdAt: string
  archivePath: string
  manifestPath: string
  type: OpenClawBackupType
  strategyId?: OpenClawBackupStrategyId
  homeCaptureMode?: OpenClawBackupHomeCaptureMode
  installFingerprint: string | null
  sourceVersion: string | null
  sourceConfigPath?: string | null
  sourceStateRoot?: string | null
  scopeAvailability: OpenClawBackupScopeAvailability
}

interface OpenClawBackupListResult {
  rootDirectory: string
  preferredRootDirectory?: string
  fallbackRootDirectory?: string | null
  usedFallbackRoot?: boolean
  searchedRootDirectories?: string[]
  warnings?: string[]
  entries: OpenClawBackupEntry[]
}

interface OpenClawManualBackupRunResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  message?: string
  errorCode?: 'no_active_install' | 'backup_failed'
}

interface OpenClawDataCleanupRunRequest {
  targetPath: string
  backupBeforeDelete?: boolean
}

interface OpenClawDataCleanupRunResult {
  ok: boolean
  deletedPath: string | null
  existedBefore: boolean
  backupCreated: OpenClawBackupEntry | null
  warnings: string[]
  message?: string
  errorCode?: 'invalid_target' | 'backup_failed' | 'delete_failed'
}

interface OpenClawBackupDeleteResult {
  ok: boolean
  deletedBackupIds: string[]
  deletedCount: number
  warnings: string[]
  errors: string[]
  message?: string
  errorCode?: 'backup_not_found' | 'delete_failed'
}

type OpenClawCleanupActionType =
  | 'remove-openclaw'
  | 'qclaw-uninstall-keep-openclaw'
  | 'qclaw-uninstall-remove-openclaw'

interface OpenClawCleanupPreviewRequest {
  actionType: OpenClawCleanupActionType
  backupBeforeDelete: boolean
  selectedCandidateIds?: string[]
}

interface OpenClawCleanupRunRequest extends OpenClawCleanupPreviewRequest {
  selectedCandidateIds?: string[]
}

interface OpenClawCleanupPreviewResult {
  ok: boolean
  canRun: boolean
  actionType: OpenClawCleanupActionType
  activeCandidate: OpenClawInstallCandidate | null
  deleteItems: string[]
  keepItems: string[]
  backupItems: string[]
  warnings: string[]
  blockedReasons: string[]
  backupDirectory: string
  availableCandidates?: OpenClawInstallCandidate[]
  selectedCandidateIds?: string[]
  manualNextStep?: string
}

type OpenClawCleanupCandidateFinalStatus = 'success' | 'partial' | 'failed' | 'skipped'

interface OpenClawCleanupStepResult {
  attempted: boolean
  ok: boolean
  message?: string
  command?: string
  errors?: string[]
}

interface OpenClawCleanupVerificationResult {
  checked: boolean
  stateRemoved: boolean
  programRemoved: boolean
  commandAvailable: boolean
  commandResolvedBinaryPath: string | null
  commandPointsToTarget: boolean | null
  remainingPaths: string[]
  notes: string[]
}

interface OpenClawCleanupCandidateResult {
  candidateId: string
  installSource?: string
  displayStateRoot?: string
  binaryPath?: string
  finalStatus: OpenClawCleanupCandidateFinalStatus
  stateCleanup?: OpenClawCleanupStepResult
  programUninstall?: OpenClawCleanupStepResult
  verification?: OpenClawCleanupVerificationResult
  message?: string
  warnings: string[]
  errors: string[]
}

interface OpenClawCleanupSummary {
  total: number
  success: number
  partial: number
  failed: number
  skipped: number
}

interface OpenClawCleanupRunResult {
  ok: boolean
  blocked: boolean
  actionType: OpenClawCleanupActionType
  backupCreated: OpenClawBackupEntry | null
  warnings: string[]
  errors: string[]
  summary?: OpenClawCleanupSummary
  perCandidateResults?: OpenClawCleanupCandidateResult[]
  message?: string
  manualNextStep?: string
}

type OpenClawRestoreScope = 'config' | 'memory' | 'all'

interface OpenClawRestorePreviewResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  availableScopes: OpenClawRestoreScope[]
  restoreItems: string[]
  warnings: string[]
  blockedReasons: string[]
}

interface OpenClawRestoreRunResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  scope: OpenClawRestoreScope
  preflightSnapshot: OpenClawBackupEntry | null
  restoredItems: string[]
  warnings: string[]
  message?: string
  errorCode?: 'backup_not_found' | 'scope_unavailable' | 'preflight_failed' | 'restore_failed' | 'runtime_apply_failed'
  gatewayApply?: {
    ok: boolean
    requestedAction: 'none' | 'hot-reload' | 'restart'
    appliedAction: 'none' | 'hot-reload' | 'restart'
    note?: string
  }
}

interface OpenClawUpgradeCheckResult {
  ok: boolean
  activeCandidate: OpenClawInstallCandidate | null
  currentVersion: string | null
  targetVersion: string | null
  latestCheck: OpenClawLatestVersionCheckResult | null
  policyState: OpenClawVersionPolicyState | null
  enforcement: OpenClawVersionEnforcement | null
  targetAction: OpenClawVersionTargetAction
  blocksContinue: boolean
  canSelfHeal: boolean
  canAutoUpgrade: boolean
  upToDate: boolean
  gatewayRunning: boolean
  warnings: string[]
  manualHint?: string
  errorCode?: 'not_installed' | 'latest_unknown' | 'manual_only'
}

interface OpenClawUpgradeRunResult {
  ok: boolean
  blocked: boolean
  currentVersion: string | null
  targetVersion: string | null
  installSource: OpenClawInstallCandidate['installSource'] | null
  backupCreated: OpenClawBackupEntry | null
  gatewayWasRunning: boolean
  gatewayRestored: boolean
  warnings: string[]
  message?: string
  errorCode?:
    | 'not_installed'
    | 'latest_unknown'
    | 'manual_only'
    | 'snapshot_failed'
    | 'lifecycle_failed_environment_repaired'
    | 'post_repair_failed_after_lifecycle'
    | 'post_repair_verification_failed'
    | 'upgrade_failed'
}

type QClawUpdateStatusState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

type QClawUpdateErrorCode =
  | 'network'
  | 'metadata_missing'
  | 'signature_invalid'
  | 'no_update'
  | 'unsupported'
  | 'not_configured'
  | 'invalid_download_url'
  | 'unknown'

interface QClawUpdateStatus {
  ok: boolean
  supported: boolean
  configured: boolean
  currentVersion: string
  availableVersion: string | null
  manualDownloadUrl?: string
  releaseDate?: string
  releaseNotes?: string
  feedUrl?: string
  status: QClawUpdateStatusState
  progressPercent: number | null
  downloaded: boolean
  message?: string
  error?: string
  errorCode?: QClawUpdateErrorCode
}

interface QClawUpdateActionResult {
  ok: boolean
  status: QClawUpdateStatus
  message?: string
  error?: string
  errorCode?: QClawUpdateErrorCode
  willQuitAndInstall?: boolean
}

interface QClawUpdateOpenDownloadResult extends QClawUpdateActionResult {
  openedUrl?: string
}

interface CombinedUpdateCheckResult {
  ok: boolean
  openclaw: OpenClawUpgradeCheckResult
  qclaw: QClawUpdateStatus
  canRun: boolean
  warnings: string[]
}

interface CombinedUpdateRunResult {
  ok: boolean
  blocked: boolean
  openclawResult: OpenClawUpgradeRunResult | null
  qclawStatus: QClawUpdateStatus
  warnings: string[]
  message?: string
  errorCode?: 'openclaw_blocked' | 'qclaw_unavailable' | 'qclaw_download_failed' | 'openclaw_upgrade_failed'
}

type DashboardChatAvailabilityReason =
  | 'ready'
  | 'gateway-offline'
  | 'no-configured-model'
  | 'model-status-error'
  | 'chat-service-error'

type DashboardChatAvailabilityState =
  | 'loading'
  | 'ready'
  | 'degraded'
  | 'offline'
  | 'no-model'
  | 'error'

type ChatSessionKind = 'direct' | 'channel' | 'unknown'

type ChatMessageRole = 'user' | 'assistant' | 'system'

type ChatMessageStatus = 'pending' | 'sent' | 'error'

type ChatThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

type ChatSendErrorCode =
  | 'gateway-offline'
  | 'command-failed'
  | 'parse-failed'
  | 'timeout'
  | 'invalid-input'
  | 'canceled'

type ChatExternalTranscriptErrorCode =
  | 'session-key-missing'
  | 'gateway-offline'
  | 'gateway-auth-failed'
  | 'session-not-found'
  | 'sessions-get-failed'
  | 'messages-map-failed'

type ChatHistorySource = 'chat-history' | 'sessions-get' | 'local-cache' | 'none'

type ChatAuthorityKind = 'upstream-direct' | 'upstream-channel' | 'local-cache-only' | 'mixed' | 'unknown'

type ChatCachePresence = 'none' | 'local-shell' | 'local-transcript'

type ChatFailureClass = 'none' | 'semantic' | 'permission' | 'connection' | 'capability' | 'unknown'

type ChatFieldStateKind = 'confirmed' | 'intent' | 'cache' | 'derived'

interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}

interface DashboardChatAvailability {
  state: DashboardChatAvailabilityState
  ready: boolean
  canSend: boolean
  reason: DashboardChatAvailabilityReason
  gatewayRunning: boolean
  connectedModels: string[]
  defaultModel?: string
  agentId: string
  message?: string
  transient?: boolean
  lastHealthyAt?: number
  consecutiveGatewayFailures?: number
}

interface ChatSessionSummary {
  sessionId: string
  sessionKey?: string
  upstreamConfirmed?: boolean
  agentId: string
  model?: string
  selectedModel?: string
  canPatchModel?: boolean
  canContinue?: boolean
  authorityKind?: ChatAuthorityKind
  cachePresence?: ChatCachePresence
  legacySemanticsActive?: boolean
  modelSwitchBlockedReason?: string
  updatedAt: number
  kind: ChatSessionKind
  hasLocalTranscript: boolean
  totalTokens?: number
  contextTokens?: number
  localOnly?: boolean
}

interface ChatMessage {
  id: string
  role: ChatMessageRole
  text: string
  createdAt: number
  status?: ChatMessageStatus
  model?: string
  requestedModel?: string
  transportSessionId?: string
  usage?: ChatUsage
}

interface ChatTranscript {
  sessionId: string
  sessionKey?: string
  upstreamConfirmed?: boolean
  agentId: string
  model?: string
  selectedModel?: string
  historySource?: ChatHistorySource
  canPatchModel?: boolean
  canContinue?: boolean
  authorityKind?: ChatAuthorityKind
  cachePresence?: ChatCachePresence
  legacySemanticsActive?: boolean
  modelSwitchBlockedReason?: string
  updatedAt: number
  hasLocalTranscript: boolean
  messages: ChatMessage[]
  externalTranscriptLimit?: number
  externalTranscriptTruncated?: boolean
  externalTranscriptErrorCode?: ChatExternalTranscriptErrorCode
  externalTranscriptErrorMessage?: string
}

interface ChatCapabilitySnapshot {
  version?: string
  discoveredAt?: string
  supportsSessionsPatch: boolean
  supportsChatHistory: boolean
  supportsGatewayChatSend: boolean
  supportsGatewayRpc: boolean
  notes: string[]
}

interface ChatSessionDebugSnapshot {
  requestedSessionId: string
  trackedSessionId: string
  resolvedSessionId: string
  resolvedSessionKey?: string
  historySource: ChatHistorySource
  confirmedModel?: string
  intentSelectedModel?: string
  canPatchModel: boolean
  canContinue: boolean
  authorityKind: ChatAuthorityKind
  cachePresence: ChatCachePresence
  failureClass: ChatFailureClass
  legacySemanticsActive: boolean
  updatedAt: number
  fieldStates: Record<string, ChatFieldStateKind>
  notes: string[]
}

interface ChatTraceEntry {
  id: string
  operation: 'transcript' | 'patch' | 'send' | 'create'
  stage: string
  sessionId?: string
  sessionKey?: string
  historySource?: ChatHistorySource
  confirmedModel?: string
  intentSelectedModel?: string
  failureClass?: ChatFailureClass
  message?: string
  createdAt: number
}

interface ChatSendRequest {
  sessionId: string
  text: string
  thinking?: ChatThinkingLevel
}

interface ChatSendResult {
  ok: boolean
  sessionId: string
  message?: ChatMessage
  errorCode?: ChatSendErrorCode
  messageText?: string
}

interface ChatPatchSessionModelRequest {
  sessionId: string
  model: string
}

interface ChatPatchSessionModelResult {
  ok: boolean
  sessionId: string
  sessionKey?: string
  model?: string
  messageText?: string
}

interface ChatClearLocalTranscriptResult {
  ok: boolean
  sessionId: string
}

type ChatStreamEvent =
  | {
      type: 'assistant-start'
      sessionId: string
      model?: string
    }
  | {
      type: 'assistant-delta'
      sessionId: string
      textDelta: string
      text: string
      model?: string
      usage?: ChatUsage
    }
  | {
      type: 'assistant-complete'
      sessionId: string
      message: ChatMessage
    }
  | {
      type: 'assistant-error'
      sessionId: string
      errorCode: ChatSendErrorCode
      messageText: string
    }

interface ElectronApi {
  // Platform
  platform: string
  quitApp: () => Promise<boolean>
  onOpenContactModal: (listener: () => void) => () => void
  onOpenModelsPage: (listener: () => void) => () => void
  getOpenClawPaths: () => Promise<OpenClawPaths>

  // Environment
  checkNode: () => Promise<NodeCheckResult>
  checkOpenClaw: () => Promise<{ installed: boolean; version: string }>
  prepareMacGitTools: () => Promise<MacGitToolsPrepareResult>
  installNode: () => Promise<CliResultExtended>
  resolveNodeInstallPlan: () => Promise<NodeInstallPlan>
  downloadNodeInstaller: (plan?: NodeInstallPlan) => Promise<{ ok: boolean; path: string; error?: string; plan?: NodeInstallPlan }>
  inspectNodeInstaller: (installerPath: string) => Promise<NodeInstallerReadinessResult>
  installEnv: (opts: { needNode: boolean; needOpenClaw: boolean; nodeInstallerPath?: string; nodeInstallPlan?: NodeInstallPlan }) => Promise<CliResultExtended>
  discoverOpenClaw: () => Promise<OpenClawDiscoveryResult>
  discoverOpenClawForEnvCheck: () => Promise<OpenClawDiscoveryResult>
  appendEnvCheckDiagnostic: (event: string, fields?: Record<string, unknown>) => Promise<void>
  checkOpenClawLatestVersion: () => Promise<OpenClawLatestVersionCheckResult>
  ensureOpenClawBaselineBackup: (candidate: OpenClawInstallCandidate) => Promise<OpenClawBaselineBackupEnsureResult>
  skipOpenClawBaselineBackup: (candidate: OpenClawInstallCandidate) => Promise<OpenClawBaselineBackupSkipResult>
  getOpenClawBaselineBackupStatus: (installFingerprint: string) => Promise<OpenClawBaselineBackupRecord | null>
  markManagedOpenClawInstall: (installFingerprint: string) => Promise<boolean>
  getOpenClawDataGuard: (candidate?: OpenClawInstallCandidate | null) => Promise<OpenClawDataGuardSummary>
  prepareManagedOpenClawConfigWrite: (candidate?: OpenClawInstallCandidate | null) => Promise<OpenClawGuardPrepareResult>
  writeConfigGuarded: (
    request: OpenClawGuardedConfigWriteRequest,
    candidate?: OpenClawInstallCandidate | null
  ) => Promise<OpenClawGuardedWriteResult>
  applyConfigPatchGuarded: (
    request: OpenClawConfigPatchWriteRequest,
    candidate?: OpenClawInstallCandidate | null
  ) => Promise<OpenClawGuardedWriteResult>
  writeEnvFileGuarded: (
    request: OpenClawGuardedEnvWriteRequest,
    candidate?: OpenClawInstallCandidate | null
  ) => Promise<OpenClawGuardedWriteResult>
  getOpenClawOwnership: (installFingerprint: string) => Promise<OpenClawOwnershipEntry | null>
  listOpenClawOwnershipChanges: (installFingerprint: string) => Promise<OpenClawOwnershipChangeList | null>
  previewOpenClawCleanup: (request: OpenClawCleanupPreviewRequest) => Promise<OpenClawCleanupPreviewResult>
  runOpenClawCleanup: (request: OpenClawCleanupRunRequest) => Promise<OpenClawCleanupRunResult>
  previewQClawUninstall: (request: OpenClawCleanupPreviewRequest) => Promise<OpenClawCleanupPreviewResult>
  prepareQClawUninstall: (request: OpenClawCleanupRunRequest) => Promise<OpenClawCleanupRunResult>
  listOpenClawBackups: () => Promise<OpenClawBackupListResult>
  getOpenClawBackupRoot: () => Promise<OpenClawBackupRootInfo>
  runOpenClawManualBackup: () => Promise<OpenClawManualBackupRunResult>
  runOpenClawDataCleanup: (request: OpenClawDataCleanupRunRequest) => Promise<OpenClawDataCleanupRunResult>
  deleteOpenClawBackup: (backupId: string) => Promise<OpenClawBackupDeleteResult>
  deleteAllOpenClawBackups: () => Promise<OpenClawBackupDeleteResult>
  openOpenClawBackupDirectory: (targetPath?: string) => Promise<{ ok: boolean; path: string; error?: string }>
  openOpenClawWorkspace: () => Promise<{ ok: boolean; path: string; error?: string }>
  previewOpenClawRestore: (backupId: string) => Promise<OpenClawRestorePreviewResult>
  runOpenClawRestore: (backupId: string, scope: OpenClawRestoreScope) => Promise<OpenClawRestoreRunResult>
  checkOpenClawUpgrade: () => Promise<OpenClawUpgradeCheckResult>
  checkOpenClawUpgradeForEnvCheck: (
    discovery: OpenClawDiscoveryResult | null
  ) => Promise<OpenClawUpgradeCheckResult>
  runOpenClawUpgrade: () => Promise<OpenClawUpgradeRunResult>
  getQClawUpdateStatus: () => Promise<QClawUpdateStatus>
  checkQClawUpdate: () => Promise<QClawUpdateStatus>
  downloadQClawUpdate: () => Promise<QClawUpdateActionResult>
  installQClawUpdate: () => Promise<QClawUpdateActionResult>
  openQClawUpdateDownloadUrl: () => Promise<QClawUpdateOpenDownloadResult>
  checkCombinedUpdate: () => Promise<CombinedUpdateCheckResult>
  runCombinedUpdate: () => Promise<CombinedUpdateRunResult>

  // Environment refresh
  refreshEnvironment: () => Promise<{ ok: boolean; newPath?: string }>
  waitForCommand: (command: string, args?: string[]) => Promise<{ ok: boolean; version?: string }>

  // Command control
  cancelCommand: () => Promise<boolean>
  cancelCommandDetailed: () => Promise<CancelActiveProcessesResult>
  cancelCommandDomain: (domain: CommandControlDomain) => Promise<boolean>
  cancelCommands: (domains: CommandControlDomain[]) => Promise<CancelActiveProcessesResult>

  // Onboard
  onboard: (opts: Record<string, any>) => Promise<OnboardResult>

  // Gateway
  gatewayHealth: () => Promise<GatewayHealthCheckResult>
  getOpenClawRuntimeReconcileState: () => Promise<OpenClawRuntimeReconcileStore>
  gatewayForceRestart: () => Promise<CliResult>
  reloadGatewayAfterModelChange: () => Promise<GatewayReloadResult>
  reloadGatewayAfterChannelChange: () => Promise<GatewayReloadResult>
  reloadGatewayManual: () => Promise<GatewayReloadResult>
  ensureGatewayRunning: (options?: {
    skipRuntimePrecheck?: boolean
    requestId?: string
  }) => Promise<GatewayEnsureRunningResult>
  onGatewayBootstrapState: (listener: (payload: GatewayBootstrapStateEvent) => void) => () => void

  // Status
  getStatus: () => Promise<CliResult>

  // Config
  readConfig: (options?: { configPath?: string | null }) => Promise<Record<string, any> | null>

  // Env file
  readEnvFile: () => Promise<Record<string, string>>

  // Doctor
  runDoctor: (options?: { fix?: boolean; nonInteractive?: boolean }) => Promise<CliResult>

  // Pairing
  pairingApprove: (channel: string, code: string, accountId?: string) => Promise<PairingApproveResult>
  pairingAddAllowFrom: (channel: string, senderId: string, accountId?: string) => Promise<CliResult>
  pairingAllowFromUsers: (channel: string, accountId?: string) => Promise<PairingAllowFromUser[]>
  pairingFeishuStatus: (accountIds: string[]) => Promise<Record<string, { pairedCount: number; pairedUsers: string[] }>>
  getFeishuRuntimeStatus: () => Promise<Record<string, FeishuBotRuntimeStatus>>
  pairingFeishuAccounts: (accountId?: string) => Promise<Array<{ openId: string; name: string }>>
  pairingRemoveAllowFrom: (channel: string, senderId: string, accountId?: string) => Promise<CliResult>

  // Plugins
  installPlugin: (name: string, expectedPluginIds?: string[]) => Promise<CliResult>
  installPluginNpx: (url: string, expectedPluginIds?: string[]) => Promise<CliResult>
  repairIncompatiblePlugins: (options?: RepairIncompatiblePluginsOptions) => Promise<RepairIncompatiblePluginsResult>
  scanIncompatiblePlugins: (options?: ScanIncompatiblePluginsOptions) => Promise<RepairIncompatiblePluginsResult>
  isPluginInstalledOnDisk: (pluginId: string) => Promise<boolean>
  uninstallPlugin: (name: string) => Promise<CliResult>
  isFeishuOfficialPluginInstalled: () => Promise<boolean>
  getFeishuOfficialPluginState: () => Promise<FeishuOfficialPluginState>
  ensureFeishuOfficialPluginReady: () => Promise<EnsureFeishuOfficialPluginReadyResult>
  validateFeishuCredentials: (appId: string, appSecret: string, domain?: string) => Promise<CliResult>
  getFeishuInstallerState: () => Promise<FeishuInstallerSessionSnapshot>
  startFeishuInstaller: () => Promise<FeishuInstallerSessionSnapshot>
  listenFeishuBotDiagnosticActivity: (
    accountId?: FeishuBotDiagnosticListenRequest['accountId'],
    timeoutMs?: FeishuBotDiagnosticListenRequest['timeoutMs'],
    requestId?: FeishuBotDiagnosticListenRequest['requestId']
  ) => Promise<FeishuBotDiagnosticListenResult>
  cancelFeishuBotDiagnosticListen: (requestId: string) => Promise<{ ok: boolean }>
  sendFeishuDiagnosticMessage: (request: FeishuBotDiagnosticSendRequest) => Promise<FeishuBotDiagnosticSendResult>
  sendFeishuInstallerInput: (sessionId: string, input: string) => Promise<{ ok: boolean; message?: string }>
  answerFeishuInstallerPrompt: (
    sessionId: string,
    promptId: string,
    resolution: FeishuInstallerPromptResolution
  ) => Promise<{ ok: boolean; message?: string }>
  stopFeishuInstaller: () => Promise<{ ok: boolean }>
  onFeishuInstallerEvent: (listener: (payload: FeishuInstallerSessionEvent) => void) => () => void
  getWeixinInstallerState: () => Promise<WeixinInstallerSessionSnapshot>
  startWeixinInstaller: () => Promise<WeixinInstallerSessionSnapshot>
  stopWeixinInstaller: () => Promise<{ ok: boolean }>
  onWeixinInstallerEvent: (listener: (payload: WeixinInstallerSessionEvent) => void) => () => void
  listWeixinAccounts: () => Promise<WeixinAccountState[]>
  removeWeixinAccount: (accountId: string) => Promise<{ ok: boolean }>

  // Channels
  channelsAdd: (channel: string, token: string) => Promise<CliResult>
  setupDingtalkOfficialChannel: (formData: Record<string, string>) => Promise<DingtalkOfficialSetupResult>
  getOfficialChannelStatus: (channelId: 'feishu' | 'dingtalk') => Promise<OfficialChannelStatusView>
  repairOfficialChannel: (channelId: 'feishu' | 'dingtalk') => Promise<OfficialChannelActionResult>
  getManagedChannelPluginStatus: (channelId: string) => Promise<ManagedChannelPluginStatusView>
  prepareManagedChannelPluginForSetup: (channelId: string) => Promise<ManagedChannelPluginPrepareResult>
  repairManagedChannelPlugin: (channelId: string) => Promise<ManagedChannelPluginRepairResult>

  // Dashboard
  openDashboard: () => Promise<CliResult>
  getChatAvailability: () => Promise<DashboardChatAvailability>
  listChatSessions: () => Promise<ChatSessionSummary[]>
  createChatSession: () => Promise<ChatSessionSummary>
  createLocalChatSession: () => Promise<ChatSessionSummary>
  getChatCapabilitySnapshot: () => Promise<ChatCapabilitySnapshot>
  getChatSessionDebugSnapshot: (sessionId: string) => Promise<ChatSessionDebugSnapshot>
  listChatTraceEntries: (limit?: number) => Promise<ChatTraceEntry[]>
  patchChatSessionModel: (request: ChatPatchSessionModelRequest) => Promise<ChatPatchSessionModelResult>
  getChatTranscript: (sessionId: string) => Promise<ChatTranscript>
  sendChatMessage: (request: ChatSendRequest) => Promise<ChatSendResult>
  cancelChatMessage: () => Promise<boolean>
  clearChatTranscript: (sessionId: string) => Promise<ChatClearLocalTranscriptResult>
  onChatStream: (listener: (payload: ChatStreamEvent) => void) => () => void

  // Uninstall
  uninstallAll: () => Promise<CliResult>

  // WeChat Work QR binding
  wecomQrGenerate: () => Promise<WecomQrGenerateResult>
  wecomQrCheckResult: (scode: string) => Promise<WecomQrCheckResult>

  // OAuth
  checkOAuthComplete: (providerKey: string) => Promise<boolean>
  getLatestOAuthUrl: () => Promise<string | null>
  openOAuthUrl: (url?: string) => Promise<CliResult>
  inspectOAuthDependency: (authChoice: string) => Promise<OAuthExternalDependencyInspectionResult>
  installOAuthDependency: (request: InstallOAuthExternalDependencyRequest) => Promise<InstallOAuthExternalDependencyResult>

  // Local models
  testLocalConnection(input: {
    provider: 'ollama' | 'vllm' | 'custom-openai'
    baseUrl: string
    apiKey?: string
  }): Promise<{
    ok: boolean
    reachable: boolean
    modelCount?: number
    error?: string
    latencyMs?: number
  }>
  scanLocalModels(input: {
    provider: string
    baseUrl?: string
    apiKey?: string
    timeoutMs?: number
  }): Promise<ModelConfigCommandResult<Record<string, any>>>
  writeLocalModelEnv(updates: Record<string, string | undefined>): Promise<void>
  ensureLocalAuthProfile(input: {
    provider: 'ollama' | 'vllm' | 'custom-openai'
    apiKey?: string
  }): Promise<{
    ok: boolean
    created: boolean
    profileId: string
    error?: string
  }>
  clearModelAuthProfiles(input: {
    providerIds: string[]
    authStorePath?: string
  }): Promise<{
    ok: boolean
    removed: number
    removedProfileIds: string[]
    authStorePath?: string
    clearedLastGoodKeys?: string[]
    error?: string
  }>
  inspectModelAuthProfiles(input: {
    providerIds: string[]
    authStorePath?: string
  }): Promise<{
    ok: boolean
    present: boolean
    matchedProfileIds: string[]
    matchedLastGoodKeys: string[]
    authStorePath?: string
    error?: string
  }>
  clearExternalProviderAuth(input: {
    providerIds: string[]
  }): Promise<{
    ok: boolean
    cleared: boolean
    attemptedSources: string[]
    error?: string
  }>

  // Models center
  getModelCapabilities: () => Promise<OpenClawCapabilities>
  listModelCatalog: (query?: ModelCatalogQuery) => Promise<ModelCatalogResult>
  getModelSnapshot: (request?: ModelUiSnapshotRequest) => Promise<ModelUiSnapshotResult>
  getModelStatus: (options?: ModelStatusOptions) => Promise<ModelConfigCommandResult<Record<string, any>>>
  getModelUpstreamState: () => Promise<{
    ok: boolean
    source: 'control-ui-app'
    data?: {
      source: 'control-ui-app'
      connected: boolean
      hasClient: boolean
      appKeys: string[]
      /** @deprecated Diagnostics only. Prefer `debugSnapshots.helloSnapshot`. */
      helloSnapshot?: Record<string, unknown> | null
      /** @deprecated Diagnostics only. Prefer `debugSnapshots.healthResult`. */
      healthResult?: Record<string, unknown> | null
      /** @deprecated Diagnostics only. Prefer `debugSnapshots.sessionsState`. */
      sessionsState?: Record<string, unknown> | null
      /** @deprecated Diagnostics only. Prefer `debugSnapshots.modelCatalogState`. */
      modelCatalogState?: Record<string, unknown> | null
      modelStatusLike?: Record<string, unknown> | null
      modelStatusSummaryLike?: {
        defaultModel?: string
        activeModel?: string
        allowedCount?: number
        fallbackCount?: number
        providerAuth: Array<{
          provider: string
          status?: string
        }>
      }
      catalogItemsLike?: Array<{
        key: string
        provider: string
        name?: string
        available?: boolean
      }>
      catalogSummaryLike?: {
        totalItems: number
        availableItems: number
        providerKeys: string[]
      }
      sessionInventoryLike?: {
        totalSessions?: number
        continuableSessions?: number
        patchableSessions?: number
        observedKinds: string[]
        observedChannels: string[]
      }
      debugSnapshots?: {
        helloSnapshot?: Record<string, unknown> | null
        healthResult?: Record<string, unknown> | null
        sessionsState?: Record<string, unknown> | null
        modelCatalogState?: Record<string, unknown> | null
        sessionsResult?: Record<string, unknown> | null
        rpcStatus?: Record<string, unknown> | null
        rpcModels?: Record<string, unknown> | null
        chatModelCatalog?: Array<Record<string, unknown>> | null
        rpcErrors?: string[]
      }
    }
    fallbackUsed: boolean
    fallbackReason?: string
    diagnostics: {
      upstreamAvailable: boolean
      connected: boolean
      hasClient: boolean
      hasHelloSnapshot: boolean
      hasHealthResult: boolean
      hasSessionsState: boolean
      hasModelCatalogState: boolean
      appKeys: string[]
      lastError?: string
    }
  }>
  syncModelVerificationState: (input?: {
    statusData?: Record<string, any> | null
  }) => Promise<{
    version: number
    records: Array<{
      runtimeKey: string
      modelKey: string
      verificationState: 'verified-available' | 'verified-unavailable'
      source: 'runtime-auto' | 'switch-success' | 'switch-failed'
      updatedAt: string
    }>
  }>
  recordModelVerification: (input: {
    modelKey: string
    verificationState: 'verified-available' | 'verified-unavailable'
  }) => Promise<{
    version: number
    records: Array<{
      runtimeKey: string
      modelKey: string
      verificationState: 'verified-available' | 'verified-unavailable'
      source: 'runtime-auto' | 'switch-success' | 'switch-failed'
      updatedAt: string
    }>
  }>
  applyModelConfigViaUpstream: (request: {
    kind: 'default' | 'agent-primary'
    model: string
    agentId?: string
  }) => Promise<{
    ok: boolean
    wrote: boolean
    gatewayReloaded: boolean
    source: 'control-ui-config.apply'
    fallbackUsed: boolean
    fallbackReason?: string
    message?: string
  }>
  validateProviderCredential: (input: ValidateProviderCredentialInput) => Promise<ValidateProviderCredentialResult>
  applyModelConfig: (action: ModelConfigAction) => Promise<ModelConfigCommandResult<Record<string, any>>>
  runModelAuth: (action: ModelAuthAction) => Promise<RunModelAuthResult>
  startModelOAuth: (request: StartModelOAuthRequest) => Promise<StartModelOAuthResult>
  cancelModelOAuth: () => Promise<boolean>
  onOAuthState: (listener: (payload: OAuthStateEventPayload) => void) => () => void
  onOAuthCode: (listener: (payload: OAuthCodeEventPayload) => void) => () => void
  onOAuthSuccess: (listener: (payload: OAuthResultEventPayload) => void) => () => void
  onOAuthError: (listener: (payload: OAuthResultEventPayload) => void) => () => void
  refreshModelData: (payload?: RefreshModelDataPayload) => Promise<RefreshModelDataResult>

  // Skills 管理
  skillsList: () => Promise<CliResult>
  skillsInfo: (name: string) => Promise<CliResult>
  skillsToggle: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  skillsUpdate: (payload: {
    skillKey: string
    enabled?: boolean
    apiKey?: string
  }) => Promise<{ ok: boolean; error?: string }>
  skillsUninstall: (name: string) => Promise<CliResult>
  skillsInstall: (name: string) => Promise<CliResult>
  clawhubSearch: (query: string, limit?: number) => Promise<{ ok: boolean; skills: { slug: string; name: string; score: number }[]; error?: string }>
  clawhubInstall: (slug: string) => Promise<CliResult>
  depsInstallBin: (bin: string) => Promise<CliResult>
  depsInstallSkillDeps: (skillName: string) => Promise<CliResult>
  onDepsInstallLog: (listener: (msg: string) => void) => () => void
  depsCheckBrew: () => Promise<{ installed: boolean }>
  depsInstallBrew: () => Promise<CliResult>
}

declare global {
  interface Window {
    api: ElectronApi
  }
}

export {}
