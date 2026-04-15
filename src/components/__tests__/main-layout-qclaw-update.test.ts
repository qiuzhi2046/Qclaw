import { describe, expect, it } from 'vitest'

import mainLayoutSource from '../MainLayout.tsx?raw'

describe('MainLayout Qclaw update shortcut', () => {
  it('keeps the install handoff observable and falls back to manual download', () => {
    expect(mainLayoutSource).toContain('QCLAW_UPDATE_INSTALL_HANDOFF_TIMEOUT_MS')
    expect(mainLayoutSource).toContain('openQClawUpdateDownloadUrl')
    expect(mainLayoutSource).toContain('安装器启动超时')
  })
})
