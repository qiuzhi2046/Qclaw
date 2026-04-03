import { useState } from 'react'
import { Card, Badge, Group, Text, ActionIcon, Menu } from '@mantine/core'
import { IconSettings, IconTrash, IconPlayerPlay, IconPlayerPause, IconLink, IconCpu, IconTool, IconPencil } from '@tabler/icons-react'
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
  displayName: string
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
  onRepairPlugin: () => void
  onRename: () => void
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

function getStatusBorderColor(channel: ChannelCardChannel): string {
  if (!channel.enabled) return 'var(--mantine-color-gray-5)'
  if (channel.channelId === 'feishu') {
    if (channel.runtimeState === 'online') return 'var(--mantine-color-orange-6)'
    if (channel.runtimeState === 'degraded') return 'var(--mantine-color-yellow-6)'
    if (channel.runtimeState === 'disabled') return 'var(--mantine-color-gray-5)'
    return 'var(--mantine-color-red-6)'
  }
  return 'var(--mantine-color-orange-6)'
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
  onRepairPlugin,
  onRename,
  onRemove,
}: ChannelCardProps) {
  const [menuOpened, setMenuOpened] = useState(false)

  return (
    <Card
      padding={0}
      withBorder
      radius="md"
      className={`transition-colors duration-200 ${
        channel.pairingRequired ? 'cursor-pointer' : ''
      }`}
      style={{
        borderLeft: `3px solid ${getStatusBorderColor(channel)}`,
        overflow: 'visible',
      }}
      onMouseEnter={(e) => {
        if (channel.pairingRequired) e.currentTarget.style.backgroundColor = 'var(--app-bg-tertiary)'
      }}
      onMouseLeave={(e) => {
        if (channel.pairingRequired) e.currentTarget.style.backgroundColor = ''
      }}
      onClick={channel.pairingRequired ? onOpenPairing : undefined}
    >
      <div style={{ padding: '14px 16px' }}>
        <Group gap="sm" align="center" wrap="wrap" justify="space-between">
          <Group gap="sm" align="center" wrap="wrap" style={{ flex: 1 }}>
            {platformInfo.logo
              ? <img src={platformInfo.logo} alt={platformInfo.name} style={{ width: 28, height: 28, borderRadius: 6 }} />
              : <Text size="xl">❓</Text>
            }
            <Text size="md" fw={600} style={{ lineHeight: 1.2 }}>{channel.displayName}</Text>

            <Badge variant="light" size="xs" radius="sm" color="gray" style={{ textTransform: 'none' }}>
              {platformInfo.name}
            </Badge>

            <Badge
              variant="dot"
              size="xs"
              color={channel.enabled ? 'teal' : 'gray'}
            >
              {getChannelEnabledLabel(channel.enabled)}
            </Badge>

            {channel.channelId === 'feishu' && (
              <Badge
                variant="dot"
                size="xs"
                color={getRuntimeBadgeColor(channel.runtimeState)}
              >
                {getRuntimeLabel(channel.runtimeState)}
              </Badge>
            )}

            {shouldShowPluginStatus(channel) && channel.pluginStatus && getVisiblePluginStatusStages(channel.pluginStatus).map((stage) => (
              <Badge
                key={`${channel.id}:${stage.id}`}
                variant="dot"
                size="xs"
                color={getOfficialChannelStageColor(stage.state)}
              >
                {getOfficialChannelStageLabel(stage.id)}
              </Badge>
            ))}
          </Group>

          <Menu
            opened={menuOpened}
            onChange={setMenuOpened}
            position="bottom-end"
            shadow="md"
            withinPortal
          >
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenuOpened((o) => !o)
                }}
                className="cursor-pointer"
              >
                <IconSettings size={18} />
              </ActionIcon>
            </Menu.Target>

            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconPencil size={14} />}
                onClick={(event) => {
                  event.stopPropagation()
                  onRename()
                }}
              >
                重命名
              </Menu.Item>

              {channel.channelId === 'feishu' && channel.agentId && (
                <Menu.Item
                  leftSection={<IconCpu size={14} />}
                  disabled={togglingAnyChannel}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenModelConfig()
                  }}
                >
                  配置模型
                </Menu.Item>
              )}

              <Menu.Item
                leftSection={channel.enabled ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                color={channel.enabled ? 'orange' : 'teal'}
                disabled={togglingAnotherChannel || isToggling}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleEnabled()
                }}
              >
                {channel.enabled ? '禁用' : '启用'}
              </Menu.Item>

              {channel.pairingRequired && (
                <Menu.Item
                  leftSection={<IconLink size={14} />}
                  disabled={togglingAnyChannel}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenPairing()
                  }}
                >
                  配对管理
                </Menu.Item>
              )}

              {shouldShowFeishuPluginRepairAction(channel) && (
                <Menu.Item
                  leftSection={<IconTool size={14} />}
                  disabled={togglingAnyChannel || (Boolean(repairingPluginChannelId) && repairingPluginChannelId !== channel.channelId)}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRepairPlugin()
                  }}
                >
                  修复飞书插件
                </Menu.Item>
              )}

              <Menu.Divider />

              <Menu.Item
                leftSection={<IconTrash size={14} />}
                color="red"
                disabled={togglingAnyChannel}
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove()
                }}
              >
                删除
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </div>
    </Card>
  )
}
