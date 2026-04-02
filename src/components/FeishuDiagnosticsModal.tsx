import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Group, Loader, Modal, Select, Stack, Text } from '@mantine/core'

import type {
  FeishuBotDiagnosticListenResult,
  FeishuBotDiagnosticSendResult,
} from '../shared/feishu-diagnostics'

interface FeishuDiagnosticsModalProps {
  opened: boolean
  onClose: () => void
  accountId: string
  botLabel: string
  agentId?: string
}

interface PairedFeishuAccount {
  openId: string
  name: string
}

function getAlertColor(result: { ok: boolean; detected?: boolean }): string {
  if (!result.ok) return 'red'
  if (typeof result.detected === 'boolean') {
    return result.detected ? 'green' : 'yellow'
  }
  return 'green'
}

function formatDuration(waitedMs: number): string {
  if (!Number.isFinite(waitedMs) || waitedMs <= 0) return '0s'
  return `${Math.max(1, Math.round(waitedMs / 1000))}s`
}

export default function FeishuDiagnosticsModal({
  opened,
  onClose,
  accountId,
  botLabel,
  agentId,
}: FeishuDiagnosticsModalProps) {
  const [pairedAccounts, setPairedAccounts] = useState<PairedFeishuAccount[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [accountsError, setAccountsError] = useState('')
  const [selectedOpenId, setSelectedOpenId] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [sending, setSending] = useState(false)
  const [listenResult, setListenResult] = useState<FeishuBotDiagnosticListenResult | null>(null)
  const [sendResult, setSendResult] = useState<FeishuBotDiagnosticSendResult | null>(null)
  const mountedRef = useRef(true)
  const activeListenRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const requestId = activeListenRequestIdRef.current
      activeListenRequestIdRef.current = null
      if (requestId) {
        void window.api.cancelFeishuBotDiagnosticListen(requestId).catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    if (!opened) return
    let active = true

    setListenResult(null)
    setSendResult(null)
    setAccountsError('')
    setLoadingAccounts(true)

    void window.api.pairingFeishuAccounts(accountId)
      .then((accounts) => {
        if (!active || !mountedRef.current) return
        const normalized = Array.isArray(accounts) ? accounts : []
        setPairedAccounts(normalized)
        setSelectedOpenId((current) => {
          if (current && normalized.some((item) => item.openId === current)) return current
          return normalized[0]?.openId || null
        })
      })
      .catch((error) => {
        if (!active || !mountedRef.current) return
        setPairedAccounts([])
        setSelectedOpenId(null)
        setAccountsError(error instanceof Error ? error.message : '读取已配对用户失败')
      })
      .finally(() => {
        if (!active || !mountedRef.current) return
        setLoadingAccounts(false)
      })

    return () => {
      active = false
    }
  }, [opened, accountId])

  const pairedAccountOptions = useMemo(
    () =>
      pairedAccounts.map((item) => ({
        value: item.openId,
        label: item.name ? `${item.name} (${item.openId})` : item.openId,
      })),
    [pairedAccounts]
  )

  const selectedRecipient = pairedAccounts.find((item) => item.openId === selectedOpenId) || null

  const cancelActiveListen = () => {
    const requestId = activeListenRequestIdRef.current
    activeListenRequestIdRef.current = null
    if (requestId) {
      void window.api.cancelFeishuBotDiagnosticListen(requestId).catch(() => undefined)
    }
    if (mountedRef.current) {
      setListening(false)
    }
  }

  const handleClose = () => {
    cancelActiveListen()
    onClose()
  }

  const handleListen = async () => {
    const startedAt = new Date().toISOString()
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `feishu-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`
    activeListenRequestIdRef.current = requestId
    setListening(true)
    setListenResult(null)
    try {
      const result = await window.api.listenFeishuBotDiagnosticActivity(accountId, 60_000, requestId)
      if (!mountedRef.current || activeListenRequestIdRef.current !== requestId) return
      setListenResult(result)
    } catch (error) {
      if (!mountedRef.current || activeListenRequestIdRef.current !== requestId) return
      setListenResult({
        ok: false,
        detected: false,
        accountId,
        activityKind: 'none',
        summary: '监听当前机器人活动失败，请稍后重试。',
        startedAt,
        endedAt: new Date().toISOString(),
        timeoutMs: 60_000,
        waitedMs: 0,
        code: 1,
        stderr: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (activeListenRequestIdRef.current === requestId) {
        activeListenRequestIdRef.current = null
      }
      if (mountedRef.current) {
        setListening(false)
      }
    }
  }

  const handleSend = async () => {
    if (!selectedOpenId) return
    const sentAt = new Date().toISOString()
    setSending(true)
    setSendResult(null)
    try {
      const result = await window.api.sendFeishuDiagnosticMessage({
        accountId,
        openId: selectedOpenId,
        recipientName: selectedRecipient?.name,
        botLabel,
      })
      if (!mountedRef.current) return
      setSendResult(result)
    } catch (error) {
      if (!mountedRef.current) return
      setSendResult({
        ok: false,
        accountId,
        openId: selectedOpenId,
        recipientName: selectedRecipient?.name,
        botLabel,
        agentId: agentId || 'unknown-agent',
        machineLabel: 'unknown-machine',
        traceId: 'trace-unavailable',
        sentAt,
        sentText: '',
        summary: '发送定位消息失败，请稍后重试。',
        code: 1,
        stderr: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (mountedRef.current) {
        setSending(false)
      }
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={`${botLabel} 故障排查`}
      size="lg"
    >
      <Stack gap="md">
        <Alert color="blue" variant="light" title="当前检查目标">
          <Text size="sm">机器人：{botLabel}</Text>
          <Text size="sm">accountId：{accountId}</Text>
          {agentId && <Text size="sm">Agent：{agentId}</Text>}
        </Alert>

        <Card withBorder padding="md">
          <Stack gap="sm">
            <div>
              <Text fw={600}>监听下一条消息</Text>
              <Text size="sm" c="dimmed">
                点击开始后，请立刻在飞书里给这个机器人发送一条消息。Qclaw 会在当前机器监听该机器人的本地活动，
                用来判断消息是否真的落到了这台机器上。
              </Text>
            </div>

            <Group justify="space-between" align="center">
              <Text size="xs" c="dimmed">监听窗口：60 秒</Text>
              <Button onClick={() => void handleListen()} loading={listening} disabled={sending}>
                监听下一条消息
              </Button>
            </Group>

            {listening && (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">正在监听当前机器上的机器人本地活动，请在飞书中立即发送一条消息…</Text>
              </Group>
            )}

            {listenResult && (
              <Alert color={getAlertColor(listenResult)} variant="light" title="监听结果">
                <Text size="sm">{listenResult.summary}</Text>
                <Text size="xs" c="dimmed">耗时：{formatDuration(listenResult.waitedMs)}</Text>
                {listenResult.evidencePath && (
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    证据路径：{listenResult.evidencePath}
                  </Text>
                )}
                {!listenResult.ok && listenResult.stderr && (
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                    错误详情：{listenResult.stderr}
                  </Text>
                )}
              </Alert>
            )}
          </Stack>
        </Card>

        <Card withBorder padding="md">
          <Stack gap="sm">
            <div>
              <Text fw={600}>发送定位消息</Text>
              <Text size="sm" c="dimmed">
                从当前这台机器的这个机器人，主动给一个已配对用户发送定位消息，用来确认“到底是哪一台机器、哪一个机器人在发消息”。
              </Text>
            </div>

            {accountsError && (
              <Alert color="red" variant="light" title="已配对用户读取失败">
                <Text size="sm">{accountsError}</Text>
              </Alert>
            )}

            {loadingAccounts ? (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">正在读取已配对用户…</Text>
              </Group>
            ) : pairedAccountOptions.length > 0 ? (
              <>
                <Select
                  label="接收定位消息的已配对用户"
                  placeholder="选择一个已配对用户"
                  data={pairedAccountOptions}
                  value={selectedOpenId}
                  onChange={setSelectedOpenId}
                  searchable
                  nothingFoundMessage="没有匹配的已配对用户"
                />
                <Group justify="space-between" align="center">
                  <Text size="xs" c="dimmed">
                    定位消息会带上机器人名称、accountId、agentId、机器名和 traceId。
                  </Text>
                  <Button onClick={() => void handleSend()} loading={sending} disabled={!selectedOpenId || listening}>
                    发送定位消息
                  </Button>
                </Group>
              </>
            ) : (
              <Alert color="yellow" variant="light" title="还没有可发送对象">
                <Text size="sm">当前机器人还没有已配对用户，暂时无法发送定位消息。</Text>
              </Alert>
            )}

            {sendResult && (
              <Alert color={getAlertColor(sendResult)} variant="light" title="发送结果">
                <Text size="sm">{sendResult.summary}</Text>
                <Text size="xs" c="dimmed">traceId：{sendResult.traceId}</Text>
                {sendResult.messageId && <Text size="xs" c="dimmed">messageId：{sendResult.messageId}</Text>}
                {!sendResult.ok && sendResult.stderr && (
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                    错误详情：{sendResult.stderr}
                  </Text>
                )}
              </Alert>
            )}
          </Stack>
        </Card>
      </Stack>
    </Modal>
  )
}
