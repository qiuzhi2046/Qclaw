import { useState, useEffect } from 'react'
import { AgentList, type Agent } from './AgentList'
import { AgentDetails } from './AgentDetails'

export interface AgentManagementProps {
  agents: Agent[]
  onUpdateAgent: (agent: Agent) => void
  onCreateAgent?: (agent: Partial<Agent>) => Promise<string | undefined>
  onDeleteAgent?: (agentId: string) => void
}

export function AgentManagement({ agents, onUpdateAgent, onCreateAgent, onDeleteAgent }: AgentManagementProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(agents[0]?.id)

  useEffect(() => {
    if (!selectedId && agents.length > 0) {
      setSelectedId(agents[0].id)
    }
  }, [agents, selectedId])

  const selectedAgent = agents.find((a) => a.id === selectedId)

  const handleCreate = async (agentData: Partial<Agent>) => {
    if (!onCreateAgent) return
    const newId = await onCreateAgent(agentData)
    if (newId) {
      setSelectedId(newId)
    }
  }

  return (
    <div className="p-6 h-full">
      <div className="flex gap-6 h-full">
        <AgentList agents={agents} selectedId={selectedId} onSelect={setSelectedId} onCreateAgent={onCreateAgent ? handleCreate : undefined} />
        <div className="flex-1 min-w-0">
          {selectedAgent ? (
            <AgentDetails agent={selectedAgent} onUpdate={onUpdateAgent} onDelete={onDeleteAgent} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">请选择或创建一个 Agent</div>
          )}
        </div>
      </div>
    </div>
  )
}
