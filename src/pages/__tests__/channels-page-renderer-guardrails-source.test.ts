import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('ChannelsPage renderer guardrails', () => {
  it('does not write Feishu normalized config from the channel list refresh path', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )

    expect(source).toContain('const [channelConfigNotice, setChannelConfigNotice] = useState')
    expect(source).toContain('需要显式同步飞书配置')
    expect(source).toContain('本页不会在后台静默写入 managed channel 配置')
    expect(source).not.toContain('Keep listing channels even if the background healing write fails.')
    expect(source).not.toContain('afterConfig: normalizedConfig')
  })

  it('removes personal Weixin account state only after the guarded config write succeeds', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'pages', 'ChannelsPage.tsx'),
      'utf8'
    )
    const writeIndex = source.indexOf('const writeResult = await window.api.applyConfigPatchGuarded({')
    const failureCheckIndex = source.indexOf('if (!writeResult.ok)', writeIndex)
    const removeStateIndex = source.indexOf('await window.api.removeWeixinAccount(weixinAccountStateToRemove)', writeIndex)

    expect(source).toContain("let weixinAccountStateToRemove = ''")
    expect(writeIndex).toBeGreaterThan(-1)
    expect(failureCheckIndex).toBeGreaterThan(writeIndex)
    expect(removeStateIndex).toBeGreaterThan(failureCheckIndex)
  })
})
