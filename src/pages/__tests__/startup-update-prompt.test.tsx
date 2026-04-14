import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import appSource from '../../App.tsx?raw'
import StartupUpdatePrompt, { resolveStartupUpdateVersionLabel } from '../StartupUpdatePrompt'

describe('StartupUpdatePrompt', () => {
  it('renders the startup update gate before the welcome safety notice', () => {
    expect(appSource).toContain("const [appState, setAppState] = useState<AppState>('startup-update')")
    expect(appSource).toContain("void window.api.checkQClawUpdate()")
    expect(appSource).toContain("if (appState === 'startup-update') {")
    expect(appSource).toContain("onLater={() => setAppState('welcome')}")
  })

  it('renders the detected version and actions', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <StartupUpdatePrompt availableVersion="2026.4.1003" onLater={vi.fn()} onUpdateNow={vi.fn()} />
      </MantineProvider>
    )

    expect(html).toContain('已发现 Qclaw 新版本')
    expect(html).toContain('新版本：2026.4.1003')
    expect(html).toContain('稍后再说')
    expect(html).toContain('立即更新')
  })

  it('normalizes the displayed version label', () => {
    expect(resolveStartupUpdateVersionLabel(' 2026.4.1003 ')).toBe('2026.4.1003')
    expect(resolveStartupUpdateVersionLabel('')).toBe('')
  })
})
