import { useState } from 'react'
import { Button, Checkbox, Text, Title } from '@mantine/core'
import { IconAlertTriangle, IconPinFilled } from '@tabler/icons-react'
import logoSrc from '@/assets/logo.png'

interface WelcomeProps {
  onAccept: () => void
}

const listStyle = {
  fontSize: '12.5px',
  lineHeight: 1.7,
} as const

export default function Welcome({ onAccept }: WelcomeProps) {
  const [accepted, setAccepted] = useState(false)

  return (
    <div className="w-full flex flex-col items-center gap-2">
      <div className="flex items-center gap-2.5">
        <img src={logoSrc} alt="Qclaw" className="w-12 h-12" />
        <Title order={4} className="app-text-primary">
          Qclaw
        </Title>
        <div className="ml-1 flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5">
          <IconAlertTriangle size={13} className="text-yellow-500" />
          <Text fw={600} size="xs" className="text-yellow-500">
            安全提醒
          </Text>
        </div>
      </div>

      <div className="w-full rounded-lg app-bg-secondary px-3.5 py-2.5 flex flex-col">
        <div className="flex items-center gap-1.5">
          <IconPinFilled size={12} className="text-red-400 flex-shrink-0" />
          <Text fw={600} size="sm" className="app-text-primary">
            关于 OpenClaw
          </Text>
        </div>
        <Text size="xs" className="app-text-secondary mt-0.5">
          OpenClaw 是一个 AI 助手，为了完成任务，它需要以下权限：
        </Text>
        <ul className="mt-0.5 flex list-inside list-disc flex-col app-text-secondary" style={listStyle}>
          <li>读取和修改文件、执行系统命令、连接互联网</li>
          <li>访问您的 API 密钥（用于调用 AI 服务）</li>
          <li>操作消息渠道（飞书、企微、钉钉等）</li>
          <li>
            <span className="app-text-warning font-medium">
              使用 AI 服务可能产生费用，具体取决于你选择的服务商和使用量。
            </span>
          </li>
        </ul>
      </div>

      <div className="w-full rounded-lg app-bg-secondary px-3.5 py-2.5 flex flex-col">
        <div className="flex items-center gap-1.5">
          <IconPinFilled size={12} className="text-red-400 flex-shrink-0" />
          <Text fw={600} size="sm" className="app-text-primary">
            关于 Qclaw
          </Text>
        </div>
        <Text size="xs" className="app-text-secondary mt-0.5">
          Qclaw 是轻量化的 OpenClaw 管家，Qclaw 会：
        </Text>
        <ul className="mt-0.5 flex list-inside list-disc flex-col app-text-secondary" style={listStyle}>
          <li>自动安装必要组件（Node.js、OpenClaw 命令行工具、IM 插件）</li>
          <li>
            <span className="app-text-warning font-medium">
              保护现有配置（安装前自动备份，不会覆盖您的设置）
            </span>
          </li>
          <li>本地数据存储（所有配置和数据默认只保存在此电脑上）</li>
        </ul>
      </div>

      <div className="w-full rounded-lg app-bg-secondary px-3.5 py-2.5 flex flex-col">
        <div className="flex items-center gap-1.5">
          <IconPinFilled size={12} className="text-red-400 flex-shrink-0" />
          <Text fw={600} size="sm" className="app-text-primary">
            环境风险
          </Text>
        </div>
        <ul className="mt-0.5 flex list-inside list-disc flex-col app-text-secondary" style={listStyle}>
          <li>
            <span className="app-text-warning font-medium">
              OpenClaw 权限较大，不建议使用含有重要文件的工作电脑。
            </span>
          </li>
          <li>
            对于开发者：当前 OpenClaw 要求 Node.js 版本高于 22.16，如果您本地的 Node.js 低于
            22.16，Qclaw 会自动安装新版 Node.js，可能造成 node 版本覆盖。
          </li>
        </ul>
      </div>

      <Checkbox
        label="我已阅读并了解以上内容"
        checked={accepted}
        onChange={(e) => setAccepted(e.currentTarget.checked)}
        className="self-start"
        size="sm"
      />

      <Button fullWidth disabled={!accepted} onClick={onAccept} size="sm">
        确认继续
      </Button>
    </div>
  )
}
