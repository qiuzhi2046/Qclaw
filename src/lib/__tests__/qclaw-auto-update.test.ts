import { describe, expect, it, vi } from 'vitest'
import type { QClawUpdateActionResult, QClawUpdateStatus } from '../../shared/openclaw-phase4'
import { runQClawAutoUpdate } from '../qclaw-auto-update'

function status(patch: Partial<QClawUpdateStatus> = {}): QClawUpdateStatus {
  return {
    ok: true,
    supported: true,
    configured: true,
    currentVersion: '2.2.0',
    availableVersion: '2.3.0',
    status: 'available',
    progressPercent: null,
    downloaded: false,
    ...patch,
  }
}

function actionResult(patch: Partial<QClawUpdateActionResult> = {}): QClawUpdateActionResult {
  return {
    ok: true,
    status: status({ status: 'downloaded', downloaded: true, progressPercent: 100 }),
    message: 'ok',
    ...patch,
  }
}

describe('runQClawAutoUpdate', () => {
  it('downloads first and then starts install', async () => {
    const downloadResult = actionResult()
    const installResult = actionResult({
      status: status({ status: 'installing', downloaded: true, progressPercent: 100 }),
      message: 'Qclaw 即将退出并安装更新。',
    })
    const api = {
      downloadQClawUpdate: vi.fn().mockResolvedValue(downloadResult),
      installQClawUpdate: vi.fn().mockResolvedValue(installResult),
    }

    const result = await runQClawAutoUpdate(api)

    expect(result.ok).toBe(true)
    expect(api.downloadQClawUpdate).toHaveBeenCalledTimes(1)
    expect(api.installQClawUpdate).toHaveBeenCalledTimes(1)
  })

  it('stops before install when download fails', async () => {
    const downloadResult = actionResult({
      ok: false,
      status: status({ status: 'error', error: 'download failed' }),
      message: 'download failed',
    })
    const api = {
      downloadQClawUpdate: vi.fn().mockResolvedValue(downloadResult),
      installQClawUpdate: vi.fn(),
    }

    const result = await runQClawAutoUpdate(api)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('download')
      expect(result.message).toBe('download failed')
    }
    expect(api.installQClawUpdate).not.toHaveBeenCalled()
  })

  it('stops before install when download did not reach downloaded state', async () => {
    const downloadResult = actionResult({
      status: status({ status: 'available', downloaded: false }),
      message: '',
    })
    const api = {
      downloadQClawUpdate: vi.fn().mockResolvedValue(downloadResult),
      installQClawUpdate: vi.fn(),
    }

    const result = await runQClawAutoUpdate(api)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('download')
      expect(result.message).toBe('Qclaw 更新包尚未下载完成，请稍后重试。')
    }
    expect(api.installQClawUpdate).not.toHaveBeenCalled()
  })

  it('reports install failures', async () => {
    const installResult = actionResult({
      ok: false,
      status: status({ status: 'error', downloaded: true, error: 'install failed' }),
      message: 'install failed',
    })
    const api = {
      downloadQClawUpdate: vi.fn().mockResolvedValue(actionResult()),
      installQClawUpdate: vi.fn().mockResolvedValue(installResult),
    }

    const result = await runQClawAutoUpdate(api)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.phase).toBe('install')
      expect(result.message).toBe('install failed')
    }
  })
})
