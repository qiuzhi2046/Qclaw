import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import appSource from '../../App.tsx?raw'
import Welcome from '../Welcome'

describe('Welcome', () => {
  it('renders the welcome frame without vertical scrolling', () => {
    expect(appSource).toMatch(
      /if \(appState === 'welcome'\) \{[\s\S]{0,220}renderFrame\([\s\S]{0,160}, false\)/
    )
  })

  it('shows the node environment risk notice for setup', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <Welcome onAccept={vi.fn()} />
      </MantineProvider>
    )

    expect(html).toContain('环境风险')
    expect(html).toContain('Openclaw权限较大，不建议使用含有重要文件的工作电脑')
    expect(html).toContain('当前Openclaw 要求 Node.js 版本高于22.16')
    expect(html).toContain('Qclaw 会自动安装最新版node，可能造成node版本覆盖')
    expect(html).toContain('OpenClaw 命令行工具')
    expect(html).toContain('使用 AI 服务可能产生费用，具体取决于你选择的服务商和使用量。')
    expect(html).toContain('本地数据存储（所有配置和数据默认只保存在此电脑上）')
  })
})
