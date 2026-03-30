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
    expect(html).toContain('Qclaw 会接管您的 Node 环境')
    expect(html).toContain('如果您有本地项目依赖特定的 Node 环境，请谨慎安装')
    expect(html).toContain('最后，建议不要在工作机上使用')
  })
})
