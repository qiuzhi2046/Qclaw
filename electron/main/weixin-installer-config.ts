const WEIXIN_PLUGIN_ID = 'openclaw-weixin'

function cloneConfig(config: Record<string, any> | null): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function prepareWeixinInstallerConfig(
  config: Record<string, any> | null,
  options: {
    pluginInstalledOnDisk: boolean
  }
): { config: Record<string, any>; changed: boolean } {
  const next = cloneConfig(config)
  if (!options.pluginInstalledOnDisk) {
    return {
      config: next,
      changed: false,
    }
  }

  const plugins = hasOwnRecord(next.plugins) ? next.plugins : null
  const entries = hasOwnRecord(plugins?.entries) ? plugins.entries : null
  if (!entries || entries[WEIXIN_PLUGIN_ID] === undefined) {
    return {
      config: next,
      changed: false,
    }
  }

  delete entries[WEIXIN_PLUGIN_ID]
  return {
    config: next,
    changed: true,
  }
}
