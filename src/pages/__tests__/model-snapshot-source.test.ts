import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('model snapshot source adoption', () => {
  it('loads the models page through the unified model snapshot IPC', () => {
    const modelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ModelsPage.tsx'),
      'utf8'
    )

    expect(modelsPageSource).toContain('window.api.getModelSnapshot')
    expect(modelsPageSource).not.toContain('const [env, cfg, upstreamState] = await Promise.all([')
  })

  it('loads the feishu model modal through the unified model snapshot IPC', () => {
    const channelsPageSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(channelsPageSource).toContain('window.api.getModelSnapshot')
    expect(channelsPageSource).not.toContain('const [statusResult, envVars, configData] = await Promise.all([')
  })
})
