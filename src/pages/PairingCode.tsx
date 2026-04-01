import { useState, useEffect, useRef } from 'react'
import { TextInput, Button, Alert, Text, Stack, Group, Card, Badge, Loader, Transition } from '@mantine/core'
import { parsePairingInput, shouldUseAllowFromFallback, buildPairingApprovalFeedback, isPairingCodeReady } from './pairing-utils'
import { UI_RUNTIME_DEFAULTS } from '../shared/runtime-policies'
import { toUserFacingCliFailureMessage } from '../lib/user-facing-cli-feedback'
import feishuIcon from '../assets/channels/feishu.svg'
import wecomIcon from '../assets/channels/wecom.svg'
import dingtalkIcon from '../assets/channels/dingtalk.svg'
import qqIcon from '../assets/channels/qq.svg'
import weixinIcon from '../assets/channels/weixin.svg'
import lineIcon from '../assets/channels/line.svg'
import telegramIcon from '../assets/channels/telegram.svg'
import slackIcon from '../assets/channels/slack.svg'
import logoUrl from '@/assets/logo.png'

type Status = 'input' | 'pairing' | 'success' | 'error'

const CHANNEL_INFO: Record<string, { name: string; icon: string }> = {
  feishu: { name: '飞书', icon: feishuIcon },
  wecom: { name: '企业微信', icon: wecomIcon },
  dingtalk: { name: '钉钉', icon: dingtalkIcon },
  qqbot: { name: 'QQ', icon: qqIcon },
  'openclaw-weixin': { name: '个人微信', icon: weixinIcon },
  line: { name: 'LINE', icon: lineIcon },
  telegram: { name: 'Telegram', icon: telegramIcon },
  slack: { name: 'Slack', icon: slackIcon },
}

export function getPairingChannelInfo(channel: string): { name: string; icon: string } {
  return CHANNEL_INFO[channel] || CHANNEL_INFO.feishu
}

export default function PairingCode({
  channel = 'feishu',
  accountId,
  accountName,
  surface = 'wizard',
  onBack,
  onComplete,
  onSkip,
  showSkip = true,
  backLabel = '上一步',
  skipLabel = '跳过（稍后配对）',
  completeLabel = '进入控制面板',
}: {
  channel?: string
  accountId?: string
  accountName?: string
  surface?: 'wizard' | 'dashboard'
  onBack: () => void
  onComplete?: () => void
  onSkip?: () => void
  showSkip?: boolean
  backLabel?: string
  skipLabel?: string
  completeLabel?: string
}) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>('input')
  const [log, setLog] = useState('')
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [openClawConfigDisplayPath, setOpenClawConfigDisplayPath] = useState('~/.openclaw/openclaw.json')
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  useEffect(() => {
    window.api.getOpenClawPaths().then((paths) => {
      if (paths?.configFile) {
        setOpenClawConfigDisplayPath(paths.configFile)
      }
    }).catch(() => {
      // keep default
    })
  }, [])

  const channelInfo = getPairingChannelInfo(channel)
  const feishuBotLabel =
    channel === 'feishu'
      ? accountName || (accountId === 'default' ? '默认 Bot' : accountId ? `Bot ${accountId}` : '')
      : ''
  const parsedInput = parsePairingInput(code)
  const canPair = isPairingCodeReady(parsedInput.code)
  const approvalCountdownSeconds = UI_RUNTIME_DEFAULTS.pairing.approvalCountdownSeconds

  const doPair = async () => {
    setStatus('pairing')
    setLog('正在配对，请稍候...\n')
    setError('')
    setCountdown(approvalCountdownSeconds)

    // 启动倒计时
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current)
          return 0
        }
        return prev - 1
      })
    }, UI_RUNTIME_DEFAULTS.pairing.countdownTickMs)

    try {
      const r = await window.api.pairingApprove(channel, parsedInput.code, accountId)

      if (countdownRef.current) clearInterval(countdownRef.current)

      if (r.ok) {
        setLog('✅ 配对成功！\n')
        setStatus('success')
      } else {
        if (shouldUseAllowFromFallback(channel, r, parsedInput.feishuOpenId)) {
          setLog(prev => prev + '⚠️ 未找到待审批配对请求，尝试按飞书用户 ID 兜底授权（多实例兼容）...\n')
          const fallback = await window.api.pairingAddAllowFrom(channel, parsedInput.feishuOpenId!, accountId)
          if (fallback.ok) {
            setLog(prev => prev + '✅ 已通过飞书用户 ID 完成授权，现在可直接聊天。\n')
            setStatus('success')
            return
          }
          setError(
            toUserFacingCliFailureMessage({
              stderr: fallback.stderr,
              stdout: fallback.stdout,
              fallback: '当前实例找不到该配对码，且兜底授权失败，请稍后重试。',
            })
          )
          setStatus('error')
        } else {
          const feedback = buildPairingApprovalFeedback({
            channelName: channelInfo.name,
            result: r,
            surface,
          })

          if (feedback.tone === 'success') {
            setLog('✅ ' + feedback.message + '\n')
            setStatus('success')
          } else {
            setError(feedback.message)
            setStatus('error')
          }
        }
      }
    } catch (e: any) {
      if (countdownRef.current) clearInterval(countdownRef.current)
      setError('网络或系统错误，请稍后重试。')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <Stack gap="md" w="100%" align="center">
        <img src={logoUrl} alt="logo" style={{ width: 80, height: 80 }} />
        <Text size="lg" fw={600} ta="center">配置完成！</Text>
        <Text size="sm" c="dimmed" ta="center">
          {channel === 'feishu' && feishuBotLabel
            ? `OpenClaw 已成功完成飞书 Bot「${feishuBotLabel}」的配对，现在可以开始对话了。`
            : `OpenClaw 已成功连接${channelInfo.name}，现在可以在${channelInfo.name}中和您的 AI 助手对话了。`}
        </Text>

        <Card padding="sm" withBorder w="100%">
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.8 }}>
            接下来您可以：
            <br />• 在{channelInfo.name}中给机器人发消息开始对话
            <br />• Gateway 已在后台运行，开机自启动
            <br />• 如需修改配置，编辑 <Text span ff="monospace" c="brand">{openClawConfigDisplayPath}</Text>
          </Text>
        </Card>

        <Button
          color="brand"
          fullWidth
          onClick={() => {
            if (onComplete) {
              onComplete()
            }
          }}
        >
          {completeLabel}
        </Button>
      </Stack>
    )
  }

  return (
    <Stack gap="sm" w="100%">
      <Text size="lg" fw={600}>输入配对码</Text>
      {channel === 'feishu' && feishuBotLabel && (
        <Alert color="blue" variant="light" title="当前正在配对的 Bot">
          {accountId ? `飞书 Bot：${feishuBotLabel}（accountId: ${accountId}）` : `飞书 Bot：${feishuBotLabel}`}
        </Alert>
      )}
      <Text size="sm" c="dimmed" mb="xs">
        在{channelInfo.name}中给机器人发送任意消息，机器人会返回配对信息。建议直接粘贴机器人完整回复。
      </Text>

      {(status === 'input' || status === 'error') && (
        <Stack gap="sm">
          <TextInput
            label="配对码"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            placeholder="输入配对码..."
            size="md"
            styles={{ input: { textAlign: 'center', letterSpacing: '0.2em', fontFamily: 'var(--mantine-font-family-monospace)' } }}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canPair) doPair()
            }}
          />

          <Transition mounted={!!error} transition="slide-down" duration={200}>
            {(styles) => (
              <Alert color="warning" variant="light" style={styles}>
                <Text size="xs" fw={500} c="warning" mb={4}>⚠️ 配对未成功</Text>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>{error}</Text>
              </Alert>
            )}
          </Transition>

          <Card padding="sm" withBorder>
            <Text size="xs" c="dimmed" style={{ lineHeight: 1.8 }}>
              操作步骤：
              <br />1. 打开{channelInfo.name}，找到您创建的机器人
              <br />2. 向机器人发送任意一条消息
              <br />3. 机器人会回复配对信息（含配对码和用户 ID）
              <br />4. 将完整回复直接粘贴到上方输入框
            </Text>
          </Card>

          <Group grow>
            <Button variant="default" onClick={onBack}>{backLabel}</Button>
            {showSkip && (
              <Button
                variant="default"
                onClick={() => {
                  if (onSkip) {
                    onSkip()
                    return
                  }
                  if (onComplete) {
                    onComplete()
                  }
                }}
              >
                {skipLabel}
              </Button>
            )}
            <Button
              color="brand"
              onClick={doPair}
              disabled={!canPair}
            >
              配对
            </Button>
          </Group>
        </Stack>
      )}

      {status === 'pairing' && (
        <Stack gap="md" align="center" py="md">
          <Loader size="lg" color="brand" />
          <Text size="sm">正在配对，预计需要 10-{approvalCountdownSeconds} 秒</Text>
          <Text size="xs" c="dimmed">配对期间请保持窗口打开</Text>
          {countdown > 0 && (
            <Badge variant="light" color="surface" size="lg" leftSection={
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--mantine-color-brand-6)', animation: 'pulse 1.5s ease-in-out infinite' }} />
            }>
              等待中 {countdown}s
            </Badge>
          )}
        </Stack>
      )}
    </Stack>
  )
}
