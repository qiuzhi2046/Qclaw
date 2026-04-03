import { useState } from 'react'
import { Text, Button, Group, Collapse, Modal, Tooltip } from '@mantine/core'
import { useComputedColorScheme, useMantineColorScheme } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import logoImg from '@/assets/logo.png'
import BackupCenter from '../components/BackupCenter'
import CleanupDialog from '../components/CleanupDialog'
import FeishuBotManagerModal from '../components/FeishuBotManagerModal'
import OpenClawDataCleanupDialog from '../components/OpenClawDataCleanupDialog'
import UpdateCenter from '../components/UpdateCenter'
import AboutModal from '../components/AboutModal'
import tooltips from '@/constants/tooltips.json'
import type { ChatComposerEnterSendMode } from '@/lib/chat-composer-enter-send-preference'

function Section({
  title,
  titleTooltip,
  defaultOpen = true,
  children,
}: {
  title: string
  titleTooltip?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className="border app-border rounded-lg overflow-hidden"
      style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--app-hover-border)'
        e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = ''
        e.currentTarget.style.boxShadow = ''
      }}
    >
      <Group
        justify="space-between"
        className="px-3 py-2.5 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <Group gap="sm">
          <IconChevronRight
            size={14}
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
            className="app-text-muted"
          />
          {titleTooltip ? (
            <Tooltip label={titleTooltip} withArrow>
              <span>
                <Text size="sm" fw={600} className="app-text-primary">{title}</Text>
              </span>
            </Tooltip>
          ) : (
            <Text size="sm" fw={600} className="app-text-primary">{title}</Text>
          )}
        </Group>
      </Group>
      <Collapse in={open}>
        <div className="px-3 pb-3 space-y-2">
          {children}
        </div>
      </Collapse>
    </div>
  )
}

interface SettingsPageProps {
  onReconfigure?: () => void
  onToggleTooltip: () => void
  tooltipEnabled: boolean
  enterSendMode: ChatComposerEnterSendMode
  onChangeEnterSendMode: (mode: ChatComposerEnterSendMode) => void
}

export default function SettingsPage({
  onReconfigure,
  onToggleTooltip,
  tooltipEnabled,
  enterSendMode,
  onChangeEnterSendMode,
}: SettingsPageProps) {
  const { setColorScheme } = useMantineColorScheme()
  const computedColorScheme = useComputedColorScheme('dark')
  const isDark = computedColorScheme === 'dark'

  const [showUpdateCenter, setShowUpdateCenter] = useState(false)
  const [showBackupCenter, setShowBackupCenter] = useState(false)
  const [showCleanupDialog, setShowCleanupDialog] = useState(false)
  const [showDataCleanupDialog, setShowDataCleanupDialog] = useState(false)
  const [showFeishuBotManager, setShowFeishuBotManager] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showReconfigureConfirm, setShowReconfigureConfirm] = useState(false)

  return (
    <div className="p-4 pb-2 h-full flex flex-col relative">
      <div className="space-y-2">
      {/* 通用工具 */}
      <Section title="通用">
        <div className="grid grid-cols-3 gap-2">
          <Tooltip label={tooltips.settingsPage.updateCenter} withArrow>
            <Button variant="default" size="sm" fw={400} onClick={() => setShowUpdateCenter(true)}>升级中心</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.backupCenter} withArrow>
            <Button variant="default" size="sm" fw={400} onClick={() => setShowBackupCenter(true)}>备份中心</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.feishuBotManager} withArrow>
            <Button variant="default" size="sm" fw={400} onClick={() => setShowFeishuBotManager(true)}>飞书机器人管理</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.reconfigure} withArrow>
            <Button variant="default" size="sm" fw={400} onClick={() => setShowReconfigureConfirm(true)}>重新进入配置引导</Button>
          </Tooltip>
          <Tooltip label={isDark ? tooltips.settingsPage.toggleThemeToLight : tooltips.settingsPage.toggleThemeToDark} withArrow>
            <Button variant="default" size="sm" fw={400} onClick={() => setColorScheme(isDark ? 'light' : 'dark')}>
              亮色/暗色
            </Button>
          </Tooltip>
          <Tooltip
            label={
              tooltipEnabled
                ? tooltips.settingsPage.disableGlobalTooltip
                : tooltips.settingsPage.enableGlobalTooltip
            }
            withArrow
          >
            <Button variant="default" size="sm" fw={400} onClick={onToggleTooltip}>
              打开/关闭软件提示
            </Button>
          </Tooltip>
        </div>
      </Section>

      {/* 聊天输入 */}
      <Section
        title="聊天输入"
        titleTooltip={tooltips.settingsPage.chatComposerEnterSendMode}
      >
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant={enterSendMode === 'enter' ? 'filled' : 'default'}
            size="sm"
            fw={400}
            onClick={() => onChangeEnterSendMode('enter')}
          >
            Enter 发送（默认）
          </Button>
          <Button
            variant={enterSendMode === 'shiftEnter' ? 'filled' : 'default'}
            size="sm"
            fw={400}
            onClick={() => onChangeEnterSendMode('shiftEnter')}
          >
            Shift+Enter 发送
          </Button>
          <Button
            variant={enterSendMode === 'altEnter' ? 'filled' : 'default'}
            size="sm"
            fw={400}
            onClick={() => onChangeEnterSendMode('altEnter')}
          >
            Alt+Enter 发送
          </Button>
        </div>
      </Section>

      {/* 卸载清除 */}
      <Section title="卸载清除" titleTooltip={tooltips.settingsPage.deleteOpenClawAndData} defaultOpen={false}>
        <Group gap="xs" grow>
          <Tooltip label={tooltips.settingsPage.cleanupOpenClaw} withArrow>
            <Button variant="light" color="red" size="sm" fw={400} onClick={() => setShowCleanupDialog(true)}>删除 OpenClaw</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.cleanupOpenClawData} withArrow>
            <Button variant="light" color="red" size="sm" fw={400} onClick={() => setShowDataCleanupDialog(true)}>清理 OpenClaw 数据</Button>
          </Tooltip>
        </Group>
      </Section>
      </div>

      <Tooltip label="关于 Qclaw" withArrow position="left">
        <button
          type="button"
          className="absolute bottom-4 right-4 p-0 border-0 bg-transparent cursor-pointer rounded-full"
          style={{ lineHeight: 0, transition: 'transform 0.2s ease' }}
          onClick={() => setShowAbout(true)}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.2)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.95)' }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1.2)' }}
        >
          <img src={logoImg} alt="Qclaw" width={64} height={64} className="rounded-full" />
        </button>
      </Tooltip>

      <AboutModal opened={showAbout} onClose={() => setShowAbout(false)} />
      <Modal
        opened={showReconfigureConfirm}
        onClose={() => setShowReconfigureConfirm(false)}
        title="重新进入配置引导？"
        size="sm"
        centered
      >
        <Text size="sm" className="app-text-secondary" mb="md">
          你可以重新进配置引导，根据页面提示配置模型和IM插件。
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" size="xs" onClick={() => setShowReconfigureConfirm(false)}>取消</Button>
          <Button
            size="xs"
            onClick={() => {
              setShowReconfigureConfirm(false)
              onReconfigure?.()
            }}
          >
            确认进入
          </Button>
        </Group>
      </Modal>
      <UpdateCenter open={showUpdateCenter} onClose={() => setShowUpdateCenter(false)} />
      <BackupCenter open={showBackupCenter} onClose={() => setShowBackupCenter(false)} />
      <FeishuBotManagerModal opened={showFeishuBotManager} onClose={() => setShowFeishuBotManager(false)} />
      <CleanupDialog open={showCleanupDialog} mode="remove-openclaw" onClose={() => setShowCleanupDialog(false)} />
      <OpenClawDataCleanupDialog
        open={showDataCleanupDialog}
        onClose={() => setShowDataCleanupDialog(false)}
      />
    </div>
  )
}
