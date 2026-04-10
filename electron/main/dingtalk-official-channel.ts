import {
  installPlugin,
  isPluginInstalledOnDisk,
  readConfig,
  repairIncompatibleExtensionPlugins,
  runDoctor,
  uninstallPlugin,
} from './cli'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { reloadGatewayForConfigChange } from './gateway-lifecycle-controller'
import { applyDingtalkFallbackConfig, type DingtalkOfficialSetupResult } from '../../src/shared/dingtalk-official-setup'
import type {
  OfficialChannelActionResult,
  OfficialChannelGatewayResult,
  OfficialChannelSetupEvidence,
} from '../../src/shared/official-channel-integration'
import { isPluginAlreadyInstalledError } from '../../src/shared/openclaw-cli-errors'
import { stripLegacyOpenClawRootKeys } from '../../src/shared/openclaw-config-sanitize'
import { getManagedChannelPluginByChannelId } from '../../src/shared/managed-channel-plugin-registry'

const DINGTALK_PLUGIN_INSTALL_REGISTRY_URL = 'https://registry.npmmirror.com'

interface CliLikeResult {
  stdout?: string
  stderr?: string
  code?: number | null
}

interface DingtalkOperationContext {
  pluginId: string
  packageName: string
  cleanupPluginIds: string[]
  evidence: OfficialChannelSetupEvidence[]
  outputParts: {
    stdout: string[]
    stderr: string[]
  }
  installedThisRun: boolean
  gatewayResult: OfficialChannelGatewayResult | null
}

function joinNonEmpty(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

function pushOutput(parts: { stdout: string[]; stderr: string[] }, result: CliLikeResult | null | undefined) {
  const stdout = String(result?.stdout || '').trim()
  const stderr = String(result?.stderr || '').trim()
  if (stdout) parts.stdout.push(stdout)
  if (stderr) parts.stderr.push(stderr)
}

function createOperationContext(): DingtalkOperationContext | null {
  const managedPlugin = getManagedChannelPluginByChannelId('dingtalk')
  if (!managedPlugin?.packageName) {
    return null
  }

  return {
    pluginId: managedPlugin.pluginId,
    packageName: managedPlugin.packageName,
    cleanupPluginIds: managedPlugin.cleanupPluginIds,
    evidence: [],
    outputParts: {
      stdout: [],
      stderr: [],
    },
    installedThisRun: false,
    gatewayResult: null,
  }
}

function buildGatewayResult(
  result: {
    ok?: boolean
    running?: boolean
    summary?: string
    stateCode?: string
    stdout?: string
    stderr?: string
  },
  requestedAction: OfficialChannelGatewayResult['requestedAction']
): OfficialChannelGatewayResult {
  return {
    ok: Boolean(result.ok),
    running: result.running === true,
    requestedAction,
    summary: String(result.summary || '').trim() || '网关重载结果未返回摘要',
    ...(String(result.stateCode || '').trim() ? { stateCode: String(result.stateCode).trim() } : {}),
    ...(joinNonEmpty([result.stderr, result.stdout])
      ? { detail: joinNonEmpty([result.stderr, result.stdout]).slice(0, 2000) }
      : {}),
  }
}

function buildActionResult(
  context: DingtalkOperationContext,
  params: Partial<OfficialChannelActionResult> & {
    summary: string
  }
): OfficialChannelActionResult {
  return {
    ok: params.ok ?? false,
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    summary: params.summary,
    installedThisRun: params.installedThisRun ?? context.installedThisRun,
    gatewayResult: params.gatewayResult ?? context.gatewayResult,
    evidence: params.evidence ?? context.evidence,
    stdout: joinNonEmpty(context.outputParts.stdout),
    stderr: joinNonEmpty(context.outputParts.stderr),
    code: params.code ?? null,
    ...(String(params.message || '').trim() ? { message: String(params.message).trim() } : {}),
  }
}

function buildSetupResult(
  context: DingtalkOperationContext,
  params: Partial<DingtalkOfficialSetupResult> & {
    summary: string
  }
): DingtalkOfficialSetupResult {
  const actionResult = buildActionResult(context, params)
  return {
    ...actionResult,
    channelId: 'dingtalk',
    changedPaths: params.changedPaths ?? [],
    applySummary: params.applySummary ?? '',
    probeResult: null,
  }
}

function buildApplySummary(params: { wrote: boolean; message?: string; changedPaths: string[] }): string {
  const baseMessage = String(params.message || '').trim()
  if (baseMessage) return baseMessage
  if (!params.wrote) return '钉钉配置没有发生变化，已复用现有配置。'
  if (params.changedPaths.length === 0) return '钉钉配置已补齐。'
  return `钉钉配置已补齐，共写入 ${params.changedPaths.length} 处变更。`
}

async function sanitizeLegacyConfig(context: DingtalkOperationContext): Promise<{ ok: true } | { ok: false; message: string; code: number }> {
  const configBeforeSanitize = await readConfig().catch(() => null)
  const sanitizedConfig = stripLegacyOpenClawRootKeys(configBeforeSanitize)
  if (JSON.stringify(sanitizedConfig) === JSON.stringify(configBeforeSanitize || {})) {
    return { ok: true }
  }

  const sanitizeResult = await applyConfigPatchGuarded(
    {
      beforeConfig: configBeforeSanitize,
      afterConfig: sanitizedConfig,
      reason: 'channel-connect-sanitize',
    },
    undefined,
    {
      applyGatewayPolicy: false,
    }
  )

  if (!sanitizeResult.ok) {
    return {
      ok: false,
      message: sanitizeResult.message || '钉钉配置预清理失败',
      code: 1,
    }
  }

  context.evidence.push({
    source: 'config',
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    message: '已清理历史 root 级别渠道键',
    jsonPaths: sanitizeResult.changedJsonPaths,
  })

  return { ok: true }
}

/**
 * Dingtalk-specific preflight hook for the unified preflight flow.
 * Runs `openclaw doctor --fix --non-interactive` to clean up stale config.
 */
export async function dingtalkPreflightHook(context: {
  homeDir: string
  config: Record<string, any>
}): Promise<{ ok: boolean; evidence?: string[]; error?: string }> {
  const doctorResult = await runDoctor({ fix: true, nonInteractive: true })
  if (!doctorResult.ok) {
    return {
      ok: false,
      evidence: [
        `openclaw doctor --fix --non-interactive exited with code ${doctorResult.code ?? 'null'}`,
        ...(doctorResult.stderr ? [doctorResult.stderr] : []),
      ],
      error: '钉钉预检修复失败，请先处理历史污染配置后重试。',
    }
  }
  return {
    ok: true,
    evidence: [`openclaw doctor --fix completed successfully`],
  }
}

async function runDingtalkDoctorAndRepair(
  context: DingtalkOperationContext
): Promise<{ ok: true } | { ok: false; message: string; code: number }> {
  const doctorResult = await runDoctor({ fix: true, nonInteractive: true })
  pushOutput(context.outputParts, doctorResult)
  if (!doctorResult.ok) {
    return {
      ok: false,
      message: '钉钉预检修复失败，请先处理历史污染配置后重试。',
      code: doctorResult.code ?? 1,
    }
  }

  context.evidence.push({
    source: 'doctor',
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    command: 'openclaw doctor --fix --non-interactive',
    message: '已完成钉钉官方预检修复',
  })

  const repairResult = await repairIncompatibleExtensionPlugins({
    scopePluginIds: Array.from(new Set([context.pluginId, ...context.cleanupPluginIds])),
    quarantineOfficialManagedPlugins: true,
  })
  if (!repairResult.ok) {
    return {
      ok: false,
      message: repairResult.summary || '钉钉历史残留清理失败',
      code: 1,
    }
  }

  context.evidence.push({
    source: 'repair',
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    message: repairResult.repaired
      ? `已完成钉钉历史残留清理：${repairResult.summary || '已清理 stale plugin 配置'}`
      : '未发现需清理的钉钉历史残留',
    detail: repairResult.repaired
      ? joinNonEmpty([
          repairResult.summary,
          repairResult.quarantinedPluginIds.length > 0
            ? `quarantined=${repairResult.quarantinedPluginIds.join(', ')}`
            : '',
          repairResult.prunedPluginIds.length > 0
            ? `pruned=${repairResult.prunedPluginIds.join(', ')}`
            : '',
        ])
      : undefined,
  })

  return { ok: true }
}

async function ensureDingtalkPluginInstalled(
  context: DingtalkOperationContext
): Promise<{ ok: true } | { ok: false; message: string; code: number }> {
  const pluginInstalledBefore = await isPluginInstalledOnDisk(context.pluginId)
  if (pluginInstalledBefore) {
    context.evidence.push({
      source: 'plugin-install',
      channelId: 'dingtalk',
      pluginId: context.pluginId,
      message: '已复用已安装的钉钉官方插件',
    })
    return { ok: true }
  }

  for (const cleanupPluginId of context.cleanupPluginIds) {
    try {
      await uninstallPlugin(cleanupPluginId)
    } catch {
      // Ignore legacy cleanup failures and continue with the official install.
    }
  }

  const installResult = await installPlugin(context.packageName, [context.pluginId], {
    registryUrl: DINGTALK_PLUGIN_INSTALL_REGISTRY_URL,
  })
  pushOutput(context.outputParts, installResult)

  if (!installResult.ok) {
    const safeAlreadyInstalled =
      isPluginAlreadyInstalledError(installResult.stderr || '')
      && !String(installResult.stderr || '').includes('已自动隔离')
      && !String(installResult.stderr || '').includes('安全修复失败')
    const pluginInstalledAfterAlreadyInstalled = safeAlreadyInstalled
      ? await isPluginInstalledOnDisk(context.pluginId)
      : false

    if (!pluginInstalledAfterAlreadyInstalled) {
      return {
        ok: false,
        message: '钉钉官方插件安装失败，请检查网络与权限后重试。',
        code: installResult.code ?? 1,
      }
    }

    context.evidence.push({
      source: 'plugin-install',
      channelId: 'dingtalk',
      pluginId: context.pluginId,
      command: `openclaw plugins install ${context.packageName}`,
      message: '命令行工具报告钉钉插件已存在，已复用当前官方插件安装',
    })
    return { ok: true }
  }

  context.installedThisRun = true
  context.evidence.push({
    source: 'plugin-install',
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    command: `NPM_CONFIG_REGISTRY=${DINGTALK_PLUGIN_INSTALL_REGISTRY_URL} openclaw plugins install ${context.packageName}`,
    message: '已安装钉钉官方插件',
  })

  return { ok: true }
}

async function reloadGatewayForDingtalkOperation(
  context: DingtalkOperationContext,
  reason: string,
  requestedAction: OfficialChannelGatewayResult['requestedAction']
): Promise<{ ok: true } | { ok: false; message: string; code: number }> {
  const reloadResult = await reloadGatewayForConfigChange(reason, {
    preferEnsureWhenNotRunning: true,
  })
  pushOutput(context.outputParts, reloadResult)
  context.gatewayResult = buildGatewayResult(reloadResult, requestedAction)

  context.evidence.push({
    source: 'gateway',
    channelId: 'dingtalk',
    pluginId: context.pluginId,
    message: context.gatewayResult.summary,
    detail: context.gatewayResult.detail,
  })

  if (!reloadResult.ok || reloadResult.running !== true) {
    return {
      ok: false,
      message: context.gatewayResult.summary || '网关启动失败',
      code: reloadResult.code ?? 1,
    }
  }

  return { ok: true }
}

export async function repairDingtalkOfficialChannel(): Promise<OfficialChannelActionResult> {
  const context = createOperationContext()
  if (!context) {
    return {
      ok: false,
      channelId: 'dingtalk',
      pluginId: 'dingtalk-connector',
      summary: '钉钉官方插件元数据缺失，无法继续执行安装。',
      installedThisRun: false,
      gatewayResult: null,
      evidence: [],
      stdout: '',
      stderr: '',
      code: 1,
      message: '钉钉官方插件元数据缺失，无法继续执行安装。',
    }
  }

  try {
    const sanitizeResult = await sanitizeLegacyConfig(context)
    if (!sanitizeResult.ok) {
      return buildActionResult(context, {
        summary: '钉钉配置预清理失败，请稍后重试。',
        code: sanitizeResult.code,
        message: sanitizeResult.message,
      })
    }

    const doctorRepairResult = await runDingtalkDoctorAndRepair(context)
    if (!doctorRepairResult.ok) {
      return buildActionResult(context, {
        summary: doctorRepairResult.message,
        code: doctorRepairResult.code,
        message: doctorRepairResult.message,
      })
    }

    const installResult = await ensureDingtalkPluginInstalled(context)
    if (!installResult.ok) {
      return buildActionResult(context, {
        summary: installResult.message,
        code: installResult.code,
        message: installResult.message,
      })
    }

    const reloadResult = await reloadGatewayForDingtalkOperation(
      context,
      'dingtalk-official-channel-repair',
      'reload-after-repair'
    )
    if (!reloadResult.ok) {
      return buildActionResult(context, {
        summary: reloadResult.message,
        code: reloadResult.code,
        message: reloadResult.message,
      })
    }

    return buildActionResult(context, {
      ok: true,
      code: 0,
      summary: context.installedThisRun
        ? '已安装并修复钉钉官方插件；loaded / ready 仍待上游证据。'
        : '钉钉官方插件已修复；loaded / ready 仍待上游证据。',
      message: '钉钉官方插件已完成修复，ready 仍待上游证据',
    })
  } catch (error) {
    return buildActionResult(context, {
      summary: error instanceof Error ? error.message : '钉钉插件修复失败',
      code: 1,
      message: error instanceof Error ? error.message : '钉钉插件修复失败',
    })
  }
}

export async function setupDingtalkOfficialChannel(
  formData: Record<string, string>
): Promise<DingtalkOfficialSetupResult> {
  const context = createOperationContext()
  if (!context) {
    return {
      ok: false,
      channelId: 'dingtalk',
      pluginId: 'dingtalk-connector',
      summary: '钉钉官方插件元数据缺失，无法继续执行安装。',
      installedThisRun: false,
      changedPaths: [],
      applySummary: '',
      gatewayResult: null,
      evidence: [],
      probeResult: null,
      stdout: '',
      stderr: '',
      code: 1,
      message: '钉钉官方插件元数据缺失，无法继续执行安装。',
    }
  }

  let changedPaths: string[] = []
  let applySummary = ''

  try {
    const sanitizeResult = await sanitizeLegacyConfig(context)
    if (!sanitizeResult.ok) {
      return buildSetupResult(context, {
        summary: '钉钉配置预清理失败，请稍后重试。',
        code: sanitizeResult.code,
        message: sanitizeResult.message,
      })
    }

    const doctorRepairResult = await runDingtalkDoctorAndRepair(context)
    if (!doctorRepairResult.ok) {
      return buildSetupResult(context, {
        summary: doctorRepairResult.message,
        code: doctorRepairResult.code,
        message: doctorRepairResult.message,
      })
    }

    const installResult = await ensureDingtalkPluginInstalled(context)
    if (!installResult.ok) {
      return buildSetupResult(context, {
        summary: installResult.message,
        code: installResult.code,
        message: installResult.message,
      })
    }

    const configBeforePatch = await readConfig().catch(() => null)
    const nextConfig = applyDingtalkFallbackConfig(configBeforePatch, formData)
    const configWriteResult = await applyConfigPatchGuarded(
      {
        beforeConfig: configBeforePatch,
        afterConfig: nextConfig,
        reason: 'channel-connect-configure',
      },
      undefined,
      {
        applyGatewayPolicy: false,
      }
    )

    if (!configWriteResult.ok) {
      return buildSetupResult(context, {
        summary: '钉钉配置写入失败，请检查当前 OpenClaw 配置后重试。',
        code: 1,
        message: configWriteResult.message || '钉钉配置写入失败',
      })
    }

    changedPaths = configWriteResult.changedJsonPaths
    applySummary = buildApplySummary({
      wrote: configWriteResult.wrote,
      message: configWriteResult.message,
      changedPaths,
    })

    context.evidence.push({
      source: 'config',
      channelId: 'dingtalk',
      pluginId: context.pluginId,
      message: configWriteResult.wrote ? '已写入钉钉最小配置补丁' : '钉钉最小配置补丁已确认，无需重复写入',
      jsonPaths: changedPaths,
    })

    const reloadResult = await reloadGatewayForDingtalkOperation(
      context,
      'dingtalk-official-channel-setup',
      'reload-after-setup'
    )
    if (!reloadResult.ok) {
      return buildSetupResult(context, {
        summary: reloadResult.message,
        code: reloadResult.code,
        message: reloadResult.message,
        changedPaths,
        applySummary,
      })
    }

    return buildSetupResult(context, {
      ok: true,
      code: 0,
      summary: '钉钉官方插件配置已完成；loaded / ready 仍待上游证据。',
      message: '钉钉官方插件配置已完成，ready 仍待上游证据',
      changedPaths,
      applySummary,
    })
  } catch (error) {
    return buildSetupResult(context, {
      summary: error instanceof Error ? error.message : '钉钉配置失败',
      code: 1,
      message: error instanceof Error ? error.message : '钉钉配置失败',
      changedPaths,
      applySummary,
    })
  }
}
