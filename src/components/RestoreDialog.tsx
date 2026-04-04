import { useEffect, useState } from 'react'
import { Button, Modal, Text, Title } from '@mantine/core'
import type {
  OpenClawBackupEntry,
  OpenClawRestorePreviewResult,
  OpenClawRestoreScope,
  OpenClawRestoreRunResult,
} from '../shared/openclaw-phase3'

function scopeLabel(scope: OpenClawRestoreScope): string {
  if (scope === 'config') return '仅配置'
  if (scope === 'memory') return '仅记忆数据'
  return '配置 + 记忆数据'
}

export default function RestoreDialog({
  open,
  backup,
  onClose,
  onRestored,
}: {
  open: boolean
  backup: OpenClawBackupEntry | null
  onClose: () => void
  onRestored?: () => void
}) {
  const [preview, setPreview] = useState<OpenClawRestorePreviewResult | null>(null)
  const [selectedScope, setSelectedScope] = useState<OpenClawRestoreScope>('config')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<OpenClawRestoreRunResult | null>(null)

  useEffect(() => {
    if (!open || !backup) return
    let disposed = false
    setPreview(null)
    setResult(null)
    const loadPreview = async () => {
      const nextPreview = await window.api.previewOpenClawRestore(backup.backupId)
      if (disposed) return
      setPreview(nextPreview)
      setSelectedScope(nextPreview.availableScopes[0] || 'config')
    }
    void loadPreview()
    return () => {
      disposed = true
    }
  }, [open, backup?.backupId])

  if (!open || !backup) return null

  const handleRunRestore = async () => {
    if (!preview || !preview.availableScopes.includes(selectedScope)) return
    setRunning(true)
    setResult(null)
    try {
      const nextResult = await window.api.runOpenClawRestore(backup.backupId, selectedScope)
      setResult(nextResult)
      if (nextResult.ok) {
        onRestored?.()
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      opened={open}
      onClose={running ? () => {} : onClose}
      withCloseButton={false}
      centered
      size="xl"
      zIndex={260}
      closeOnClickOutside={!running}
      closeOnEscape={!running}
      overlayProps={{ backgroundOpacity: 0.7, blur: 0 }}
      padding="lg"
      radius="xl"
    >
      <div className="rounded-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Text size="xs" className="uppercase tracking-[0.24em] app-text-success/80">Restore</Text>
            <Title order={3} mt="xs" size="lg" fw={600} className="app-text-primary">从备份恢复 OpenClaw 数据</Title>
          </div>
          <Button
            variant="subtle"
            size="xs"
            onClick={onClose}
            disabled={running}
            className="app-text-muted transition hover:app-text-secondary"
          >
            关闭
          </Button>
        </div>

        <div className="mt-4 rounded-xl border app-border app-bg-tertiary p-4 text-sm app-text-secondary">
          <div>备份类型：{backup.type}</div>
          <div className="mt-1">创建时间：{backup.createdAt}</div>
          <Text size="xs" mt="xs" c="dimmed" className="break-all">路径：{backup.archivePath}</Text>
        </div>

        {!preview ? (
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-300 border-t-transparent" />
            <span>正在生成恢复预览...</span>
          </div>
        ) : (
          <>
            <div className="mt-5 rounded-xl border app-border app-bg-tertiary p-4">
              <Text size="sm" fw={500} className="app-text-primary">可恢复范围</Text>
              <div className="mt-3 flex flex-wrap gap-2">
                {preview.availableScopes.map((scope) => (
                  <Button
                    key={scope}
                    variant={selectedScope === scope ? 'light' : 'default'}
                    color={selectedScope === scope ? 'success' : undefined}
                    size="xs"
                    onClick={() => setSelectedScope(scope)}
                  >
                    {scopeLabel(scope)}
                  </Button>
                ))}
              </div>
            </div>

            <div className="mt-5 rounded-xl border app-border app-bg-tertiary p-4">
              <Text size="sm" fw={500} className="app-text-primary">恢复内容</Text>
              <div className="mt-3 space-y-2 text-sm app-text-secondary">
                {preview.restoreItems.map((item) => (
                  <Text key={item} size="sm" className="leading-6">
                    {item}
                  </Text>
                ))}
              </div>
            </div>

            {(preview.warnings.length > 0 || preview.blockedReasons.length > 0) && (
              <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100/85">
                {preview.warnings.map((warning) => (
                  <Text key={warning} size="sm" className="leading-6">
                    {warning}
                  </Text>
                ))}
                {preview.blockedReasons.map((reason) => (
                  <Text key={reason} size="sm" className="leading-6">
                    {reason}
                  </Text>
                ))}
              </div>
            )}

            {result && (
              <div
                className={`mt-5 rounded-xl border p-4 text-sm ${
                  result.ok
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100/90'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-100/90'
                }`}
              >
                <Text size="sm" fw={500}>{result.message || (result.ok ? '恢复完成。' : '恢复失败。')}</Text>
                {result.preflightSnapshot && (
                  <Text size="xs" mt="xs" className="break-all">
                    恢复前快照：{result.preflightSnapshot.archivePath}
                  </Text>
                )}
                {result.gatewayApply?.note && (
                  <Text size="xs" mt="xs" className="leading-5">
                    当前状态处理：{result.gatewayApply.note}
                  </Text>
                )}
                {result.restoredItems.map((item) => (
                  <Text key={item} size="xs" mt={4} className="leading-5">
                    {item}
                  </Text>
                ))}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <Button
                variant="default"
                size="sm"
                onClick={onClose}
                disabled={running}
              >
                关闭
              </Button>
              <Button
                color="success"
                size="sm"
                onClick={() => void handleRunRestore()}
                disabled={running || !preview.ok || preview.availableScopes.length === 0}
              >
                {running ? '恢复中...' : '执行恢复'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
