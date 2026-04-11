export interface QClawUpdateConfigurationState {
  supported: boolean
  configured: boolean
  message: string
}

export type BuilderPublishConfig = {
  appId?: string
  publish?: { url?: string } | string
}

function normalizeText(value: unknown): string {
  return String(value || '').trim()
}

export function looksPlaceholderPublishUrl(value: string): boolean {
  const normalized = normalizeText(value)
  return (
    !normalized ||
    /example\.invalid/i.test(normalized) ||
    /example\.com/i.test(normalized) ||
    /electron-vite-react/i.test(normalized) ||
    /releases\/download\/v0\.9\.9/i.test(normalized)
  )
}

export function unquoteYamlScalar(value: string): string {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1).trim()
  }
  return normalized
}

export function extractPublishUrlFromAppUpdateYaml(raw: string): string | undefined {
  const match = raw.match(/^\s*url:\s*(.+?)\s*$/m)
  const value = match?.[1]
  return value ? unquoteYamlScalar(value) : undefined
}

export function extractPublishUrlFromBuilderConfig(config: BuilderPublishConfig): string {
  return typeof config.publish === 'string'
    ? normalizeText(config.publish)
    : normalizeText(config.publish?.url)
}

export function resolveConfigurationStateFromBuilderConfig(config: BuilderPublishConfig): QClawUpdateConfigurationState {
  const publishUrl = extractPublishUrlFromBuilderConfig(config)
  const looksPlaceholder =
    normalizeText(config.appId) === 'YourAppID' ||
    looksPlaceholderPublishUrl(publishUrl)

  return {
    supported: true,
    configured: false,
    message: looksPlaceholder
      ? '当前仍是占位发布配置，Qclaw 自动更新尚未启用。'
      : '当前为开发环境，Qclaw 自动更新需在打包产物中验证。',
  }
}

export function resolveConfigurationStateFromPackagedYaml(rawConfig: string): QClawUpdateConfigurationState {
  const publishUrl = extractPublishUrlFromAppUpdateYaml(rawConfig)
  if (looksPlaceholderPublishUrl(publishUrl || '')) {
    return {
      supported: true,
      configured: false,
      message: '当前打包产物仍使用占位更新源，Qclaw 自动更新尚未启用。',
    }
  }

  return {
    supported: true,
    configured: true,
    message: 'Qclaw 自动更新已就绪。',
  }
}
