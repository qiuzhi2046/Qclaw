import { useEffect, useState } from 'react'
import { ActionIcon, Alert, Button, Group, Loader, Modal, Text, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import type { CombinedUpdateCheckResult } from '../shared/openclaw-phase4'
import CombinedUpdateDialog from './CombinedUpdateDialog'
import OpenClawUpgradeDialog from './OpenClawUpgradeDialog'
import QClawUpdateDialog from './QClawUpdateDialog'

export function summarizeOpenClaw(check: CombinedUpdateCheckResult | null): string {
  if (!check) return '读取中...'
  if (check.openclaw.policyState === 'supported_target') return '当前已是受支持上限版本'
  if (check.openclaw.policyState === 'supported_not_target' && check.openclaw.targetVersion) {
    if (check.openclaw.enforcement === 'manual_block') {
      return `如需升级请手动切换到 ${check.openclaw.targetVersion}`
    }
    return `${check.openclaw.currentVersion || '未知'} → ${check.openclaw.targetVersion}`
  }
  if (check.openclaw.enforcement === 'manual_block') return '当前版本需手动调整到 2026.3.24'
  if (check.openclaw.enforcement === 'auto_correct') return '启动阶段会先自动修复到 2026.3.24'
  return '无法确认 OpenClaw 版本状态'
}

export function summarizeQClaw(check: CombinedUpdateCheckResult | null): string {
  if (!check) return '读取中...'
  if (check.qclaw.availableVersion) {
    return `${check.qclaw.currentVersion} → ${check.qclaw.availableVersion}`
  }
  return `当前版本 ${check.qclaw.currentVersion}`
}

export default function UpdateCenter({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [check, setCheck] = useState<CombinedUpdateCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showOpenClawDialog, setShowOpenClawDialog] = useState(false)
  const [showQClawDialog, setShowQClawDialog] = useState(false)
  const [showCombinedDialog, setShowCombinedDialog] = useState(false)

  const loadCheck = async () => {
    setLoading(true)
    setError('')
    try {
      const nextCheck = await window.api.checkCombinedUpdate()
      setCheck(nextCheck)
    } catch (e: any) {
      setError(e?.message || '读取升级中心状态失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void loadCheck()
  }, [open])

  if (!open) return null

  const UPDATE_OPTIONS = [
    {
      label: 'OpenClaw',
      desc: '保留原位置和数据，升级前自动创建快照',
      status: summarizeOpenClaw(check),
      action: () => setShowOpenClawDialog(true),
      btnText: '查看升级',
    },
    {
      label: 'Qclaw',
      desc: '只更新面板，不影响 OpenClaw 配置与运行',
      status: summarizeQClaw(check),
      action: () => setShowQClawDialog(true),
      btnText: '查看更新',
    },
    {
      label: '组合更新',
      desc: '先下载面板更新，再升级 OpenClaw',
      status: '升级失败时面板不会自动更新',
      action: () => setShowCombinedDialog(true),
      btnText: '查看组合更新',
    },
  ]

  return (
    <>
      <Modal
        opened={open}
        onClose={onClose}
        title={
          <Group gap="xs">
            <Text size="sm" fw={600}>升级中心</Text>
            <Tooltip label="刷新状态" withArrow>
              <ActionIcon variant="subtle" size="sm" onClick={() => void loadCheck()} loading={loading}>
                <IconRefresh size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
        size="lg"
        centered
      >
        {loading && !check ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">正在加载升级状态...</Text>
          </Group>
        ) : (
          <>
            {error && (
              <Alert color="red" variant="light" mb="sm" withCloseButton onClose={() => setError('')}>
                {error}
              </Alert>
            )}

            {check && check.warnings.length > 0 && (
              <Alert color="yellow" variant="light" mb="sm">
                {check.warnings.map((w) => (
                  <Text key={w} size="xs">{w}</Text>
                ))}
              </Alert>
            )}

            <div className="space-y-2">
              {UPDATE_OPTIONS.map((opt) => (
                <div
                  key={opt.label}
                  className="border app-border rounded-lg px-3 py-2.5"
                  style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--app-hover-border)'
                    e.currentTarget.style.boxShadow = '0 0 8px var(--app-hover-glow)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = ''
                    e.currentTarget.style.boxShadow = ''
                  }}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text size="sm" fw={600} className="app-text-primary">{opt.label}</Text>
                      <Text size="xs" c="dimmed">{opt.desc}</Text>
                      <Text size="xs" c="dimmed" mt={2}>{opt.status}</Text>
                    </div>
                    <Button size="compact-xs" variant="light" onClick={opt.action}>
                      {opt.btnText}
                    </Button>
                  </Group>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      <OpenClawUpgradeDialog
        open={showOpenClawDialog}
        onClose={() => setShowOpenClawDialog(false)}
        onUpdated={() => void loadCheck()}
      />
      <QClawUpdateDialog open={showQClawDialog} onClose={() => setShowQClawDialog(false)} />
      <CombinedUpdateDialog
        open={showCombinedDialog}
        onClose={() => setShowCombinedDialog(false)}
        onUpdated={() => void loadCheck()}
      />
    </>
  )
}
