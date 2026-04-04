export type NodeInstallerIssueKind =
  | 'missing-installer'
  | 'corrupted-installer'
  | 'missing-system-command'
  | 'xcode-clt-pending'
  | 'git-unavailable'
  | 'developer-tools-prepare-failed'
  | 'not-admin-user'
  | 'blocked-by-policy'
  | 'unsupported-macos'
  | 'user-cancelled'
  | 'permission-denied'
  | 'installer-failed'
  | 'download-failed'

export interface NodeInstallerIssue {
  kind: NodeInstallerIssueKind
  title: string
  message: string
  details?: string
}

export interface NodeInstallerReadinessResult {
  ok: boolean
  issue?: NodeInstallerIssue
}

function normalizeDetails(details: string): string | undefined {
  const normalized = String(details || '').trim()
  return normalized || undefined
}

export function createNodeInstallerIssue(
  kind: NodeInstallerIssueKind,
  details = ''
): NodeInstallerIssue {
  const normalizedDetails = normalizeDetails(details)

  if (kind === 'missing-installer') {
    return {
      kind,
      title: 'Node 安装包不存在',
      message: '已下载的 Node.js 安装包没有找到，安装无法继续。请点击“继续安装”再次尝试环境准备流程。',
      details: normalizedDetails,
    }
  }

  if (kind === 'corrupted-installer') {
    return {
      kind,
      title: 'Node 安装包无效或已损坏',
      message: '下载到的 Node.js 安装包未通过签名/完整性检查，可能已损坏或被代理替换。请检查网络环境后重试。',
      details: normalizedDetails,
    }
  }

  if (kind === 'missing-system-command') {
    return {
      kind,
      title: '系统缺少安装预检命令',
      message: '当前系统缺少 Node.js 自动安装所需的系统命令，Qclaw 无法继续自动预检。请联系管理员修复系统工具，或改为手动安装 Node.js。',
      details: normalizedDetails,
    }
  }

  if (kind === 'xcode-clt-pending') {
    return {
      kind,
      title: '等待 Xcode Command Line Tools 安装完成',
      message:
        '已尝试触发 Xcode 命令行工具系统安装弹窗。如果没有弹窗，请点击屏幕右下角的安装图标继续安装；安装完成后，点击“重试识别”刷新状态。',
      details: normalizedDetails,
    }
  }

  if (kind === 'git-unavailable') {
    return {
      kind,
      title: 'Git 命令不可用',
      message: '当前系统无法使用 Git，Qclaw 无法继续环境准备。请先修复 Git 或安装 Xcode Command Line Tools 后重试。',
      details: normalizedDetails,
    }
  }

  if (kind === 'developer-tools-prepare-failed') {
    return {
      kind,
      title: 'macOS 开发者工具预检失败',
      message: 'Qclaw 在准备 Git / Xcode Command Line Tools 时遇到问题。请稍后重试；如果仍失败，请手动检查系统开发者工具状态。',
      details: normalizedDetails,
    }
  }

  if (kind === 'not-admin-user') {
    return {
      kind,
      title: '当前账户没有管理员权限',
      message: '自动安装 Node.js 需要 macOS 管理员权限。请使用管理员账户登录，或联系设备管理员处理。',
      details: normalizedDetails,
    }
  }

  if (kind === 'blocked-by-policy') {
    return {
      kind,
      title: '系统策略阻止了安装',
      message: '这台电脑的安全策略阻止了 Node.js 安装。请联系管理员处理，或改为手动安装 Node.js。',
      details: normalizedDetails,
    }
  }

  if (kind === 'unsupported-macos') {
    return {
      kind,
      title: '当前 macOS 版本不支持该 Node 安装包',
      message: '当前系统版本与目标 Node.js 安装包不兼容，Qclaw 无法继续自动安装。请先升级系统，或手动安装兼容的 Node.js 版本。',
      details: normalizedDetails,
    }
  }

  if (kind === 'user-cancelled') {
    return {
      kind,
      title: '已取消 Node 安装',
      message: '你已取消管理员授权或安装流程，因此 Node.js 未安装。',
      details: normalizedDetails,
    }
  }

  if (kind === 'permission-denied') {
    return {
      kind,
      title: '没有足够权限安装 Node.js',
      message: '安装 Node.js 时权限不足。请确认当前账号具备管理员权限，并允许系统弹出的安装授权。',
      details: normalizedDetails,
    }
  }

  if (kind === 'download-failed') {
    return {
      kind,
      title: 'Node 安装包下载失败',
      message: '自动下载 Node.js 安装包失败。请检查网络、代理或证书设置；如果仍然失败，可前往 Node.js 官网手动下载。',
      details: normalizedDetails,
    }
  }

  return {
    kind: 'installer-failed',
    title: 'Node 安装器执行失败',
    message: 'Node.js 安装器执行时报错。请稍后重试；如果仍然失败，建议去 Node.js 官网手动安装。',
    details: normalizedDetails,
  }
}

export function classifyMacGitToolsIssue(result: {
  errorCode?: 'xcode_clt_pending' | 'git_unavailable' | 'prepare_failed'
  stderr?: string
  stdout?: string
}): NodeInstallerIssue {
  const details = [String(result.stderr || '').trim(), String(result.stdout || '').trim()]
    .filter(Boolean)
    .join('\n')

  if (result.errorCode === 'xcode_clt_pending') {
    return createNodeInstallerIssue('xcode-clt-pending', details)
  }

  if (result.errorCode === 'git_unavailable') {
    return createNodeInstallerIssue('git-unavailable', details)
  }

  return createNodeInstallerIssue('developer-tools-prepare-failed', details)
}

export function classifyMacNodeInstallerFailure(rawError: string): NodeInstallerIssue {
  const raw = String(rawError || '').trim()
  const normalized = raw.toLowerCase()

  if (!raw) {
    return createNodeInstallerIssue('installer-failed')
  }

  if (
    normalized.includes('user canceled') ||
    normalized.includes('user cancelled') ||
    normalized.includes('(-128)')
  ) {
    return createNodeInstallerIssue('user-cancelled', raw)
  }

  if (
    normalized.includes('requires macos') ||
    normalized.includes('requires os x') ||
    normalized.includes('incompatible with this version of macos') ||
    normalized.includes("can't be installed on this disk") ||
    normalized.includes('this package is incompatible')
  ) {
    return createNodeInstallerIssue('unsupported-macos', raw)
  }

  if (
    normalized.includes('administrator privileges') ||
    normalized.includes('not authorized') ||
    normalized.includes('authorization') ||
    normalized.includes('permission denied')
  ) {
    return createNodeInstallerIssue('permission-denied', raw)
  }

  if (
    normalized.includes('assessment denied') ||
    normalized.includes('rejected') ||
    normalized.includes('untrusted') ||
    normalized.includes('notar') ||
    normalized.includes('cannot be opened because') ||
    normalized.includes('source=no usable signature')
  ) {
    return createNodeInstallerIssue('blocked-by-policy', raw)
  }

  if (
    normalized.includes('no such file or directory') ||
    normalized.includes('does not exist')
  ) {
    return createNodeInstallerIssue('missing-installer', raw)
  }

  return createNodeInstallerIssue('installer-failed', raw)
}

export function classifyNodeInstallerDownloadFailure(rawError: string): NodeInstallerIssue {
  return createNodeInstallerIssue('download-failed', rawError)
}
