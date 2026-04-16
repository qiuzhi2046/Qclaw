import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('ipc channel-aware config patch source', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'electron', 'main', 'ipc-handlers.ts'),
    'utf-8'
  )

  it('routes renderer config patch IPC through the channel-aware wrapper', () => {
    expect(source).toContain("import { applyChannelAwareConfigPatchGuarded } from './channel-aware-config-patch'")
    expect(source).toContain("ipcMain.handle('openclaw:config:apply-patch'")
    expect(source).toContain('applyChannelAwareConfigPatchGuarded(request, candidate)')
  })

  it('classifies renderer full config writes through the channel-aware wrapper before writing', () => {
    const guardedWriteIndex = source.indexOf("ipcMain.handle('openclaw:config:guarded-write'")
    const applyIndex = source.indexOf('applyChannelAwareConfigPatchGuarded(', guardedWriteIndex)
    const readIndex = source.indexOf('const beforeConfig = await readConfig().catch(() => null)', guardedWriteIndex)
    const writeIndex = source.indexOf('guardedWriteConfig(request, preferredCandidate)', guardedWriteIndex)

    expect(guardedWriteIndex).toBeGreaterThan(-1)
    expect(readIndex).toBeGreaterThan(guardedWriteIndex)
    expect(applyIndex).toBeGreaterThan(readIndex)
    expect(writeIndex).toBeGreaterThan(applyIndex)
  })
})
