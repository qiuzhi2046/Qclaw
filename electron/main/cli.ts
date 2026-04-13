/**
 * OpenClaw CLI wrapper — all interactions via spawn
 */
import type { ChildProcess } from 'node:child_process'
import { access, lstat, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import https from 'node:https'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { atomicWriteJson } from './atomic-write'
import { detectedNodeBinDirChanged, setDetectedNodeBinDir } from './detected-node-bin'
import { applyEnvFileUpdates } from './env-file'
import { createOAuthOutputScanner, shouldAutoOpenBrowserForArgs } from './oauth-browser'
import { normalizeAuthChoice } from './openclaw-spawn'
import { resolveStdioForCommand } from './cli-process'
import { writeWindowsManagedOpenClawRuntimeMarker } from './platforms/windows/windows-runtime-policy'
import { buildMacDeveloperToolsProbeEnv } from './mac-developer-tools'
import {
  probePlatformCommandCapability,
  resetCommandCapabilityCache,
  type PlatformCommandId,
} from './command-capabilities'
import {
  buildAppleScriptDoShellScript,
  buildGitHubHttpsRewriteEnvCommands,
  buildMacNpmCommand,
  extractNodeBinDir,
  isNodeVersionAtLeast,
  listNodeExecutableCandidates,
  prefixPosixCommandWithWorkingDirectory,
} from './node-runtime'
import {
  buildNvmInstallCommand,
  buildNvmNodeBinDir,
  buildNvmUseCommand,
  detectNvmWindowsDir,
  listInstalledNvmNodeBinDirs,
  listInstalledNvmWindowsNodeExePaths,
} from './nvm-node-runtime'
import {
  resolveNodeInstallStrategy,
  selectPreferredNodeRuntime,
  shouldFallbackToInstallerAfterNvmInstall,
} from './node-runtime-selection'
import {
  OPENCLAW_NPM_REGISTRY_MIRRORS,
  type OpenClawNpmCommandOptions,
  type OpenClawCommandResultLike,
  type OpenClawNpmRegistryAttempt,
  attachOpenClawMirrorFailureDetails,
  buildOpenClawConfigGetPrefixArgs,
  buildMirrorAwareTimeoutMs,
  buildOpenClawInstallArgs,
  buildOpenClawUninstallArgs,
  runOpenClawNpmRegistryFallback,
} from './openclaw-download-fallbacks'
import {
  isMacOpenClawAdminFallbackEnabledByPolicy,
  shouldPreferMacOpenClawAdminMainlineByProbe,
  shouldAllowMacOpenClawAdminFallbackByProbe,
} from './openclaw-admin-fallback-policy'
import { sanitizeManagedPluginConfig } from './openclaw-plugin-config'
import { appendEnvCheckDiagnostic } from './env-check-diagnostics'
import { restoreConfiguredManagedChannelPlugins } from './managed-channel-plugin-restore'
import {
  buildIncompatiblePluginRepairSummary,
  finalizePluginInstallSafetyResult,
  repairIncompatibleExtensionPlugins as repairIncompatibleExtensionPluginsOnDisk,
  reconcileIncompatibleExtensionPlugins,
  type RepairIncompatibleExtensionsResult,
} from './plugin-install-safety'
import {
  getManagedChannelPluginByChannelId,
  isOfficialManagedPluginId,
} from '../../src/shared/managed-channel-plugin-registry'
import { repairKnownProviderConfigGaps, repairKnownProviderConfigGapsOnDisk } from './openclaw-provider-config-repair'
import {
  mutatePairingAllowFromInConfig,
  normalizePairingAllowFromList,
  resolvePairingConfigTarget,
} from './pairing-allowfrom-config'
import type { OpenClawDiscoveryResult, OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import { buildCliPathWithCandidates, listExecutablePathCandidates } from './runtime-path-discovery'
import { resolveBoundOpenClawCommand } from './openclaw-runtime-invocation'
import { ensureWindowsPrivateNodeRuntime } from './platforms/windows/windows-private-node-runtime'
import {
  buildWindowsActiveRuntimeSnapshot,
  buildWindowsSelectedRuntimeSnapshotFields,
  prepareWindowsManagedOpenClawRuntimeCandidate,
  resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable,
  reuseWindowsSelectedRuntimeSnapshotFields,
  resolveWindowsPrivateOpenClawRuntimePaths,
  resolveWindowsPrivateNodeRuntimePaths,
  selectAuthoritativeWindowsActiveRuntimeSnapshot,
  type WindowsActiveRuntimeSnapshot,
} from './platforms/windows/windows-runtime-policy'
import { rankWindowsActiveRuntimeDiscoveryCandidates } from './platforms/windows/windows-runtime-selection'
import {
  normalizeWindowsChannelRuntimeSnapshot,
  type WindowsChannelRuntimeSnapshot,
  type WindowsManagedPluginSnapshot,
  type WindowsResolvedChannelBinding,
} from './platforms/windows/windows-channel-runtime-snapshot'
import {
  clearCachedWindowsChannelRuntimeSnapshot,
  readCachedWindowsChannelRuntimeSnapshot,
  replaceCachedWindowsChannelRuntimeSnapshot,
  reconcileWindowsChannelRuntimeSelection,
} from './platforms/windows/windows-channel-runtime-reconcile'
import { inspectMacNodeInstaller, type NodeInstallerReadinessResult } from './node-installer-checks'
import { isSkipConfigUnsupportedError, shouldTryLegacySkipConfig } from './plugin-install-npx'
import {
  DEFAULT_BUNDLED_NODE_REQUIREMENT,
  getBundledTargetNodeVersion,
  resolveNodeInstallPlan as resolveRuntimeNodeInstallPlan,
  resolveOpenClawNodeRequirement,
  type NodeInstallPlan,
} from './node-installation-policy'
import {
  buildOpenClawGatewayUninstallArgs,
  buildOpenClawStateUninstallArgs,
  resolveLaunchAgentCleanupPlan,
  resolveShellInitFiles,
  stripManagedShellBlocks,
} from './openclaw-cleanup'
import {
  formatDisplayPathWithHome,
  isOpenClawInstallPermissionFailureOutput,
  isOpenClawInstallPermissionFailureResult,
  probeOpenClawInstallPath,
  resolveOpenClawGlobalInstallProbePath,
  type OpenClawInstallPathProbe,
} from './openclaw-install-permissions'
import {
  runCliLikeWithPermissionAutoRepair,
  runFsWithPermissionAutoRepair,
} from './openclaw-permission-auto-repair'
import {
  resolveOpenClawBinaryPath,
  resolveOpenClawBinaryPathFromNpmPrefix,
  resolveOpenClawPackageRoot,
} from './openclaw-package'
import { buildOnboardCommand, collectOnboardValueFlags } from './openclaw-command-builder'
import { parseJsonFromCommandResult } from './openclaw-command-output'
import type { RepairStalePluginConfigFromCommandResult } from './openclaw-config-warnings'
import type { OpenClawPaths } from './openclaw-paths'
import { resolveOpenClawPaths, resolveOpenClawPathsFromStateRoot } from './openclaw-paths'
import { rerunReadOnlyCommandAfterStalePluginRepair } from './openclaw-readonly-stale-plugin-repair'
import { resolveOpenClawPathsForRead } from './openclaw-runtime-readonly'
import { resetRuntimeOpenClawPathsCache, resolveRuntimeOpenClawPaths } from './openclaw-runtime-paths'
import { isProviderConfiguredInStatus } from './openclaw-status'
import {
  cancelActiveProcess as cancelTrackedProcess,
  cancelActiveProcesses as cancelTrackedProcesses,
  type CancelActiveProcessesResult,
  clearActiveProcessIfMatch,
  consumeCanceledProcess,
  type CommandControlDomain,
  setActiveProcess as trackActiveProcess,
  setActiveAbortController as trackActiveAbortController,
} from './command-control'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'
import { withManagedOperationLock } from './managed-operation-lock'
import {
  createPrivilegedOpenClawNpmCommandOptions,
  ensureManagedOpenClawNpmRuntime,
} from './openclaw-npm-runtime'
import {
  runMacOpenClawElevatedLifecycleTransaction,
  type OpenClawElevatedLifecycleTransactionResult,
} from './openclaw-elevated-lifecycle-transaction'
import { sanitizeManagedInstallerEnv } from './managed-installer-env'
import { cleanupIsolatedNpmCacheEnv, createIsolatedNpmCacheEnv } from './npm-cache-env'
import { pollWithBackoff } from '../../src/shared/polling'
import { PINNED_OPENCLAW_VERSION, resolveOpenClawVersionEnforcement } from '../../src/shared/openclaw-version-policy'
import { runPluginRepairPreflight } from './plugin-repair-preflight'
import {
  classifyOnboardFailure,
  isPluginAlreadyInstalledError,
  type OnboardErrorCode,
} from '../../src/shared/openclaw-cli-errors'
import { resolvePairingApproveErrorCode, type PairingApproveErrorCode } from '../../src/shared/pairing-protocol'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import type { GatewayRuntimeStateCode } from '../../src/shared/gateway-runtime-state'
import {
  clearSelectedWindowsActiveRuntimeSnapshot,
  getSelectedWindowsActiveRuntimeSnapshot,
  setSelectedWindowsActiveRuntimeSnapshot,
} from './windows-active-runtime'
import {
  discoverOpenClawInstallations,
  discoverOpenClawInstallationsFromKnownPaths,
} from './openclaw-install-discovery'

// 记录检测到的 Node.js bin 目录，用于后续找 npm
let detectedNodeBinDir: string | null = null
let openClawConfigRepairPreflightPromise: Promise<void> | null = null
let selectedWindowsActiveRuntimeSnapshotPromise: Promise<WindowsActiveRuntimeSnapshot | null> | null = null

function normalizeRuntimePathForCompare(value: string | null | undefined): string {
  const trimmed = String(value || '').trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

function clearSelectedWindowsRuntimeSnapshot(): void {
  if (process.platform !== 'win32') return
  selectedWindowsActiveRuntimeSnapshotPromise = null
  clearSelectedWindowsActiveRuntimeSnapshot()
  clearCachedWindowsChannelRuntimeSnapshot()
}

function rememberDetectedNodeBinDir(nextBinDir: string | null | undefined): string | null {
  const normalizedNext = String(nextBinDir || '').trim() || null
  if (detectedNodeBinDirChanged(normalizedNext)) {
    clearSelectedWindowsRuntimeSnapshot()
  }
  detectedNodeBinDir = normalizedNext
  setDetectedNodeBinDir(normalizedNext)
  return detectedNodeBinDir
}

function getCurrentWindowsActiveRuntimeSnapshot(): WindowsActiveRuntimeSnapshot | null {
  if (process.platform !== 'win32') return null
  return getSelectedWindowsActiveRuntimeSnapshot()
}

async function resolveWindowsActiveRuntimeSnapshotForRead(
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null
  if (activeRuntimeSnapshot) return activeRuntimeSnapshot

  const cachedRuntimeSnapshot = getCurrentWindowsActiveRuntimeSnapshot()
  if (cachedRuntimeSnapshot) return cachedRuntimeSnapshot

  // Read-only paths can still derive the selected private runtime directly
  // without committing or reconciling runtime state.
  return resolveSelectedWindowsOpenClawRuntimeSnapshot()
}

async function canAccessPath(targetPath: string): Promise<boolean> {
  const trimmed = String(targetPath || '').trim()
  if (!trimmed) return false
  try {
    await access(trimmed)
    return true
  } catch {
    return false
  }
}

async function inspectSelectedWindowsOpenClawRuntimeCompleteness(): Promise<boolean> {
  if (process.platform !== 'win32') return true

  await appendEnvCheckDiagnostic('main-openclaw-completeness-check-start', {})
  const activeRuntimeSnapshot = await resolveSelectedWindowsOpenClawRuntimeSnapshot()
  if (!activeRuntimeSnapshot) {
    const nodeExecutable = await resolveSelectedWindowsNodeExecutablePath()
    const requiredRuntimePaths = resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
      nodeExecutable,
      {
        env: process.env,
      }
    )
    const completeWithoutSnapshot = requiredRuntimePaths ? false : true
    await appendEnvCheckDiagnostic('main-openclaw-completeness-check-result', {
      hasActiveRuntimeSnapshot: false,
      nodeExecutable: nodeExecutable || null,
      complete: completeWithoutSnapshot,
      requiredRuntimePathsDetected: Boolean(requiredRuntimePaths),
    })
    return completeWithoutSnapshot
  }

  const completeWithSnapshot = await canAccessWindowsActiveRuntimeSnapshot(activeRuntimeSnapshot)
  await appendEnvCheckDiagnostic('main-openclaw-completeness-check-result', {
    hasActiveRuntimeSnapshot: true,
    nodeExecutable: activeRuntimeSnapshot.nodePath || null,
    openclawPath: activeRuntimeSnapshot.openclawPath || null,
    complete: completeWithSnapshot,
  })
  return completeWithSnapshot
}

async function resolveSelectedWindowsNodeExecutablePath(): Promise<string> {
  if (process.platform !== 'win32') return ''

  const candidates = listExecutablePathCandidates('node', {
    platform: 'win32',
    currentPath: process.env.PATH || '',
    detectedNodeBinDir,
    env: process.env,
  })

  for (const candidate of candidates) {
    if (await canAccessPath(candidate)) {
      return candidate
    }
  }

  return ''
}

async function resolveSelectedWindowsOpenClawRuntimeSnapshot(): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null

  const nodeExecutable = await resolveSelectedWindowsNodeExecutablePath()
  if (!nodeExecutable) return null

  const requiredRuntimePaths = resolveRequiredWindowsOpenClawRuntimePathsForNodeExecutable(
    nodeExecutable,
    {
      env: process.env,
    }
  )
  if (!requiredRuntimePaths) return null

  const openClawPaths = await resolveRuntimeOpenClawPaths({
    binaryPath: requiredRuntimePaths.openclawExecutable,
    platform: 'win32',
    env: process.env,
  }).catch(() => null)
  if (!openClawPaths?.homeDir || !openClawPaths.configFile) return null

  const privateRuntimeSnapshot = buildWindowsActiveRuntimeSnapshot({
    openclawExecutable: requiredRuntimePaths.openclawExecutable,
    hostPackageRoot: requiredRuntimePaths.hostPackageRoot,
    nodeExecutable,
    npmPrefix: resolveWindowsPrivateOpenClawRuntimePaths({
      env: process.env,
    }).npmPrefix,
    configPath: openClawPaths.configFile,
    stateDir: openClawPaths.homeDir,
    extensionsDir: join(openClawPaths.homeDir, 'extensions'),
    userDataDir: String(process.env.QCLAW_USER_DATA_DIR || '').trim() || undefined,
  })
  if (await canAccessWindowsActiveRuntimeSnapshot(privateRuntimeSnapshot)) {
    return privateRuntimeSnapshot
  }

  return null
}

async function canAccessWindowsActiveRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined
): Promise<boolean> {
  const candidate = snapshot || null
  if (!candidate) return false

  const nodePath = String(candidate.nodePath || '').trim()
  const openclawPath = String(candidate.openclawPath || '').trim()
  const hostPackageRoot = String(candidate.hostPackageRoot || '').trim()
  if (!nodePath || !openclawPath || !hostPackageRoot) return false

  const [nodeExists, openclawExists, hostPackageRootExists] = await Promise.all([
    canAccessPath(nodePath),
    canAccessPath(openclawPath),
    canAccessPath(hostPackageRoot),
  ])
  return nodeExists && openclawExists && hostPackageRootExists
}

function resolveDiscoveryActiveCandidate(
  discovery: OpenClawDiscoveryResult | null | undefined
): OpenClawInstallCandidate | null {
  const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : []
  const activeCandidateId = String(discovery?.activeCandidateId || '').trim()
  return (
    candidates.find((candidate) => candidate.candidateId === activeCandidateId)
    || candidates.find((candidate) => candidate.isPathActive)
    || candidates[0]
    || null
  )
}

function shouldSwitchWindowsRuntimeToManagedCandidate(
  candidate: OpenClawInstallCandidate | null | undefined
): boolean {
  const activeCandidate = candidate || null
  if (!activeCandidate) return false
  if (activeCandidate.installSource === 'qclaw-managed') return false

  const policy = resolveOpenClawVersionEnforcement({
    version: activeCandidate.version,
    installSource: activeCandidate.installSource,
    candidatePaths: activeCandidate,
    platform: 'win32',
  })
  return policy.blocksContinue
}

async function prepareManagedWindowsRuntimeSnapshotFromExistingRuntime(input: {
  configPath?: string | null
  stateDir?: string | null
  extensionsDir?: string | null
}): Promise<WindowsActiveRuntimeSnapshot | null> {
  const stateDir = String(input.stateDir || '').trim()
  const configPath = String(input.configPath || '').trim()
  const extensionsDir = String(input.extensionsDir || '').trim() || join(stateDir, 'extensions')
  if (!stateDir || !configPath) {
    await appendEnvCheckDiagnostic('main-windows-runtime-preparing-managed-runtime-skipped', {
      reason: 'missing-runtime-paths',
      hasStateDir: Boolean(stateDir),
      hasConfigPath: Boolean(configPath),
    }).catch(() => undefined)
    return null
  }

  await appendEnvCheckDiagnostic('main-windows-runtime-preparing-managed-runtime', {
    stateDir,
    configPath,
    extensionsDir,
  }).catch(() => undefined)

  try {
    const preparedManagedRuntime = await prepareWindowsManagedOpenClawRuntimeCandidate({
      configPath,
      env: process.env,
      extensionsDir,
      stateDir,
      userDataDir: String(process.env.QCLAW_USER_DATA_DIR || '').trim() || undefined,
    })
    const preparedSnapshot = preparedManagedRuntime.snapshot

    await appendEnvCheckDiagnostic('main-windows-runtime-verifying-managed-runtime', {
      ok: preparedManagedRuntime.ok,
      reason: preparedManagedRuntime.ok ? 'candidate-ready' : 'candidate-incomplete',
      stateDir,
      configPath,
      openclawPath: preparedManagedRuntime.ok ? preparedSnapshot?.openclawPath || null : null,
      nodePath: preparedManagedRuntime.ok ? preparedSnapshot?.nodePath || null : null,
    }).catch(() => undefined)

    return preparedManagedRuntime.ok ? preparedSnapshot : null
  } catch (error) {
    await appendEnvCheckDiagnostic('main-windows-runtime-verifying-managed-runtime', {
      ok: false,
      reason: 'prepare-threw',
      stateDir,
      configPath,
      error: error instanceof Error ? error.message : String(error || 'unknown'),
    }).catch(() => undefined)
    return null
  }
}

export async function activateManagedWindowsRuntimeSnapshotFromExistingRuntime(input: {
  configPath?: string | null
  stateDir?: string | null
  extensionsDir?: string | null
}): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null
  const preparedManagedRuntimeSnapshot = await prepareManagedWindowsRuntimeSnapshotFromExistingRuntime(input)
  if (!preparedManagedRuntimeSnapshot) return null
  return commitSelectedWindowsActiveRuntimeSnapshot(preparedManagedRuntimeSnapshot)
}

async function discoverWindowsActiveRuntimeSnapshot(): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null

  const selectedRuntimeSnapshot = await resolveSelectedWindowsOpenClawRuntimeSnapshot()
  if (selectedRuntimeSnapshot) {
    return selectedRuntimeSnapshot
  }

  const nodeExecutable = await resolveSelectedWindowsNodeExecutablePath()
  if (!nodeExecutable) return null

  const discovery = await discoverOpenClawInstallations().catch(() => null)
  const rankedCandidates = rankWindowsActiveRuntimeDiscoveryCandidates(
    (discovery?.candidates || []).flatMap((candidate) =>
      candidate.activeRuntimeSnapshot
        ? [
            {
              snapshot: candidate.activeRuntimeSnapshot,
              isPathActive: candidate.isPathActive,
            },
          ]
        : []
    ),
    {
      env: process.env,
    }
  )

  const selectedCandidate = await selectAuthoritativeWindowsActiveRuntimeSnapshot(rankedCandidates, {
    env: process.env,
    isSnapshotComplete: canAccessWindowsActiveRuntimeSnapshot,
  })
  const activeDiscoveryCandidate = resolveDiscoveryActiveCandidate(discovery)
  const shouldSwitchToManaged = shouldSwitchWindowsRuntimeToManagedCandidate(activeDiscoveryCandidate)
  await appendEnvCheckDiagnostic('main-windows-runtime-selection-decision', {
    hasSelectedCandidate: Boolean(selectedCandidate),
    activeCandidateId: activeDiscoveryCandidate?.candidateId || null,
    activeCandidateSource: activeDiscoveryCandidate?.installSource || null,
    activeCandidateVersion: activeDiscoveryCandidate?.version || null,
    shouldSwitchToManaged,
  }).catch(() => undefined)
  if (selectedCandidate) {
    if (!shouldSwitchToManaged) {
      await appendEnvCheckDiagnostic('main-windows-runtime-selection-result', {
        decision: 'keep-selected',
        reason: 'active-candidate-not-blocking',
        selectedNodePath: selectedCandidate.nodePath,
        selectedOpenClawPath: selectedCandidate.openclawPath,
      }).catch(() => undefined)
      return selectedCandidate
    }

    const preparedManagedRuntimeSnapshot = await prepareManagedWindowsRuntimeSnapshotFromExistingRuntime({
      configPath: activeDiscoveryCandidate?.configPath || selectedCandidate.configPath,
      stateDir: activeDiscoveryCandidate?.stateRoot || selectedCandidate.stateDir,
      extensionsDir: selectedCandidate.extensionsDir,
    })
    if (preparedManagedRuntimeSnapshot) {
      await appendEnvCheckDiagnostic('main-windows-runtime-selection-result', {
        decision: 'use-prepared-managed',
        reason: 'blocking-active-candidate',
        previousOpenClawPath: selectedCandidate.openclawPath,
        selectedOpenClawPath: preparedManagedRuntimeSnapshot.openclawPath,
        selectedNodePath: preparedManagedRuntimeSnapshot.nodePath,
      }).catch(() => undefined)
      return preparedManagedRuntimeSnapshot
    }

    await appendEnvCheckDiagnostic('main-windows-runtime-selection-result', {
      decision: 'keep-selected',
      reason: 'managed-runtime-prepare-failed',
      selectedNodePath: selectedCandidate.nodePath,
      selectedOpenClawPath: selectedCandidate.openclawPath,
    }).catch(() => undefined)
    return selectedCandidate
  }

  const openclawExecutable = await resolveOpenClawBinaryPath({
    platform: 'win32',
    env: process.env,
  }).catch(() => '')
  if (!openclawExecutable) return null
  const hostPackageRoot = await resolveOpenClawPackageRoot({
    binaryPath: openclawExecutable,
    env: process.env,
    platform: 'win32',
  }).catch(() => '')

  const openClawPaths = await resolveRuntimeOpenClawPaths({
    binaryPath: openclawExecutable,
    platform: 'win32',
    env: process.env,
  }).catch(() => null)
  if (!openClawPaths?.homeDir || !openClawPaths.configFile) return null

  if (shouldSwitchToManaged) {
    const preparedManagedRuntimeSnapshot = await prepareManagedWindowsRuntimeSnapshotFromExistingRuntime({
      configPath: activeDiscoveryCandidate?.configPath || openClawPaths.configFile,
      stateDir: activeDiscoveryCandidate?.stateRoot || openClawPaths.homeDir,
      extensionsDir: join(activeDiscoveryCandidate?.stateRoot || openClawPaths.homeDir, 'extensions'),
    })
    if (preparedManagedRuntimeSnapshot) {
      await appendEnvCheckDiagnostic('main-windows-runtime-selection-result', {
        decision: 'use-prepared-managed',
        reason: 'blocking-active-candidate',
        previousOpenClawPath: openclawExecutable,
        selectedOpenClawPath: preparedManagedRuntimeSnapshot.openclawPath,
        selectedNodePath: preparedManagedRuntimeSnapshot.nodePath,
      }).catch(() => undefined)
      return preparedManagedRuntimeSnapshot
    }
  }

  await appendEnvCheckDiagnostic('main-windows-runtime-selection-result', {
    decision: 'use-external-fallback',
    reason: shouldSwitchToManaged ? 'managed-runtime-prepare-failed' : 'active-candidate-not-blocking',
    selectedNodePath: nodeExecutable,
    selectedOpenClawPath: openclawExecutable,
    activeCandidateId: activeDiscoveryCandidate?.candidateId || null,
    activeCandidateSource: activeDiscoveryCandidate?.installSource || null,
  }).catch(() => undefined)
  return buildWindowsActiveRuntimeSnapshot({
    openclawExecutable,
    hostPackageRoot,
    nodeExecutable,
    npmPrefix: dirname(openclawExecutable),
    configPath: openClawPaths.configFile,
    stateDir: openClawPaths.homeDir,
    extensionsDir: join(openClawPaths.homeDir, 'extensions'),
    userDataDir: String(process.env.QCLAW_USER_DATA_DIR || '').trim() || undefined,
  })
}

async function ensureSelectedWindowsActiveRuntimeSnapshot(): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null

  const existingSnapshot = getSelectedWindowsActiveRuntimeSnapshot()
  if (existingSnapshot) return existingSnapshot
  if (selectedWindowsActiveRuntimeSnapshotPromise) {
    return selectedWindowsActiveRuntimeSnapshotPromise
  }

  const discoveryPromise = (async () => {
    const discoveredSnapshot = await discoverWindowsActiveRuntimeSnapshot()
    if (!discoveredSnapshot) return null
    return commitSelectedWindowsActiveRuntimeSnapshot(discoveredSnapshot)
  })()
  selectedWindowsActiveRuntimeSnapshotPromise = discoveryPromise

  try {
    return await discoveryPromise
  } finally {
    if (selectedWindowsActiveRuntimeSnapshotPromise === discoveryPromise) {
      selectedWindowsActiveRuntimeSnapshotPromise = null
    }
  }
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFeishuSnapshotConfigured(config: Record<string, any> | null | undefined): boolean {
  const feishuConfig = config?.channels?.feishu
  if (hasOwnRecord(feishuConfig)) {
    if (normalizeText(feishuConfig.appId) || normalizeText(feishuConfig.appSecret)) return true
    if (hasOwnRecord(feishuConfig.accounts) && Object.keys(feishuConfig.accounts).length > 0) return true
  }

  const bindings = Array.isArray(config?.bindings) ? config.bindings : []
  return bindings.some((binding) => normalizeText(binding?.match?.channel) === 'feishu')
}

function resolveWindowsManagedPluginSnapshot(
  config: Record<string, any> | null,
  installedOnDisk: boolean,
  registeredPlugins: string[] | null
): WindowsManagedPluginSnapshot {
  const feishuPlugin = getManagedChannelPluginByChannelId('feishu')
  const allowedPlugins = Array.isArray(config?.plugins?.allow)
    ? config.plugins.allow.map((item: unknown) => normalizeText(item).toLowerCase()).filter(Boolean)
    : []
  const registeredPluginIds = Array.isArray(registeredPlugins)
    ? registeredPlugins.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : []
  const pluginId = normalizeText(feishuPlugin?.pluginId).toLowerCase()

  return {
    configured: isFeishuSnapshotConfigured(config),
    installedOnDisk,
    allowedInConfig: Boolean(pluginId && allowedPlugins.includes(pluginId)),
    registered: Boolean(pluginId && registeredPluginIds.includes(pluginId)),
    loaded: false,
    ready: false,
  }
}

function resolveWindowsResolvedChannelBinding(
  config: Record<string, any> | null
): WindowsResolvedChannelBinding {
  const bindings = Array.isArray(config?.bindings) ? config.bindings : []
  const feishuBinding = bindings.find((binding) => normalizeText(binding?.match?.channel) === 'feishu')
  if (feishuBinding) {
    return {
      channelId: 'feishu',
      accountId: normalizeText(feishuBinding?.match?.accountId) || 'default',
      agentId:
        normalizeText(feishuBinding?.agentId)
        || getManagedFeishuAgentId(normalizeText(feishuBinding?.match?.accountId) || 'default'),
      source: 'config-binding',
    }
  }

  if (isFeishuSnapshotConfigured(config)) {
    return {
      channelId: 'feishu',
      accountId: 'default',
      agentId: getManagedFeishuAgentId('default'),
      source: 'managed-plugin-registry',
    }
  }

  return {
    channelId: '',
    accountId: '',
    agentId: '',
    source: '',
  }
}

async function listRegisteredPluginsForWindowsSnapshot(input: {
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
}): Promise<string[] | null> {
  const result = await runCliStreaming(['plugins', 'list', '--json'], {
    activeRuntimeSnapshot: input.activeRuntimeSnapshot || undefined,
    controlDomain: 'plugin-install',
  }).catch(() => null)
  if (!result?.ok) return null

  try {
    const payload = parseJsonFromCommandResult<unknown>(result)
    if (Array.isArray(payload)) {
      return payload.map((item) => normalizeText(item)).filter(Boolean)
    }

    const pluginEntries = hasOwnRecord(payload) && Array.isArray(payload.plugins)
      ? payload.plugins
      : []
    return pluginEntries
      .map((item) => {
        if (typeof item === 'string') return normalizeText(item)
        if (!hasOwnRecord(item)) return ''
        return normalizeText(item.id || item.pluginId || item.name)
      })
      .filter(Boolean)
  } catch {
    return null
  }
}

export interface BuildAuthoritativeWindowsChannelRuntimeSnapshotDependencies {
  buildGatewayOwnerSnapshotFromLauncherIntegrity?: (input: {
    launcherPath: string | null
    shouldReinstallService: boolean
    status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
    taskName: string | null
  }) => WindowsChannelRuntimeSnapshot['gatewayOwner']
  inspectGatewayLauncherIntegrity?: (input: { homeDir: string }) => Promise<{
    launcherPath: string | null
    shouldReinstallService: boolean
    status: 'healthy' | 'launcher-missing' | 'service-missing' | 'unknown'
    taskName: string | null
  }>
  isPluginInstalledOnDisk?: (pluginId: string) => Promise<boolean>
  listRegisteredPlugins?: (input: {
    activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null
  }) => Promise<string[] | null>
  readConfig?: () => Promise<Record<string, any> | null>
  readSelectedRuntimeSnapshot?: () => Promise<WindowsActiveRuntimeSnapshot | null>
}

export interface CommitSelectedWindowsActiveRuntimeSnapshotDependencies {
  ensureAuthoritativeWindowsChannelRuntimeSnapshot?: typeof ensureAuthoritativeWindowsChannelRuntimeSnapshot
  getSelectedRuntimeSnapshot?: () => WindowsActiveRuntimeSnapshot | null
  readCachedWindowsChannelRuntimeSnapshot?: () => WindowsChannelRuntimeSnapshot | null
  reconcileWindowsChannelRuntimeSelection?: typeof reconcileWindowsChannelRuntimeSelection
  replaceCachedWindowsChannelRuntimeSnapshot?: (
    snapshot: WindowsChannelRuntimeSnapshot | null | undefined
  ) => WindowsChannelRuntimeSnapshot | null
  setSelectedRuntimeSnapshot?: (
    snapshot: WindowsActiveRuntimeSnapshot | null | undefined
  ) => WindowsActiveRuntimeSnapshot | null
}

export interface EnsureAuthoritativeWindowsChannelRuntimeSnapshotDependencies
  extends BuildAuthoritativeWindowsChannelRuntimeSnapshotDependencies {
  buildAuthoritativeWindowsChannelRuntimeSnapshot?: typeof buildAuthoritativeWindowsChannelRuntimeSnapshot
  readCachedWindowsChannelRuntimeSnapshot?: () => WindowsChannelRuntimeSnapshot | null
  replaceCachedWindowsChannelRuntimeSnapshot?: (
    snapshot: WindowsChannelRuntimeSnapshot | null | undefined
  ) => WindowsChannelRuntimeSnapshot | null
}

export function readAuthoritativeWindowsChannelRuntimeSnapshot(): WindowsChannelRuntimeSnapshot | null {
  if (process.platform !== 'win32') return null
  return readCachedWindowsChannelRuntimeSnapshot()
}

export async function ensureAuthoritativeWindowsChannelRuntimeSnapshot(
  dependencies: EnsureAuthoritativeWindowsChannelRuntimeSnapshotDependencies = {}
): Promise<WindowsChannelRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null

  const {
    buildAuthoritativeWindowsChannelRuntimeSnapshot: buildSnapshot,
    readCachedWindowsChannelRuntimeSnapshot: readCachedSnapshot,
    replaceCachedWindowsChannelRuntimeSnapshot: persistCachedSnapshot,
    ...buildDependencies
  } = dependencies
  const cachedSnapshot = (readCachedSnapshot || readCachedWindowsChannelRuntimeSnapshot)()
  if (cachedSnapshot) return cachedSnapshot

  const rebuiltSnapshot = await (
    buildSnapshot || buildAuthoritativeWindowsChannelRuntimeSnapshot
  )(null, buildDependencies)

  return (persistCachedSnapshot || replaceCachedWindowsChannelRuntimeSnapshot)(rebuiltSnapshot)
}

export async function commitSelectedWindowsActiveRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined,
  dependencies: CommitSelectedWindowsActiveRuntimeSnapshotDependencies = {}
): Promise<WindowsActiveRuntimeSnapshot | null> {
  if (process.platform !== 'win32') {
    return snapshot ? { ...snapshot } : null
  }

  const getSelectedRuntimeSnapshot =
    dependencies.getSelectedRuntimeSnapshot || getSelectedWindowsActiveRuntimeSnapshot
  const readCachedSnapshot =
    dependencies.readCachedWindowsChannelRuntimeSnapshot || readCachedWindowsChannelRuntimeSnapshot
  const persistCachedSnapshot =
    dependencies.replaceCachedWindowsChannelRuntimeSnapshot || replaceCachedWindowsChannelRuntimeSnapshot
  const setSelectedRuntimeSnapshot =
    dependencies.setSelectedRuntimeSnapshot || setSelectedWindowsActiveRuntimeSnapshot
  const previousSelectedRuntimeSnapshot = getSelectedRuntimeSnapshot()
  const nextSelectedRuntimeSnapshot = snapshot ? { ...snapshot } : null
  const previousAuthoritativeSnapshot = readCachedSnapshot()

  const changed = (
    [
      ['nodePath', previousSelectedRuntimeSnapshot?.nodePath, nextSelectedRuntimeSnapshot?.nodePath],
      ['openclawPath', previousSelectedRuntimeSnapshot?.openclawPath, nextSelectedRuntimeSnapshot?.openclawPath],
      ['hostPackageRoot', previousSelectedRuntimeSnapshot?.hostPackageRoot, nextSelectedRuntimeSnapshot?.hostPackageRoot],
      ['stateDir', previousSelectedRuntimeSnapshot?.stateDir, nextSelectedRuntimeSnapshot?.stateDir],
    ] as const
  ).some(([, previousValue, nextValue]) => {
    return normalizeRuntimePathForCompare(previousValue || '') !== normalizeRuntimePathForCompare(nextValue || '')
  })

  if (!changed) {
    if (previousSelectedRuntimeSnapshot && !readCachedSnapshot()) {
      await (
        dependencies.ensureAuthoritativeWindowsChannelRuntimeSnapshot
        || ensureAuthoritativeWindowsChannelRuntimeSnapshot
      )({
        readSelectedRuntimeSnapshot: async () => previousSelectedRuntimeSnapshot,
      })
    }
    return previousSelectedRuntimeSnapshot
  }

  const reconciledRuntimeSnapshot = await (
    dependencies.reconcileWindowsChannelRuntimeSelection || reconcileWindowsChannelRuntimeSelection
  )(
    {
      nextSelectedRuntimeSnapshot,
      previousSelectedRuntimeSnapshot,
    },
    {
      buildAuthoritativeSnapshot: (existingSnapshot, buildDependencies) =>
        buildAuthoritativeWindowsChannelRuntimeSnapshot(existingSnapshot, {
          ...buildDependencies,
          readSelectedRuntimeSnapshot: async () => nextSelectedRuntimeSnapshot,
        }),
      persistSnapshot: false,
      platform: 'win32',
    }
  )

  try {
    const committedSelectedRuntimeSnapshot = setSelectedRuntimeSnapshot(nextSelectedRuntimeSnapshot)
    persistCachedSnapshot(reconciledRuntimeSnapshot.snapshot)
    return committedSelectedRuntimeSnapshot
  } catch (error) {
    setSelectedRuntimeSnapshot(previousSelectedRuntimeSnapshot)
    persistCachedSnapshot(previousAuthoritativeSnapshot)
    throw error
  }
}

export async function buildAuthoritativeWindowsChannelRuntimeSnapshot(
  existingSnapshot: WindowsChannelRuntimeSnapshot | null = null,
  dependencies: BuildAuthoritativeWindowsChannelRuntimeSnapshotDependencies = {}
): Promise<WindowsChannelRuntimeSnapshot | null> {
  if (process.platform !== 'win32') return null

  const selectedRuntimeSnapshot = await (
    dependencies.readSelectedRuntimeSnapshot || ensureSelectedWindowsActiveRuntimeSnapshot
  )()
  if (!selectedRuntimeSnapshot) return null

  const selectedRuntimeFields = reuseWindowsSelectedRuntimeSnapshotFields(
    selectedRuntimeSnapshot,
    existingSnapshot ? buildWindowsSelectedRuntimeSnapshotFields(existingSnapshot) : null
  )
  const config = await (dependencies.readConfig || readConfig)().catch(() => null)
  const feishuPlugin = getManagedChannelPluginByChannelId('feishu')
  const [launcherIntegrity, registeredPlugins, installedOnDisk] = await Promise.all([
    (async () => {
      if (dependencies.inspectGatewayLauncherIntegrity) {
        return dependencies.inspectGatewayLauncherIntegrity({ homeDir: selectedRuntimeFields.stateDir })
      }

      const { inspectWindowsGatewayLauncherIntegrity } = await import('./platforms/windows/windows-platform-ops')
      return inspectWindowsGatewayLauncherIntegrity({
        homeDir: selectedRuntimeFields.stateDir,
      })
    })(),
    (dependencies.listRegisteredPlugins || listRegisteredPluginsForWindowsSnapshot)({
      activeRuntimeSnapshot: selectedRuntimeSnapshot,
    }),
    feishuPlugin?.pluginId
      ? (dependencies.isPluginInstalledOnDisk || isPluginInstalledOnDisk)(feishuPlugin.pluginId)
      : Promise.resolve(false),
  ])

  const buildGatewayOwnerSnapshotFromLauncherIntegrity =
    dependencies.buildGatewayOwnerSnapshotFromLauncherIntegrity ||
    (
      await import('./platforms/windows/windows-platform-ops')
    ).buildWindowsGatewayOwnerSnapshotFromLauncherIntegrity

  return normalizeWindowsChannelRuntimeSnapshot({
    ...selectedRuntimeFields,
    gatewayOwner: buildGatewayOwnerSnapshotFromLauncherIntegrity(launcherIntegrity),
    managedPlugin: resolveWindowsManagedPluginSnapshot(config, installedOnDisk, registeredPlugins),
    resolvedBinding: resolveWindowsResolvedChannelBinding(config),
  })
}

function extractFirstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

async function ensureOpenClawConfigRepairPreflight(): Promise<void> {
  return ensureOpenClawConfigRepairPreflightWithOptions({})
}

interface EnsureOpenClawConfigRepairPreflightOptions {
  preferredHomeDir?: string | null
}

async function ensureOpenClawConfigRepairPreflightWithOptions(
  options: EnsureOpenClawConfigRepairPreflightOptions = {}
): Promise<void> {
  if (openClawConfigRepairPreflightPromise) {
    appendEnvCheckDiagnostic('main-config-preflight-reuse-pending', {}).catch(() => undefined)
    return openClawConfigRepairPreflightPromise
  }

  const preferredHomeDir = String(options.preferredHomeDir || '').trim() || null

  openClawConfigRepairPreflightPromise = (async () => {
    try {
      appendEnvCheckDiagnostic('main-config-preflight-start', {}).catch(() => undefined)
      await runPluginRepairPreflight({
        resolveHomeDir: async () => {
          appendEnvCheckDiagnostic('main-config-preflight-step-home-dir-start', {
            step: 'incompatible-plugins',
          }).catch(() => undefined)
          const homeDir = preferredHomeDir || String((await getOpenClawPaths().catch(() => null))?.homeDir || '').trim() || null
          appendEnvCheckDiagnostic('main-config-preflight-step-home-dir-result', {
            step: 'incompatible-plugins',
            hasHomeDir: Boolean(homeDir),
            homeDir,
          }).catch(() => undefined)
          return homeDir
        },
        repair: async (homeDir) => {
          appendEnvCheckDiagnostic('main-config-preflight-step-repair-start', {
            step: 'incompatible-plugins',
            homeDir,
          }).catch(() => undefined)
          const result = await repairIncompatibleExtensionPluginsOnDisk({
            homeDir,
            readConfig,
            writeConfig,
          })
          appendEnvCheckDiagnostic('main-config-preflight-step-repair-result', {
            step: 'incompatible-plugins',
            repaired: Boolean(result?.repaired),
          }).catch(() => undefined)
          return result
        },
      })
      appendEnvCheckDiagnostic('main-config-preflight-step-complete', {
        step: 'incompatible-plugins',
      }).catch(() => undefined)
      await runPluginRepairPreflight({
        resolveHomeDir: async () => {
          appendEnvCheckDiagnostic('main-config-preflight-step-home-dir-start', {
            step: 'provider-config-gaps',
          }).catch(() => undefined)
          const homeDir = preferredHomeDir || String((await getOpenClawPaths().catch(() => null))?.homeDir || '').trim() || null
          appendEnvCheckDiagnostic('main-config-preflight-step-home-dir-result', {
            step: 'provider-config-gaps',
            hasHomeDir: Boolean(homeDir),
            homeDir,
          }).catch(() => undefined)
          return homeDir
        },
        repair: async () => {
          appendEnvCheckDiagnostic('main-config-preflight-step-repair-start', {
            step: 'provider-config-gaps',
          }).catch(() => undefined)
          const result = await repairKnownProviderConfigGapsOnDisk({
            readConfig,
            writeConfig,
          })
          appendEnvCheckDiagnostic('main-config-preflight-step-repair-result', {
            step: 'provider-config-gaps',
            changed: Boolean(result?.changed),
          }).catch(() => undefined)
          return result
        },
      })
      appendEnvCheckDiagnostic('main-config-preflight-step-complete', {
        step: 'provider-config-gaps',
      }).catch(() => undefined)
      appendEnvCheckDiagnostic('main-config-preflight-result', {
        ok: true,
      }).catch(() => undefined)
    } catch (error) {
      appendEnvCheckDiagnostic('main-config-preflight-result', {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      throw error
    } finally {
      openClawConfigRepairPreflightPromise = null
    }
  })()

  return openClawConfigRepairPreflightPromise
}

export interface CliResult {
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

interface InstallEnvOptions {
  needNode: boolean
  needOpenClaw: boolean
  nodeInstallerPath?: string
  nodeInstallPlan?: NodeInstallPlan
}

export type MacGitToolsPrepareErrorCode =
  | 'xcode_clt_pending'
  | 'git_unavailable'
  | 'prepare_failed'

export interface MacGitToolsPrepareResult extends CliResult {
  errorCode?: MacGitToolsPrepareErrorCode
}

export interface GatewayHealthCheckResult {
  running: boolean
  raw?: string
  stderr?: string
  code?: number | null
  stateCode?: GatewayRuntimeStateCode
  summary?: string
}

export interface GatewayStatusCheckResult extends GatewayHealthCheckResult {
  rpcReachable?: boolean
}

export interface OnboardResult extends CliResult {
  errorCode?: OnboardErrorCode
}

export interface PairingApproveResult extends CliResult {
  errorCode?: PairingApproveErrorCode
}

export interface FeishuBotRuntimeStatus {
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

export interface NodeCheckResult {
  installed: boolean
  version: string
  needsUpgrade: boolean
  meetsRequirement: boolean
  requiredVersion: string
  targetVersion: string
  installStrategy: 'nvm' | 'installer'
}

export interface OpenClawCheckResult {
  installed: boolean
  selectedRuntimeComplete: boolean
  version: string
}

export interface RunCliStreamOptions {
  timeout?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  onOAuthUrl?: (url: string) => void | Promise<void>
  autoOpenOAuth?: boolean
  controlDomain?: CommandControlDomain
  env?: Partial<NodeJS.ProcessEnv>
  binaryPath?: string
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot
  configRepairPreflightHomeDir?: string | null
  requireConfigRepairPreflight?: boolean
  skipPermissionAutoRepair?: boolean
  skipConfigRepairPreflight?: boolean
}

interface GatewayMutationCommandOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  configRepairPreflightHomeDir?: string | null
}

export async function getOpenClawPaths(): Promise<OpenClawPaths> {
  const activeRuntimeSnapshot = await ensureSelectedWindowsActiveRuntimeSnapshot()
  return resolveRuntimeOpenClawPaths({
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
  })
}

export async function getOpenClawPathsForRead(
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
): Promise<OpenClawPaths> {
  const runtimeSnapshotForRead = await resolveWindowsActiveRuntimeSnapshotForRead(activeRuntimeSnapshot)
  return resolveOpenClawPathsForRead({
    activeRuntimeSnapshot: runtimeSnapshotForRead || undefined,
  })
}

interface ReadConfigOptions {
  configPath?: string | null
}

interface ReadEnvFileOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  openClawPaths?: OpenClawPaths | null
  diagnosticProbe?: 'gateway-health' | 'version-probe' | null
}

const isWin = process.platform === 'win32'
const LATEST_OAUTH_URL_KEY = '__QCLAW_LATEST_OAUTH_URL__'
type OAuthUrlGlobal = typeof globalThis & { [LATEST_OAUTH_URL_KEY]?: string | null }

type SpawnFn = typeof import('node:child_process')['spawn']
let cachedSpawnFn: SpawnFn | null = null

function resolveCommandControlDomain(
  args: string[],
  preferredDomain?: CommandControlDomain
): CommandControlDomain {
  if (preferredDomain) return preferredDomain

  const command = String(args[0] || '').trim().toLowerCase()
  const subCommand = String(args[1] || '').trim().toLowerCase()
  if (!command) return 'global'
  if (command.startsWith('-')) return 'capabilities'

  if (command === 'gateway' || command === 'health') return 'gateway'
  if (command === 'status') return 'gateway'
  if (command === 'secrets') return 'config-write'
  if (command === 'plugins') return 'plugin-install'
  if (command === 'skills') return 'plugin-install'
  if (command === 'chat') return 'chat'
  if (command === 'models' && subCommand === 'auth') return 'oauth'
  if (command === 'models') return 'models'
  if (command === 'doctor' || command === 'onboard') return 'env-setup'
  if (command === 'pairing') return 'config-write'
  if (command === 'dashboard') return 'gateway'
  if (command === 'channels') return 'config-write'
  if (command === 'upgrade' || command === 'combined:update') return 'upgrade'

  return 'global'
}

async function getSpawnFn(): Promise<SpawnFn> {
  if (cachedSpawnFn) return cachedSpawnFn
  const mod = await import('node:child_process')
  cachedSpawnFn = mod.spawn
  return cachedSpawnFn
}

function resolveManagedSpawnCwd(): string {
  return resolveSafeWorkingDirectory()
}

const QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR = join(tmpdir(), 'qclaw-lite', 'npm-cache')
const QCLAW_PLUGIN_INSTALL_PERMISSION_MARKER = 'QCLAW_PLUGIN_INSTALL_PERMISSION_DENIED'
const RUNTIME_INSTALL_LOCK_KEY = 'runtime-install'

function createPermissionAutoRepairDependencies(options: { readOnlyPaths?: boolean } = {}) {
  const currentUser = userInfo()
  return {
    platform: process.platform,
    homeDir: homedir(),
    userDataDir: process.env.QCLAW_USER_DATA_DIR || '',
    safeWorkDir: process.env.QCLAW_SAFE_WORK_DIR || resolveManagedSpawnCwd(),
    pluginNpmCacheDir: QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR,
    currentUser: {
      uid: typeof currentUser.uid === 'number' ? currentUser.uid : 0,
      gid: typeof currentUser.gid === 'number' ? currentUser.gid : 0,
      username: currentUser.username,
    },
    getOpenClawPaths: () => options.readOnlyPaths ? getOpenClawPathsForRead() : getOpenClawPaths(),
    probePath: (pathname: string) => probeOpenClawInstallPath(pathname),
    runPrivilegedRepair: async (request: {
      command: string
      prompt: string
      controlDomain: string
    }) => {
      if (process.platform !== 'darwin') {
        return {
          ok: false,
          stdout: '',
          stderr: '当前平台暂未接入自动提权修复。',
          code: 1,
        }
      }

      const capabilityError = await guardPlatformCommands(['osascript'])
      if (capabilityError) return capabilityError

      return runDirectOnce(
        'osascript',
        ['-e', buildAppleScriptDoShellScript(request.command, { prompt: request.prompt })],
        MAIN_RUNTIME_POLICY.cli.defaultDirectTimeoutMs,
        request.controlDomain as CommandControlDomain
      )
    },
  }
}

async function createPluginInstallNpmEnv(): Promise<{
  cacheDir: string
  env: Partial<NodeJS.ProcessEnv>
}> {
  return createIsolatedNpmCacheEnv(QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR)
}

async function resolveManagedOpenClawInstallNpmCommandOptions(
  operationLabel: string,
  options: {
    prefixPath?: string | null
  } = {}
): Promise<{ options: OpenClawNpmCommandOptions } | { error: CliResult }> {
  try {
    const runtime = await ensureManagedOpenClawNpmRuntime({
      workingDirectory: resolveManagedSpawnCwd(),
    })
    const prefixPath = String(options.prefixPath || '').trim()
    return {
      options: prefixPath
        ? {
            ...runtime.commandOptions,
            prefixPath,
          }
        : runtime.commandOptions,
    }
  } catch (error) {
    return {
      error: {
        ok: false,
        stdout: '',
        stderr: `${operationLabel}失败：无法初始化安装隔离环境。${error instanceof Error ? ` ${error.message}` : ''}`.trim(),
        code: -1,
      },
    }
  }
}

function isPluginInstallPermissionFailure(result: CliResult): boolean {
  return isOpenClawInstallPermissionFailureResult(result)
}

function dedupeNonEmptyPaths(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)))
}

function buildPluginPermissionRecoveryGuidance(): string[] {
  if (process.platform === 'win32') {
    return [
      '请先修复权限后重试（PowerShell 示例）：',
      'icacls "$env:USERPROFILE\\.openclaw" /grant "$env:USERNAME:(OI)(CI)F" /T',
      'icacls "$env:USERPROFILE\\.npm" /grant "$env:USERNAME:(OI)(CI)F" /T',
    ]
  }

  return [
    '请先修复权限后重试：',
    'sudo chown -R "$(id -u)":"$(id -g)" ~/.openclaw ~/.npm',
  ]
}

async function annotatePluginPermissionFailure(result: CliResult): Promise<CliResult> {
  if (!isPluginInstallPermissionFailure(result)) return result

  const fallbackHomeDir = join(homedir(), '.openclaw')
  const openClawPaths = await getOpenClawPaths().catch(() => null)
  const openClawHomeDir = String(openClawPaths?.homeDir || fallbackHomeDir).trim() || fallbackHomeDir
  const probes = await Promise.all(
    dedupeNonEmptyPaths([
      openClawHomeDir,
      join(openClawHomeDir, 'extensions'),
      join(homedir(), '.npm'),
      QCLAW_PLUGIN_NPM_CACHE_ROOT_DIR,
    ]).map((pathname) => probeOpenClawInstallPath(pathname))
  )

  const blocked = probes.filter((probe) => !probe.writable || probe.ownerMatchesCurrentUser === false)
  const hintLines =
    blocked.length > 0
      ? blocked.map((probe) => {
          const status: string[] = []
          if (!probe.writable) {
            status.push(`当前用户不可写（检查路径：${formatDisplayPathWithHome(probe.checkPath)}）`)
          }
          if (probe.ownerMatchesCurrentUser === false) {
            status.push(`owner uid=${probe.ownerUid ?? 'unknown'}`)
          }
          if (!probe.exists) {
            status.push('目录不存在')
          }
          return `- ${probe.displayPath}: ${status.join('；') || '写入条件不满足'}`
        })
      : ['- 未定位到具体目录，但错误输出命中了权限拒绝特征。']

  const guidance = [
    QCLAW_PLUGIN_INSTALL_PERMISSION_MARKER,
    '检测到插件安装权限不足，通常是曾使用 sudo 运行 openclaw/npm 导致目录所有权漂移。',
    ...hintLines,
    ...buildPluginPermissionRecoveryGuidance(),
  ].join('\n')

  return {
    ...result,
    stderr: guidance,
  }
}

async function finalizePluginInstallResult(
  result: CliResult,
  expectedPluginIds: string[] = []
): Promise<CliResult> {
  const shouldAttemptReconcile = result.ok || isPluginAlreadyInstalledError(result.stderr || '')
  if (!shouldAttemptReconcile) return result

  const openClawPaths = await getOpenClawPaths().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (!homeDir) return result

  const repairResult = await repairIncompatibleExtensionPluginsOnDisk({
    homeDir,
    readConfig,
    writeConfig,
    scopePluginIds: expectedPluginIds,
    quarantineOfficialManagedPlugins: expectedPluginIds.some((pluginId) => isOfficialManagedPluginId(pluginId)),
  })

  if (!repairResult.ok) {
    return {
      ok: false,
      stdout: result.stdout,
      stderr: [result.stderr, `插件安装后的安全修复失败：${repairResult.summary}`].filter(Boolean).join('\n\n'),
      code: 1,
      ...(result.npmRegistryAttempts ? { npmRegistryAttempts: result.npmRegistryAttempts } : {}),
    }
  }

  const finalized = finalizePluginInstallSafetyResult(result, repairResult, expectedPluginIds)
  return {
    ...finalized,
    ...(result.npmRegistryAttempts ? { npmRegistryAttempts: result.npmRegistryAttempts } : {}),
  }
}

function attachNpmRegistryAttempts(
  result: CliResult,
  attempts: OpenClawNpmRegistryAttempt<OpenClawCommandResultLike>[]
): CliResult {
  if (attempts.length === 0) return result

  return {
    ...result,
    npmRegistryAttempts: attempts.map((attempt) => ({
      mirrorId: attempt.mirror.id,
      label: attempt.mirror.label,
      registryUrl: attempt.mirror.registryUrl,
      ok: attempt.result.ok,
      ...(attempt.result.canceled ? { canceled: true } : {}),
    })),
  }
}

export interface RepairIncompatibleExtensionPluginsOptions {
  scopePluginIds?: string[]
  quarantineOfficialManagedPlugins?: boolean
  restoreConfiguredManagedChannels?: boolean
}

export interface ScanIncompatibleExtensionPluginsOptions {
  scopePluginIds?: string[]
  quarantineOfficialManagedPlugins?: boolean
}

async function resolveOpenClawPluginRepairPaths(): Promise<OpenClawPaths | null> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead().catch(() => null)
  if (activeRuntimeSnapshot?.stateDir) {
    return resolveOpenClawPathsFromStateRoot({
      stateRoot: activeRuntimeSnapshot.stateDir,
    })
  }

  const authoritativeRuntimeSnapshot = readAuthoritativeWindowsChannelRuntimeSnapshot()
  if (authoritativeRuntimeSnapshot?.stateDir) {
    return resolveOpenClawPathsFromStateRoot({
      stateRoot: authoritativeRuntimeSnapshot.stateDir,
    })
  }

  const readOnlyPaths = await getOpenClawPathsForRead(activeRuntimeSnapshot || undefined).catch(() => null)
  if (String(readOnlyPaths?.homeDir || '').trim()) {
    return readOnlyPaths
  }

  const writablePaths = await getOpenClawPaths().catch(() => null)
  if (String(writablePaths?.homeDir || '').trim()) {
    return writablePaths
  }

  return null
}

async function resolveOpenClawPluginRepairHomeDir(): Promise<string | null> {
  const openClawPaths = await resolveOpenClawPluginRepairPaths()
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  return homeDir || null
}

export async function scanIncompatibleExtensionPlugins(
  options: ScanIncompatibleExtensionPluginsOptions = {}
): Promise<RepairIncompatibleExtensionsResult> {
  const homeDir = await resolveOpenClawPluginRepairHomeDir()
  if (!homeDir) {
    return {
      ok: false,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '未能定位 OpenClaw 状态目录，暂时无法修复损坏插件环境。',
      stderr: 'OpenClaw homeDir unavailable',
    }
  }

  return repairIncompatibleExtensionPluginsOnDisk({
    homeDir,
    readConfig,
    writeConfig,
    scopePluginIds: options.scopePluginIds,
    quarantineOfficialManagedPlugins: options.quarantineOfficialManagedPlugins,
  })
}

export async function repairIncompatibleExtensionPlugins(
  options: RepairIncompatibleExtensionPluginsOptions = {}
): Promise<RepairIncompatibleExtensionsResult> {
  await appendEnvCheckDiagnostic('main-plugin-repair-start', {
    restoreConfiguredManagedChannels: options.restoreConfiguredManagedChannels === true,
    scopePluginIds: options.scopePluginIds || [],
    quarantineOfficialManagedPlugins: options.quarantineOfficialManagedPlugins === true,
  })
  const openClawPaths = await resolveOpenClawPluginRepairPaths()
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  const configPath = String(openClawPaths?.configFile || '').trim()
  if (!homeDir) {
    await appendEnvCheckDiagnostic('main-plugin-repair-home-dir-missing', {})
    return {
      ok: false,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '未能定位 OpenClaw 状态目录，暂时无法修复损坏插件环境。',
      stderr: 'OpenClaw homeDir unavailable',
    }
  }

  const referenceConfig = options.restoreConfiguredManagedChannels === true
    ? configPath
      ? await readConfig({ configPath }).catch(() => null)
      : null
    : null

  const result = await scanIncompatibleExtensionPlugins({
    scopePluginIds: options.scopePluginIds,
    quarantineOfficialManagedPlugins: options.quarantineOfficialManagedPlugins,
  })
  await appendEnvCheckDiagnostic('main-plugin-repair-after-scan', {
    ok: result.ok,
    repaired: result.repaired,
    quarantinedPluginIds: result.quarantinedPluginIds,
    prunedPluginIds: result.prunedPluginIds,
    summary: String(result.summary || '').trim() || null,
  })

  if (result.ok && options.restoreConfiguredManagedChannels === true) {
    await appendEnvCheckDiagnostic('main-plugin-repair-before-restore-configured-managed-channels', {
      affectedPluginIds: Array.from(new Set([
        ...(result.quarantinedPluginIds || []),
        ...(result.prunedPluginIds || []),
      ])),
    })
    const managedLifecycle = await import('./managed-channel-plugin-lifecycle')

    const restoreResult = await restoreConfiguredManagedChannelPlugins({
      referenceConfig,
      repairResult: result,
      dependencies: {
        inspectManagedChannelPlugin: managedLifecycle.inspectManagedChannelPlugin,
        repairManagedChannelPlugin: managedLifecycle.repairManagedChannelPlugin,
      },
    })
    await appendEnvCheckDiagnostic('main-plugin-repair-after-restore-configured-managed-channels', {
      ok: restoreResult.ok,
      restoredChannelIds: restoreResult.restoredChannelIds,
      gatewayReloaded: restoreResult.gatewayReloaded,
      summary: String(restoreResult.summary || '').trim() || null,
    })

    const summaryParts = [
      result.summary || buildIncompatiblePluginRepairSummary(result),
      restoreResult.restoredChannelIds.length > 0 ? restoreResult.summary : '',
    ].filter(Boolean)
    const combinedSummary = summaryParts.join(' ')

    if (!restoreResult.ok) {
      return {
        ...result,
        ok: false,
        repaired: result.repaired || restoreResult.restoredChannelIds.length > 0,
        summary: combinedSummary || restoreResult.summary,
        stderr: [result.stderr, restoreResult.stderr].filter(Boolean).join('\n\n'),
      }
    }

    return {
      ...result,
      repaired: result.repaired || restoreResult.restoredChannelIds.length > 0,
      summary: combinedSummary || restoreResult.summary,
      stderr: [result.stderr, restoreResult.stderr].filter(Boolean).join('\n\n'),
    }
  }

  if (result.ok && !result.repaired && !result.summary) {
    return {
      ...result,
      summary: buildIncompatiblePluginRepairSummary(result),
    }
  }

  return result
}

async function openUrlInSystemBrowser(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

function normalizeHttpUrl(raw?: string | null): string | null {
  const value = String(raw || '').trim()
  if (!value) return null

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function readLatestOAuthUrl(): string | null {
  const stored = (globalThis as OAuthUrlGlobal)[LATEST_OAUTH_URL_KEY]
  return normalizeHttpUrl(stored || null)
}

function writeLatestOAuthUrl(url: string | null): void {
  const normalized = normalizeHttpUrl(url)
  ;(globalThis as OAuthUrlGlobal)[LATEST_OAUTH_URL_KEY] = normalized
}

export function getLatestOAuthUrl(): string | null {
  return readLatestOAuthUrl()
}

export async function openOAuthUrl(url?: string): Promise<CliResult> {
  const target = normalizeHttpUrl(url || readLatestOAuthUrl())
  if (!target) {
    return {
      ok: false,
      stdout: '',
      stderr: '当前没有可打开的浏览器授权登录链接',
      code: 1,
    }
  }

  try {
    await openUrlInSystemBrowser(target)
    return {
      ok: true,
      stdout: target,
      stderr: '',
      code: 0,
    }
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    }
  }
}

/** Run any openclaw CLI command */
export async function runCli(
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
  controlDomain?: CommandControlDomain,
  options: Pick<
    RunCliStreamOptions,
    | 'activeRuntimeSnapshot'
    | 'configRepairPreflightHomeDir'
    | 'requireConfigRepairPreflight'
    | 'skipPermissionAutoRepair'
    | 'skipConfigRepairPreflight'
  > = {}
): Promise<CliResult> {
  return runCliStreaming(args, {
    timeout,
    controlDomain: resolveCommandControlDomain(args, controlDomain),
    activeRuntimeSnapshot: options.activeRuntimeSnapshot,
    configRepairPreflightHomeDir: options.configRepairPreflightHomeDir,
    requireConfigRepairPreflight: options.requireConfigRepairPreflight,
    skipPermissionAutoRepair: options.skipPermissionAutoRepair,
    skipConfigRepairPreflight: options.skipConfigRepairPreflight,
  })
}

function isReadOnlyCommand(controlDomain: CommandControlDomain, args: string[]): boolean {
  const lastArg = args[args.length - 1]
  return (
    (args.length === 1 && args[0] === '--version')
    || lastArg === '--help'
    || (args[0] === 'plugins' && args[1] === 'list' && args.includes('--json'))
    || (controlDomain === 'gateway' && args[0] === 'health' && args[1] === '--json')
    || (controlDomain === 'gateway' && args[0] === 'status' && args[1] === '--json')
  )
}

export async function runCliWithBinary(
  binaryPath: string,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
  controlDomain?: CommandControlDomain,
  env?: Partial<NodeJS.ProcessEnv>
): Promise<CliResult> {
  return runCliStreaming(args, {
    timeout,
    controlDomain: resolveCommandControlDomain(args, controlDomain),
    binaryPath,
    env,
  })
}

/** Run openclaw command while exposing stream callbacks for long-running flows */
async function runCliStreamingOnce(args: string[], options: RunCliStreamOptions = {}): Promise<CliResult> {
  const controlDomain = resolveCommandControlDomain(args, options.controlDomain)
  const readOnlyCommand = isReadOnlyCommand(controlDomain, args)
  const isEnvCheckVersionProbe = controlDomain === 'env-setup' && args.length === 1 && args[0] === '--version'
  const isGatewayHealthProbe = controlDomain === 'gateway' && args[0] === 'health' && args[1] === '--json'
  const isGatewayStartCommand = controlDomain === 'gateway' && args[0] === 'gateway' && args[1] === 'start'
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-streaming-once-start', {})
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-enter', {})
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-enter', {})
  }
  if (isGatewayStartCommand && options.requireConfigRepairPreflight && !options.skipConfigRepairPreflight) {
    await appendEnvCheckDiagnostic('main-gateway-start-before-config-preflight', {})
  }
  if (options.requireConfigRepairPreflight && !options.skipConfigRepairPreflight) {
    await ensureOpenClawConfigRepairPreflightWithOptions({
      preferredHomeDir: options.configRepairPreflightHomeDir,
    })
  }
  if (isGatewayStartCommand && options.requireConfigRepairPreflight && !options.skipConfigRepairPreflight) {
    await appendEnvCheckDiagnostic('main-gateway-start-after-config-preflight', {})
  }
  // 读取 ~/.openclaw/.env 文件中的环境变量，合并到 CLI 进程环境中
  const activeRuntimeSnapshot =
    options.activeRuntimeSnapshot
    || getCurrentWindowsActiveRuntimeSnapshot()
    || (
      readOnlyCommand
        ? null
        : await ensureSelectedWindowsActiveRuntimeSnapshot()
    )
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-runtime-snapshot', {
      providedSnapshot: Boolean(options.activeRuntimeSnapshot),
      resolvedSnapshot: Boolean(activeRuntimeSnapshot),
      stateDir: String(activeRuntimeSnapshot?.stateDir || '').trim() || null,
      nodePath: String(activeRuntimeSnapshot?.nodePath || '').trim() || null,
    })
  }
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-before-read-env-file', {})
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-before-read-env-file', {})
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-before-read-env-file', {})
  }
  const envFromFile = await readEnvFile({
    diagnosticProbe: isGatewayHealthProbe
      ? 'gateway-health'
      : isEnvCheckVersionProbe
        ? 'version-probe'
        : null,
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    openClawPaths: readOnlyCommand
      ? await getOpenClawPathsForRead(activeRuntimeSnapshot || undefined).catch(() => undefined)
      : undefined,
  })
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-after-read-env-file', {
      envKeyCount: Object.keys(envFromFile || {}).length,
    })
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-after-read-env-file', {
      envKeyCount: Object.keys(envFromFile || {}).length,
    })
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-after-read-env-file', {
      envKeyCount: Object.keys(envFromFile || {}).length,
    })
  }
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-before-get-spawn', {})
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-before-get-spawn', {})
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-before-get-spawn', {})
  }
  const spawn = await getSpawnFn()
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-after-get-spawn', {})
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-after-get-spawn', {})
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-after-get-spawn', {})
  }
  const timeout = options.timeout ?? MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-active-runtime-snapshot', {
      nodePath: activeRuntimeSnapshot?.nodePath || null,
      openclawPath: activeRuntimeSnapshot?.openclawPath || null,
      hostPackageRoot: activeRuntimeSnapshot?.hostPackageRoot || null,
    })
  }
  const commandProbeEnv = buildCommandCapabilityEnv(activeRuntimeSnapshot)
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-command-probe-env-built', {
      hasPath: Boolean(commandProbeEnv.PATH),
    })
  }
  const explicitBinaryPath = String(options.binaryPath || '').trim()
  if (!explicitBinaryPath) {
    const openClawCapability = await probePlatformCommandCapability('openclaw', {
      platform: process.platform,
      env: commandProbeEnv,
    })
    if (isEnvCheckVersionProbe) {
      await appendEnvCheckDiagnostic('main-run-cli-openclaw-capability', {
        available: openClawCapability.available,
        message: openClawCapability.message || null,
      })
    }
    if (isGatewayStartCommand) {
      await appendEnvCheckDiagnostic('main-gateway-start-run-cli-openclaw-capability', {
        available: openClawCapability.available,
        message: openClawCapability.message || null,
      })
    }
    if (!openClawCapability.available) {
      return {
        ok: false,
        stdout: '',
        stderr: openClawCapability.message || 'OpenClaw 命令行工具命令不可用',
        code: 1,
      }
    }
  }
  const needsPtyWrapper = shouldAutoOpenBrowserForArgs(args) && !isWin
  const needsGeminiExpectWrapper =
    !isWin &&
    args[0] === 'models' &&
    args[1] === 'auth' &&
    args[2] === 'login' &&
    (() => {
      const providerIndex = args.findIndex((item) => item === '--provider')
      return providerIndex >= 0 && normalizeAuthChoice(String(args[providerIndex + 1] || '').trim()) === 'google-gemini-cli'
    })()
  const expectCapability = needsGeminiExpectWrapper
    ? await probePlatformCommandCapability('expect', {
        platform: process.platform,
        env: commandProbeEnv,
      })
    : null
  const scriptCapability = needsPtyWrapper
    ? await probePlatformCommandCapability('script', {
        platform: process.platform,
        env: commandProbeEnv,
      })
    : null
  const resolvedCommand = await resolveBoundOpenClawCommand(args, {
    platform: process.platform,
    expectAvailable: expectCapability?.available,
    expectWarning: expectCapability?.message,
    scriptAvailable: scriptCapability?.available,
    scriptWarning: scriptCapability?.message,
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    commandPath: explicitBinaryPath || undefined,
  })
  if (isEnvCheckVersionProbe) {
    await appendEnvCheckDiagnostic('main-run-cli-command-resolved', {
      command: resolvedCommand.command,
      shell: resolvedCommand.shell,
      capabilityWarning: resolvedCommand.capabilityWarning || null,
      args,
    })
  }
  if (isGatewayHealthProbe) {
    await appendEnvCheckDiagnostic('main-gateway-health-run-cli-command-resolved', {
      command: resolvedCommand.command,
      shell: resolvedCommand.shell,
      capabilityWarning: resolvedCommand.capabilityWarning || null,
    })
  }
  if (isGatewayStartCommand) {
    await appendEnvCheckDiagnostic('main-gateway-start-run-cli-command-resolved', {
      command: resolvedCommand.command,
      shell: resolvedCommand.shell,
      capabilityWarning: resolvedCommand.capabilityWarning || null,
      args,
    })
  }

  return new Promise((resolve) => {
    // 把常见的 node bin 目录加到 PATH，确保能找到 openclaw
    const envPath = buildCliPathWithCandidates({
      platform: process.platform,
      currentPath: process.env.PATH || '',
      detectedNodeBinDir,
      env: process.env,
      activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    })
    const managedCwd = resolveManagedSpawnCwd()

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...envFromFile,
      ...(options.env || {}),
      PATH: envPath,
      NO_COLOR: '1',
    }
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined || value === null) {
          delete mergedEnv[key]
        }
      }
    }

    let proc: ChildProcess
    try {
      if (isEnvCheckVersionProbe) {
        void appendEnvCheckDiagnostic('main-run-cli-before-spawn', {
          command: resolvedCommand.command,
          cwd: managedCwd,
        })
      }
      if (isGatewayHealthProbe) {
        void appendEnvCheckDiagnostic('main-gateway-health-run-cli-before-spawn', {
          command: resolvedCommand.command,
          cwd: managedCwd,
        })
      }
      if (isGatewayStartCommand) {
        void appendEnvCheckDiagnostic('main-gateway-start-run-cli-before-spawn', {
          command: resolvedCommand.command,
          cwd: managedCwd,
        })
      }
      proc = spawn(resolvedCommand.command, resolvedCommand.args, {
        env: mergedEnv,
        cwd: managedCwd,
        timeout,
        shell: resolvedCommand.shell,
        windowsHide: process.platform === 'win32',
        stdio: resolveStdioForCommand(resolvedCommand.command),
      })
    } catch (error) {
      if (isEnvCheckVersionProbe) {
        void appendEnvCheckDiagnostic('main-run-cli-spawn-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      if (isGatewayHealthProbe) {
        void appendEnvCheckDiagnostic('main-gateway-health-run-cli-spawn-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      if (isGatewayStartCommand) {
        void appendEnvCheckDiagnostic('main-gateway-start-run-cli-spawn-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      resolve(createSpawnFailureResult(error))
      return
    }
    trackActiveProcess(proc, controlDomain)
    const enableOAuthScan = shouldAutoOpenBrowserForArgs(args)
    if (enableOAuthScan) {
      writeLatestOAuthUrl(null)
    }
    const scanOAuthOutput = enableOAuthScan
      ? createOAuthOutputScanner((url) => {
          writeLatestOAuthUrl(url)
          return Promise.resolve(options.onOAuthUrl?.(url))
            .catch(() => {
              // 回调失败不影响命令执行。
            })
            .then(() => {
              if (options.autoOpenOAuth === false) return
              return openUrlInSystemBrowser(url).catch(() => {
                // 自动拉起失败时，保留链接供 UI 手动兜底打开。
              })
            })
        })
      : null
    let stdout = ''
    let stderr = resolvedCommand.capabilityWarning
      ? `[Qclaw] ${resolvedCommand.capabilityWarning}\n`
      : ''
    proc.stdout?.on('data', (d) => {
      const chunk = d.toString()
      stdout += chunk
      options.onStdout?.(chunk)
      scanOAuthOutput?.(chunk)
    })
    proc.stderr?.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      options.onStderr?.(chunk)
      scanOAuthOutput?.(chunk)
    })
    proc.on('close', (code) => {
      clearActiveProcessIfMatch(proc, controlDomain)
      const canceled = consumeCanceledProcess(proc, controlDomain)
      if (isEnvCheckVersionProbe) {
        void appendEnvCheckDiagnostic('main-run-cli-close', {
          code,
          canceled,
          stdout: stdout.trim() || null,
          stderr: stderr.trim() || null,
        })
      }
      if (isGatewayHealthProbe) {
        void appendEnvCheckDiagnostic('main-gateway-health-run-cli-close', {
          code,
          canceled,
          stdout: stdout.trim() || null,
          stderr: stderr.trim() || null,
        })
      }
      if (isGatewayStartCommand) {
        void appendEnvCheckDiagnostic('main-gateway-start-run-cli-close', {
          code,
          canceled,
          stdout: stdout.trim() || null,
          stderr: stderr.trim() || null,
        })
      }
      resolve({
        ok: code === 0 && !canceled,
        stdout,
        stderr: canceled ? stderr || 'Command canceled' : stderr,
        code: canceled ? null : code,
        canceled,
      })
    })
    proc.on('error', (err) => {
      clearActiveProcessIfMatch(proc, controlDomain)
      const canceled = consumeCanceledProcess(proc, controlDomain)
      if (isEnvCheckVersionProbe) {
        void appendEnvCheckDiagnostic('main-run-cli-error', {
          canceled,
          message: err.message,
        })
      }
      if (isGatewayHealthProbe) {
        void appendEnvCheckDiagnostic('main-gateway-health-run-cli-error', {
          canceled,
          message: err.message,
        })
      }
      if (isGatewayStartCommand) {
        void appendEnvCheckDiagnostic('main-gateway-start-run-cli-error', {
          canceled,
          message: err.message,
        })
      }
      resolve({
        ok: false,
        stdout,
        stderr: canceled ? stderr || err.message || 'Command canceled' : err.message,
        code: canceled ? null : -1,
        canceled,
      })
      })
  })
}

/** Run openclaw command while exposing stream callbacks for long-running flows */
export async function runCliStreaming(args: string[], options: RunCliStreamOptions = {}): Promise<CliResult> {
  const controlDomain = resolveCommandControlDomain(args, options.controlDomain)
  const readOnlyCommand = isReadOnlyCommand(controlDomain, args)
  if (options.skipPermissionAutoRepair || readOnlyCommand) {
    return runCliStreamingOnce(args, { ...options, controlDomain })
  }
  return runCliLikeWithPermissionAutoRepair(
    () => runCliStreamingOnce(args, { ...options, controlDomain }),
    {
      operation: 'openclaw-cli',
      controlDomain,
      args,
    },
    createPermissionAutoRepairDependencies()
  )
}

/** Run any shell command */
type RunShellOptions = {
  cwd?: string
  controlDomain?: CommandControlDomain
  env?: Partial<NodeJS.ProcessEnv>
  shell?: boolean
}

const NPM_TLS_FALLBACK_SANITIZE_KEYS = [
  'npm_config_cafile',
  'NPM_CONFIG_CAFILE',
  'npm_config_ca',
  'NPM_CONFIG_CA',
] as const
const NPM_TLS_CERT_FAILURE_PATTERN =
  /(UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_OSSL|certificate)/i
const MAC_SYSTEM_CERT_FILE_PATH = '/etc/ssl/cert.pem'

function shouldSanitizeManagedEnv(controlDomain: CommandControlDomain): boolean {
  return controlDomain === 'env-setup' || controlDomain === 'upgrade'
}

function sanitizeManagedEnv(
  env: NodeJS.ProcessEnv,
  controlDomain: CommandControlDomain
): NodeJS.ProcessEnv {
  if (!shouldSanitizeManagedEnv(controlDomain)) return env
  return sanitizeManagedInstallerEnv(env)
}

function isNpmCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase()
  return (
    normalized === 'npm' ||
    normalized === 'npm.cmd' ||
    normalized.endsWith('/npm') ||
    normalized.endsWith('\\npm') ||
    normalized.endsWith('/npm.cmd') ||
    normalized.endsWith('\\npm.cmd')
  )
}

function shouldRetryWithNpmTlsFallback(
  command: string,
  result: CliResult,
  controlDomain: CommandControlDomain
): boolean {
  if (result.ok || result.canceled) return false
  if (!shouldSanitizeManagedEnv(controlDomain)) return false
  if (!isNpmCommand(command)) return false
  const detail = `${String(result.stderr || '')}\n${String(result.stdout || '')}`
  return NPM_TLS_CERT_FAILURE_PATTERN.test(detail)
}

function buildNpmTlsFallbackEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cloned: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of NPM_TLS_FALLBACK_SANITIZE_KEYS) {
    delete cloned[key]
  }
  if (existsSync(MAC_SYSTEM_CERT_FILE_PATH)) {
    cloned.SSL_CERT_FILE = MAC_SYSTEM_CERT_FILE_PATH
  }
  return cloned
}

function resolveCommandForShelllessSpawn(command: string): string {
  const normalized = String(command || '').trim()
  if (!normalized || process.platform !== 'win32') return normalized
  if (/[\\/]/.test(normalized) || /\.[A-Za-z0-9]+$/.test(normalized)) return normalized

  const lower = normalized.toLowerCase()
  if (lower === 'npm') return 'npm.cmd'
  if (lower === 'npx') return 'npx.cmd'
  if (lower === 'pnpm') return 'pnpm.cmd'
  if (lower === 'yarn') return 'yarn.cmd'
  if (lower === 'openclaw') return 'openclaw.cmd'
  return normalized
}

function createSpawnFailureResult(error: unknown): CliResult {
  return {
    ok: false,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error || ''),
    code: -1,
  }
}

function normalizeWindowsRuntimePath(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function resolvePreferredWindowsOpenClawInstallPrefix(
  explicitPrefixPath?: string | null
): string | null {
  if (process.platform !== 'win32') return null

  const explicitPrefix = String(explicitPrefixPath || '').trim()
  if (explicitPrefix) return explicitPrefix

  const privateRuntimeRoot = normalizeWindowsRuntimePath(
    resolveWindowsPrivateNodeRuntimePaths({
      env: process.env,
    }).runtimeRoot
  )

  const snapshotPrefix = String(getSelectedWindowsActiveRuntimeSnapshot()?.npmPrefix || '').trim()
  if (snapshotPrefix && normalizeWindowsRuntimePath(snapshotPrefix).startsWith(privateRuntimeRoot)) {
    return snapshotPrefix
  }

  if (detectedNodeBinDir && normalizeWindowsRuntimePath(detectedNodeBinDir).startsWith(privateRuntimeRoot)) {
    return detectedNodeBinDir
  }

  return null
}

function normalizeRunShellOptions(
  input?: CommandControlDomain | RunShellOptions
): RunShellOptions {
  if (!input) return {}
  if (typeof input === 'string') {
    return { controlDomain: input }
  }
  return input
}

async function runShellOnce(
  command: string,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultShellTimeoutMs,
  options?: CommandControlDomain | RunShellOptions
): Promise<CliResult> {
  const normalizedOptions = normalizeRunShellOptions(options)
  const controlDomain = normalizedOptions.controlDomain ?? 'global'
  const spawn = await getSpawnFn()
  const useShell = normalizedOptions.shell === true
  const resolvedCommand = useShell ? command : resolveCommandForShelllessSpawn(command)
  const runOnce = (env: NodeJS.ProcessEnv): Promise<CliResult> =>
    new Promise((resolve) => {
      const forceOpenShell = resolvedCommand.endsWith('.cmd') && process.platform === 'win32'
      let proc: ChildProcess
      try {
        proc = spawn(resolvedCommand, args, {
          env,
          cwd: normalizedOptions.cwd || resolveManagedSpawnCwd(),
          shell: forceOpenShell ? true : useShell,
          timeout,
          windowsHide: process.platform === 'win32',
        })
      } catch (error) {
        resolve(createSpawnFailureResult(error))
        return
      }
      trackActiveProcess(proc, controlDomain)
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d) => (stdout += d.toString()))
      proc.stderr?.on('data', (d) => (stderr += d.toString()))
      proc.on('close', (code) => {
        clearActiveProcessIfMatch(proc, controlDomain)
        const canceled = consumeCanceledProcess(proc, controlDomain)
        resolve({
          ok: code === 0 && !canceled,
          stdout,
          stderr: canceled ? stderr || 'Command canceled' : stderr,
          code: canceled ? null : code,
          canceled,
        })
      })
      proc.on('error', (err) => {
        clearActiveProcessIfMatch(proc, controlDomain)
        const canceled = consumeCanceledProcess(proc, controlDomain)
        resolve({
          ok: false,
          stdout,
          stderr: canceled ? stderr || err.message || 'Command canceled' : err.message,
          code: canceled ? null : -1,
          canceled,
        })
      })
    })

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(normalizedOptions.env || {}),
  }
  if (normalizedOptions.env) {
    for (const [key, value] of Object.entries(normalizedOptions.env)) {
      if (value === undefined || value === null) {
        delete mergedEnv[key]
      }
    }
  }
  mergedEnv.PATH = buildCliPathWithCandidates({
    platform: process.platform,
    currentPath: mergedEnv.PATH || process.env.PATH || '',
    detectedNodeBinDir,
    env: mergedEnv,
    activeRuntimeSnapshot: getCurrentWindowsActiveRuntimeSnapshot() || undefined,
  })
  const managedEnv = sanitizeManagedEnv(mergedEnv, controlDomain)

  const firstResult = await runOnce(managedEnv)
  if (!shouldRetryWithNpmTlsFallback(command, firstResult, controlDomain)) {
    return firstResult
  }

  const retryResult = await runOnce(buildNpmTlsFallbackEnv(managedEnv))
  if (retryResult.ok) return retryResult
  return {
    ...retryResult,
    stderr: [firstResult.stderr, retryResult.stderr].filter(Boolean).join('\n\n'),
  }
}

export async function runShell(
  command: string,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultShellTimeoutMs,
  options?: CommandControlDomain | RunShellOptions
): Promise<CliResult> {
  const normalizedOptions = normalizeRunShellOptions(options)
  const controlDomain = normalizedOptions.controlDomain ?? 'global'
  return runCliLikeWithPermissionAutoRepair(
    () => runShellOnce(command, args, timeout, normalizedOptions),
    {
      operation: 'shell',
      controlDomain,
      command,
      args,
    },
    createPermissionAutoRepairDependencies()
  )
}

/** Run command without shell (for osascript etc.) */
async function runDirectOnce(
  command: string,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultDirectTimeoutMs,
  controlDomain: CommandControlDomain = 'global'
): Promise<CliResult> {
  const spawn = await getSpawnFn()
  return new Promise((resolve) => {
    const managedEnv = sanitizeManagedEnv(process.env, controlDomain)
    let proc: ChildProcess
    try {
      proc = spawn(command, args, {
        env: managedEnv,
        cwd: resolveManagedSpawnCwd(),
        timeout,
        windowsHide: process.platform === 'win32',
      })
    } catch (error) {
      resolve(createSpawnFailureResult(error))
      return
    }
    trackActiveProcess(proc, controlDomain)
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => (stdout += d.toString()))
    proc.stderr?.on('data', (d) => (stderr += d.toString()))
    proc.on('close', (code) => {
      clearActiveProcessIfMatch(proc, controlDomain)
      const canceled = consumeCanceledProcess(proc, controlDomain)
      resolve({
        ok: code === 0 && !canceled,
        stdout,
        stderr: canceled ? stderr || 'Command canceled' : stderr,
        code: canceled ? null : code,
        canceled,
      })
    })
    proc.on('error', (err) => {
      clearActiveProcessIfMatch(proc, controlDomain)
      const canceled = consumeCanceledProcess(proc, controlDomain)
      resolve({
        ok: false,
        stdout,
        stderr: canceled ? stderr || err.message || 'Command canceled' : err.message,
        code: canceled ? null : -1,
        canceled,
      })
    })
  })
}

/** Run command without shell (for osascript etc.) */
export async function runDirect(
  command: string,
  args: string[],
  timeout = MAIN_RUNTIME_POLICY.cli.defaultDirectTimeoutMs,
  controlDomain: CommandControlDomain = 'global'
): Promise<CliResult> {
  return runCliLikeWithPermissionAutoRepair(
    () => runDirectOnce(command, args, timeout, controlDomain),
    {
      operation: 'direct',
      controlDomain,
      command,
      args,
    },
    createPermissionAutoRepairDependencies()
  )
}

function buildCommandCapabilityEnv(
  activeRuntimeSnapshot: WindowsActiveRuntimeSnapshot | null = getCurrentWindowsActiveRuntimeSnapshot()
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildCliPathWithCandidates({
      platform: process.platform,
      currentPath: process.env.PATH || '',
      detectedNodeBinDir,
      env: process.env,
      activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    }),
  }
}

async function guardPlatformCommands(commandIds: PlatformCommandId[]): Promise<CliResult | null> {
  const env = buildCommandCapabilityEnv()
  for (const commandId of commandIds) {
    const capability = await probePlatformCommandCapability(commandId, {
      platform: process.platform,
      env,
    })
    if (!capability.available) {
      return {
        ok: false,
        stdout: '',
        stderr: capability.message || `Required command ${capability.command} is unavailable`,
        code: 1,
      }
    }
  }
  return null
}

function isMacDeveloperToolsMissing(detail: string): boolean {
  const corpus = String(detail || '').toLowerCase()
  return (
    corpus.includes('xcode-select: error: no developer tools were found') ||
    corpus.includes('xcode-select: note: no developer tools were found') ||
    corpus.includes('xcode-select --install') ||
    corpus.includes('invalid active developer path') ||
    corpus.includes('command not found: git') ||
    corpus.includes('git: command not found')
  )
}

function collectCommandDetail(output: { stderr?: string; stdout?: string }): string {
  return [String(output.stderr || '').trim(), String(output.stdout || '').trim()]
    .filter(Boolean)
    .join('\n')
}

const MAC_GIT_TOOLS_PREPARE_SCRIPT =
  'unset DEVELOPER_DIR; xcode-select -p >/dev/null 2>&1 || { xcode-select --install >/dev/null 2>&1 || true; xcode-select -p >/dev/null 2>&1 || { echo "Xcode Command Line Tools 尚未就绪，请完成系统安装弹窗后重新运行安装"; exit 1; }; }'

export async function prepareMacGitTools(): Promise<MacGitToolsPrepareResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    }
  }

  const probeEnv = buildMacDeveloperToolsProbeEnv()
  const gitReady = await runShell(
    'git',
    ['--version'],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    {
      controlDomain: 'env-setup',
      env: probeEnv,
    }
  )
  if (gitReady.ok) {
    return {
      ...gitReady,
    }
  }

  const initialDetail = collectCommandDetail(gitReady)
  if (!isMacDeveloperToolsMissing(initialDetail)) {
    return {
      ok: false,
      stdout: gitReady.stdout,
      stderr: initialDetail || '检测到 git 命令不可用，请检查本机 Git 安装后重试。',
      code: gitReady.code ?? 1,
      errorCode: 'git_unavailable',
    }
  }

  const prepareResult = await runDirect(
    '/bin/bash',
    ['-lc', MAC_GIT_TOOLS_PREPARE_SCRIPT],
    MAIN_RUNTIME_POLICY.cli.defaultDirectTimeoutMs,
    'env-setup'
  )

  await refreshEnvironment().catch(() => ({ ok: false }))

  const recheckProbeEnv = buildMacDeveloperToolsProbeEnv()
  const recheckResult = await runShell(
    'git',
    ['--version'],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    {
      controlDomain: 'env-setup',
      env: recheckProbeEnv,
    }
  )
  if (recheckResult.ok) {
    return {
      ...recheckResult,
    }
  }

  const recheckDetail = collectCommandDetail(recheckResult)
  const prepareDetail = collectCommandDetail(prepareResult)
  const detail = [prepareDetail, recheckDetail].filter(Boolean).join('\n')

  if (isMacDeveloperToolsMissing(detail) || detail.includes('尚未就绪')) {
    return {
      ok: false,
      stdout: [prepareResult.stdout, recheckResult.stdout].filter(Boolean).join('\n'),
      stderr: [
        '已尝试触发 Xcode 命令行工具系统安装弹窗。如果没有弹窗，请点击屏幕右下角的安装图标继续安装；安装完成后，点击“重试识别”刷新状态。',
        detail ? `\n原始错误：${detail}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      code: recheckResult.code ?? prepareResult.code ?? 1,
      errorCode: 'xcode_clt_pending',
    }
  }

  return {
    ok: false,
    stdout: [prepareResult.stdout, recheckResult.stdout].filter(Boolean).join('\n'),
    stderr: detail || 'Git/Xcode 预检失败，请稍后重试。',
    code: recheckResult.code ?? prepareResult.code ?? 1,
    errorCode: 'prepare_failed',
  }
}

async function guardMacOpenClawGitPreflight(): Promise<CliResult | null> {
  if (process.platform !== 'darwin') return null

  const prepared = await prepareMacGitTools()
  if (prepared.ok) return null
  return {
    ok: false,
    stdout: prepared.stdout,
    stderr: prepared.stderr,
    code: prepared.code ?? 1,
  }

  return null
}

// ─── Specific commands ───

async function resolveNodeFromShell(): Promise<{ version: string; binDir: string | null } | null> {
  const versionResult = await runShell(
    'node',
    ['--version'],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'env-setup'
  )
  if (!versionResult.ok) return null

  let binDir: string | null = null
  const execPathResult = await runShell(
    'node',
    ['-p', 'process.execPath'],
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'env-setup'
  )
  if (execPathResult.ok) {
    binDir = extractNodeBinDir(execPathResult.stdout)
  }

  if (!binDir) {
    const whichCmd = isWin ? 'where' : 'which'
    const whichResult = await runShell(
      whichCmd,
      ['node'],
      MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
      'env-setup'
    )
    if (whichResult.ok && whichResult.stdout.trim()) {
      const nodePath = whichResult.stdout.trim().split(/\r?\n/)[0]
      binDir = extractNodeBinDir(nodePath)
    }
  }

  rememberDetectedNodeBinDir(binDir)

  return {
    version: versionResult.stdout.trim(),
    binDir,
  }
}

function buildNodeCheckResult(
  version: string,
  installed: boolean,
  requiredVersion: string,
  targetVersion: string,
  installStrategy: 'nvm' | 'installer'
): NodeCheckResult {
  const normalizedVersion = String(version || '').trim()
  const meetsRequirement = installed && isNodeVersionAtLeast(normalizedVersion, requiredVersion)
  return {
    installed,
    version: normalizedVersion,
    needsUpgrade: installed && !meetsRequirement,
    meetsRequirement,
    requiredVersion,
    targetVersion,
    installStrategy,
  }
}

async function resolveNodeInstallPlanForNodeCheck(): Promise<NodeInstallPlan | null> {
  if (!isWin) {
    return resolveRuntimeNodeInstallPlan().catch(() => null)
  }

  return resolveRuntimeNodeInstallPlan({
    skipDynamicOpenClawRequirementProbe: true,
  }).catch(() => null)
}

export async function checkNode(): Promise<NodeCheckResult> {
  const requirement = await resolveOpenClawNodeRequirement(
    isWin
      ? {
          skipDynamicOpenClawRequirementProbe: true,
        }
      : undefined
  ).catch(() => ({
    minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
    source: 'bundled-fallback' as const,
  }))
  const installPlan = await resolveNodeInstallPlanForNodeCheck()
  const requiredVersion = installPlan?.requiredVersion || requirement.minVersion
  const targetVersion = installPlan?.version || ''
  const nvmDir = !isWin ? await detectNvmDir() : null
  const nvmWindowsDir = isWin ? await detectNvmWindowsDir().catch(() => null) : null
  const effectiveNvmDir = nvmWindowsDir ?? nvmDir

  const shellNode = await resolveNodeFromShell()
  const nvmNode = nvmDir
    ? await resolveNodeFromInstalledNvmVersions(nvmDir, targetVersion)
    : nvmWindowsDir
      ? await resolveNodeFromInstalledNvmWindowsVersions(nvmWindowsDir, targetVersion)
      : null
  const preferredNode = selectPreferredNodeRuntime({
    shellNode,
    nvmNode,
    requiredVersion,
    nvmDir: effectiveNvmDir,
  })

  if (preferredNode) {
    rememberDetectedNodeBinDir(preferredNode.candidate.binDir)
    return buildNodeCheckResult(
      preferredNode.candidate.version,
      true,
      requiredVersion,
      targetVersion,
      preferredNode.installStrategy
    )
  }

  for (const nodePath of listNodeExecutableCandidates(process.platform, process.env.PATH || '', detectedNodeBinDir)) {
    const r = await runDirect(nodePath, ['--version'], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs, 'env-setup')
    if (r.ok) {
      const nodeBinDir = dirname(nodePath)
      rememberDetectedNodeBinDir(nodeBinDir)
      return buildNodeCheckResult(
        r.stdout.trim(),
        true,
        requiredVersion,
        targetVersion,
        resolveNodeInstallStrategy(nodeBinDir, effectiveNvmDir)
      )
    }
  }

  return buildNodeCheckResult('', false, requiredVersion, targetVersion, effectiveNvmDir ? 'nvm' : 'installer')
}

// ─── Node.js Auto Install ───

/**
 * 检测用户是否使用 nvm 管理 Node.js。
 * 满足任一条件即认为使用 nvm：
 *  1. NVM_DIR 环境变量非空
 *  2. NVM_BIN 环境变量非空
 *  3. detectedNodeBinDir 路径包含 /.nvm/
 *  4. ~/.nvm/nvm.sh 文件存在（兜底：Electron 从 Dock 启动时 env vars 可能为空）
 */
async function detectNvmDir(): Promise<string | null> {
  if (process.env.NVM_DIR) return process.env.NVM_DIR
  if (process.env.NVM_BIN) return join(process.env.NVM_BIN, '..', '..')
  if (detectedNodeBinDir && detectedNodeBinDir.includes('/.nvm/')) {
    const idx = detectedNodeBinDir.indexOf('/.nvm/')
    return detectedNodeBinDir.slice(0, idx + 5) // includes trailing /.nvm
  }
  const fallbackDir = join(homedir(), '.nvm')
  try {
    await access(join(fallbackDir, 'nvm.sh'))
    return fallbackDir
  } catch {
    return null
  }
}

/**
 * 通过 nvm 升级 Node.js 到指定版本。
 * nvm 是 shell function，必须先 source nvm.sh 再调用。
 */
async function upgradeNodeViaNvm(nvmDir: string, targetVersion: string): Promise<CliResult> {
  const script = buildNvmInstallCommand(nvmDir, targetVersion)
  const result = await runDirect(
    '/bin/bash',
    ['-c', script],
    MAIN_RUNTIME_POLICY.node.installNodeTimeoutMs,
    'env-setup'
  )

  if (result.ok) {
    const preferredBinDir = buildNvmNodeBinDir(nvmDir, targetVersion)
    try {
      await access(join(preferredBinDir, 'node'))
      rememberDetectedNodeBinDir(preferredBinDir)
    } catch {
      // Fall back to wider nvm discovery when the exact install path is unavailable.
    }
  }

  return result
}

async function resolveNodeFromInstalledNvmVersions(
  nvmDir: string,
  preferredVersion?: string | null
): Promise<{ version: string; binDir: string | null } | null> {
  const candidateBinDirs = Array.from(
    new Set(
      [
        preferredVersion ? buildNvmNodeBinDir(nvmDir, preferredVersion) : '',
        ...(await listInstalledNvmNodeBinDirs(nvmDir)),
      ].filter(Boolean)
    )
  )

  for (const binDir of candidateBinDirs) {
    const versionResult = await runDirect(
      join(binDir, 'node'),
      ['--version'],
      MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
      'env-setup'
    )
    if (!versionResult.ok) continue

    rememberDetectedNodeBinDir(binDir)
    return {
      version: versionResult.stdout.trim(),
      binDir,
    }
  }

  return null
}

async function resolveNodeFromInstalledNvmWindowsVersions(
  nvmWindowsDir: string,
  preferredVersion?: string | null
): Promise<{ version: string; binDir: string | null } | null> {
  const candidateExePaths = Array.from(
    new Set(
      [
        preferredVersion
          ? join(nvmWindowsDir, `v${preferredVersion.replace(/^v/, '')}`, 'node.exe')
          : '',
        ...(await listInstalledNvmWindowsNodeExePaths(nvmWindowsDir).catch(() => [])),
      ].filter(Boolean)
    )
  )

  for (const exePath of candidateExePaths) {
    const versionResult = await runDirect(
      exePath,
      ['--version'],
      MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
      'env-setup'
    )
    if (!versionResult.ok) continue

    const binDir = dirname(exePath)
    rememberDetectedNodeBinDir(binDir)
    return {
      version: versionResult.stdout.trim(),
      binDir,
    }
  }

  return null
}

function buildMacOpenClawInstallFallbackCommand(options: {
  version: string
  npmCommandOptions: OpenClawNpmCommandOptions
  detectedBinDir?: string | null
  user?: string
  npmCacheDir?: string
  fixCacheOwnership?: boolean
  workingDirectory?: string | null
}): string {
  const commands = OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) =>
    buildMacNpmCommand(
      buildOpenClawInstallArgs(options.version, mirror.registryUrl, options.npmCommandOptions),
      {
        detectedBinDir: options.detectedBinDir,
        user: options.user,
        npmCacheDir: options.npmCacheDir,
        fixCacheOwnership: options.fixCacheOwnership,
        workingDirectory: options.workingDirectory,
      }
    )
  )
  return commands.map((command) => `(${command})`).join(' || ')
}

async function installOpenClawWithNpmMirrorFallback(
  version: string,
  runner: (args: string[]) => Promise<CliResult>,
  operationLabel: string,
  npmCommandOptions: OpenClawNpmCommandOptions
): Promise<CliResult> {
  const { result, attempts } = await runOpenClawNpmRegistryFallback((mirror) =>
    runner(buildOpenClawInstallArgs(version, mirror.registryUrl, npmCommandOptions))
  )
  if (result.ok || result.canceled) {
    return result
  }
  return attachOpenClawMirrorFailureDetails(result, attempts, {
    operationLabel,
    version,
  })
}

function shouldRetryOpenClawInstallWithAdmin(result: CliResult): boolean {
  if (result.ok || process.platform !== 'darwin') return false
  const output = `${String(result.stderr || '')}\n${String(result.stdout || '')}`
  return isOpenClawInstallPermissionFailureOutput(output)
}

interface MacOpenClawAdminProbe {
  prefixResolved: boolean
  writable: boolean
  ownerMatchesCurrentUser: boolean | null
  prefixPath?: string
  userHome: string
}

async function resolveMacOpenClawAdminProbe(
  npmCommandOptions: OpenClawNpmCommandOptions
): Promise<MacOpenClawAdminProbe> {
  const userHome = homedir()
  const prefixResult = await runShell(
    'npm',
    buildOpenClawConfigGetPrefixArgs(npmCommandOptions),
    MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
    'env-setup'
  )

  if (!prefixResult.ok) {
    return {
      prefixResolved: false,
      writable: false,
      ownerMatchesCurrentUser: null,
      userHome,
    }
  }

  const prefixPath = String(prefixResult.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!prefixPath) {
    return {
      prefixResolved: false,
      writable: false,
      ownerMatchesCurrentUser: null,
      userHome,
    }
  }

  const installProbePath = resolveOpenClawGlobalInstallProbePath(prefixPath, process.platform)
  const probe = await probeOpenClawInstallPath(installProbePath || prefixPath)
  return {
    prefixResolved: true,
    writable: probe.writable,
    ownerMatchesCurrentUser: probe.ownerMatchesCurrentUser,
    prefixPath,
    userHome,
  }
}

async function shouldAllowMacOpenClawAdminFallback(
  npmCommandOptions: OpenClawNpmCommandOptions
): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const policyEnabled = isMacOpenClawAdminFallbackEnabledByPolicy()
  const probe = await resolveMacOpenClawAdminProbe(npmCommandOptions)
  return shouldAllowMacOpenClawAdminFallbackByProbe({
    policyEnabled,
    prefixResolved: probe.prefixResolved,
    writable: probe.writable,
    ownerMatchesCurrentUser: probe.ownerMatchesCurrentUser,
    prefixPath: probe.prefixPath,
    userHome: probe.userHome,
  })
}

function buildUnknownOpenClawMirrorAttempts(): {
  mirror: (typeof OPENCLAW_NPM_REGISTRY_MIRRORS)[number]
  result: OpenClawCommandResultLike
}[] {
  return OPENCLAW_NPM_REGISTRY_MIRRORS.map((mirror) => ({
    mirror,
    result: {
      ok: false,
      stdout: '',
      stderr: '当前执行路径未返回分镜像明细，请按下方命令手动重试。',
      code: null,
    },
  }))
}

function maybeAttachMirrorDetailsToElevatedInstallResult(
  result: OpenClawElevatedLifecycleTransactionResult,
  version: string
): CliResult {
  if (result.ok || result.lifecycle.ok || result.status === 'snapshot_failed') {
    return result
  }

  return attachOpenClawMirrorFailureDetails(
    result,
    buildUnknownOpenClawMirrorAttempts(),
    {
      operationLabel: 'OpenClaw 命令行工具安装',
      version,
    }
  )
}

async function runMacPrivilegedOpenClawInstall(
  version: string,
  npmCommandOptions: OpenClawNpmCommandOptions,
  workingDirectory: string
): Promise<CliResult> {
  const privilegedNpmCommandOptions = createPrivilegedOpenClawNpmCommandOptions(npmCommandOptions)
  const lifecycleCommand = buildMacOpenClawInstallFallbackCommand({
    version,
    npmCommandOptions: privilegedNpmCommandOptions,
    detectedBinDir: detectedNodeBinDir,
    user: userInfo().username,
    npmCacheDir: join(homedir(), '.npm'),
    fixCacheOwnership: false,
    workingDirectory,
  })

  const result = await runMacOpenClawElevatedLifecycleTransaction({
    operation: 'install',
    lifecycleCommand,
    prompt:
      'Qclaw 需要安装 OpenClaw 命令行工具。\n\n这是连接 AI 服务和消息渠道的核心组件。\n\n请输入您的 Mac 登录密码以继续。',
    timeoutMs: buildMirrorAwareTimeoutMs(MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs),
    controlDomain: 'env-setup',
    qclawSafeWorkDir: workingDirectory,
    includeManagedInstallerRoot: true,
    runDirect,
  })

  return maybeAttachMirrorDetailsToElevatedInstallResult(result, version)
}

async function installOpenClawOnMac(
  npmCommandOptions: OpenClawNpmCommandOptions,
  expectations: {
    expectNode: boolean
  }
): Promise<CliResult> {
  const capabilityError = await guardPlatformCommands(['npm'])
  if (capabilityError) return capabilityError

  const adminProbe = await resolveMacOpenClawAdminProbe(npmCommandOptions)
  const safeWorkingDirectory = resolveManagedSpawnCwd()

  if (shouldPreferMacOpenClawAdminMainlineByProbe(adminProbe)) {
    const adminCapabilityError = await guardPlatformCommands(['osascript', 'npm'])
    if (adminCapabilityError) return adminCapabilityError
    const adminResult = await runMacPrivilegedOpenClawInstall(PINNED_OPENCLAW_VERSION, npmCommandOptions, safeWorkingDirectory)
    return finalizeInstallResult(adminResult, {
      expectNode: expectations.expectNode,
      expectOpenClaw: true,
    })
  }

  const userInstallResult = await installOpenClawWithNpmMirrorFallback(
    PINNED_OPENCLAW_VERSION,
    (args) =>
      runShell(
        'npm',
        args,
        MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs,
        'env-setup'
      ),
    'OpenClaw 命令行工具安装',
    npmCommandOptions
  )

  const shouldRetryWithAdmin = shouldRetryOpenClawInstallWithAdmin(userInstallResult)
  if (userInstallResult.ok || !shouldRetryWithAdmin) {
    return finalizeInstallResult(userInstallResult, {
      expectNode: expectations.expectNode,
      expectOpenClaw: true,
    })
  }

  const allowAdminFallback = shouldAllowMacOpenClawAdminFallbackByProbe({
    policyEnabled: isMacOpenClawAdminFallbackEnabledByPolicy(),
    prefixResolved: adminProbe.prefixResolved,
    writable: adminProbe.writable,
    ownerMatchesCurrentUser: adminProbe.ownerMatchesCurrentUser,
    prefixPath: adminProbe.prefixPath,
    userHome: adminProbe.userHome,
  })
  if (!allowAdminFallback) {
    return finalizeInstallResult(userInstallResult, {
      expectNode: expectations.expectNode,
      expectOpenClaw: true,
    })
  }

  const adminCapabilityError = await guardPlatformCommands(['osascript', 'npm'])
  if (adminCapabilityError) return adminCapabilityError
  const adminResult = await runMacPrivilegedOpenClawInstall(PINNED_OPENCLAW_VERSION, npmCommandOptions, safeWorkingDirectory)
  return finalizeInstallResult(adminResult, {
    expectNode: expectations.expectNode,
    expectOpenClaw: true,
  })
}

function shouldAttachOpenClawMirrorDetailsForCombinedInstall(
  result: CliResult,
  opts: { needNode: boolean; needOpenClaw: boolean }
): boolean {
  if (result.canceled) return false
  if (!opts.needOpenClaw || result.ok) return false
  if (!opts.needNode) return true

  // When Node and OpenClaw are installed in one combined command, Node failures
  // can occur before npm install starts. Only attach mirror details when output
  // suggests the OpenClaw/npm step actually ran.
  const output = `${String(result.stderr || '')}\n${String(result.stdout || '')}`.toLowerCase()
  return (
    output.includes('openclaw') ||
    output.includes('openclaw@') ||
    output.includes('npm') ||
    output.includes('registry')
  )
}

export async function resolveNodeInstallPlan(): Promise<NodeInstallPlan> {
  return resolveRuntimeNodeInstallPlan(
    isWin
      ? {
          skipDynamicOpenClawRequirementProbe: true,
        }
      : undefined
  )
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath)
    const request = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          file.close()
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject)
          return
        }
      }

      if (response.statusCode !== 200) {
        file.close()
        reject(new Error(`Download failed with status ${response.statusCode}`))
        return
      }

      response.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    })

    request.on('error', (err) => {
      file.close()
      reject(err)
    })

    request.setTimeout(MAIN_RUNTIME_POLICY.node.installerDownloadTimeoutMs, () => {
      request.destroy()
      reject(new Error('Download timeout'))
    })
  })
}

async function installNodeWithAdmin(installerPath: string): Promise<CliResult> {
  if (process.platform === 'darwin') {
    const capabilityError = await guardPlatformCommands(['osascript', 'installer'])
    if (capabilityError) return capabilityError
    const installCommand = prefixPosixCommandWithWorkingDirectory(
      `installer -pkg '${installerPath}' -target /`,
      resolveManagedSpawnCwd()
    )
    // macOS: 使用 osascript 弹出密码框，带自定义提示
    return runDirect('osascript', [
      '-e',
      buildAppleScriptDoShellScript(installCommand, {
        prompt: 'Qclaw 需要安装 Node.js。\n\n请输入您的 Mac 登录密码以继续安装。',
      })
    ], MAIN_RUNTIME_POLICY.node.installNodeTimeoutMs, 'env-setup')
  } else if (process.platform === 'win32') {
    const capabilityError = await guardPlatformCommands(['powershell', 'msiexec'])
    if (capabilityError) return capabilityError
    // Windows: 使用 powershell Start-Process -Verb RunAs
    return runShell('powershell', [
      '-Command',
      `Start-Process -FilePath msiexec -ArgumentList '/i','${installerPath}','/qn' -Verb RunAs -Wait`
    ], MAIN_RUNTIME_POLICY.node.installNodeTimeoutMs, 'env-setup')
  }
  throw new Error('Unsupported platform')
}

export async function installNode(): Promise<CliResult> {
  return withManagedOperationLock(RUNTIME_INSTALL_LOCK_KEY, async () => {
    try {
      const downloadResult = await downloadNodeInstaller()
      if (!downloadResult.ok || !downloadResult.path) {
        return {
          ok: false,
          stdout: '',
          stderr: downloadResult.error || 'Failed to download Node installer',
          code: -1,
        }
      }

      const installerPath = downloadResult.path

      // 使用管理员权限安装
      const result = await installNodeWithAdmin(installerPath)

      // 清理安装包
      try {
        await unlink(installerPath)
      } catch {
        // 忽略清理失败
      }

      return finalizeInstallResult(result, {
        expectNode: true,
        expectOpenClaw: false,
      })
    } catch (err) {
      return {
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        code: -1
      }
    }
  })
}

/** 下载 Node.js 安装包（不安装），返回安装包路径 */
export async function downloadNodeInstaller(
  installPlan?: NodeInstallPlan
): Promise<{ ok: boolean; path: string; error?: string; plan?: NodeInstallPlan }> {
  try {
    const plan = installPlan || (await resolveNodeInstallPlan())
    const installerPath = join(tmpdir(), plan.filename)
    await downloadFile(plan.url, installerPath)
    return { ok: true, path: installerPath, plan }
  } catch (err) {
    return { ok: false, path: '', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function inspectNodeInstaller(installerPath: string): Promise<NodeInstallerReadinessResult> {
  if (process.platform !== 'darwin') {
    return { ok: true }
  }

  return inspectMacNodeInstaller(installerPath, {
    runDirect: (command, args, timeout) => runDirect(command, args, timeout, 'env-setup'),
  })
}

export async function checkOpenClaw(): Promise<OpenClawCheckResult> {
  await appendEnvCheckDiagnostic('main-check-openclaw-start', {})
  const selectedRuntimeSnapshot = await resolveSelectedWindowsOpenClawRuntimeSnapshot()
  const selectedRuntimeComplete = await inspectSelectedWindowsOpenClawRuntimeCompleteness()
  if (!selectedRuntimeComplete) {
    await appendEnvCheckDiagnostic('main-check-openclaw-result', {
      installed: false,
      selectedRuntimeComplete,
      version: null,
      reason: 'selected-runtime-incomplete',
    })
    return {
      installed: false,
      selectedRuntimeComplete,
      version: '',
    }
  }

  await appendEnvCheckDiagnostic('main-check-openclaw-before-run-cli', {
    nodePath: selectedRuntimeSnapshot?.nodePath || null,
    openclawPath: selectedRuntimeSnapshot?.openclawPath || null,
  })
  const r = await runCli(['--version'], MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs, 'env-setup', {
    activeRuntimeSnapshot: selectedRuntimeSnapshot || undefined,
    skipConfigRepairPreflight: true,
  })
  if (!r.ok) {
    await appendEnvCheckDiagnostic('main-check-openclaw-result', {
      installed: false,
      selectedRuntimeComplete,
      version: null,
      reason: 'run-cli-failed',
      stderr: String(r.stderr || '').trim() || null,
      stdout: String(r.stdout || '').trim() || null,
    })
    return {
      installed: false,
      selectedRuntimeComplete,
      version: '',
    }
  }
  await appendEnvCheckDiagnostic('main-check-openclaw-result', {
    installed: true,
    selectedRuntimeComplete,
    version: r.stdout.trim() || null,
    reason: 'ok',
  })
  return {
    installed: true,
    selectedRuntimeComplete,
    version: r.stdout.trim(),
  }
}

export async function discoverOpenClawForEnvCheck(): Promise<OpenClawDiscoveryResult> {
  if (process.platform !== 'win32') {
    return discoverOpenClawInstallations()
  }

  const selectedRuntimeSnapshot = await resolveSelectedWindowsOpenClawRuntimeSnapshot()
  const selectedOpenClawPath = String(selectedRuntimeSnapshot?.openclawPath || '').trim()
  const commandProbeEnv = buildCommandCapabilityEnv(selectedRuntimeSnapshot || null)
  const resolvedOpenClawPath =
    selectedOpenClawPath ||
    (await resolveOpenClawBinaryPath({
      activeRuntimeSnapshot: selectedRuntimeSnapshot || undefined,
      env: commandProbeEnv,
    }).catch(() => null))
  const discovery = await discoverOpenClawInstallationsFromKnownPaths({
    activeBinaryPath: resolvedOpenClawPath || null,
    knownPaths: [selectedOpenClawPath, resolvedOpenClawPath],
  })
  const gatewayOwnerHomeDir =
    String(selectedRuntimeSnapshot?.stateDir || '').trim() || resolveOpenClawPaths().homeDir

  try {
    const { inspectWindowsGatewayLauncherIntegrity } = await import('./platforms/windows/windows-platform-ops')
    const launcherIntegrity = await inspectWindowsGatewayLauncherIntegrity({
      homeDir: gatewayOwnerHomeDir,
    })

    return {
      ...discovery,
      windowsGatewayOwnerState: launcherIntegrity.status,
    }
  } catch {
    return {
      ...discovery,
      windowsGatewayOwnerState: 'unknown',
    }
  }
}

export async function installOpenClaw(): Promise<CliResult> {
  return withManagedOperationLock(RUNTIME_INSTALL_LOCK_KEY, async () => {
    if (isWin) {
      const capabilityError = await guardPlatformCommands(['npm'])
      if (capabilityError) return capabilityError
      const managedNpmOptionsResult = await resolveManagedOpenClawInstallNpmCommandOptions(
        'OpenClaw 命令行工具安装',
        {
          prefixPath: resolvePreferredWindowsOpenClawInstallPrefix(),
        }
      )
      if ('error' in managedNpmOptionsResult) return managedNpmOptionsResult.error
      // Windows: npm install -g 不需要管理员权限（安装到 %APPDATA%\npm）
      const result = await installOpenClawWithNpmMirrorFallback(
        PINNED_OPENCLAW_VERSION,
        (args) =>
          runShell(
            'npm',
            args,
            MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs,
            'env-setup'
          ),
        'OpenClaw 命令行工具安装',
        managedNpmOptionsResult.options
      )
      return finalizeInstallResult(result, {
        expectNode: false,
        expectOpenClaw: true,
      })
    }

    const gitPreflight = await guardMacOpenClawGitPreflight()
    if (gitPreflight) return gitPreflight

    const capabilityError = await guardPlatformCommands(['npm'])
    if (capabilityError) return capabilityError
    const managedNpmOptionsResult = await resolveManagedOpenClawInstallNpmCommandOptions('OpenClaw 命令行工具安装')
    if ('error' in managedNpmOptionsResult) return managedNpmOptionsResult.error
    return installOpenClawOnMac(managedNpmOptionsResult.options, {
      expectNode: false,
    })
  })
}

/** 智能安装：根据需要安装 Node.js 和/或 OpenClaw CLI（只弹一次权限弹窗） */
export async function installEnv(opts: InstallEnvOptions): Promise<CliResult> {
  return withManagedOperationLock(RUNTIME_INSTALL_LOCK_KEY, async () => {
    const { needNode, needOpenClaw } = opts
    let nodeInstallerPath = opts.nodeInstallerPath
    let openClawNpmCommandOptions: OpenClawNpmCommandOptions | null = null
    const providedNodeInstallPlan = opts.nodeInstallPlan

    if (!needNode && !needOpenClaw) {
      return { ok: true, stdout: '', stderr: '', code: 0 }
    }

    if (isWin) {
      let windowsSelectedNodePrefix: string | null = null
      if (needNode) {
        const installPlan = providedNodeInstallPlan || (await resolveNodeInstallPlan())
        const nodeRuntimeResult = await ensureWindowsPrivateNodeRuntime({
          plan: installPlan,
          downloadFile,
          env: process.env,
          runPowerShell: (command, args, timeoutMs) =>
            runShell(command, args, timeoutMs, 'env-setup'),
          timeoutMs: MAIN_RUNTIME_POLICY.node.installNodeTimeoutMs,
        })
        if (!nodeRuntimeResult.ok) {
          return {
            ok: false,
            stdout: nodeRuntimeResult.stdout || '',
            stderr: nodeRuntimeResult.stderr || 'Failed to install private Node.js runtime',
            code: nodeRuntimeResult.code ?? 1,
          }
        }
        rememberDetectedNodeBinDir(nodeRuntimeResult.nodeBinDir || detectedNodeBinDir)
        windowsSelectedNodePrefix = nodeRuntimeResult.nodeBinDir || null
        process.env.PATH = buildCliPathWithCandidates({
          platform: process.platform,
          currentPath: process.env.PATH || '',
          detectedNodeBinDir,
          env: process.env,
        })
        resetCommandCapabilityCache()
        resetRuntimeOpenClawPathsCache()
      }
      if (needOpenClaw) {
        const capabilityError = await guardPlatformCommands(['npm'])
        if (capabilityError) return capabilityError
        const managedNpmOptionsResult = await resolveManagedOpenClawInstallNpmCommandOptions(
          'OpenClaw 命令行工具安装',
          {
            prefixPath: resolvePreferredWindowsOpenClawInstallPrefix(windowsSelectedNodePrefix),
          }
        )
        if ('error' in managedNpmOptionsResult) return managedNpmOptionsResult.error
        const result = await installOpenClawWithNpmMirrorFallback(
          PINNED_OPENCLAW_VERSION,
          (args) =>
            runShell(
              'npm',
              args,
              MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs,
              'env-setup'
            ),
          'OpenClaw 命令行工具安装',
          managedNpmOptionsResult.options
        )
        return finalizeInstallResult(result, {
          expectNode: needNode,
          expectOpenClaw: true,
        })
      }
      return finalizeInstallResult(
        { ok: true, stdout: '', stderr: '', code: 0 },
        {
          expectNode: needNode,
          expectOpenClaw: false,
        }
      )
    }

    if (needOpenClaw) {
      const gitPreflight = await guardMacOpenClawGitPreflight()
      if (gitPreflight) return gitPreflight
      const managedNpmOptionsResult = await resolveManagedOpenClawInstallNpmCommandOptions('OpenClaw 命令行工具安装')
      if ('error' in managedNpmOptionsResult) return managedNpmOptionsResult.error
      openClawNpmCommandOptions = managedNpmOptionsResult.options
    }

    if (!needNode && needOpenClaw) {
      return installOpenClawOnMac(
        openClawNpmCommandOptions as OpenClawNpmCommandOptions,
        {
          expectNode: false,
        }
      )
    }

    // macOS: 如果检测到 nvm，优先通过 nvm 升级 Node.js（无需 sudo）
    if (needNode) {
      const nvmDir = await detectNvmDir()
      if (nvmDir) {
        const installPlan =
          providedNodeInstallPlan ||
          (await resolveRuntimeNodeInstallPlan().catch(() => null))
        const targetVersion =
          installPlan?.version ||
          getBundledTargetNodeVersion(installPlan?.requiredVersion || DEFAULT_BUNDLED_NODE_REQUIREMENT)
        const nvmResult = await upgradeNodeViaNvm(nvmDir, targetVersion)
        if (nvmResult.ok) {
          await refreshEnvironment()
          if (!needOpenClaw) {
            return finalizeInstallResult(nvmResult, { expectNode: true, expectOpenClaw: false })
          }
          // nvm 环境下 npm install -g 不需要 sudo；按镜像顺序重试。
          const gitRewritePrefix = buildGitHubHttpsRewriteEnvCommands().join(' && ')
          const nvmNpmPathResult = await runDirect(
            '/bin/bash',
            ['-c', `${buildNvmUseCommand(nvmDir, targetVersion)} >/dev/null && command -v npm`],
            MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
            'env-setup'
          )
          const nvmNpmPath = String(nvmNpmPathResult.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1)
          const nvmDetectedBinDir = nvmNpmPath ? dirname(nvmNpmPath) : null
          const npmResult = await installOpenClawWithNpmMirrorFallback(
            PINNED_OPENCLAW_VERSION,
            (args) =>
              runDirect(
                '/bin/bash',
                [
                  '-c',
                  `${buildNvmUseCommand(nvmDir, targetVersion)} && ${gitRewritePrefix} && ${buildMacNpmCommand(
                    args,
                    {
                      detectedBinDir: nvmDetectedBinDir,
                      fixCacheOwnership: false,
                      workingDirectory: resolveManagedSpawnCwd(),
                    }
                  )}`,
                ],
                MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs,
                'env-setup'
              ),
            'OpenClaw 命令行工具安装',
            openClawNpmCommandOptions as OpenClawNpmCommandOptions
          )
          return finalizeInstallResult(npmResult, { expectNode: true, expectOpenClaw: true })
        }
        if (!shouldFallbackToInstallerAfterNvmInstall(nvmResult)) {
          return nvmResult
        }
        // nvm 升级失败，回退到 .pkg 安装器
      }
    }

    // macOS 回退路径：需要 .pkg 安装器时，确保已下载
    if (needNode && !nodeInstallerPath) {
      const downloadResult = await downloadNodeInstaller(providedNodeInstallPlan)
      if (!downloadResult.ok || !downloadResult.path) {
        return {
          ok: false,
          stdout: '',
          stderr: downloadResult.error || 'Failed to download Node installer',
          code: -1,
        }
      }
      nodeInstallerPath = downloadResult.path
    }

    const requiredCommands: PlatformCommandId[] = ['osascript']
    if (needNode) requiredCommands.push('installer')
    if (needOpenClaw && !needNode) requiredCommands.push('npm')
    const capabilityError = await guardPlatformCommands(requiredCommands)
    if (capabilityError) return capabilityError

    // macOS: 回退路径
    // - Node 安装仍通过 osascript 执行
    // - OpenClaw 始终优先在用户态安装，避免管理员安装路径遗留 root 挂起进程
    const installOpenClawAfterNode = needNode && needOpenClaw

    // macOS: 通过 osascript 安装需要管理员权限的组件
    const commands: string[] = []
    const components: string[] = []
    const safeWorkingDirectory = resolveManagedSpawnCwd()

    if (needNode && nodeInstallerPath) {
      commands.push(`installer -pkg '${nodeInstallerPath}' -target /`)
      components.push('Node.js')
    }

    if (needOpenClaw && !installOpenClawAfterNode) {
      const privilegedNpmCommandOptions = createPrivilegedOpenClawNpmCommandOptions(
        openClawNpmCommandOptions as OpenClawNpmCommandOptions
      )
      commands.push(
        buildMacOpenClawInstallFallbackCommand({
          version: PINNED_OPENCLAW_VERSION,
          npmCommandOptions: privilegedNpmCommandOptions,
          detectedBinDir: detectedNodeBinDir,
          user: userInfo().username,
          npmCacheDir: join(homedir(), '.npm'),
          fixCacheOwnership: true,
          workingDirectory: safeWorkingDirectory,
        })
      )
      components.push('OpenClaw 命令行工具')
    }

    const cmd = prefixPosixCommandWithWorkingDirectory(commands.join(' && '), safeWorkingDirectory)
    const prompt = `Qclaw 需要安装以下组件：\n\n${components.map(c => '• ' + c).join('\n')}\n\n请输入您的 Mac 登录密码以继续。`

    const result = await runDirect('osascript', [
      '-e',
      buildAppleScriptDoShellScript(cmd, { prompt })
    ], buildMirrorAwareTimeoutMs(MAIN_RUNTIME_POLICY.node.installCombinedTimeoutMs), 'env-setup')
    const decoratedResult = shouldAttachOpenClawMirrorDetailsForCombinedInstall(result, {
      needNode,
      needOpenClaw: needOpenClaw && !installOpenClawAfterNode,
    })
      ? attachOpenClawMirrorFailureDetails(
          result,
          buildUnknownOpenClawMirrorAttempts(),
          {
            operationLabel: 'OpenClaw 命令行工具安装',
            version: PINNED_OPENCLAW_VERSION,
          }
        )
      : result
    if (!decoratedResult.ok || !installOpenClawAfterNode) {
      return finalizeInstallResult(decoratedResult, {
        expectNode: needNode,
        expectOpenClaw: needOpenClaw && !installOpenClawAfterNode,
      })
    }

    await refreshEnvironment().catch(() => ({ ok: false }))
    return installOpenClawOnMac(
      openClawNpmCommandOptions as OpenClawNpmCommandOptions,
      {
        expectNode: true,
      }
    )
  })
}

export async function runOnboard(opts: Record<string, any>): Promise<OnboardResult> {
  const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
  const capabilities = await loadOpenClawCapabilities()
  const buildResult = buildOnboardCommand(
    {
      interactive: Boolean(opts.interactive),
      authChoice: typeof opts.authChoice === 'string' ? opts.authChoice : undefined,
      acceptRisk: Boolean(opts.acceptRisk),
      installDaemon:
        typeof opts.installDaemon === 'boolean'
          ? opts.installDaemon
          : undefined,
      skipChannels: opts.skipChannels,
      skipSkills: opts.skipSkills,
      skipUi: opts.skipUi,
      valueFlags: collectOnboardValueFlags(opts),
    },
    capabilities
  )

  if (!buildResult.ok) {
    return {
      ok: false,
      stdout: '',
      stderr: buildResult.message,
      code: 1,
    }
  }

  const result = await runCli(buildResult.command, MAIN_RUNTIME_POLICY.cli.runOnboardTimeoutMs, 'env-setup')
  if (result.ok) return result

  return {
    ...result,
    errorCode: classifyOnboardFailure(result).errorCode,
  }
}

export async function gatewayHealth(): Promise<GatewayHealthCheckResult> {
  await appendEnvCheckDiagnostic('main-gateway-health-start', {})
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  const r = await runCli(['health', '--json'], MAIN_RUNTIME_POLICY.cli.gatewayHealthTimeoutMs, 'gateway', {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    skipConfigRepairPreflight: true,
    skipPermissionAutoRepair: true,
  })
  const classification = classifyGatewayRuntimeState(r)
  const result: GatewayHealthCheckResult = {
    running: r.ok,
    raw: r.stdout,
    stderr: r.stderr,
    code: r.code,
    stateCode: r.ok ? 'healthy' : classification.stateCode,
    summary: r.ok ? '网关已确认可用' : classification.summary,
  }
  await appendEnvCheckDiagnostic('main-gateway-health-result', {
    running: result.running,
    code: result.code,
    stateCode: result.stateCode,
    summary: result.summary,
  })
  return result
}

export async function gatewayStatus(): Promise<GatewayStatusCheckResult> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  const result = await runCli(['status', '--json'], MAIN_RUNTIME_POLICY.cli.statusTimeoutMs, 'gateway', {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    skipConfigRepairPreflight: true,
    skipPermissionAutoRepair: true,
  })

  let payload: {
    service?: {
      runtime?: {
        status?: unknown
      } | null
    } | null
    health?: {
      healthy?: unknown
    } | null
    rpc?: {
      ok?: unknown
    } | null
  } | null = null

  try {
    payload = parseJsonFromCommandResult(result)
  } catch {
    payload = null
  }

  const serviceStatus = String(payload?.service?.runtime?.status || '').trim().toLowerCase()
  const serviceRunning = serviceStatus === 'running'
  const healthHealthy = payload?.health?.healthy === true
  const rpcReachable = payload?.rpc?.ok === true
  const running = serviceRunning || healthHealthy

  if (running) {
    return {
      running: true,
      rpcReachable,
      raw: result.stdout,
      stderr: result.stderr,
      code: result.code,
      stateCode: 'healthy',
      summary:
        rpcReachable === false
          ? '网关服务已确认正在运行；本地 RPC 探测未通过'
          : '网关已确认可用',
    }
  }

  const classification = classifyGatewayRuntimeState({
    ...result,
    running: false,
  })
  return {
    running: false,
    rpcReachable,
    raw: result.stdout,
    stderr: result.stderr,
    code: result.code,
    stateCode: classification.stateCode,
    summary: classification.summary,
  }
}

async function resolveGatewayMutationPreflightHomeDir(): Promise<string | null> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  if (activeRuntimeSnapshot?.stateDir) {
    return String(activeRuntimeSnapshot.stateDir).trim() || null
  }

  const authoritativeRuntimeSnapshot = readAuthoritativeWindowsChannelRuntimeSnapshot()
  if (authoritativeRuntimeSnapshot?.stateDir) {
    return String(authoritativeRuntimeSnapshot.stateDir).trim() || null
  }

  const readOnlyPaths = await resolveOpenClawPathsForRead({
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
  }).catch(() => null)
  if (readOnlyPaths?.homeDir) {
    return String(readOnlyPaths.homeDir).trim() || null
  }

  return String(resolveOpenClawPaths().homeDir || '').trim() || null
}

export async function gatewayStart(options: GatewayMutationCommandOptions = {}): Promise<CliResult> {
  await appendEnvCheckDiagnostic('main-gateway-start-start', {})
  const activeRuntimeSnapshot =
    options.activeRuntimeSnapshot || await resolveWindowsActiveRuntimeSnapshotForRead()
  await appendEnvCheckDiagnostic('main-gateway-start-runtime-snapshot', {
    providedSnapshot: Boolean(options.activeRuntimeSnapshot),
    hasSnapshot: Boolean(activeRuntimeSnapshot),
    stateDir: String(activeRuntimeSnapshot?.stateDir || '').trim() || null,
    nodePath: String(activeRuntimeSnapshot?.nodePath || '').trim() || null,
  })
  const configRepairPreflightHomeDir =
    String(options.configRepairPreflightHomeDir || '').trim()
    || await resolveGatewayMutationPreflightHomeDir()
  const result = await runCli(['gateway', 'start'], MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs, 'gateway', {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    configRepairPreflightHomeDir,
    requireConfigRepairPreflight: true,
  })
  await appendEnvCheckDiagnostic('main-gateway-start-result', {
    ok: result.ok,
    code: result.code,
    stdout: String(result.stdout || '').slice(0, 400),
    stderr: String(result.stderr || '').slice(0, 400),
  })
  return result
}

// Singleflight lock to prevent concurrent restart operations
let restartPromise: Promise<CliResult> | null = null

async function gatewayRestartImpl(): Promise<CliResult> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  const configRepairPreflightHomeDir = await resolveGatewayMutationPreflightHomeDir()
  return runCli(['gateway', 'restart'], MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs, 'gateway', {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    configRepairPreflightHomeDir,
    requireConfigRepairPreflight: true,
  })
}

export async function gatewayRestart(): Promise<CliResult> {
  if (restartPromise) {
    return restartPromise
  }

  restartPromise = gatewayRestartImpl()

  try {
    return await restartPromise
  } finally {
    restartPromise = null
  }
}

export async function gatewayForceRestart(): Promise<CliResult> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  const configRepairPreflightHomeDir = await resolveGatewayMutationPreflightHomeDir()
  return runCli(['gateway', 'restart', '--force'], undefined, undefined, {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    configRepairPreflightHomeDir,
    requireConfigRepairPreflight: true,
  })
}

export async function gatewayStop(): Promise<CliResult> {
  return runCli(['gateway', 'stop'], MAIN_RUNTIME_POLICY.cli.gatewayStopTimeoutMs, 'gateway')
}

export async function getStatus(): Promise<CliResult> {
  const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
  return runCli(['status', '--json'], MAIN_RUNTIME_POLICY.cli.statusTimeoutMs, 'gateway', {
    activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
    skipConfigRepairPreflight: true,
    skipPermissionAutoRepair: true,
  })
}

export async function readConfig(options: ReadConfigOptions = {}): Promise<Record<string, any> | null> {
  const requestedConfigPath = String(options.configPath || '').trim()
  try {
    await appendEnvCheckDiagnostic('main-read-config-start', {
      requestedConfigPath: requestedConfigPath || null,
    })
    const config = await runFsWithPermissionAutoRepair(
      async () => {
        const openClawPaths = requestedConfigPath ? null : await getOpenClawPathsForRead()
        const configFile = requestedConfigPath || openClawPaths?.configFile || ''
        await appendEnvCheckDiagnostic('main-read-config-resolved-path', {
          requestedConfigPath: requestedConfigPath || null,
          resolvedConfigPath: configFile,
        })
        const raw = await readFile(configFile, 'utf-8')
        return JSON.parse(raw)
      },
      {
        operation: 'read-config',
        controlDomain: 'config-write',
      },
      createPermissionAutoRepairDependencies({ readOnlyPaths: true })
    )
    await appendEnvCheckDiagnostic('main-read-config-result', {
      requestedConfigPath: requestedConfigPath || null,
      isNull: !config,
      topLevelKeys: config && typeof config === 'object' ? Object.keys(config).length : 0,
    })
    return config
  } catch {
    await appendEnvCheckDiagnostic('main-read-config-result', {
      requestedConfigPath: requestedConfigPath || null,
      isNull: true,
      errored: true,
    })
    return null
  }
}

export async function writeConfig(config: Record<string, any>): Promise<void> {
  await runFsWithPermissionAutoRepair(
    async () => {
      const openClawPaths = await getOpenClawPaths()
      await mkdir(openClawPaths.homeDir, { recursive: true })
      const repairedConfig = repairKnownProviderConfigGaps(config).config || config
      const sanitizedConfig = sanitizeManagedPluginConfig(repairedConfig).config
      await atomicWriteJson(openClawPaths.configFile, sanitizedConfig, {
        description: 'OpenClaw 主配置',
      })
    },
    {
      operation: 'write-config',
      controlDomain: 'config-write',
    },
    createPermissionAutoRepairDependencies()
  )
}

/** Read and parse .env file as key-value pairs */
export async function readEnvFile(options: ReadEnvFileOptions = {}): Promise<Record<string, string>> {
  if (options.diagnosticProbe === 'gateway-health') {
    await appendEnvCheckDiagnostic('main-gateway-health-read-env-enter', {})
    await appendEnvCheckDiagnostic('main-gateway-health-read-env-before-run-fs', {})
  }
  try {
    const env = await runFsWithPermissionAutoRepair(
      async () => {
        if (options.diagnosticProbe === 'gateway-health') {
          await appendEnvCheckDiagnostic('main-gateway-health-read-env-execute-start', {})
          await appendEnvCheckDiagnostic('main-gateway-health-read-env-before-resolve-paths', {
            hasProvidedPaths: Boolean(options.openClawPaths),
            hasRuntimeSnapshot: Boolean(options.activeRuntimeSnapshot),
          })
        }
        const openClawPaths =
          options.openClawPaths
          || (
            options.activeRuntimeSnapshot
              ? await resolveRuntimeOpenClawPaths({
                  activeRuntimeSnapshot: options.activeRuntimeSnapshot,
                })
              : await getOpenClawPathsForRead()
          )
        if (options.diagnosticProbe === 'gateway-health') {
          await appendEnvCheckDiagnostic('main-gateway-health-read-env-after-resolve-paths', {
            envFile: openClawPaths.envFile,
            homeDir: openClawPaths.homeDir,
          })
          await appendEnvCheckDiagnostic('main-gateway-health-read-env-before-read-file', {
            envFile: openClawPaths.envFile,
          })
        }
        const raw = await readFile(openClawPaths.envFile, 'utf-8')
        if (options.diagnosticProbe === 'gateway-health') {
          await appendEnvCheckDiagnostic('main-gateway-health-read-env-after-read-file', {
            size: raw.length,
          })
        }
        const env: Record<string, string> = {}
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIndex = trimmed.indexOf('=')
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex)
            const value = trimmed.slice(eqIndex + 1)
            env[key] = value
          }
        }
        return env
      },
      {
        operation: 'read-env',
        controlDomain: 'config-write',
      },
      createPermissionAutoRepairDependencies({ readOnlyPaths: true })
    )
    if (options.diagnosticProbe === 'gateway-health') {
      await appendEnvCheckDiagnostic('main-gateway-health-read-env-after-run-fs', {
        envKeyCount: Object.keys(env || {}).length,
      })
    }
    return env
  } catch {
    if (options.diagnosticProbe === 'gateway-health') {
      await appendEnvCheckDiagnostic('main-gateway-health-read-env-catch', {})
    }
    return {}
  }
}

/** Write key-value pairs to .env file, preserving comments */
export async function writeEnvFile(updates: Record<string, string | null | undefined>): Promise<void> {
  await runFsWithPermissionAutoRepair(
    async () => {
      const openClawPaths = await getOpenClawPaths()
      await mkdir(openClawPaths.homeDir, { recursive: true })

      let existing = ''
      try {
        existing = await readFile(openClawPaths.envFile, 'utf-8')
      } catch {
        // file doesn't exist
      }

      await writeFile(openClawPaths.envFile, applyEnvFileUpdates(existing, updates), 'utf-8')
    },
    {
      operation: 'write-env',
      controlDomain: 'config-write',
    },
    createPermissionAutoRepairDependencies()
  )
}

interface RunDoctorOptions {
  fix?: boolean
  nonInteractive?: boolean
  repairStalePluginConfigFromCommandResult?: (
    result: {
      stdout?: string
      stderr?: string
    }
  ) => Promise<RepairStalePluginConfigFromCommandResult>
}

function isUnsupportedDoctorFixFlag(result: CliResult): boolean {
  if (result.ok) return false
  const corpus = `${String(result.stderr || '')}\n${String(result.stdout || '')}`.toLowerCase()
  return /unknown option|unknown flag|unknown argument|invalid option|no such option|unexpected argument/.test(corpus)
    && corpus.includes('--fix')
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<CliResult> {
  const nonInteractive = options.nonInteractive !== false
  const args = ['doctor']
  if (options.fix) args.push('--fix')
  if (nonInteractive) args.push('--non-interactive')

  const result = options.fix
    ? await runCli(args, MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs, 'env-setup')
    : await rerunReadOnlyCommandAfterStalePluginRepair(
        () => runCli(args, MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs, 'env-setup'),
        {
          repairStalePluginConfigFromCommandResult: options.repairStalePluginConfigFromCommandResult,
        }
      )
  if (!options.fix || !isUnsupportedDoctorFixFlag(result)) {
    return result
  }

  return runCli(
    ['doctor', '--repair', ...(nonInteractive ? ['--non-interactive'] : [])],
    MAIN_RUNTIME_POLICY.cli.doctorTimeoutMs,
    'env-setup'
  )
}

/** Approve a pairing request: openclaw pairing approve <channel> <code> */
export async function pairingApprove(
  channel: string,
  code: string,
  accountId?: string
): Promise<PairingApproveResult> {
  const normalizedAccountId = String(accountId || '').trim()
  const maskedCode = maskPairingApproveCode(code)
  await appendEnvCheckDiagnostic('main-pairing-approve-start', {
    channel: String(channel || '').trim() || null,
    accountId: normalizedAccountId || null,
    maskedCode,
    timeoutMs: null,
  })
  try {
    const result = await runCli(
      [
        'pairing',
        'approve',
        channel,
        code,
        '--notify',
        ...(normalizedAccountId ? ['--account', normalizedAccountId] : []),
      ],
      undefined,
      'config-write'
    )
    const errorCode = result.ok ? null : resolvePairingApproveErrorCode(result) || 'unknown'

    await appendEnvCheckDiagnostic('main-pairing-approve-result', {
      channel: String(channel || '').trim() || null,
      accountId: normalizedAccountId || null,
      maskedCode,
      ok: result.ok,
      code: result.code,
      canceled: result.canceled === true,
      errorCode,
      stdout: truncatePairingApproveDiagnosticText(result.stdout.trim() || null),
      stderr: truncatePairingApproveDiagnosticText(result.stderr.trim() || null),
    })

    if (result.ok) return result

    await appendEnvCheckDiagnostic('main-pairing-approve-failed', {
      channel: String(channel || '').trim() || null,
      accountId: normalizedAccountId || null,
      maskedCode,
      code: result.code,
      canceled: result.canceled === true,
      errorCode,
      stdout: truncatePairingApproveDiagnosticText(result.stdout.trim() || null),
      stderr: truncatePairingApproveDiagnosticText(result.stderr.trim() || null),
    })

    return {
      ...result,
      errorCode: errorCode || 'unknown',
    }
  } catch (error) {
    await appendEnvCheckDiagnostic('main-pairing-approve-failed', {
      channel: String(channel || '').trim() || null,
      accountId: normalizedAccountId || null,
      maskedCode,
      code: null,
      canceled: false,
      errorCode: 'unknown',
      stdout: null,
      stderr: truncatePairingApproveDiagnosticText(error instanceof Error ? error.message : String(error || '')),
    })
    throw error
  }
}

function maskPairingApproveCode(code: string): string | null {
  const normalized = String(code || '').trim().toUpperCase()
  if (!normalized) return null
  if (normalized.length <= 4) return `${normalized[0] || '*'}***`
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`
}

function truncatePairingApproveDiagnosticText(value: string | null): string | null {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  return normalized.slice(0, 1_200)
}

function sanitizeStoreKey(input: string): string {
  const safe = input.trim().toLowerCase().replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')
  if (!safe || safe === '_') {
    throw new Error('Invalid channel/account identifier')
  }
  return safe
}

function normalizePairingSenderId(channel: string, senderId: string): string | null {
  const trimmed = senderId.trim()
  if (!trimmed) return null

  if (channel === 'feishu') {
    const matched = trimmed.match(/\bou_[a-z0-9]{8,}\b/i)
    return matched?.[0]?.toLowerCase() || null
  }

  return trimmed
}

async function resolveAllowFromStorePaths(
  channel: string,
  accountId?: string,
  options: { readOnly?: boolean } = {}
): Promise<string[]> {
  const openClawPaths = options.readOnly
    ? await getOpenClawPathsForRead()
    : await getOpenClawPaths()
  const safeChannel = sanitizeStoreKey(channel)
  const safeAccount = sanitizeStoreKey(accountId?.trim() || 'default')
  const scoped = join(openClawPaths.credentialsDir, `${safeChannel}-${safeAccount}-allowFrom.json`)

  if (safeAccount !== 'default') {
    return [scoped]
  }

  const legacy = join(openClawPaths.credentialsDir, `${safeChannel}-allowFrom.json`)
  return [scoped, legacy]
}

interface JsonRequestResult {
  ok: boolean
  status: number
  data: any
}

function resolveFeishuOpenBase(domain?: string): string {
  const normalized = String(domain || 'feishu').trim().toLowerCase()
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.replace(/\/+$/, '')
  }
  if (normalized === 'lark') {
    return 'https://open.larksuite.com'
  }
  return 'https://open.feishu.cn'
}

function requestJson(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<JsonRequestResult> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url)
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          method,
          headers,
          timeout: MAIN_RUNTIME_POLICY.cli.feishuApiTimeoutMs,
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk) => {
            raw += chunk.toString()
          })
          res.on('end', () => {
            try {
              resolve({
                ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300,
                status: res.statusCode || 500,
                data: raw ? JSON.parse(raw) : {},
              })
            } catch {
              resolve({
                ok: false,
                status: res.statusCode || 500,
                data: {},
              })
            }
          })
        }
      )
      req.on('error', () => resolve({ ok: false, status: 500, data: {} }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, status: 408, data: {} })
      })
      if (body) {
        req.write(body)
      }
      req.end()
    } catch {
      resolve({ ok: false, status: 500, data: {} })
    }
  })
}

export async function validateFeishuCredentials(
  appId: string,
  appSecret: string,
  domain?: string
): Promise<CliResult> {
  const normalizedAppId = String(appId || '').trim()
  const normalizedAppSecret = String(appSecret || '').trim()

  if (!normalizedAppId || !normalizedAppSecret) {
    return {
      ok: false,
      stdout: '',
      stderr: '请填写完整的 App ID 和 App Secret。',
      code: 1,
    }
  }

  const baseUrl = resolveFeishuOpenBase(domain)
  const tokenResp = await requestJson(
    'POST',
    `${baseUrl}/open-apis/auth/v3/app_access_token/internal`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ app_id: normalizedAppId, app_secret: normalizedAppSecret })
  )

  const appAccessToken = String(tokenResp.data?.app_access_token || '').trim()
  const feishuCode = Number(tokenResp.data?.code ?? (tokenResp.ok ? 0 : tokenResp.status || 1))
  const feishuMessage = String(tokenResp.data?.msg || tokenResp.data?.message || '').trim()

  if (tokenResp.ok && feishuCode === 0 && appAccessToken) {
    return {
      ok: true,
      stdout: '飞书凭据校验成功。',
      stderr: '',
      code: 0,
    }
  }

  let errorMessage = '无法校验飞书 App ID / App Secret，请稍后重试。'
  if (tokenResp.status === 408) {
    errorMessage = '连接飞书开放平台超时，请检查网络后重试。'
  } else if (!tokenResp.ok && tokenResp.status >= 500) {
    errorMessage = '无法连接飞书开放平台，请检查网络或稍后重试。'
  } else if (feishuCode !== 0) {
    errorMessage = feishuMessage
      ? `飞书校验失败（${feishuCode}）：${feishuMessage}。请确认 App ID / App Secret 是否正确。`
      : `飞书校验失败（${feishuCode}）。请确认 App ID / App Secret 是否正确。`
  } else if (tokenResp.ok && !appAccessToken) {
    errorMessage = '飞书开放平台没有返回可用的访问令牌，请确认 App ID / App Secret 是否正确。'
  }

  return {
    ok: false,
    stdout: '',
    stderr: errorMessage,
    code: tokenResp.status || 1,
  }
}

function isConfigSecretRefLike(
  value: unknown
): value is { source: 'env' | 'file'; provider: string; id: string } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      (value as Record<string, unknown>).source === 'env'
      || (value as Record<string, unknown>).source === 'file'
    )
    && typeof (value as Record<string, unknown>).provider === 'string'
    && typeof (value as Record<string, unknown>).id === 'string'
}

function isSecretFileModeSecure(mode: number): boolean {
  return (mode & 0o077) === 0
}

function normalizeResolvedSecretValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function resolveUserPathForConfigSecret(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2))
  }
  return resolvePath(input)
}

function getConfigSecretByJsonPointer(obj: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/' || pointer === '') return obj
  const tokens = pointer.split('/').slice(1)
  let current: unknown = obj
  for (const token of tokens) {
    const unescaped = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[unescaped]
  }
  return current
}

function hasConfiguredSecretInput(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  return isConfigSecretRefLike(value)
}

async function resolveConfiguredSecretValue(
  input: unknown,
  configOverride?: Record<string, any> | null
): Promise<string | null> {
  if (typeof input === 'string') {
    const normalized = input.trim()
    return normalized || null
  }

  if (!isConfigSecretRefLike(input)) return null

  if (input.source === 'env') {
    const envVar = String(input.id || '').trim()
    if (!envVar) return null
    const envValue = String(process.env[envVar] || '').trim()
    if (envValue) return envValue
    const envFile = await readEnvFile().catch(() => ({} as Record<string, string>))
    const fileValue = String(envFile?.[envVar] || '').trim()
    return fileValue || null
  }

  if (input.source === 'file') {
    const config = configOverride ?? (await readConfig().catch(() => null))
    const providers = config?.secrets?.providers
    const provider =
      providers && typeof providers === 'object'
        ? (providers[input.provider] as Record<string, unknown> | undefined)
        : undefined
    if (!provider || provider.source !== 'file') return null

    const filePath = String(provider.path || '').trim()
    if (!filePath) return null

    try {
      const resolvedFilePath = resolveUserPathForConfigSecret(filePath)
      const fileStat = await lstat(resolvedFilePath)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        return null
      }
      if (process.platform !== 'win32' && !isSecretFileModeSecure(fileStat.mode)) {
        return null
      }

      const raw = await readFile(resolvedFilePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (provider.mode === 'singleValue') {
        return normalizeResolvedSecretValue(parsed)
      }
      const resolved = getConfigSecretByJsonPointer(parsed, String(input.id || '').trim())
      return normalizeResolvedSecretValue(resolved)
    } catch {
      return null
    }
  }

  return null
}

export async function resolveConfigSecretValue(
  input: unknown,
  configOverride?: Record<string, any> | null
): Promise<string | null> {
  return resolveConfiguredSecretValue(input, configOverride)
}

async function resolveFeishuAccountCredentials(accountId?: string): Promise<{
  appId: string
  appSecret: string
  baseUrl: string
} | null> {
  const config = await readConfig()
  const feishu = (config?.channels?.feishu || {}) as Record<string, any>
  if (!feishu || typeof feishu !== 'object') return null

  const normalizedAccountId = String(accountId || 'default').trim() || 'default'
  const accountOverride =
    normalizedAccountId === 'default'
      ? undefined
      : (feishu.accounts?.[normalizedAccountId] as Record<string, any> | undefined)
  const merged = accountOverride ? { ...feishu, ...accountOverride } : feishu

  const appId = String(merged.appId || '').trim()
  const appSecret = await resolveConfiguredSecretValue(merged.appSecret, config)
  if (!appId || !appSecret) return null

  return {
    appId,
    appSecret,
    baseUrl: resolveFeishuOpenBase(merged.domain),
  }
}

async function resolveFeishuUserNames(
  openIds: string[],
  accountId?: string
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(openIds.map(id => id.trim()).filter(Boolean)))
  const resolved: Record<string, string> = {}
  for (const id of unique) {
    resolved[id] = id
  }

  if (unique.length === 0) return resolved

  const credentials = await resolveFeishuAccountCredentials(accountId)
  if (!credentials) return resolved

  const tokenResp = await requestJson(
    'POST',
    `${credentials.baseUrl}/open-apis/auth/v3/app_access_token/internal`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret })
  )
  const appAccessToken = tokenResp.data?.app_access_token
  if (!tokenResp.ok || tokenResp.data?.code !== 0 || !appAccessToken) {
    return resolved
  }

  for (const openId of unique) {
    const userResp = await requestJson(
      'GET',
      `${credentials.baseUrl}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      { Authorization: `Bearer ${appAccessToken}` }
    )
    if (!userResp.ok || userResp.data?.code !== 0) continue
    const user = userResp.data?.data?.user || {}
    const name = String(user.name || user.en_name || user.nickname || '').trim()
    if (name) {
      resolved[openId] = name
    }
  }

  return resolved
}

async function readAllowFromStore(pathname: string): Promise<string[]> {
  try {
    const raw = await readFile(pathname, 'utf-8')
    const parsed = JSON.parse(raw) as { allowFrom?: unknown }
    if (!Array.isArray(parsed.allowFrom)) return []
    return parsed.allowFrom.map(v => String(v || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function writeAllowFromStore(pathname: string, allowFrom: string[]): Promise<void> {
  const openClawPaths = await getOpenClawPaths()
  await mkdir(openClawPaths.credentialsDir, { recursive: true })
  await atomicWriteJson(
    pathname,
    { version: 1, allowFrom },
    {
      description: '配对 allowFrom 配置',
      mode: 0o600,
    }
  )
}

interface AllowFromStoreChange {
  path: string
  previous: string[]
}

interface UpdateAllowFromStoreResult {
  changed: boolean
  changes: AllowFromStoreChange[]
}

async function updateAllowFromStore(
  channel: string,
  senderId: string,
  mode: 'add' | 'remove',
  accountId?: string
): Promise<UpdateAllowFromStoreResult> {
  const targets = await resolveAllowFromStorePaths(channel, accountId)
  const changes: AllowFromStoreChange[] = []

  for (const target of targets) {
    const current = await readAllowFromStore(target)
    const hasSender = current.includes(senderId)
    if (mode === 'add' && hasSender) continue
    if (mode === 'remove' && !hasSender) continue

    const next =
      mode === 'add'
        ? [...current, senderId]
        : current.filter(item => item !== senderId)
    await writeAllowFromStore(target, next)
    changes.push({
      path: target,
      previous: current,
    })
  }

  return {
    changed: changes.length > 0,
    changes,
  }
}

async function rollbackAllowFromStore(changes: AllowFromStoreChange[]): Promise<{ ok: boolean; failedPaths: string[] }> {
  const failedPaths: string[] = []
  for (const change of [...changes].reverse()) {
    try {
      await writeAllowFromStore(change.path, change.previous)
    } catch {
      failedPaths.push(change.path)
    }
  }
  return {
    ok: failedPaths.length === 0,
    failedPaths,
  }
}

async function syncPairingAllowFromConfig(
  channel: string,
  senderId: string,
  mode: 'add' | 'remove',
  accountId?: string
): Promise<{ ok: boolean; changed: boolean; targetMissing: boolean; warning?: string; error?: string }> {
  try {
    const beforeConfig = await readConfig()
    if (!beforeConfig || typeof beforeConfig !== 'object') {
      return {
        ok: true,
        changed: false,
        targetMissing: true,
        warning: 'OpenClaw 配置文件不存在，仅写入配对缓存 allowFrom。',
      }
    }

    const nextConfig = JSON.parse(JSON.stringify(beforeConfig)) as Record<string, any>
    const mutation = mutatePairingAllowFromInConfig(nextConfig, channel, senderId, mode, {
      accountId,
      normalizeSenderId: normalizePairingSenderId,
    })
    if (mutation.targetMissing) {
      return {
        ok: true,
        changed: false,
        targetMissing: true,
        warning: '未找到对应渠道账号配置，仅写入配对缓存 allowFrom。',
      }
    }
    if (!mutation.changed) {
      return {
        ok: true,
        changed: false,
        targetMissing: false,
      }
    }

    const { applyConfigPatchGuarded } = await import('./openclaw-config-coordinator')
    const writeResult = await applyConfigPatchGuarded({
      beforeConfig,
      afterConfig: nextConfig,
      reason: 'pairing-allowfrom-sync',
    })
    if (!writeResult.ok) {
      return {
        ok: false,
        changed: true,
        targetMissing: false,
        error:
          writeResult.message ||
          'allowFrom 配置同步失败，请稍后重试。',
      }
    }

    return {
      ok: true,
      changed: Boolean(writeResult.wrote),
      targetMissing: false,
    }
  } catch (err) {
    return {
      ok: false,
      changed: false,
      targetMissing: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function collectPairingAllowFromUsers(
  channel: string,
  accountId?: string
): Promise<Set<string>> {
  const normalizedChannel = sanitizeStoreKey(channel)
  const users = new Set<string>()

  const targets = await resolveAllowFromStorePaths(normalizedChannel, accountId, {
    readOnly: true,
  })
  for (const target of targets) {
    const allowFrom = await readAllowFromStore(target)
    for (const user of allowFrom) {
      const normalizedUser = normalizePairingSenderId(normalizedChannel, user)
      if (normalizedUser) users.add(normalizedUser)
    }
  }

  const config = await readConfig()
  const configTarget = resolvePairingConfigTarget(config, normalizedChannel, accountId)
  const configAllowFrom = normalizePairingAllowFromList(
    normalizedChannel,
    configTarget?.allowFrom,
    normalizePairingSenderId
  )
  for (const user of configAllowFrom) {
    users.add(user)
  }

  return users
}

/**
 * Manual pairing fallback for multi-instance setup:
 * directly trust sender id in allowFrom store + active runtime config.
 */
export async function pairingAddAllowFrom(
  channel: string,
  senderId: string,
  accountId?: string
): Promise<CliResult> {
  try {
    const normalizedChannel = sanitizeStoreKey(channel)
    const normalizedSenderId = normalizePairingSenderId(normalizedChannel, senderId)
    if (!normalizedSenderId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Invalid sender id for channel ${normalizedChannel}`,
        code: 1,
      }
    }

    const storeUpdate = await updateAllowFromStore(
      normalizedChannel,
      normalizedSenderId,
      'add',
      accountId
    )

    const configSync = await syncPairingAllowFromConfig(
      normalizedChannel,
      normalizedSenderId,
      'add',
      accountId
    )
    if (!configSync.ok) {
      let rollbackNote = ''
      if (storeUpdate.changed) {
        const rollback = await rollbackAllowFromStore(storeUpdate.changes)
        if (!rollback.ok) {
          rollbackNote = `；且回滚 store 失败: ${rollback.failedPaths.join(', ')}`
        } else {
          rollbackNote = '；已回滚本次 store 写入'
        }
      }
      return {
        ok: false,
        stdout: '',
        stderr:
          (configSync.error || `Failed to sync allowFrom to runtime config (${normalizedChannel})`) + rollbackNote,
        code: 1,
      }
    }
    const syncNote = configSync.warning ? ` (${configSync.warning})` : ''

    return {
      ok: true,
      stdout: storeUpdate.changed || configSync.changed
        ? `Added ${normalizedSenderId} to allowFrom (${normalizedChannel})${syncNote}`
        : `${normalizedSenderId} already exists in allowFrom (${normalizedChannel})${syncNote}`,
      stderr: '',
      code: 0,
    }
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    }
  }
}

export async function pairingFeishuStatus(
  accountIds: string[]
): Promise<Record<string, { pairedCount: number; pairedUsers: string[] }>> {
  const status: Record<string, { pairedCount: number; pairedUsers: string[] }> = {}
  const normalized = Array.from(
    new Set(
      accountIds
        .map(id => String(id || '').trim())
        .filter(Boolean)
        .map(id => (id === 'default' ? 'default' : sanitizeStoreKey(id)))
    )
  )

  for (const accountId of normalized) {
    const users = await collectPairingAllowFromUsers(
      'feishu',
      accountId === 'default' ? undefined : accountId
    )

    status[accountId] = {
      pairedCount: users.size,
      pairedUsers: Array.from(users),
    }
  }

  return status
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getManagedFeishuAgentId(accountId: string): string {
  return `feishu-${accountId === 'default' ? 'default' : sanitizeStoreKey(accountId)}`
}

function getManagedFeishuWorkspace(accountId: string): string {
  return `~/.openclaw/workspace-feishu-${accountId === 'default' ? 'default' : sanitizeStoreKey(accountId)}`
}

export async function getFeishuBotRuntimeStatuses(): Promise<Record<string, FeishuBotRuntimeStatus>> {
  const config = await readConfig()
  const gateway = await gatewayHealth().catch(() => ({ running: false } as GatewayHealthCheckResult))
  const feishu = config?.channels?.feishu as Record<string, any> | undefined
  const agents = Array.isArray(config?.agents?.list) ? config?.agents?.list : []
  const bindings = Array.isArray(config?.bindings) ? config?.bindings : []
  const pluginConfigured = Array.isArray(config?.plugins?.allow)
    ? config?.plugins?.allow.some((item: unknown) => String(item || '').trim() === 'openclaw-lark')
    : false
  const dmScopeCorrect = normalizeText(config?.session?.dmScope) === 'per-account-channel-peer'

  const bots: Array<{ accountId: string; enabled: boolean; credentialsComplete: boolean }> = []
  if (feishu && typeof feishu === 'object') {
    const defaultCredentialsComplete = Boolean(normalizeText(feishu.appId) && hasConfiguredSecretInput(feishu.appSecret))
    if (defaultCredentialsComplete) {
      bots.push({
        accountId: 'default',
        enabled: feishu.enabled !== false,
        credentialsComplete: defaultCredentialsComplete,
      })
    }

    const accounts = feishu.accounts as Record<string, any> | undefined
    if (accounts && typeof accounts === 'object') {
      for (const [accountId, rawAccount] of Object.entries(accounts)) {
        const account = rawAccount as Record<string, any>
        const credentialsComplete = Boolean(normalizeText(account.appId) && hasConfiguredSecretInput(account.appSecret))
        if (!credentialsComplete) continue
        bots.push({
          accountId,
          enabled: account.enabled !== false,
          credentialsComplete,
        })
      }
    }
  }

  const result: Record<string, FeishuBotRuntimeStatus> = {}
  for (const bot of bots) {
    const agentId = getManagedFeishuAgentId(bot.accountId)
    const workspace = getManagedFeishuWorkspace(bot.accountId)
    const issues: string[] = []
    const managedAgent = agents.find((agent: any) => normalizeText(agent?.id) === agentId)
    const matchingBindings = bindings.filter(
      (binding: any) =>
        normalizeText(binding?.match?.channel) === 'feishu' &&
        normalizeText(binding?.match?.accountId) === bot.accountId
    )

    if (!bot.enabled) {
      issues.push('该机器人当前被禁用。')
    }
    if (!bot.credentialsComplete) {
      issues.push('缺少完整的 App ID / App Secret。')
    }
    if (!pluginConfigured) {
      issues.push('openclaw-lark 插件未在配置中启用。')
    }
    if (!dmScopeCorrect) {
      issues.push('session.dmScope 不是 per-account-channel-peer。')
    }
    if (!managedAgent) {
      issues.push(`缺少托管 Agent：${agentId}。`)
    } else if (normalizeText(managedAgent.workspace) !== workspace) {
      issues.push(`Agent workspace 未隔离到 ${workspace}。`)
    }
    if (!matchingBindings.some((binding: any) => normalizeText(binding?.agentId) === agentId)) {
      issues.push(`缺少 accountId=${bot.accountId} 的路由绑定。`)
    }
    if (matchingBindings.some((binding: any) => normalizeText(binding?.agentId) !== agentId)) {
      issues.push(`检测到 accountId=${bot.accountId} 的冲突绑定。`)
    }
    if (!gateway.running) {
      issues.push('网关当前未运行。')
    }

    let runtimeState: FeishuBotRuntimeStatus['runtimeState'] = 'online'
    let summary = '运行中'
    if (!bot.enabled) {
      runtimeState = 'disabled'
      summary = '已禁用'
    } else if (!gateway.running) {
      runtimeState = 'offline'
      summary = '网关未运行'
    } else if (issues.length > 0) {
      runtimeState = 'degraded'
      summary = issues[0] || '配置存在漂移'
    }

    result[bot.accountId] = {
      accountId: bot.accountId,
      agentId,
      workspace,
      enabled: bot.enabled,
      credentialsComplete: bot.credentialsComplete,
      gatewayRunning: Boolean(gateway.running),
      runtimeState,
      summary,
      issues,
    }
  }

  return result
}

export async function pairingFeishuAccounts(
  accountId?: string
): Promise<Array<{ openId: string; name: string }>> {
  const normalizedAccountId = String(accountId || 'default').trim() || 'default'
  const users = await collectPairingAllowFromUsers(
    'feishu',
    normalizedAccountId === 'default' ? undefined : normalizedAccountId
  )

  const openIds = Array.from(users).sort()
  const names = await resolveFeishuUserNames(openIds, normalizedAccountId)
  return openIds.map(openId => ({ openId, name: names[openId] || openId }))
}

export async function pairingAllowFromUsers(
  channel: string,
  accountId?: string
): Promise<Array<{ senderId: string; displayName: string }>> {
  const normalizedChannel = sanitizeStoreKey(channel)
  const normalizedAccountId = String(accountId || '').trim()
  const users = await collectPairingAllowFromUsers(
    normalizedChannel,
    normalizedAccountId || undefined
  )
  const senderIds = Array.from(users).sort((left, right) => left.localeCompare(right, 'zh-CN'))

  return senderIds.map((senderId) => ({
    senderId,
    displayName: senderId,
  }))
}

export async function pairingRemoveAllowFrom(
  channel: string,
  senderId: string,
  accountId?: string
): Promise<CliResult> {
  try {
    const normalizedChannel = sanitizeStoreKey(channel)
    const normalizedSenderId = normalizePairingSenderId(normalizedChannel, senderId)
    if (!normalizedSenderId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Invalid sender id for channel ${normalizedChannel}`,
        code: 1,
      }
    }

    const storeUpdate = await updateAllowFromStore(
      normalizedChannel,
      normalizedSenderId,
      'remove',
      accountId
    )

    const configSync = await syncPairingAllowFromConfig(
      normalizedChannel,
      normalizedSenderId,
      'remove',
      accountId
    )
    if (!configSync.ok) {
      let rollbackNote = ''
      if (storeUpdate.changed) {
        const rollback = await rollbackAllowFromStore(storeUpdate.changes)
        if (!rollback.ok) {
          rollbackNote = `；且回滚 store 失败: ${rollback.failedPaths.join(', ')}`
        } else {
          rollbackNote = '；已回滚本次 store 写入'
        }
      }
      return {
        ok: false,
        stdout: '',
        stderr:
          (configSync.error || `Failed to sync allowFrom removal to runtime config (${normalizedChannel})`) +
          rollbackNote,
        code: 1,
      }
    }
    const syncNote = configSync.warning ? ` (${configSync.warning})` : ''

    return {
      ok: true,
      stdout: storeUpdate.changed || configSync.changed
        ? `Removed ${normalizedSenderId} from allowFrom (${normalizedChannel})${syncNote}`
        : `${normalizedSenderId} not found in allowFrom (${normalizedChannel})${syncNote}`,
      stderr: '',
      code: 0,
    }
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    }
  }
}

/** Install a plugin: openclaw plugins install <name> */
export async function installPlugin(name: string, expectedPluginIds: string[] = []): Promise<CliResult> {
  const npmEnv = await createPluginInstallNpmEnv()
  try {
    const result = await runCliStreaming(['plugins', 'install', name], {
      timeout: MAIN_RUNTIME_POLICY.cli.pluginInstallTimeoutMs,
      controlDomain: 'plugin-install',
      env: npmEnv.env,
    })
    const annotated = await annotatePluginPermissionFailure(result)
    return finalizePluginInstallResult(annotated, expectedPluginIds)
  } finally {
    await cleanupIsolatedNpmCacheEnv(npmEnv.cacheDir)
  }
}

/** Uninstall a plugin: openclaw plugins uninstall <name> */
export async function uninstallPlugin(name: string): Promise<CliResult> {
  return runCli(
    ['plugins', 'uninstall', name],
    MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
    'plugin-install'
  )
}

export async function isPluginInstalledOnDisk(pluginId: string): Promise<boolean> {
  const normalizedPluginId = String(pluginId || '').trim()
  if (!normalizedPluginId) return false

  const openClawPaths = await getOpenClawPathsForRead().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (!homeDir) return false

  const pluginRoot = join(homeDir, 'extensions', normalizedPluginId)
  for (const manifestName of ['openclaw.plugin.json', 'package.json']) {
    try {
      await access(join(pluginRoot, manifestName))
      return true
    } catch {
      // Ignore missing manifests and continue probing fallbacks.
    }
  }

  return false
}

/** Add a channel via CLI: openclaw channels add --channel <name> --token <token> */
export async function channelsAdd(channel: string, token: string): Promise<CliResult> {
  return runCli(
    ['channels', 'add', '--channel', channel, '--token', token],
    MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
    'config-write'
  )
}

/** Install plugin via npx (for official plugins like feishu) */
export async function installPluginNpx(
  url: string,
  expectedPluginIds: string[] = []
): Promise<CliResult> {
  const capabilityError = await guardPlatformCommands(['npx'])
  if (capabilityError) return capabilityError
  const runNpxInstall = async (args: string[], registryUrl?: string | null) => {
    const npmEnv = await createPluginInstallNpmEnv()
    try {
      return await runShell(
        'npx',
        args,
        MAIN_RUNTIME_POLICY.cli.pluginInstallNpxTimeoutMs,
        {
          controlDomain: 'plugin-install',
          env: {
            ...npmEnv.env,
            ...(String(registryUrl || '').trim()
              ? {
                  npm_config_registry: String(registryUrl || '').trim(),
                  NPM_CONFIG_REGISTRY: String(registryUrl || '').trim(),
                }
              : {}),
          },
        }
      )
    } finally {
      await cleanupIsolatedNpmCacheEnv(npmEnv.cacheDir)
    }
  }
  const runNpxInstallWithMirrorFallback = (baseArgs: string[]) =>
    runOpenClawNpmRegistryFallback((mirror) =>
      runNpxInstall(baseArgs, mirror.registryUrl)
    )

  if (!shouldTryLegacySkipConfig(url)) {
    const { result, attempts } = await runNpxInstallWithMirrorFallback(['-y', url, 'install'])
    const annotated = attachNpmRegistryAttempts(await annotatePluginPermissionFailure(result), attempts)
    return finalizePluginInstallResult(annotated, expectedPluginIds)
  }

  const legacySkipConfigResult = await runNpxInstallWithMirrorFallback(['-y', url, 'install', '--skip-config'])

  if (legacySkipConfigResult.result.ok) {
    const annotated = attachNpmRegistryAttempts(
      await annotatePluginPermissionFailure(legacySkipConfigResult.result),
      legacySkipConfigResult.attempts
    )
    return finalizePluginInstallResult(annotated, expectedPluginIds)
  }

  if (!legacySkipConfigResult.result.ok) {
    const hasUnsupportedSkipConfigAttempt = legacySkipConfigResult.attempts.some((attempt) =>
      isSkipConfigUnsupportedError(attempt.result)
    )
    if (!hasUnsupportedSkipConfigAttempt) {
      return attachNpmRegistryAttempts(
        await annotatePluginPermissionFailure(legacySkipConfigResult.result),
        legacySkipConfigResult.attempts
      )
    }
  }

  const fallbackResult = await runNpxInstallWithMirrorFallback(['-y', url, 'install'])
  const annotated = attachNpmRegistryAttempts(
    await annotatePluginPermissionFailure(fallbackResult.result),
    fallbackResult.attempts
  )
  return finalizePluginInstallResult(annotated, expectedPluginIds)
}

/** Open OpenClaw dashboard in browser */
export async function openDashboard(): Promise<CliResult> {
  return runCli(['dashboard'], MAIN_RUNTIME_POLICY.cli.dashboardLaunchTimeoutMs, 'gateway')
}

// ─── Uninstall All ───

async function cleanManagedShellConfig(): Promise<void> {
  const shellConfigs = resolveShellInitFiles({
    homeDir: homedir(),
    platform: process.platform,
    shellPath: process.env.SHELL || userInfo().shell || undefined,
    env: process.env,
  })

  for (const configPath of shellConfigs) {
    try {
      const content = await readFile(configPath, 'utf-8')
      const result = stripManagedShellBlocks(content)
      if (result.changed) {
        await writeFile(configPath, result.content, 'utf-8')
      }
    } catch {
      // 文件不存在或无法读取，忽略
    }
  }
}

async function uninstallLaunchAgentFallback(): Promise<void> {
  const launchctlCapability = await probePlatformCommandCapability('launchctl', {
    platform: process.platform,
    env: buildCommandCapabilityEnv(),
  })
  if (!launchctlCapability.available) return

  const cleanupPlan = resolveLaunchAgentCleanupPlan({
    homeDir: homedir(),
    platform: process.platform,
    env: process.env,
  })
  if (cleanupPlan.labels.length === 0 && cleanupPlan.plistPaths.length === 0) return

  const currentUser = userInfo()
  if (typeof currentUser.uid === 'number' && currentUser.uid >= 0) {
    for (const plistPath of cleanupPlan.plistPaths) {
      try {
        await runDirect(
          'launchctl',
          ['bootout', `gui/${currentUser.uid}`, plistPath],
          MAIN_RUNTIME_POLICY.cli.launchctlTimeoutMs,
          'upgrade'
        )
      } catch {
        // 忽略，可能并未通过 bootout 域加载
      }
    }
  }

  for (const label of cleanupPlan.labels) {
    try {
      await runDirect('launchctl', ['remove', label], MAIN_RUNTIME_POLICY.cli.launchctlTimeoutMs, 'upgrade')
    } catch {
      // 忽略，可能服务不存在
    }
  }

  for (const plistPath of cleanupPlan.plistPaths) {
    try {
      await unlink(plistPath)
    } catch {
      // 文件可能不存在
    }
  }
}

interface CleanupOpenClawStateOptions {
  stateRootOverride?: string
  displayStateRootOverride?: string
  targetedStateCleanup?: boolean
}

export async function cleanupOpenClawStateAndData(
  options: CleanupOpenClawStateOptions = {}
): Promise<CliResult> {
  const errors: string[] = []
  const openClawPaths = await getOpenClawPaths()
  const targetHomeDir = String(options.stateRootOverride || openClawPaths.homeDir || '').trim()
  const targetDisplayHomeDir = String(
    options.displayStateRootOverride || openClawPaths.displayHomeDir || targetHomeDir
  ).trim()
  const targetedStateCleanup = options.targetedStateCleanup === true

  if (!targetHomeDir) {
    return {
      ok: false,
      stdout: '',
      stderr: '未提供可清理的 OpenClaw 状态目录路径',
      code: 1,
    }
  }

  // 1. 停止 Gateway
  try {
    await runCli(['gateway', 'stop'], MAIN_RUNTIME_POLICY.cli.gatewayStopTimeoutMs, 'upgrade')
  } catch {
    // 忽略，可能没在运行
  }

  const uninstallStateResult = targetedStateCleanup
    ? {
        ok: false,
        stdout: '',
        stderr: 'Skipped official uninstall command in targeted state cleanup mode',
        code: 1,
      }
    : await runCli(
        buildOpenClawStateUninstallArgs(),
        MAIN_RUNTIME_POLICY.cli.stateUninstallTimeoutMs,
        'upgrade'
      ).catch(() => ({
        ok: false,
        stdout: '',
        stderr: 'OpenClaw official uninstall command failed',
        code: 1,
      }))
  const officialStateCleanupSucceeded = uninstallStateResult.ok

  if (isWin) {
    if (!officialStateCleanupSucceeded) {
      // 旧版 OpenClaw 无官方 uninstall 时，回退到本地目录删除
      const rmOpenclaw = await runShell(
        'cmd',
        ['/c', 'rmdir', '/s', '/q', targetHomeDir],
        MAIN_RUNTIME_POLICY.cli.removeHomeDirTimeoutMs,
        'upgrade'
      )
      if (!rmOpenclaw.ok) {
        errors.push(`删除 ${targetDisplayHomeDir} 失败: ${rmOpenclaw.stderr}`)
      }
    }
  } else {
    if (!officialStateCleanupSucceeded) {
      const gatewayUninstallResult = await runCli(
        buildOpenClawGatewayUninstallArgs(),
        MAIN_RUNTIME_POLICY.cli.gatewayUninstallTimeoutMs,
        'upgrade'
      ).catch(() => ({
        ok: false,
        stdout: '',
        stderr: 'OpenClaw gateway uninstall command failed',
        code: 1,
      }))

      if (!gatewayUninstallResult.ok) {
        await uninstallLaunchAgentFallback()
      }

      const rmCapability = await guardPlatformCommands(['rm'])
      if (rmCapability) {
        errors.push(`删除 ${targetDisplayHomeDir} 失败: ${rmCapability.stderr}`)
      } else {
        const rmOpenclaw = await runShell(
          'rm',
          ['-rf', targetHomeDir],
          MAIN_RUNTIME_POLICY.cli.removeHomeDirTimeoutMs,
          'upgrade'
        )
        if (!rmOpenclaw.ok) {
          errors.push(`删除 ${targetDisplayHomeDir} 失败: ${rmOpenclaw.stderr}`)
        }
      }
    }

    // shell 配置只删除带有本应用标记的块，避免误删用户自定义行
    try {
      await cleanManagedShellConfig()
    } catch {
      // 忽略清理失败
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      stdout: '',
      stderr: errors.join('\n'),
      code: 1
    }
  }

  return {
    ok: true,
    stdout: '卸载完成',
      stderr: '',
      code: 0
    }
}

/** 卸载 OpenClaw（保留 Node.js） */
export async function uninstallAll(): Promise<CliResult> {
  const errors: string[] = []
  const stateCleanupResult = await cleanupOpenClawStateAndData()
  if (!stateCleanupResult.ok && stateCleanupResult.stderr.trim()) {
    errors.push(stateCleanupResult.stderr.trim())
  }

  const packageRemovalResult = await uninstallOpenClawNpmGlobalPackage()
  if (!packageRemovalResult.ok && packageRemovalResult.stderr.trim()) {
    errors.push(packageRemovalResult.stderr.trim())
  }

  if (errors.length > 0) {
    return {
      ok: false,
      stdout: '',
      stderr: errors.join('\n'),
      code: 1,
    }
  }

  return {
    ok: true,
    stdout: '卸载完成',
    stderr: '',
    code: 0,
  }
}

async function resolveManagedOpenClawUninstallBinaryPath(options: {
  npmCommandOptions: OpenClawNpmCommandOptions
  workingDirectory: string
}): Promise<string> {
  const prefixResult = await runShell(
    'npm',
    buildOpenClawConfigGetPrefixArgs(options.npmCommandOptions),
    MAIN_RUNTIME_POLICY.cli.defaultShellTimeoutMs,
    {
      controlDomain: 'upgrade',
      cwd: options.workingDirectory,
    }
  )
  const npmPrefix = extractFirstNonEmptyLine(prefixResult.stdout)
  if (!prefixResult.ok || !npmPrefix || npmPrefix === 'undefined' || npmPrefix === 'null') {
    return ''
  }

  return resolveOpenClawBinaryPathFromNpmPrefix({
    npmPrefix,
  })
}

export async function uninstallOpenClawNpmGlobalPackage(): Promise<CliResult> {
  const errors: string[] = []

  if (isWin) {
    const uninstallCapability = await guardPlatformCommands(['npm'])
    if (uninstallCapability) {
      errors.push(`卸载 OpenClaw 命令行工具失败: ${uninstallCapability.stderr}`)
    } else {
      const uninstallResult = await runShell(
        'npm',
        ['uninstall', '-g', 'openclaw'],
        MAIN_RUNTIME_POLICY.cli.npmUninstallTimeoutMs,
        'upgrade'
      )
      if (!uninstallResult.ok && !uninstallResult.stderr.includes('not installed')) {
        errors.push(`卸载 OpenClaw 命令行工具失败: ${uninstallResult.stderr}`)
      }
    }
  } else {
    const uninstallCapability = await guardPlatformCommands(['osascript', 'npm'])
    if (uninstallCapability) {
      errors.push(`卸载 OpenClaw 命令行工具失败: ${uninstallCapability.stderr}`)
    } else {
      const uninstallWorkingDirectory = resolveManagedSpawnCwd()
      let uninstallNpmOptions: OpenClawNpmCommandOptions | null = null
      try {
        uninstallNpmOptions = (
          await ensureManagedOpenClawNpmRuntime({
            workingDirectory: uninstallWorkingDirectory,
          })
        ).commandOptions
      } catch (error) {
        errors.push(
          `卸载 OpenClaw 命令行工具失败: 无法初始化安装隔离环境。${
            error instanceof Error ? error.message : String(error || '')
          }`
        )
      }

      if (uninstallNpmOptions) {
        const privilegedUninstallNpmOptions = createPrivilegedOpenClawNpmCommandOptions(
          uninstallNpmOptions
        )
        const uninstallBinaryPath =
          (await resolveManagedOpenClawUninstallBinaryPath({
            npmCommandOptions: privilegedUninstallNpmOptions,
            workingDirectory: uninstallWorkingDirectory,
          }).catch(() => '')) || (await resolveOpenClawBinaryPath().catch(() => ''))
        const uninstallPaths = await resolveRuntimeOpenClawPaths({
          binaryPath: uninstallBinaryPath || undefined,
          cacheTtlMs: 0,
        }).catch(() => null)
        const cmd = buildMacNpmCommand(buildOpenClawUninstallArgs(privilegedUninstallNpmOptions), {
          detectedBinDir: detectedNodeBinDir,
          fixCacheOwnership: false,
          workingDirectory: uninstallWorkingDirectory,
        })

        const uninstallResult = await runMacOpenClawElevatedLifecycleTransaction({
          operation: 'uninstall',
          lifecycleCommand: cmd,
          prompt: 'Qclaw 需要卸载 OpenClaw 命令行工具。\n\n请输入您的 Mac 登录密码以继续。',
          timeoutMs: MAIN_RUNTIME_POLICY.cli.npmUninstallTimeoutMs,
          controlDomain: 'upgrade',
          binaryPath: uninstallBinaryPath || undefined,
          preferredStateRootPath: String(uninstallPaths?.homeDir || '').trim() || undefined,
          qclawSafeWorkDir: uninstallWorkingDirectory,
          includeManagedInstallerRoot: true,
          runDirect,
        })

        if (!uninstallResult.ok && !uninstallResult.stderr.includes('not installed')) {
          errors.push(`卸载 OpenClaw 命令行工具失败: ${uninstallResult.stderr}`)
        }
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      stdout: '',
      stderr: errors.join('\n'),
      code: 1,
    }
  }

  return {
    ok: true,
    stdout: '卸载完成',
    stderr: '',
    code: 0,
  }
}

/** 检查 OAuth 是否完成（通过 models status --json 检测 provider 状态） */
export async function checkOAuthComplete(providerKey: string): Promise<boolean> {
  try {
    const { getModelStatus } = await import('./openclaw-model-config')
    const result = await getModelStatus()
    if (!result.ok) return false
    return isProviderConfiguredInStatus(result.data as Record<string, any> | undefined, providerKey)
  } catch {
    return false
  }
}

// ─── Command Control ───

/**
 * 刷新环境变量，让新安装的程序可以被检测到
 */
export async function refreshEnvironment(): Promise<{ ok: boolean; newPath?: string }> {
  const platform = process.platform

  try {
    const commitPath = (newPath: string) => {
      process.env.PATH = newPath
      clearSelectedWindowsRuntimeSnapshot()
      resetCommandCapabilityCache()
      resetRuntimeOpenClawPathsCache()
      return { ok: true, newPath }
    }

    if (platform === 'win32') {
      const powershellCapability = await probePlatformCommandCapability('powershell', {
        platform,
        env: buildCommandCapabilityEnv(),
      })
      if (!powershellCapability.available) {
        return commitPath(buildCliPathWithCandidates({
          platform,
          currentPath: process.env.PATH || '',
          detectedNodeBinDir,
          env: process.env,
        }))
      }

      // Windows: 从注册表读取最新 PATH 并更新当前进程的环境变量
      const result = await runShell('powershell', [
        '-NoProfile',
        '-Command',
        '[System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")'
      ], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs, 'env')
      if (result.ok && result.stdout.trim()) {
        return commitPath(result.stdout.trim())
      }
      return commitPath(buildCliPathWithCandidates({
        platform,
        currentPath: process.env.PATH || '',
        detectedNodeBinDir,
        env: process.env,
      }))
    } else {
      // macOS/Linux: 先复用当前已探测到的 Node，再回退到 nvm/常见路径。
      const nvmDir = await detectNvmDir()
      if (detectedNodeBinDir) {
        try {
          await access(join(detectedNodeBinDir, 'node'))
          return commitPath(buildCliPathWithCandidates({
            platform,
            currentPath: process.env.PATH || '',
            detectedNodeBinDir,
            env: process.env,
          }))
        } catch {
          // Fall through to rediscover the runtime below.
        }
      }

      if (nvmDir) {
        const nvmNode = await resolveNodeFromInstalledNvmVersions(nvmDir)
        if (nvmNode?.binDir) {
          rememberDetectedNodeBinDir(nvmNode.binDir)
          return commitPath(buildCliPathWithCandidates({
            platform,
            currentPath: process.env.PATH || '',
            detectedNodeBinDir,
            env: process.env,
          }))
        }
      }

      // 非 nvm 或 nvm 解析失败：优先解析当前可执行 node 的真实路径，再回退到常见安装位置
      const shellNodeResult = await runShell(
        'node',
        ['-p', 'process.execPath'],
        MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
        'env'
      )
      const shellNodeBinDir = shellNodeResult.ok ? extractNodeBinDir(shellNodeResult.stdout) : null
      if (shellNodeBinDir) {
        rememberDetectedNodeBinDir(shellNodeBinDir)
        return commitPath(buildCliPathWithCandidates({
          platform,
          currentPath: process.env.PATH || '',
          detectedNodeBinDir,
          env: process.env,
        }))
      }

      for (const nodePath of listNodeExecutableCandidates(platform, process.env.PATH || '', detectedNodeBinDir)) {
        try {
          await access(nodePath)
          rememberDetectedNodeBinDir(dirname(nodePath))
          return commitPath(buildCliPathWithCandidates({
            platform,
            currentPath: process.env.PATH || '',
            detectedNodeBinDir,
            env: process.env,
          }))
        } catch {
          // 继续尝试下一个路径
        }
      }

      rememberDetectedNodeBinDir(null)
      return commitPath(buildCliPathWithCandidates({
        platform,
        currentPath: process.env.PATH || '',
        detectedNodeBinDir,
        env: process.env,
      }))
    }
  } catch (error) {
    return { ok: false }
  }
}

function buildCommandReadyError(commandLabel: string, readiness: { stderr?: string }): string {
  const detail = String(readiness.stderr || '').trim()
  return detail ? `${commandLabel} 安装完成后仍不可用: ${detail}` : `${commandLabel} 安装完成后仍不可用`
}

async function finalizeInstallResult(
  installResult: CliResult,
  expectations: {
    expectNode: boolean
    expectOpenClaw: boolean
  }
): Promise<CliResult> {
  if (!installResult.ok) {
    return installResult
  }

  if (process.platform === 'win32' && expectations.expectOpenClaw) {
    await writeWindowsManagedOpenClawRuntimeMarker().catch(() => undefined)
  }

  await refreshEnvironment().catch(() => ({ ok: false }))

  const readinessErrors: string[] = []
  if (expectations.expectNode) {
    const nodeReady = await waitForCommandAvailable('node', ['--version'], undefined, undefined, 'env-setup')
    if (!nodeReady.ok) {
      readinessErrors.push(buildCommandReadyError('Node.js', nodeReady))
    }
  }

  if (expectations.expectOpenClaw) {
    const openClawReady = await waitForCommandAvailable(
      'openclaw',
      ['--version'],
      undefined,
      undefined,
      'env-setup'
    )
    if (!openClawReady.ok) {
      readinessErrors.push(buildCommandReadyError('OpenClaw 命令行工具', openClawReady))
    }
  }

  if (readinessErrors.length === 0) {
    return installResult
  }

  return {
    ok: false,
    stdout: installResult.stdout,
    stderr: [String(installResult.stderr || '').trim(), ...readinessErrors].filter(Boolean).join('\n'),
    code: installResult.code ?? 1,
  }
}

/**
 * 等待命令在 PATH 中可用（用于安装后检测）
 */
export async function waitForCommandAvailable(
  command: string,
  args: string[] = ['--version'],
  maxWait = MAIN_RUNTIME_POLICY.commandAvailability.timeoutMs,
  interval = MAIN_RUNTIME_POLICY.commandAvailability.initialIntervalMs,
  controlDomain: CommandControlDomain = 'global'
): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  const result = await pollWithBackoff({
    policy: {
      timeoutMs: maxWait,
      initialIntervalMs: interval,
      maxIntervalMs: Math.max(interval, MAIN_RUNTIME_POLICY.commandAvailability.maxIntervalMs),
      backoffFactor: MAIN_RUNTIME_POLICY.commandAvailability.backoffFactor,
    },
    execute: async () => {
      try {
        return await runShell(command, args, MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs, {
          controlDomain,
          shell: false,
        })
      } catch {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          code: null,
        } satisfies CliResult
      }
    },
    isSuccess: (value) => value.ok,
  })

  if (result.ok && result.value) {
    return {
      ok: true,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
    }
  }

  return { ok: false, stderr: `命令 ${command} 在 ${maxWait}ms 内未可用` }
}

/**
 * 取消当前活跃的命令
 */
export async function cancelActiveCommand(domain: CommandControlDomain = 'global'): Promise<boolean> {
  return cancelTrackedProcess(domain)
}

export async function cancelActiveCommands(
  domains: CommandControlDomain[]
): Promise<CancelActiveProcessesResult> {
  return cancelTrackedProcesses(domains)
}

/**
 * 设置活跃的进程（用于后续取消）
 */
export function setActiveProcess(proc: ChildProcess | null, domain: CommandControlDomain = 'global'): void {
  trackActiveProcess(proc, domain)
}

/**
 * 设置活跃的 AbortController（用于后续取消）
 */
export function setActiveAbortController(
  controller: AbortController | null,
  domain: CommandControlDomain = 'global'
): void {
  trackActiveAbortController(controller, domain)
}
