import { useEffect, useState } from 'react'
import { Loader, Alert, Group, Text } from '@mantine/core'
import { AgentManagement } from './AgentManagement/AgentManagement'
import type { Agent } from './AgentManagement/AgentList'

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchAgents = async () => {
    try {
      setError('')
      const config = await window.api.readConfig()
      if (config && config.agents && Array.isArray(config.agents.list)) {
        const list = config.agents.list
        const mainAgent = list.find((a: any) => a.id === 'main')
        const allowedAgents = mainAgent?.subagents?.allowAgents || []

        const mappedAgents = list.map((a: any) => {
          const boundBindings = (config.bindings || []).filter((b: any) => b.agentId === a.id)
          const workspace = a.id === 'main' ? config.agents?.defaults?.workspace || '' : a.workspace

          let feishuAppId = ''
          let feishuAppSecret = ''
          if (config.channels?.feishu?.accounts?.[a.id]) {
            feishuAppId = config.channels.feishu.accounts[a.id].appId || ''
            feishuAppSecret = config.channels.feishu.accounts[a.id].appSecret || ''
          }

          return {
            ...a,
            workspace,
            allowDispatch: allowedAgents.includes(a.id),
            bindings: boundBindings,
            feishuAppId,
            feishuAppSecret,
          }
        })
        setAgents(mappedAgents)
      } else {
        setAgents([])
      }
    } catch (e) {
      setError('读取配置失败: ' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchAgents()
  }, [])

  const handleUpdateAgent = async (agent: Agent) => {
    try {
      const config = await window.api.readConfig()
      if (!config) return

      const beforeConfig = JSON.parse(JSON.stringify(config))
      const nextConfig = JSON.parse(JSON.stringify(config))

      if (!nextConfig.agents) nextConfig.agents = { list: [] }
      const list = nextConfig.agents.list || []

      let mainAgent = list.find((a: any) => a.id === 'main')
      if (!mainAgent) {
        mainAgent = { id: 'main', subagents: { allowAgents: [] } }
        list.push(mainAgent)
      }

      if (!mainAgent.subagents) mainAgent.subagents = { allowAgents: [] }
      if (!mainAgent.subagents.allowAgents) mainAgent.subagents.allowAgents = []

      const allowedAgents = new Set<string>(mainAgent.subagents.allowAgents)
      if (agent.allowDispatch) {
        allowedAgents.add(agent.id)
      } else {
        allowedAgents.delete(agent.id)
      }
      mainAgent.subagents.allowAgents = Array.from(allowedAgents)

      if (agent.id === 'main') {
        if (!nextConfig.agents.defaults) nextConfig.agents.defaults = {}
        nextConfig.agents.defaults.workspace = agent.workspace
      }

      const agentToSave = { ...agent }
      delete agentToSave.allowDispatch
      const newBindings = agentToSave.bindings
      delete agentToSave.bindings
      const feishuAppId = agentToSave.feishuAppId
      const feishuAppSecret = agentToSave.feishuAppSecret
      delete agentToSave.feishuAppId
      delete agentToSave.feishuAppSecret

      if (feishuAppId || feishuAppSecret) {
        if (!nextConfig.channels) nextConfig.channels = {}
        if (!nextConfig.channels.feishu) nextConfig.channels.feishu = { enabled: true, connectionMode: 'websocket', domain: 'feishu', requireMention: true, accounts: {} }
        if (!nextConfig.channels.feishu.accounts) nextConfig.channels.feishu.accounts = {}
        if (!nextConfig.channels.feishu.accounts[agent.id]) nextConfig.channels.feishu.accounts[agent.id] = {}

        if (feishuAppId) nextConfig.channels.feishu.accounts[agent.id].appId = feishuAppId
        if (feishuAppSecret) nextConfig.channels.feishu.accounts[agent.id].appSecret = feishuAppSecret
      } else if (nextConfig.channels?.feishu?.accounts?.[agent.id]) {
        delete nextConfig.channels.feishu.accounts[agent.id].appId
        delete nextConfig.channels.feishu.accounts[agent.id].appSecret
      }

      if (agent.id === 'main') {
        delete agentToSave.workspace
      }

      const index = list.findIndex((a: any) => a.id === agent.id)
      if (index >= 0) {
        list[index] = { ...list[index], ...agentToSave }
      } else {
        list.push(agentToSave)
      }
      nextConfig.agents.list = list

      if (newBindings !== undefined) {
        const otherBindings = (nextConfig.bindings || []).filter((b: any) => b.agentId !== agent.id)
        const agentBindings = newBindings.map((b: any) => ({ ...b, agentId: agent.id }))
        nextConfig.bindings = [...otherBindings, ...agentBindings]
      }

      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig,
        afterConfig: nextConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) throw new Error(writeResult.message)
      await fetchAgents()
    } catch (e) {
      setError('更新 Agent 失败: ' + (e as Error).message)
    }
  }

  const handleCreateAgent = async (newAgent: Partial<Agent>): Promise<string | undefined> => {
    try {
      const config = await window.api.readConfig()
      if (!config) return undefined

      const beforeConfig = JSON.parse(JSON.stringify(config))
      const nextConfig = JSON.parse(JSON.stringify(config))

      if (!nextConfig.agents) nextConfig.agents = { list: [] }
      const list = nextConfig.agents.list || []

      const agentToSave = {
        id: newAgent.id!,
        model: config.agents?.defaults?.model || '',
        workspace: config.agents?.defaults?.workspace
          ? config.agents.defaults.workspace.replace(/workspace(-main)?$/, `workspace-${newAgent.id}`)
          : `~/.openclaw/workspace-${newAgent.id}`,
      }

      list.push(agentToSave)
      nextConfig.agents.list = list

      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig,
        afterConfig: nextConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) throw new Error(writeResult.message)
      await fetchAgents()
      return newAgent.id
    } catch (e) {
      setError('新建 Agent 失败: ' + (e as Error).message)
      return undefined
    }
  }

  const handleDeleteAgent = async (agentId: string) => {
    try {
      const config = await window.api.readConfig()
      if (!config) return

      const beforeConfig = JSON.parse(JSON.stringify(config))
      const nextConfig = JSON.parse(JSON.stringify(config))

      if (!nextConfig.agents) nextConfig.agents = { list: [] }
      const list = nextConfig.agents.list || []

      nextConfig.agents.list = list.filter((a: any) => a.id !== agentId)

      const mainAgent = nextConfig.agents.list.find((a: any) => a.id === 'main')
      if (mainAgent?.subagents?.allowAgents) {
        mainAgent.subagents.allowAgents = mainAgent.subagents.allowAgents.filter((id: string) => id !== agentId)
      }

      if (nextConfig.bindings) {
        nextConfig.bindings = nextConfig.bindings.filter((b: any) => b.agentId !== agentId)
      }

      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig,
        afterConfig: nextConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) throw new Error(writeResult.message)
      await fetchAgents()
    } catch (e) {
      setError('删除 Agent 失败: ' + (e as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="lg" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 h-full flex flex-col">
      <Group justify="space-between">
        <div>
          <Text size="xl" fw={700}>Agent 管理</Text>
          <Text size="sm" c="dimmed" mt={4}>
            管理主/子 Agent 的调用权限、技能、工作区及关联渠道配置
          </Text>
        </div>
      </Group>

      {error && (
        <Alert color="red" title="错误" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <div className="flex-1 min-h-0 bg-transparent rounded-md border app-border">
        <AgentManagement
          agents={agents}
          onUpdateAgent={handleUpdateAgent}
          onCreateAgent={handleCreateAgent}
          onDeleteAgent={handleDeleteAgent}
        />
      </div>
    </div>
  )
}
