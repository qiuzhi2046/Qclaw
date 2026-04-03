import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DashboardChatPanel from '../components/dashboard/DashboardChatPanel'
import type { ChatComposerEnterSendMode } from '../lib/chat-composer-enter-send-preference'
import {
  resolveChatPageAvailabilityState,
  type ChatPageAvailabilityState,
} from './chat-availability-state'
import { resolveChatSelectableModels } from './chat-model-options'
import { createNextRequestId, shouldApplyRequestResult } from './chat-request-guards'

const INITIAL_AVAILABILITY_STATE: ChatPageAvailabilityState = {
  availabilityState: 'loading',
  canSend: false,
  gatewayRunning: false,
  connectedModels: [],
  defaultModel: '',
  availabilityMessage: '正在读取聊天状态...',
}

export default function ChatPage({
  enterSendMode,
}: {
  enterSendMode: ChatComposerEnterSendMode
}) {
  const navigate = useNavigate()
  const [chatAvailability, setChatAvailability] = useState<ChatPageAvailabilityState>(
    INITIAL_AVAILABILITY_STATE
  )
  const availabilityStateRef = useRef<ChatPageAvailabilityState>(INITIAL_AVAILABILITY_STATE)
  const latestAvailabilityRequestIdRef = useRef(0)
  const availabilityInFlightRef = useRef(false)

  const loadAvailability = useCallback(async (): Promise<ChatPageAvailabilityState> => {
    const requestId = createNextRequestId(latestAvailabilityRequestIdRef.current)
    latestAvailabilityRequestIdRef.current = requestId
    availabilityInFlightRef.current = true

    try {
      const nextState = await resolveChatPageAvailabilityState({
        getChatAvailability: () => window.api.getChatAvailability(),
        gatewayHealth: () => window.api.gatewayHealth(),
        readConfig: () => window.api.readConfig(),
      })

      if (shouldApplyRequestResult(requestId, latestAvailabilityRequestIdRef.current)) {
        availabilityStateRef.current = nextState
        setChatAvailability(nextState)
      }
      return nextState
    } catch (error) {
      console.error('ChatPage: failed to resolve availability', error)
      return availabilityStateRef.current
    } finally {
      if (shouldApplyRequestResult(requestId, latestAvailabilityRequestIdRef.current)) {
        availabilityInFlightRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    void loadAvailability()
    const intervalId = window.setInterval(() => {
      if (availabilityInFlightRef.current) return
      void loadAvailability()
    }, 10000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadAvailability])

  const {
    availabilityState,
    canSend,
    gatewayRunning,
    connectedModels,
    defaultModel,
    availabilityMessage,
  } = chatAvailability
  const selectableModels = resolveChatSelectableModels({
    connectedModels,
    defaultModel,
  })

  const handleEnsureGateway = async (): Promise<boolean> => {
    try {
      if (!gatewayRunning) {
        const ensureResult = await window.api.ensureGatewayRunning()
        if (!ensureResult?.ok || !ensureResult?.running) return false
        const nextState = await loadAvailability()
        return nextState.canSend
      }
      const nextState = await loadAvailability()
      return nextState.canSend
    } catch (e) {
      console.error('Failed to ensure gateway ready', e)
      return false
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <DashboardChatPanel
        availabilityState={availabilityState}
        canSend={canSend}
        gatewayRunning={gatewayRunning}
        connectedModels={selectableModels}
        defaultModel={defaultModel}
        availabilityMessage={availabilityMessage}
        onOpenSettings={() => navigate('/models')}
        onEnsureGatewayRunning={handleEnsureGateway}
        enterSendMode={enterSendMode}
      />
    </div>
  )
}
