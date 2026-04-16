import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractHandlerSource(source: string, channelName: string): string {
  const marker = `ipcMain.handle('${channelName}'`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`${channelName} handler not found`)
  const nextHandler = source.indexOf('ipcMain.handle(', start + marker.length)
  return nextHandler >= 0 ? source.slice(start, nextHandler) : source.slice(start)
}

describe('managed channel plugin IPC guard source wiring', () => {
  it('guards generic plugin install/uninstall and mutating repair without locking dry-run scan', async () => {
    const source = await readFile(path.join(process.cwd(), 'electron/main/ipc-handlers.ts'), 'utf8')

    expect(source).toContain("from './managed-channel-ipc-guard'")
    expect(source).toContain('getManagedChannelPluginLockKey')
    expect(extractHandlerSource(source, 'plugins:install')).toContain('runManagedPluginIpcOperation')
    expect(extractHandlerSource(source, 'plugins:installNpx')).toContain('runManagedPluginIpcOperation')
    expect(extractHandlerSource(source, 'plugins:uninstall')).toContain('runManagedPluginIpcOperation')
    expect(extractHandlerSource(source, 'plugins:repair-incompatible')).toContain('runManagedPluginRepairIpcOperation')
    expect(extractHandlerSource(source, 'plugins:scan-incompatible')).not.toContain('runManagedPluginRepairIpcOperation')
  })

  it('serializes official channel mutating IPC through the managed channel lock', async () => {
    const source = await readFile(path.join(process.cwd(), 'electron/main/ipc-handlers.ts'), 'utf8')

    expect(source).toContain('function runOfficialChannelMutation')
    expect(source).toContain('withManagedOperationLock(getManagedChannelPluginLockKey(channelId), operation)')
    expect(extractHandlerSource(source, 'plugins:feishu-ensure-ready')).toContain(
      "runOfficialChannelMutation('feishu'"
    )
    expect(extractHandlerSource(source, 'channels:dingtalk:setup-official')).toContain(
      "runOfficialChannelMutation('dingtalk'"
    )
    expect(extractHandlerSource(source, 'channels:official:repair')).toContain(
      'runOfficialChannelMutation(channelId'
    )
  })
})
