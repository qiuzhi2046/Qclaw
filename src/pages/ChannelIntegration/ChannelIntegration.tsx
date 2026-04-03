import { ScrollArea, Card, Text } from '@mantine/core'
import { ChannelCard, type Channel } from './ChannelCard'

export interface ChannelIntegrationProps {
  channels: Channel[]
  onUpdatePlugin: (channelId: string, pluginId: string, enabled: boolean) => void
}

export function ChannelIntegration({ channels, onUpdatePlugin }: ChannelIntegrationProps) {
  return (
    <div className="p-6 h-full">
      <ScrollArea h="calc(100vh - 200px)" type="auto">
        <div className="space-y-4 pr-4">
          {channels.length === 0 ? (
            <Card padding="xl" withBorder className="text-center">
              <Text size="sm" c="dimmed">
                暂无配置的 IM 渠道
              </Text>
            </Card>
          ) : (
            channels.map((channel) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                onUpdatePlugin={onUpdatePlugin}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
