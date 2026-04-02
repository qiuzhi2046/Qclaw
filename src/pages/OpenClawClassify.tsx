import { useEffect, useMemo, useState } from 'react'
import { Button, Text, Title } from '@mantine/core'
import type {
  EnvCheckReadyPayload,
  OpenClawClassificationResult,
  OpenClawDiscoveryResult,
  OpenClawLatestVersionCheckResult,
} from '../shared/openclaw-phase1'
import {
  classifyOpenClawPhase1,
  shouldRouteToSetupAfterPhase1,
} from '../shared/openclaw-phase1'

export default function OpenClawClassify({
  discovery,
  envSummary,
  onProceed,
}: {
  discovery: OpenClawDiscoveryResult
  envSummary: EnvCheckReadyPayload | null
  onProceed: (target: 'setup' | 'dashboard', options?: { openUpdateCenter?: boolean }) => void
}) {
  const [latestCheck, setLatestCheck] = useState<OpenClawLatestVersionCheckResult | null>(null)
  const [checkingLatest, setCheckingLatest] = useState(Boolean(discovery.activeCandidateId))
  const [latestCheckAttempt, setLatestCheckAttempt] = useState(0)

  useEffect(() => {
    if (!discovery.activeCandidateId) {
      setCheckingLatest(false)
      setLatestCheck(null)
      return
    }

    let disposed = false
    const run = async () => {
      setCheckingLatest(true)
      const result = await window.api.checkOpenClawLatestVersion()
      if (!disposed) {
        setLatestCheck(result)
        setCheckingLatest(false)
      }
    }

    void run()
    return () => {
      disposed = true
    }
  }, [discovery.activeCandidateId, latestCheckAttempt])

  const classification: OpenClawClassificationResult = useMemo(
    () => classifyOpenClawPhase1(discovery, latestCheck),
    [discovery, latestCheck]
  )

  const freshManagedInstall = Boolean(
    envSummary && !envSummary.hadOpenClawInstalled && envSummary.installedOpenClawDuringCheck
  )
  const setupRequired = shouldRouteToSetupAfterPhase1(envSummary)

  const activeCandidate = classification.activeCandidate
  const handleRefreshLatestVersion = () => {
    if (!discovery.activeCandidateId || checkingLatest) return
    setLatestCheckAttempt((current) => current + 1)
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border app-border app-bg-inset p-6 shadow-2xl">
      <Text size="xs" tt="uppercase" lts="0.24em" c="success.4" style={{ opacity: 0.8 }}>OpenClaw Classify</Text>
      <Title order={2} size="h4" fw={600} mt="xs" c="var(--app-text-primary)">安装状态与版本分流</Title>
      <Text size="sm" lh="1.625" mt="xs" c="var(--app-text-tertiary)">
        Qclaw 会根据当前安装状态决定是直接进入控制面板，还是继续进行首次配置。
      </Text>

      <div className="mt-5 rounded-xl border app-border app-bg-tertiary p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border app-border-light px-2 py-0.5 text-[11px] app-text-tertiary">
            分类：{classification.versionStatus}
          </span>
          {activeCandidate && (
            <span className="rounded-full border app-border-light px-2 py-0.5 text-[11px] app-text-tertiary">
              来源：{activeCandidate.installSource}
            </span>
          )}
          {classification.latestVersion && (
            <span className="rounded-full border app-border-light px-2 py-0.5 text-[11px] app-text-tertiary">
              最新：{classification.latestVersion}
            </span>
          )}
        </div>

        {activeCandidate && (
          <div className="mt-3 space-y-1 text-sm app-text-secondary">
            <div>当前版本：{activeCandidate.version || '未知版本'}</div>
            <div className="break-all app-text-muted">命令路径：{activeCandidate.binaryPath}</div>
            {activeCandidate.baselineBackup && (
              <div className="break-all app-text-success">
                已备份：{activeCandidate.baselineBackup.archivePath}
              </div>
            )}
          </div>
        )}

        {checkingLatest && activeCandidate && (
          <div className="mt-4 flex items-center gap-3 text-sm app-text-tertiary">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            <span>正在检查 OpenClaw 最新版本...</span>
          </div>
        )}

        {!checkingLatest && classification.warnings.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100/85">
            {classification.warnings.map((warning) => (
              <Text key={warning} size="xs" lh="1.25rem">
                {warning}
              </Text>
            ))}
          </div>
        )}
      </div>

      {setupRequired ? (
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <Title order={3} size="sm" fw={500} c="var(--mantine-color-success-3)">
            {freshManagedInstall
              ? '已安装最新 OpenClaw，并由 Qclaw 管理'
              : '已检测到 OpenClaw，但尚未完成首次初始化'}
          </Title>
          <Text size="sm" lh="1.625" mt="xs" style={{ color: 'rgba(167, 243, 208, 0.85)' }}>
            {freshManagedInstall
              ? '当前环境是本次启动中新安装的 OpenClaw，下一步将进入首次配置流程。'
              : '当前机器已有 OpenClaw 命令行工具，但还没有生成可直接启动网关的当前配置。下一步必须先进入配置引导执行初始化。'}
          </Text>
          <Button
            onClick={() => onProceed('setup')}
            color="success"
            mt="md"
            size="sm"
          >
            继续配置
          </Button>
        </div>
      ) : classification.versionStatus === 'equal' ? (
        <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <Title order={3} size="sm" fw={500} c="var(--mantine-color-success-3)">当前 OpenClaw 已与最新版本一致</Title>
          <Text size="sm" lh="1.625" mt="xs" style={{ color: 'rgba(167, 243, 208, 0.85)' }}>
            Qclaw 不会改写你现有的安装，只会作为监控与控制面板使用。
          </Text>
          <Button
            onClick={() => onProceed('dashboard')}
            color="success"
            mt="md"
            size="sm"
          >
            进入控制面板
          </Button>
        </div>
      ) : classification.versionStatus === 'outdated' ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border app-border app-bg-tertiary p-4">
            <Title order={3} size="sm" fw={500} c="var(--app-text-primary)">选项 1：仅接管，不升级</Title>
            <Text size="sm" lh="1.625" mt="xs" c="var(--app-text-tertiary)">
              保留当前已安装的低版本 OpenClaw，不执行程序升级，先进入面板观察和接管。
            </Text>
            <Button
              onClick={() => onProceed('dashboard')}
              variant="default"
              mt="md"
              size="sm"
            >
              仅接管当前版本
            </Button>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <Title order={3} size="sm" fw={500} c="warning.3">选项 2：升级现有安装</Title>
            <Text size="sm" lh="1.625" mt="xs" style={{ color: 'rgba(254, 243, 199, 0.85)' }}>
              升级会保留原位置、原配置和原记忆数据，不会新装第二份 OpenClaw。若当前来源无法安全自动升级，升级中心会明确告诉你原因。
            </Text>
            <Button
              onClick={() => onProceed('dashboard', { openUpdateCenter: true })}
              color="warning"
              mt="md"
              size="sm"
            >
              升级当前安装
            </Button>
          </div>
        </div>
      ) : classification.versionStatus === 'latest-unknown' ? (
        <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <Title order={3} size="sm" fw={500} c="warning.3">已检测到 OpenClaw，但最新版本暂时未知</Title>
          <Text size="sm" lh="1.625" mt="xs" style={{ color: 'rgba(254, 243, 199, 0.85)' }}>
            因网络或远端解析失败，当前无法确认最新版本。你仍可以先进入控制面板，不会触发自动升级。
          </Text>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              onClick={handleRefreshLatestVersion}
              disabled={checkingLatest}
              variant="outline"
              color="warning"
              size="sm"
              mt="md"
            >
              {checkingLatest ? '正在重新检测...' : '刷新版本信息'}
            </Button>
            <Button
              onClick={() => onProceed('dashboard')}
              color="warning"
              size="sm"
              mt="md"
            >
              继续进入控制面板
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-xl border app-border app-bg-tertiary p-4">
          <Title order={3} size="sm" fw={500} c="var(--app-text-primary)">继续流程</Title>
          <Text size="sm" lh="1.625" mt="xs" c="var(--app-text-tertiary)">
            当前分类结果不会阻断接管。您可以继续进入控制面板，后续阶段再补齐升级与治理能力。
          </Text>
          <Button
            onClick={() => onProceed(activeCandidate ? 'dashboard' : 'setup')}
            color="success"
            mt="md"
            size="sm"
          >
            继续
          </Button>
        </div>
      )}
    </div>
  )
}
