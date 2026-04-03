import { Switch, Card, Text, Group, Badge } from '@mantine/core'

export interface Channel {
  id: string
  name?: string
  platform?: string
  enabled?: boolean
  plugins?: Record<string, { enabled: boolean; [key: string]: any }>
  [key: string]: any
}

interface ChannelCardProps {
  channel: Channel
  onUpdatePlugin: (channelId: string, pluginId: string, enabled: boolean) => void
}

export function ChannelCard({ channel, onUpdatePlugin }: ChannelCardProps) {
  return (
    <Card padding="lg" withBorder>
      <Group justify="space-between" align="flex-start" mb="md">
        <div>
          <Group gap="xs">
            <Text fw={600} size="lg">{channel.name || channel.id}</Text>
            {channel.platform && (
              <Badge variant="light" size="sm">{channel.platform}</Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" mt={4}>ID: {channel.id}</Text>
        </div>
        <Badge variant="light" size="sm" color={channel.enabled ? 'teal' : 'gray'}>
          {channel.enabled ? '已启用' : '已禁用'}
        </Badge>
      </Group>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <Text fw={500} size="sm" mb="md">渠道插件</Text>
        <div className="space-y-3">
          <Group justify="space-between" align="center" wrap="nowrap">
            <div>
              <Text fw={500} size="sm">在线工单收集</Text>
              <Text size="xs" c="dimmed" mt={2}>开启后可在线收集用户反馈并转化为工单</Text>
            </div>
            <Switch
              checked={channel.plugins?.['online-issue']?.enabled || false}
              onChange={(e) => onUpdatePlugin(channel.id, 'online-issue', e.currentTarget.checked)}
            />
          </Group>

          <Group justify="space-between" align="center" wrap="nowrap">
            <div>
              <Text fw={500} size="sm">自动修复</Text>
              <Text size="xs" c="dimmed" mt={2}>遇到运行异常时尝试自动恢复</Text>
            </div>
            <Switch
              checked={channel.plugins?.['auto-repair']?.enabled || false}
              onChange={(e) => onUpdatePlugin(channel.id, 'auto-repair', e.currentTarget.checked)}
            />
          </Group>
        </div>
      </div>
    </Card>
  )
}
