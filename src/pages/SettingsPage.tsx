import { useState } from 'react'
import { Text, Button, Group, Collapse, Modal, Tooltip, Select } from '@mantine/core'
import { useComputedColorScheme, useMantineColorScheme } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import BackupCenter from '../components/BackupCenter'
import CleanupDialog from '../components/CleanupDialog'
import FeishuBotManagerModal from '../components/FeishuBotManagerModal'
import OpenClawDataCleanupDialog from '../components/OpenClawDataCleanupDialog'
import UpdateCenter from '../components/UpdateCenter'
import AboutModal from '../components/AboutModal'
import tooltips from '@/constants/tooltips.json'
import type { ChatComposerEnterSendMode } from '../lib/chat-composer-enter-send-preference'

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
    <div className="p-4 space-y-2">
      {/* 通用工具 */}
      <Section title="通用">
        <Group gap="xs" grow>
          <Tooltip label={tooltips.settingsPage.updateCenter} withArrow>
            <Button variant="default" size="xs" onClick={() => setShowUpdateCenter(true)}>升级中心</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.backupCenter} withArrow>
            <Button variant="default" size="xs" onClick={() => setShowBackupCenter(true)}>备份中心</Button>
          </Tooltip>
        </Group>
        <Group gap="xs" grow>
          <Tooltip label={tooltips.settingsPage.feishuBotManager} withArrow>
            <Button variant="default" size="xs" onClick={() => setShowFeishuBotManager(true)}>飞书 Bot 管理</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.reconfigure} withArrow>
            <Button variant="default" size="xs" onClick={() => setShowReconfigureConfirm(true)}>重新进入配置引导</Button>
          </Tooltip>
        </Group>
        <Group gap="xs" grow>
          <Tooltip label={isDark ? tooltips.settingsPage.toggleThemeToLight : tooltips.settingsPage.toggleThemeToDark} withArrow>
            <Button variant="default" size="xs" onClick={() => setColorScheme(isDark ? 'light' : 'dark')}>
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
            <Button variant="default" size="xs" onClick={onToggleTooltip}>
              打开/关闭软件提示
            </Button>
          </Tooltip>
        </Group>
        <Group gap="sm" align="flex-end">
          <div style={{ flex: 1 }}>
            <Text size="xs" className="app-text-secondary" mb={4}>Enter 键发送模式</Text>
            <Select
              value={enterSendMode}
              onChange={(value) => value && onChangeEnterSendMode(value as ChatComposerEnterSendMode)}
              data={[
                { value: 'enter', label: 'Enter 发送 · Shift+Enter 换行' },
                { value: 'shiftEnter', label: 'Shift+Enter 发送 · Enter 换行' },
                { value: 'altEnter', label: 'Alt+Enter 发送 · Enter 换行' },
              ]}
              allowDeselect={false}
              size="xs"
              styles={{ input: { fontSize: 'var(--mantine-font-size-xs)' } }}
            />
          </div>
          <Tooltip label={tooltips.settingsPage.chatComposerEnterSendMode} withArrow>
            <div>ℹ️</div>
          </Tooltip>
        </Group>
      </Section>

      {/* 卸载清除 */}
      <Section title="卸载清除" titleTooltip={tooltips.settingsPage.deleteOpenClawAndData} defaultOpen={false}>
        <Group gap="xs" grow>
          <Tooltip label={tooltips.settingsPage.cleanupOpenClaw} withArrow>
            <Button variant="light" color="red" size="xs" onClick={() => setShowCleanupDialog(true)}>删除 OpenClaw</Button>
          </Tooltip>
          <Tooltip label={tooltips.settingsPage.cleanupOpenClawData} withArrow>
            <Button variant="light" color="red" size="xs" onClick={() => setShowDataCleanupDialog(true)}>清理 OpenClaw 数据</Button>
          </Tooltip>
        </Group>
      </Section>

      {/* 关于 — 与上方按钮规格一致 */}
      <Button
        variant="default"
        size="xs"
        fullWidth
        onClick={() => setShowAbout(true)}
        styles={{ inner: { justifyContent: 'space-between' } }}
      >
        <span>关于 Qclaw</span>
        <IconChevronRight size={14} />
      </Button>

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
