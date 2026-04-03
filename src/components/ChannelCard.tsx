import { Button, Card, Badge, Group, Text } from '@mantine/core'
import {
  getChannelEnabledLabel,
  shouldShowPluginStatus,
  getVisiblePluginStatusStages,
  shouldShowFeishuPluginRepairAction,
} from '../pages/ChannelsPage'
import {
  getOfficialChannelStageColor,
  getOfficialChannelStageLabel,
} from '../shared/official-channel-status-view'
import type { ManagedChannelPluginStatusView } from '../shared/managed-channel-plugin-lifecycle'

type FeishuRuntimeStatusState = 'online' | 'offline' | 'degraded' | 'disabled'

export interface ChannelCardChannel {
  id: string
  channelId: string
  name: string
  enabled: boolean
  pairingRequired: boolean
  pairingAccountId?: string
  agentId?: string
  runtimeState?: FeishuRuntimeStatusState
  pluginStatus?: ManagedChannelPluginStatusView | null
}

export interface ChannelCardProps {
  channel: ChannelCardChannel
  platformInfo: { logo: string | null; name: string }
  isToggling: boolean
  togglingAnyChannel: boolean
  togglingAnotherChannel: boolean
  repairingPluginChannelId: string | null
  onOpenModelConfig: () => void
  onToggleEnabled: () => void
  onOpenPairing: () => void
  onOpenDiagnostics: () => void
  onRepairPlugin: () => void
  onRemove: () => void
}

function getRuntimeBadgeColor(state: FeishuRuntimeStatusState | undefined): string {
  if (state === 'online') return 'teal'
  if (state === 'degraded') return 'yellow'
  if (state === 'disabled') return 'gray'
  return 'red'
}

function getRuntimeLabel(state: FeishuRuntimeStatusState | undefined): string {
  if (state === 'online') return '在线'
  if (state === 'degraded') return '待修复'
  if (state === 'disabled') return '已禁用'
  return '离线'
}

export default function ChannelCard({
  channel,
  platformInfo,
  isToggling,
  togglingAnyChannel,
  togglingAnotherChannel,
  repairingPluginChannelId,
  onOpenModelConfig,
  onToggleEnabled,
  onOpenPairing,
  onOpenDiagnostics,
  onRepairPlugin,
  onRemove,
}: ChannelCardProps) {
  return (
    <Card
      padding="lg"
      withBorder
      className={`transition-colors duration-200 ${
        channel.pairingRequired ? 'cursor-pointer' : ''
      }`}
      style={channel.pairingRequired ? { '--hover-bg': 'var(--app-bg-tertiary)' } as React.CSSProperties : undefined}
      onMouseEnter={(e) => {
        if (channel.pairingRequired) e.currentTarget.style.backgroundColor = 'var(--app-bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        if (channel.pairingRequired) e.currentTarget.style.backgroundColor = ''
      }}
      onClick={channel.pairingRequired ? onOpenPairing : undefined}
    >
      <div className="space-y-3">
        {/* 信息区：Logo + 名称 + 所有状态标签 */}
        <Group gap="sm" align="center" wrap="wrap">
          {platformInfo.logo
            ? <img src={platformInfo.logo} alt={platformInfo.name} style={{ width: 32, height: 32 }} />
            : <Text size="2xl">❓</Text>
          }
          <Text size="lg" fw={600}>{channel.name}</Text>
          <Badge variant="light" size="sm">
            {platformInfo.name}
          </Badge>
          <Badge variant="light" size="sm" color={channel.enabled ? 'teal' : 'gray'}>
            {getChannelEnabledLabel(channel.enabled)}
          </Badge>
          {channel.channelId === 'feishu' && (
            <Badge
              variant="light"
              size="sm"
              color={getRuntimeBadgeColor(channel.runtimeState)}
            >
              {getRuntimeLabel(channel.runtimeState)}
            </Badge>
          )}
          {shouldShowPluginStatus(channel) && channel.pluginStatus && getVisiblePluginStatusStages(channel.pluginStatus).map((stage) => (
            <Badge
              key={`${channel.id}:${stage.id}`}
              variant="light"
              size="sm"
              color={getOfficialChannelStageColor(stage.state)}
            >
              {getOfficialChannelStageLabel(stage.id)}
            </Badge>
          ))}
        </Group>

        {/* 操作区：所有按钮 */}
        <Group gap="xs" justify="flex-end" wrap="wrap">
          {channel.channelId === 'feishu' && channel.agentId && (
            <Button
              variant="light"
              size="sm"
              disabled={togglingAnyChannel}
              onClick={(event) => {
                event.stopPropagation()
                onOpenModelConfig()
              }}
              className="cursor-pointer"
            >
              配置模型
            </Button>
          )}
          <Button
            color={channel.enabled ? 'orange' : 'teal'}
            variant="light"
            size="sm"
            disabled={togglingAnotherChannel}
            loading={isToggling}
            onClick={(event) => {
              event.stopPropagation()
              onToggleEnabled()
            }}
            className="cursor-pointer"
          >
            {channel.enabled ? '禁用' : '启用'}
          </Button>
          {channel.pairingRequired && (
            <Button
              variant="light"
              size="sm"
              disabled={togglingAnyChannel}
              onClick={(event) => {
                event.stopPropagation()
                onOpenPairing()
              }}
              className="cursor-pointer"
            >
              配对管理
            </Button>
          )}
          {shouldShowFeishuPluginRepairAction(channel) && (
            <Button
              variant="light"
              size="sm"
              disabled={togglingAnyChannel || (Boolean(repairingPluginChannelId) && repairingPluginChannelId !== channel.channelId)}
              loading={repairingPluginChannelId === channel.channelId}
              onClick={(event) => {
                event.stopPropagation()
                onRepairPlugin()
              }}
              className="cursor-pointer"
            >
              修复飞书插件
            </Button>
          )}
          <Button
            color="red"
            variant="light"
            size="sm"
            disabled={togglingAnyChannel}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            className="cursor-pointer"
          >
            删除
          </Button>
        </Group>
      </div>
    </Card>
  )
}
