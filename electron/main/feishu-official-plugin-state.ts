import {
  applyFeishuMultiBotIsolation,
  extractFeishuRoutingBots,
  isFeishuManagedAgentId,
} from '../../src/lib/feishu-multi-bot-routing'
import { getOpenClawPaths, installPluginNpx, readConfig, repairIncompatibleExtensionPlugins } from './cli'
import { reconcileTrustedPluginAllowlist, sanitizeManagedPluginConfig } from './openclaw-plugin-config'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { FEISHU_PLUGIN_NPX_SPECIFIER } from './plugin-install-npx'
import { reloadGatewayForConfigChange } from './gateway-lifecycle-controller'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const FEISHU_OFFICIAL_PLUGIN_ID = 'openclaw-lark'
const FEISHU_OFFICIAL_PLUGIN_SPEC = '@larksuite/openclaw-lark'
const FEISHU_OFFICIAL_PLUGIN_MANIFEST = 'openclaw.plugin.json'
const LEGACY_FEISHU_PLUGIN_IDS = ['feishu', 'feishu-openclaw-plugin']
const FEISHU_PLUGIN_REPAIR_SCOPE = [FEISHU_OFFICIAL_PLUGIN_ID, ...LEGACY_FEISHU_PLUGIN_IDS]

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function normalizePluginId(value: unknown): string {
  return String(value || '').trim()
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBuiltInFeishuPluginExplicitlyDisabled(value: unknown): boolean {
  return hasOwnRecord(value) && value.enabled === false
}

function collectLegacyPluginIds(config: Record<string, any>): string[] {
  const found = new Set<string>()
  const allow = Array.isArray(config.plugins?.allow) ? config.plugins.allow : []
  for (const item of allow) {
    const pluginId = normalizePluginId(item)
    if (LEGACY_FEISHU_PLUGIN_IDS.includes(pluginId)) found.add(pluginId)
  }

  const entries = hasOwnRecord(config.plugins?.entries) ? config.plugins.entries : {}
  for (const pluginId of Object.keys(entries)) {
    if (
      pluginId === 'feishu' &&
      isBuiltInFeishuPluginExplicitlyDisabled(entries[pluginId])
    ) {
      continue
    }
    if (LEGACY_FEISHU_PLUGIN_IDS.includes(pluginId)) found.add(pluginId)
  }

  const installs = hasOwnRecord(config.plugins?.installs) ? config.plugins.installs : {}
  for (const pluginId of Object.keys(installs)) {
    if (LEGACY_FEISHU_PLUGIN_IDS.includes(pluginId)) found.add(pluginId)
  }

  return Array.from(found).sort()
}

function sanitizeLegacyFeishuPluginConfig(config: Record<string, any>): { config: Record<string, any>; changed: boolean } {
  return sanitizeManagedPluginConfig(config, {
    preserveBuiltInFeishuDisable: true,
  })
}

function stripOfficialFeishuPluginConfig(config: Record<string, any>): { config: Record<string, any>; changed: boolean } {
  const next = cloneConfig(config)
  next.plugins = hasOwnRecord(next.plugins) ? next.plugins : {}

  let changed = false

  if (Array.isArray(next.plugins.allow)) {
    const filtered = next.plugins.allow.filter(
      (item: unknown) => normalizePluginId(item) !== FEISHU_OFFICIAL_PLUGIN_ID
    )
    if (filtered.length !== next.plugins.allow.length) {
      next.plugins.allow = filtered
      changed = true
    }
  }

  if (hasOwnRecord(next.plugins.entries) && FEISHU_OFFICIAL_PLUGIN_ID in next.plugins.entries) {
    delete next.plugins.entries[FEISHU_OFFICIAL_PLUGIN_ID]
    changed = true
  }

  if (hasOwnRecord(next.plugins.installs) && FEISHU_OFFICIAL_PLUGIN_ID in next.plugins.installs) {
    delete next.plugins.installs[FEISHU_OFFICIAL_PLUGIN_ID]
    changed = true
  }

  return {
    config: next,
    changed,
  }
}

function isOfficialPluginEnabled(config: Record<string, any>): boolean {
  const allow = Array.isArray(config.plugins?.allow) ? config.plugins.allow : []
  return allow.some((item: unknown) => normalizePluginId(item) === FEISHU_OFFICIAL_PLUGIN_ID)
}

function ensureOfficialPluginInstallRecord(
  config: Record<string, any>,
  installPath: string
): Record<string, any> {
  const next = cloneConfig(config)
  next.plugins = hasOwnRecord(next.plugins) ? next.plugins : {}
  next.plugins.installs = hasOwnRecord(next.plugins.installs) ? next.plugins.installs : {}

  const existingInstall = hasOwnRecord(next.plugins.installs[FEISHU_OFFICIAL_PLUGIN_ID])
    ? next.plugins.installs[FEISHU_OFFICIAL_PLUGIN_ID]
    : {}

  next.plugins.installs[FEISHU_OFFICIAL_PLUGIN_ID] = {
    ...existingInstall,
    source: normalizeText(existingInstall.source) || 'npm',
    spec: normalizeText(existingInstall.spec) || FEISHU_OFFICIAL_PLUGIN_SPEC,
    ...(installPath
      ? {
          installPath: normalizeText(existingInstall.installPath) || installPath,
        }
      : {}),
  }

  return next
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function shouldApplyFeishuIsolation(config: Record<string, any>): boolean {
  if (extractFeishuRoutingBots(config).length > 0) {
    return true
  }

  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : []
  if (
    agents.some((agent: Record<string, any>) => {
      const agentId = normalizeText(agent?.id)
      return agentId === 'feishu-bot' || isFeishuManagedAgentId(agentId)
    })
  ) {
    return true
  }

  const bindings = Array.isArray(config?.bindings) ? config.bindings : []
  return bindings.some((binding: Record<string, any>) => normalizeText(binding?.match?.channel) === 'feishu')
}

function buildNormalizedConfig(params: {
  config: Record<string, any>
  installedOnDisk: boolean
  installPath: string
}): Record<string, any> {
  const sanitized = sanitizeLegacyFeishuPluginConfig(params.config).config
  if (!params.installedOnDisk) {
    const stripped = stripOfficialFeishuPluginConfig(sanitized).config
    return shouldApplyFeishuIsolation(stripped)
      ? applyFeishuMultiBotIsolation(stripped)
      : stripped
  }

  const withInstallRecord = ensureOfficialPluginInstallRecord(sanitized, params.installPath)
  const withAllowlist = reconcileTrustedPluginAllowlist(withInstallRecord).config
  return applyFeishuMultiBotIsolation(withAllowlist)
}

function isStateReady(state: FeishuOfficialPluginState): boolean {
  return state.installedOnDisk && state.officialPluginConfigured
}

/**
 * Feishu-specific config reconciliation for the unified reconciler.
 * Wraps buildNormalizedConfig to match the reconcileConfig hook signature.
 */
export function reconcileFeishuPluginConfig(
  config: Record<string, any> | null | undefined,
  runtime: { installedOnDisk: boolean; installPath: string }
): { config: Record<string, any>; changed: boolean } {
  const safeConfig = cloneConfig(config)
  const normalized = buildNormalizedConfig({
    config: safeConfig,
    installedOnDisk: runtime.installedOnDisk,
    installPath: runtime.installPath,
  })
  const changed = JSON.stringify(safeConfig) !== JSON.stringify(normalized)
  return { config: normalized, changed }
}

function resolveFeishuOfficialPluginManifestPath(homeDir: string): string {
  return path.join(homeDir, 'extensions', FEISHU_OFFICIAL_PLUGIN_ID, FEISHU_OFFICIAL_PLUGIN_MANIFEST)
}

async function isFeishuOfficialPluginInstalledOnDisk(homeDir: string): Promise<boolean> {
  if (!homeDir) return false
  try {
    await fs.promises.access(resolveFeishuOfficialPluginManifestPath(homeDir))
    return true
  } catch {
    return false
  }
}

export interface FeishuOfficialPluginState {
  pluginId: string
  installedOnDisk: boolean
  installPath: string
  officialPluginConfigured: boolean
  legacyPluginIdsPresent: string[]
  configChanged: boolean
  normalizedConfig: Record<string, any>
}

export interface EnsureFeishuOfficialPluginReadyResult {
  ok: boolean
  installedThisRun: boolean
  state: FeishuOfficialPluginState
  stdout: string
  stderr: string
  code: number | null
  message?: string
}

async function applyNormalizedConfigIfNeeded(state: FeishuOfficialPluginState): Promise<boolean> {
  if (!state.configChanged) return false

  const currentConfig = await readConfig().catch(() => null)
  const writeResult = await applyConfigPatchGuarded(
    {
      beforeConfig: currentConfig,
      afterConfig: state.normalizedConfig,
      reason: 'unknown',
    },
    undefined,
    { applyGatewayPolicy: false }
  )
  if (!writeResult.ok) {
    throw new Error(writeResult.message || '飞书官方插件配置归一化失败')
  }
  return true
}

async function reloadGatewayAfterFeishuRepair(reason: string): Promise<void> {
  const reloadResult = await reloadGatewayForConfigChange(reason)
  if (!reloadResult.ok) {
    throw new Error(reloadResult.summary || reloadResult.stderr || reloadResult.stdout || '网关重载失败')
  }
}

export async function getFeishuOfficialPluginState(): Promise<FeishuOfficialPluginState> {
  const [config, openClawPaths] = await Promise.all([
    readConfig().catch(() => null),
    getOpenClawPaths().catch(() => null),
  ])

  const homeDir = String(openClawPaths?.homeDir || '').trim()
  const installPath = homeDir ? path.join(homeDir, 'extensions', FEISHU_OFFICIAL_PLUGIN_ID) : ''
  const installedOnDisk = await isFeishuOfficialPluginInstalledOnDisk(homeDir)

  const baseConfig = cloneConfig(config)
  const legacyPluginIdsPresent = collectLegacyPluginIds(baseConfig)
  const normalizedConfig = buildNormalizedConfig({
    config: baseConfig,
    installedOnDisk,
    installPath,
  })
  const configChanged = JSON.stringify(normalizedConfig) !== JSON.stringify(baseConfig)

  return {
    pluginId: FEISHU_OFFICIAL_PLUGIN_ID,
    installedOnDisk,
    installPath,
    officialPluginConfigured: isOfficialPluginEnabled(normalizedConfig),
    legacyPluginIdsPresent,
    configChanged,
    normalizedConfig,
  }
}

export async function ensureFeishuOfficialPluginReady(): Promise<EnsureFeishuOfficialPluginReadyResult> {
  let beforeState = await getFeishuOfficialPluginState()
  let appliedBeforeReady = false
  let lastAppliedConfigFingerprint = ''

  try {
    appliedBeforeReady = await applyNormalizedConfigIfNeeded(beforeState)
    if (appliedBeforeReady) {
      lastAppliedConfigFingerprint = JSON.stringify(beforeState.normalizedConfig)
    }
    if (appliedBeforeReady) {
      beforeState = await getFeishuOfficialPluginState()
    }
  } catch (error) {
    return {
      ok: false,
      installedThisRun: false,
      state: beforeState,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
      message: '飞书插件预检查失败',
    }
  }

  const repairResult = await repairIncompatibleExtensionPlugins({
    scopePluginIds: FEISHU_PLUGIN_REPAIR_SCOPE,
    quarantineOfficialManagedPlugins: true,
  })
  if (!repairResult.ok) {
    return {
      ok: false,
      installedThisRun: false,
      state: beforeState,
      stdout: '',
      stderr: repairResult.stderr,
      code: 1,
      message: repairResult.summary || '飞书官方插件兼容修复失败',
    }
  }
  if (repairResult.repaired) {
    beforeState = await getFeishuOfficialPluginState()
    const repairedOfficialPlugin =
      repairResult.quarantinedPluginIds.includes(FEISHU_OFFICIAL_PLUGIN_ID)
      || repairResult.prunedPluginIds.includes(FEISHU_OFFICIAL_PLUGIN_ID)
    if (repairedOfficialPlugin) {
      beforeState = {
        ...beforeState,
        installedOnDisk: false,
        officialPluginConfigured: false,
      }
    }
  }

  if (isStateReady(beforeState)) {
    if (appliedBeforeReady) {
      try {
        await reloadGatewayAfterFeishuRepair('feishu-official-plugin-config-sync')
      } catch (error) {
        return {
          ok: false,
          installedThisRun: false,
          state: beforeState,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: 1,
          message: '飞书官方插件配置已同步，但网关重载失败',
        }
      }
    }

    return {
      ok: true,
      installedThisRun: false,
      state: beforeState,
      stdout: '',
      stderr: '',
      code: 0,
      message: '已确认飞书官方插件可用',
    }
  }

  const installResult = await installPluginNpx(FEISHU_PLUGIN_NPX_SPECIFIER, [FEISHU_OFFICIAL_PLUGIN_ID])
  let afterState = await getFeishuOfficialPluginState()
  let appliedAfterInstall = false

  try {
    const afterConfigFingerprint = JSON.stringify(afterState.normalizedConfig)
    const alreadyAppliedSameConfig =
      Boolean(lastAppliedConfigFingerprint)
      && afterConfigFingerprint === lastAppliedConfigFingerprint

    appliedAfterInstall = alreadyAppliedSameConfig
      ? false
      : await applyNormalizedConfigIfNeeded(afterState)
    if (appliedAfterInstall) {
      afterState = await getFeishuOfficialPluginState()
    }
  } catch (error) {
    return {
      ok: false,
      installedThisRun: installResult.ok,
      state: afterState,
      stdout: installResult.stdout,
      stderr: [installResult.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n\n'),
      code: installResult.ok ? 1 : installResult.code,
      message: installResult.ok
        ? '飞书官方插件安装成功，但配置归一化失败'
        : '飞书官方插件安装失败，且配置归一化失败',
    }
  }

  if (!isStateReady(afterState)) {
    return {
      ok: false,
      installedThisRun: installResult.ok,
      state: afterState,
      stdout: installResult.stdout,
      stderr: installResult.stderr,
      code: installResult.code,
      message: installResult.stderr || '飞书官方插件安装后仍未启用',
    }
  }

  try {
    await reloadGatewayAfterFeishuRepair(
      installResult.ok
        ? 'feishu-official-plugin-install'
        : appliedAfterInstall || appliedBeforeReady
          ? 'feishu-official-plugin-config-sync'
          : 'feishu-official-plugin-ready'
    )
  } catch (error) {
    return {
      ok: false,
      installedThisRun: installResult.ok,
      state: afterState,
      stdout: installResult.stdout,
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
      message: installResult.ok
        ? '飞书官方插件安装成功，但网关重载失败'
        : '飞书官方插件已就绪，但网关重载失败',
    }
  }

  return {
    ok: true,
    installedThisRun: installResult.ok,
    state: afterState,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    code: installResult.code,
    message: '飞书官方插件已安装并可用',
  }
}
