import { describe, expect, it } from 'vitest'

const { readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('electron phase4 contract', () => {
  it('keeps ElectronApi phase4 methods aligned to shared upgrade result types', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/types/electron.d.ts'), 'utf8')

    expect(source).toContain('interface OpenClawUpgradeCheckResult {')
    expect(source).toContain('manualHint?: string')
    expect(source).toContain("errorCode?: 'not_installed' | 'latest_unknown' | 'manual_only'")
    expect(source).toContain('interface OpenClawUpgradeRunResult {')
    expect(source).toContain("installSource: OpenClawInstallCandidate['installSource'] | null")
    expect(source).toContain('interface CombinedUpdateCheckResult {')
    expect(source).toContain('openclaw: OpenClawUpgradeCheckResult')
    expect(source).toContain('canRun: boolean')
    expect(source).toContain('interface CombinedUpdateRunResult {')
    expect(source).toContain("errorCode?: 'openclaw_blocked' | 'qclaw_unavailable' | 'qclaw_download_failed' | 'openclaw_upgrade_failed'")
    expect(source).toContain('checkOpenClawUpgrade: () => Promise<OpenClawUpgradeCheckResult>')
    expect(source).toContain('checkOpenClawUpgradeForEnvCheck: (')
    expect(source).toContain(') => Promise<OpenClawUpgradeCheckResult>')
    expect(source).toContain('runOpenClawUpgrade: () => Promise<OpenClawUpgradeRunResult>')
    expect(source).toContain('checkCombinedUpdate: () => Promise<CombinedUpdateCheckResult>')
    expect(source).toContain('runCombinedUpdate: () => Promise<CombinedUpdateRunResult>')
  })

  it('exposes structured channel installer guardrail fields to the renderer contract', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/types/electron.d.ts'), 'utf8')

    expect(source).toContain('ChannelInstallerGuardrailStatus')
    expect(source).toContain('interface FeishuInstallerSessionSnapshot')
    expect(source).toContain('interface WeixinInstallerSessionSnapshot')
    expect(source).toContain('guardrail?: ChannelInstallerGuardrailStatus')
    expect(source).toContain('guardrail?: ChannelInstallerGuardrailStatus')
    expect(source).toContain('onFeishuInstallerEvent: (listener: (payload: FeishuInstallerSessionEvent) => void) => () => void')
    expect(source).toContain('onWeixinInstallerEvent: (listener: (payload: WeixinInstallerSessionEvent) => void) => () => void')
  })
})
