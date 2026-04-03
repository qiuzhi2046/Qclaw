import { useEffect, useState, useCallback } from 'react'
import { Switch, Card, Text, Group, Divider, TextInput, Button, Badge, Loader, ActionIcon, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import type { Agent } from './AgentList'

interface AgentDetailsProps {
  agent: Agent
  onUpdate: (agent: Agent) => void
  onDelete?: (agentId: string) => void
}

interface SkillInfo {
  name: string
  title?: string
  description?: string
  source?: string
  path?: string
}

export function AgentDetails({ agent, onUpdate, onDelete }: AgentDetailsProps) {
  const [workspace, setWorkspace] = useState(agent.workspace || '')
  const [agentDir, setAgentDir] = useState(agent.agentDir || '')
  const [model, setModel] = useState(agent.model || '')
  const [feishuAppId, setFeishuAppId] = useState(agent.feishuAppId || '')
  const [feishuAppSecret, setFeishuAppSecret] = useState(agent.feishuAppSecret || '')
  const [sharedSkills, setSharedSkills] = useState<SkillInfo[]>([])
  const [exclusiveSkills, setExclusiveSkills] = useState<SkillInfo[]>([])
  const [loadingSkills, setLoadingSkills] = useState(false)

  const loadSkills = useCallback(async () => {
    setLoadingSkills(true)
    try {
      const sharedResult = await window.api.skillsList()
      if (sharedResult.ok && sharedResult.stdout) {
        const parsed = JSON.parse(sharedResult.stdout)
        const list = Array.isArray(parsed) ? parsed : (parsed.skills || [])
        setSharedSkills(list.filter((s: any) => s.source !== 'openclaw-workspace'))
      }

      if (agent.workspace) {
        const exclusiveResult = await window.api.skillsWorkspaceList(agent.workspace)
        if (exclusiveResult.ok && exclusiveResult.stdout) {
          setExclusiveSkills(JSON.parse(exclusiveResult.stdout))
        } else {
          setExclusiveSkills([])
        }
      } else {
        setExclusiveSkills([])
      }
    } catch (e) {
      console.error('Failed to load skills:', e)
    } finally {
      setLoadingSkills(false)
    }
  }, [agent.workspace])

  useEffect(() => {
    setWorkspace(agent.workspace || '')
    setAgentDir(agent.agentDir || '')
    setModel(agent.model || '')
    setFeishuAppId(agent.feishuAppId || '')
    setFeishuAppSecret(agent.feishuAppSecret || '')
    void loadSkills()
  }, [agent, loadSkills])

  const handleSave = () => {
    const updatedAgent: Agent = {
      ...agent,
      workspace,
      agentDir,
      model,
      feishuAppId,
      feishuAppSecret,
    }

    onUpdate(updatedAgent)
  }

  const handleDeleteSharedSkill = (skillName: string) => {
    modals.openConfirmModal({
      title: '确认删除共享技能',
      children: (
        <Text size="sm">
          您确定要删除共享技能 <b>{skillName}</b> 吗？删除后将无法恢复，所有 Agent 都将无法使用此技能。
        </Text>
      ),
      labels: { confirm: '确认删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res = await window.api.skillsUninstall(skillName)
          if (res.ok) {
            await loadSkills()
          } else {
            alert('删除失败: ' + res.stderr)
          }
        } catch (e) {
          alert('删除失败: ' + String(e))
        }
      },
    })
  }

  const handleDeleteExclusiveSkill = (skillName: string) => {
    if (!agent.workspace) return
    modals.openConfirmModal({
      title: '确认删除专属技能',
      children: (
        <Text size="sm">
          您确定要删除专属技能 <b>{skillName}</b> 吗？删除后将无法恢复。
        </Text>
      ),
      labels: { confirm: '确认删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res = await window.api.skillsWorkspaceUninstall(agent.workspace!, skillName)
          if (res.ok) {
            await loadSkills()
          } else {
            alert('删除失败: ' + res.stderr)
          }
        } catch (e) {
          alert('删除失败: ' + String(e))
        }
      },
    })
  }

  const handleDeleteAgent = () => {
    if (!onDelete) return
    modals.openConfirmModal({
      title: '确认删除 Agent',
      children: (
        <Text size="sm">
          您确定要删除 Agent <b>{agent.name || agent.id}</b> 吗？相关配置将被清理。此操作不可恢复。
        </Text>
      ),
      labels: { confirm: '确认删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        if (agent.workspace) {
          modals.openConfirmModal({
            title: '是否同时删除工作区内容？',
            children: (
              <Text size="sm">
                是否要同时从磁盘中删除该 Agent 关联的工作区目录 <b>{agent.workspace}</b>？<br />
                如果您在其它地方也使用了此目录，请选择“保留工作区目录”。
              </Text>
            ),
            labels: { confirm: '连同目录一起删除', cancel: '保留工作区目录' },
            confirmProps: { color: 'red' },
            onConfirm: async () => {
              await window.api.workspaceDelete(agent.workspace!)
              onDelete(agent.id)
            },
            onCancel: () => {
              onDelete(agent.id)
            },
            onClose: () => {
              onDelete(agent.id)
            },
          })
        } else {
          onDelete(agent.id)
        }
      },
    })
  }

  return (
    <Card padding="lg" withBorder shadow="sm" className="h-full flex flex-col">
      <Group justify="space-between" mb="md">
        <div>
          <Text size="xl" fw={700}>{agent.name || agent.id}</Text>
          <Text size="sm" c="dimmed" mt={4}>ID: {agent.id}</Text>
        </div>
        {agent.id !== 'main' && onDelete && (
          <Button color="red" variant="light" size="sm" onClick={handleDeleteAgent}>
            删除 Agent
          </Button>
        )}
      </Group>
      <Divider mb="lg" />

      <div className="space-y-6 flex-1 overflow-y-auto pr-4">
        {agent.id !== 'main' && (
          <div>
            <Text fw={500} size="md" mb="xs">调度设置</Text>
            <Card padding="md" withBorder>
              <Group justify="space-between" align="center" wrap="nowrap">
                <div>
                  <Text fw={500} size="sm">允许主 Agent 调度</Text>
                  <Text size="xs" c="dimmed" mt={2}>开启后，主 Agent 可以将任务分发给该 Agent 执行</Text>
                </div>
                <Switch
                  size="md"
                  checked={agent.allowDispatch || false}
                  onChange={(e) => onUpdate({ ...agent, allowDispatch: e.currentTarget.checked })}
                />
              </Group>
            </Card>
          </div>
        )}

        <div>
          <Text fw={500} size="md" mb="xs">关联渠道</Text>
          <Card padding="md" withBorder>
            {agent.bindings && agent.bindings.length > 0 ? (
              <Group gap="xs">
                {agent.bindings.map((b: any, i: number) => {
                  const channelStr = b.match?.channel ? b.match.channel : 'Unknown'
                  const accountStr = b.match?.accountId ? ` (${b.match.accountId})` : ''
                  const peerStr = b.match?.peer?.id ? ` (群/单聊: ${b.match.peer.id})` : ''
                  return (
                    <Badge key={i} color="indigo" variant="light">
                      {channelStr}{accountStr}{peerStr}
                    </Badge>
                  )
                })}
              </Group>
            ) : (
              <Text size="sm" c="dimmed">暂未绑定任何渠道</Text>
            )}
          </Card>
        </div>

        <div>
          <Text fw={500} size="md" mb="xs">技能管理</Text>
          <Card padding="md" withBorder>
            {loadingSkills ? (
              <Group justify="center" py="md"><Loader size="sm" /></Group>
            ) : (
              <div className="space-y-4">
                <div>
                  <Text size="sm" fw={500} mb="xs">专属技能 (当前 Agent Workspace)</Text>
                  {exclusiveSkills.length > 0 ? (
                    <div className="space-y-2">
                      {exclusiveSkills.map((skill, idx) => (
                        <Card key={idx} padding="sm" withBorder shadow="none">
                          <Group justify="space-between" wrap="nowrap">
                            <div className="flex-1 min-w-0">
                              <Text size="sm" fw={500} truncate>{skill.title || skill.name}</Text>
                              <Text size="xs" c="dimmed" truncate>{skill.description || '暂无描述'}</Text>
                            </div>
                            <Tooltip label="删除该专属技能">
                              <ActionIcon color="red" variant="light" onClick={() => handleDeleteExclusiveSkill(skill.name)}>
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <Text size="sm" c="dimmed">无专属技能</Text>
                  )}
                </div>

                <div>
                  <Text size="sm" fw={500} mb="xs">共享技能 (~/.openclaw/skills)</Text>
                  {sharedSkills.length > 0 ? (
                    <div className="space-y-2">
                      {sharedSkills.map((skill, idx) => (
                        <Card key={idx} padding="sm" withBorder shadow="none">
                          <Group justify="space-between" wrap="nowrap">
                            <div className="flex-1 min-w-0">
                              <Group gap="xs">
                                <Text size="sm" fw={500} truncate>{skill.title || skill.name}</Text>
                                {skill.source === 'openclaw-bundled' && <Badge size="xs" variant="light">内置</Badge>}
                              </Group>
                              <Text size="xs" c="dimmed" truncate>{skill.description || '暂无描述'}</Text>
                            </div>
                            {agent.id === 'main' && skill.source !== 'openclaw-bundled' && (
                              <Tooltip label="删除该共享技能">
                                <ActionIcon color="red" variant="light" onClick={() => handleDeleteSharedSkill(skill.name)}>
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <Text size="sm" c="dimmed">无共享技能</Text>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>

        <div>
          <Text fw={500} size="md" mb="xs">基础配置</Text>
          <Card padding="md" withBorder className="space-y-4">
            <TextInput
              label="模型 (Model)"
              placeholder="例如: volcengine-plan/doubao-seed-2.0-pro"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
              description="配置该 Agent 优先使用的大语言模型"
            />
            <TextInput
              label="工作区 (Workspace)"
              placeholder="工作区路径"
              value={workspace}
              onChange={(e) => setWorkspace(e.currentTarget.value)}
              description="Agent 执行任务时使用的本地工作目录"
            />
            <TextInput
              label="Agent 目录 (AgentDir)"
              placeholder="Agent 配置文件所在目录"
              value={agentDir}
              onChange={(e) => setAgentDir(e.currentTarget.value)}
              description="存储 Agent 提示词、技能配置的目录"
            />
          </Card>
        </div>

        <div>
          <Text fw={500} size="md" mb="xs">飞书渠道配置 (Feishu Channel)</Text>
          <Card padding="md" withBorder className="space-y-4">
            <TextInput
              label="App ID"
              placeholder="cli_..."
              value={feishuAppId}
              onChange={(e) => setFeishuAppId(e.currentTarget.value)}
              description="飞书机器人的 App ID"
            />
            <TextInput
              label="App Secret"
              placeholder="输入应用密钥"
              type="password"
              value={feishuAppSecret}
              onChange={(e) => setFeishuAppSecret(e.currentTarget.value)}
              description="飞书机器人的 App Secret"
            />
            <div className="pt-2">
              <Button onClick={handleSave}>保存配置</Button>
            </div>
          </Card>
        </div>
      </div>
    </Card>
  )
}
