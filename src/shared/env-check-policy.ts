export interface EnvCheckSupportAction {
  kind: 'external-link'
  label: string
  href: string
}

const NODE_DOWNLOAD_ACTION: EnvCheckSupportAction = Object.freeze({
  kind: 'external-link',
  label: '打开 Node 官网',
  href: 'https://nodejs.org/',
})

const NODE_MANUAL_DOWNLOAD_ISSUE_KINDS = new Set([
  'blocked-by-policy',
  'corrupted-installer',
  'download-failed',
  'installer-failed',
  'missing-system-command',
  'unsupported-macos',
])

export const ENV_CHECK_UI_POLICY = Object.freeze({
  loadingTips: Object.freeze([
    '正在检查系统环境...',
    'Qclaw 支持飞书、企微、钉钉、QQ渠道接入',
    '所有配置和数据仅保存在您的电脑上',
    '安装和配置速度会受到网络和电脑性能影响',
    '安装、配置过程可能会输入电脑密码',
    '请确保网络连接正常',
  ]),
  nodeDownloadAction: NODE_DOWNLOAD_ACTION,
})

export function getEnvCheckSupportActionsForIssueKind(
  issueKind?: string | null
): EnvCheckSupportAction[] {
  if (!issueKind || !NODE_MANUAL_DOWNLOAD_ISSUE_KINDS.has(issueKind)) {
    return []
  }

  return [ENV_CHECK_UI_POLICY.nodeDownloadAction]
}
