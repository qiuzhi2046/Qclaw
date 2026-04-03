import { Card, Text, ScrollArea, Group, Badge, Button, TextInput, Stack } from '@mantine/core'
import { modals } from '@mantine/modals'

export interface Agent {
  id: string
  name?: string
  allowDispatch?: boolean
  bindings?: any[]
  feishuAppId?: string
  feishuAppSecret?: string
  [key: string]: any
}

interface AgentListProps {
  agents: Agent[]
  selectedId?: string | null
  onSelect: (id: string) => void
  onCreateAgent?: (agent: Partial<Agent>) => Promise<void> | void
}

export function AgentList({ agents, selectedId, onSelect, onCreateAgent }: AgentListProps) {
  const handleCreateClick = () => {
    if (!onCreateAgent) return
    let newId = ''
    modals.open({
      title: '新建 Agent',
      children: (
        <Stack>
          <TextInput
            label="Agent ID"
            placeholder="例如: designer, data-analyst"
            required
            onChange={(e) => {
              newId = e.currentTarget.value
            }}
            description="只能包含字母、数字和连字符，作为唯一标识"
          />
          <Button fullWidth onClick={async () => {
            if (!newId.trim() || !/^[a-zA-Z0-9-]+$/.test(newId.trim())) {
              alert('ID 格式不正确')
              return
            }
            if (agents.find(a => a.id === newId.trim())) {
              alert('ID 已存在')
              return
            }
            await onCreateAgent({ id: newId.trim() })
            modals.closeAll()
          }}>
            创建
          </Button>
        </Stack>
      ),
    })
  }

  return (
    <div className="w-[300px] flex-shrink-0">
      <ScrollArea h="calc(100vh - 200px)" type="auto">
        <div className="space-y-3 pr-4">
          {onCreateAgent && (
            <Button variant="light" color="blue" onClick={handleCreateClick} fullWidth>
              + 新建 Agent
            </Button>
          )}
          {agents.length === 0 ? (
            <Card padding="xl" withBorder className="text-center">
              <Text size="sm" c="dimmed">
                暂无 Agent
              </Text>
            </Card>
          ) : (
            agents.map((agent) => {
              const isSelected = selectedId === agent.id
              return (
                <Card
                  key={agent.id}
                  padding="md"
                  withBorder
                  className="cursor-pointer transition-colors duration-200"
                  style={{
                    backgroundColor: isSelected ? 'var(--mantine-color-blue-light)' : undefined,
                    borderColor: isSelected ? 'var(--mantine-color-blue-filled)' : undefined,
                  }}
                  onClick={() => onSelect(agent.id)}
                >
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <div className="overflow-hidden">
                      <Text fw={600} truncate>{agent.name || agent.id}</Text>
                      <Text size="xs" c="dimmed" mt={4} truncate>
                        ID: {agent.id}
                      </Text>
                    </div>
                    {agent.allowDispatch && (
                      <Badge size="xs" color="blue" variant="light" className="flex-shrink-0">
                        可调度
                      </Badge>
                    )}
                  </Group>
                </Card>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
