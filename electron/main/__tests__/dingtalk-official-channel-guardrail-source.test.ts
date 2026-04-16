import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function extractHandlerSource(source: string, channelName: string): string {
  const marker = `ipcMain.handle('${channelName}'`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`${channelName} handler not found`)
  const nextHandler = source.indexOf('ipcMain.handle(', start + marker.length)
  return nextHandler >= 0 ? source.slice(start, nextHandler) : source.slice(start)
}

describe('DingTalk official channel guardrail boundaries', () => {
  it('keeps the DingTalk official setup IPC on the dedicated adapter path', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'ipc-handlers.ts'),
      'utf8'
    )
    const handler = extractHandlerSource(source, 'channels:dingtalk:setup-official')

    expect(handler).toContain("runOfficialChannelMutation('dingtalk'")
    expect(handler).toContain('setupDingtalkOfficialChannel(formData)')
    expect(handler).not.toContain('runManagedPluginIpcOperation')
    expect(handler).not.toContain('runManagedPluginRepairIpcOperation')
    expect(handler).not.toContain('prepareManagedChannelPluginForSetup')
  })

  it('does not attach Feishu or Weixin installer guardrail/runtime bridge logic to the DingTalk adapter', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'main', 'dingtalk-official-channel.ts'),
      'utf8'
    )

    expect(source).toContain("reason: 'channel-connect-sanitize'")
    expect(source).toContain("reason: 'channel-connect-configure'")
    expect(source).toContain("'dingtalk-official-channel-setup'")
    expect(source).toContain("'dingtalk-official-channel-repair'")
    expect(source).not.toContain('ChannelInstallerGuardrail')
    expect(source).not.toContain('startFeishuInstallerSession')
    expect(source).not.toContain('startWeixinInstallerSession')
    expect(source).not.toContain('resolveWindowsChannelRuntimeContext')
    expect(source).not.toContain('channel-preflight')
  })
})
