import { isPluginInstalledOnDisk, runCli } from './cli'
import { getFeishuOfficialPluginState, ensureFeishuOfficialPluginReady } from './feishu-official-plugin-state'
import { repairDingtalkOfficialChannel } from './dingtalk-official-channel'
import { parseJsonFromCommandResult } from './openclaw-command-output'
import { rerunReadOnlyCommandAfterStalePluginRepair } from './openclaw-readonly-stale-plugin-repair'
import type {
  OfficialChannelActionResult,
  OfficialChannelAdapterId,
  OfficialChannelSetupEvidence,
  OfficialChannelStatusStage,
  OfficialChannelStatusStageState,
  OfficialChannelStatusView,
} from '../../src/shared/official-channel-integration'

interface FeishuOfficialRepairResultLike {
  ok: boolean
  installedThisRun: boolean
  state: {
    pluginId: string
    installedOnDisk: boolean
    officialPluginConfigured: boolean
    configChanged: boolean
  }
  stdout: string
  stderr: string
  code: number | null
  message?: string
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

function normalizePluginId(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function createStage(
  id: OfficialChannelStatusStage['id'],
  state: OfficialChannelStatusStageState,
  source: string,
  message: string
): OfficialChannelStatusStage {
  return {
    id,
    state,
    source,
    message,
  }
}

function collectPluginListEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!hasOwnRecord(payload)) return []

  for (const key of ['plugins', 'items', 'list', 'entries', 'data']) {
    if (Array.isArray(payload[key])) {
      return payload[key] as unknown[]
    }
  }

  if (hasOwnRecord(payload.plugins)) {
    return Object.entries(payload.plugins).map(([id, value]) =>
      hasOwnRecord(value)
        ? { id, ...value }
        : { id }
    )
  }

  return []
}

function extractPluginIdsFromPayload(payload: unknown): string[] {
  const pluginIds = new Set<string>()
  for (const item of collectPluginListEntries(payload)) {
    if (typeof item === 'string') {
      const pluginId = normalizePluginId(item)
      if (pluginId) pluginIds.add(pluginId)
      continue
    }

    if (!hasOwnRecord(item)) continue

    const candidates = [
      item.id,
      item.pluginId,
      item.name,
      hasOwnRecord(item.manifest) ? item.manifest.id : '',
      hasOwnRecord(item.plugin) ? item.plugin.id : '',
      hasOwnRecord(item.extension) ? item.extension.id : '',
    ]

    for (const candidate of candidates) {
      const pluginId = normalizePluginId(candidate)
      if (pluginId) pluginIds.add(pluginId)
    }
  }

  return Array.from(pluginIds)
}

async function detectRegisteredPlugin(params: {
  channelId: OfficialChannelAdapterId
  pluginId: string
}): Promise<{
  state: OfficialChannelStatusStageState
  evidence: OfficialChannelSetupEvidence
}> {
  const listResult = await rerunReadOnlyCommandAfterStalePluginRepair(
    () => runCli(['plugins', 'list', '--json'], undefined, 'plugin-install')
  ).catch(() => null)
  if (!listResult || !listResult.ok) {
    return {
      state: 'unknown',
      evidence: {
        source: 'plugins-list',
        channelId: params.channelId,
        pluginId: params.pluginId,
        command: 'openclaw plugins list --json',
        message: '当前 CLI 未提供可解析的 plugins list，registered 暂记为 unknown / 未证实',
        detail: normalizeText(listResult?.stderr) || normalizeText(listResult?.stdout),
      },
    }
  }

  try {
    const payload = parseJsonFromCommandResult<unknown>(listResult)
    const pluginIds = extractPluginIdsFromPayload(payload)
    const registered = pluginIds.includes(normalizePluginId(params.pluginId))
    return {
      state: registered ? 'verified' : 'missing',
      evidence: {
        source: 'plugins-list',
        channelId: params.channelId,
        pluginId: params.pluginId,
        command: 'openclaw plugins list --json',
        message: registered
          ? '已在上游 plugins list 中确认插件已注册'
          : '当前未在上游 plugins list 中确认插件已注册',
      },
    }
  } catch (error) {
    return {
      state: 'unknown',
      evidence: {
        source: 'plugins-list',
        channelId: params.channelId,
        pluginId: params.pluginId,
        command: 'openclaw plugins list --json',
        message: 'plugins list 输出暂不可解析，registered 暂记为 unknown / 未证实',
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function getDingtalkOfficialChannelStatus(): Promise<OfficialChannelStatusView> {
  const pluginId = 'dingtalk-connector'
  const installedOnDisk = await isPluginInstalledOnDisk(pluginId)
  const registered = await detectRegisteredPlugin({
    channelId: 'dingtalk',
    pluginId,
  })

  const evidence: OfficialChannelSetupEvidence[] = [
    {
      source: 'disk',
      channelId: 'dingtalk',
      pluginId,
      message: installedOnDisk
        ? '已确认钉钉官方插件安装目录存在'
        : '当前未确认到钉钉官方插件安装目录',
    },
    registered.evidence,
    {
      source: 'plugins-list',
      channelId: 'dingtalk',
      pluginId,
      message: '当前缺少上游 loaded / ready 证明，状态保留为未知。',
    },
  ]

  const stages: OfficialChannelStatusStage[] = [
    createStage(
      'installed',
      installedOnDisk ? 'verified' : 'missing',
      'disk',
      installedOnDisk ? '已确认本机存在钉钉官方插件安装' : '本机尚未确认到钉钉官方插件安装'
    ),
    createStage(
      'registered',
      registered.state,
      registered.evidence.source,
      registered.evidence.message
    ),
  ]

  return {
    channelId: 'dingtalk',
    pluginId,
    summary: !installedOnDisk
      ? '钉钉官方插件尚未安装。'
      : registered.state === 'verified'
        ? '钉钉官方插件已安装并已注册；loaded / ready 仍待上游证据。'
        : registered.state === 'missing'
          ? '钉钉官方插件已安装，但尚未在上游 plugins list 中确认注册。'
          : '钉钉官方插件已安装；registered / loaded / ready 仍待更多上游证据。',
    stages,
    evidence,
  }
}

async function getFeishuOfficialChannelStatus(): Promise<OfficialChannelStatusView> {
  const state = await getFeishuOfficialPluginState()
  const registered = await detectRegisteredPlugin({
    channelId: 'feishu',
    pluginId: state.pluginId,
  })

  const evidence: OfficialChannelSetupEvidence[] = [
    {
      source: 'disk',
      channelId: 'feishu',
      pluginId: state.pluginId,
      message: state.installedOnDisk
        ? '已确认飞书官方插件安装目录存在'
        : '当前未确认到飞书官方插件安装目录',
    },
    registered.evidence,
    ...(state.configChanged
      ? [{
          source: 'config' as const,
          channelId: 'feishu',
          pluginId: state.pluginId,
          message: '检测到飞书官方插件配置仍待同步，当前 status 只确认到安装 / 注册层级',
        }]
      : []),
    {
      source: 'plugins-list',
      channelId: 'feishu',
      pluginId: state.pluginId,
      message: '当前缺少上游 loaded / ready 证明，状态保留为未知。',
    },
  ]

  const stages: OfficialChannelStatusStage[] = [
    createStage(
      'installed',
      state.installedOnDisk ? 'verified' : 'missing',
      'disk',
      state.installedOnDisk ? '已确认本机存在飞书官方插件安装' : '本机尚未确认到飞书官方插件安装'
    ),
    createStage(
      'registered',
      registered.state,
      'plugins-list',
      registered.evidence.message
    ),
  ]

  return {
    channelId: 'feishu',
    pluginId: state.pluginId,
    summary: !state.installedOnDisk
      ? '飞书官方插件尚未安装。'
      : state.configChanged
        ? '飞书官方插件已安装，但配置仍待同步；loaded / ready 仍待上游证据。'
        : registered.state === 'verified'
          ? '飞书官方插件已安装并已注册；loaded / ready 仍待上游证据。'
          : registered.state === 'missing'
            ? '飞书官方插件已安装，但尚未在上游 plugins list 中确认注册。'
            : '飞书官方插件已安装；registered / loaded / ready 仍待更多上游证据。',
    stages,
    evidence,
  }
}

function mapFeishuRepairResult(result: FeishuOfficialRepairResultLike): OfficialChannelActionResult {
  const evidence: OfficialChannelSetupEvidence[] = []

  if (result.installedThisRun) {
    evidence.push({
      source: 'plugin-install',
      channelId: 'feishu',
      pluginId: result.state.pluginId,
      message: '已安装飞书官方插件，并完成必要配置归一化',
    })
  } else {
    evidence.push({
      source: 'status',
      channelId: 'feishu',
      pluginId: result.state.pluginId,
      message: '已确认飞书官方插件安装存在，且配置已处于归一化状态',
    })
  }

  return {
    ok: result.ok,
    channelId: 'feishu',
    pluginId: result.state.pluginId,
    summary: result.ok
      ? result.installedThisRun
        ? '已安装并归一化飞书官方插件；loaded / ready 仍待上游证据。'
        : '飞书官方插件已归一化；loaded / ready 仍待上游证据。'
      : (result.message || '飞书官方插件处理失败'),
    installedThisRun: result.installedThisRun,
    gatewayResult: null,
    evidence,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ...(normalizeText(result.message) ? { message: normalizeText(result.message) } : {}),
  }
}

export async function getOfficialChannelStatus(
  channelId: OfficialChannelAdapterId
): Promise<OfficialChannelStatusView> {
  if (channelId === 'dingtalk') {
    return getDingtalkOfficialChannelStatus()
  }
  if (channelId === 'feishu') {
    return getFeishuOfficialChannelStatus()
  }
  throw new Error(`Unsupported official channel status adapter: ${channelId}`)
}

export async function repairOfficialChannel(
  channelId: OfficialChannelAdapterId
): Promise<OfficialChannelActionResult> {
  if (channelId === 'dingtalk') {
    return repairDingtalkOfficialChannel()
  }
  if (channelId === 'feishu') {
    const result = await ensureFeishuOfficialPluginReady()
    return mapFeishuRepairResult(result)
  }
  throw new Error(`Unsupported official channel repair adapter: ${channelId}`)
}
