import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOpenClawLegacyEnvPatch,
  resetOpenClawLegacyEnvWarningsForTests,
  resolveOpenClawEnvValue,
} from '../openclaw-legacy-env-migration'

const { resolveOpenClawPathsForReadMock, readConfigMock } = vi.hoisted(() => ({
  resolveOpenClawPathsForReadMock: vi.fn(),
  readConfigMock: vi.fn(),
}))

const { existsSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const { mkdtemp, mkdir, readFile, rm, writeFile } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

vi.mock('../cli', () => ({
  readConfig: readConfigMock,
}))

vi.mock('../openclaw-runtime-readonly', () => ({
  resolveOpenClawPathsForRead: resolveOpenClawPathsForReadMock,
}))

import { listWeixinAccountState, removeWeixinAccountState } from '../weixin-account-state'

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

describe('weixin-account-state', () => {
  let homeDir = ''

  beforeEach(async () => {
    homeDir = await mkdtemp('/tmp/qclaw-weixin-state-')
    resolveOpenClawPathsForReadMock.mockReset()
    readConfigMock.mockReset()
    resetOpenClawLegacyEnvWarningsForTests()
    resolveOpenClawPathsForReadMock.mockResolvedValue({ homeDir })
    readConfigMock.mockResolvedValue(null)
  })

  afterEach(async () => {
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('lists personal WeChat accounts from state index and config metadata', async () => {
    const weixinStateDir = joinPath(homeDir, 'openclaw-weixin')
    const accountsDir = joinPath(weixinStateDir, 'accounts')
    await mkdir(accountsDir, { recursive: true })
    await writeFile(
      joinPath(weixinStateDir, 'accounts.json'),
      JSON.stringify(['wx-account']),
      'utf-8'
    )
    await writeFile(
      joinPath(accountsDir, 'wx-account.json'),
      JSON.stringify({
        token: 'token-123',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        userId: 'user@im.wechat',
      }),
      'utf-8'
    )

    readConfigMock.mockResolvedValue({
      channels: {
        'openclaw-weixin': {
          accounts: {
            'wx-account': {
              enabled: false,
              name: '主账号',
            },
            stale: {
              enabled: true,
              name: '残留账号',
            },
          },
        },
      },
    })

    const accounts = await listWeixinAccountState()

    expect(accounts).toEqual([
      {
        accountId: 'stale',
        configured: false,
        enabled: true,
        name: '残留账号',
      },
      {
        accountId: 'wx-account',
        configured: true,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        userId: 'user@im.wechat',
        enabled: false,
        name: '主账号',
      },
    ])
  })

  it('ignores removed CLAWDBOT_STATE_DIR during steady-state reads and warns once', async () => {
    const previousStateDir = process.env.CLAWDBOT_STATE_DIR
    const legacyHomeDir = await mkdtemp('/tmp/qclaw-weixin-legacy-state-')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CLAWDBOT_STATE_DIR = legacyHomeDir

    try {
      const legacyWeixinStateDir = joinPath(legacyHomeDir, 'openclaw-weixin')
      const legacyAccountsDir = joinPath(legacyWeixinStateDir, 'accounts')
      await mkdir(legacyAccountsDir, { recursive: true })
      await writeFile(
        joinPath(legacyWeixinStateDir, 'accounts.json'),
        JSON.stringify(['legacy-only']),
        'utf-8'
      )
      await writeFile(
        joinPath(legacyAccountsDir, 'legacy-only.json'),
        JSON.stringify({ token: 'legacy-token' }),
        'utf-8'
      )

      const accounts = await listWeixinAccountState()

      expect(accounts).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        '[openclaw] Ignoring removed legacy env alias CLAWDBOT_STATE_DIR; steady-state now reads OPENCLAW_STATE_DIR only.'
      )
    } finally {
      warnSpy.mockRestore()
      await rm(legacyHomeDir, { recursive: true, force: true })
      if (previousStateDir == null) delete process.env.CLAWDBOT_STATE_DIR
      else process.env.CLAWDBOT_STATE_DIR = previousStateDir
    }
  })

  it('migrates legacy aliases only in explicit migration mode', () => {
    const warn = vi.fn()
    const migrated = resolveOpenClawEnvValue(
      { MOLTBOT_STATE_DIR: '/tmp/moltbot-state' },
      'OPENCLAW_STATE_DIR',
      { mode: 'migration', onWarning: warn }
    )
    const patch = buildOpenClawLegacyEnvPatch(
      { MOLTBOT_STATE_DIR: '/tmp/moltbot-state' },
      { mode: 'migration', onWarning: warn }
    )

    expect(migrated).toEqual({
      canonicalKey: 'OPENCLAW_STATE_DIR',
      value: '/tmp/moltbot-state',
      source: 'legacy',
      legacyKey: 'MOLTBOT_STATE_DIR',
    })
    expect(patch).toMatchObject({
      OPENCLAW_STATE_DIR: '/tmp/moltbot-state',
      MOLTBOT_STATE_DIR: undefined,
      CLAWDBOT_STATE_DIR: undefined,
    })
    expect(warn).toHaveBeenCalledWith(
      '[openclaw] Detected removed legacy env alias MOLTBOT_STATE_DIR; migrating it to OPENCLAW_STATE_DIR for this compatibility path only. Set OPENCLAW_STATE_DIR explicitly.'
    )
  })

  it('removes personal WeChat account files and updates the account index', async () => {
    const weixinStateDir = joinPath(homeDir, 'openclaw-weixin')
    const accountsDir = joinPath(weixinStateDir, 'accounts')
    const credentialsDir = joinPath(homeDir, 'credentials')
    await mkdir(accountsDir, { recursive: true })
    await mkdir(credentialsDir, { recursive: true })

    await writeFile(
      joinPath(weixinStateDir, 'accounts.json'),
      JSON.stringify(['wx-account', 'keep-account'], null, 2),
      'utf-8'
    )
    await writeFile(joinPath(accountsDir, 'wx-account.json'), '{}', 'utf-8')
    await writeFile(joinPath(accountsDir, 'wx-account.sync.json'), '{}', 'utf-8')
    await writeFile(
      joinPath(credentialsDir, 'openclaw-weixin-wx-account-allowFrom.json'),
      '{}',
      'utf-8'
    )

    const result = await removeWeixinAccountState('wx-account')

    expect(result).toEqual({ ok: true })
    expect(existsSync(joinPath(accountsDir, 'wx-account.json'))).toBe(false)
    expect(existsSync(joinPath(accountsDir, 'wx-account.sync.json'))).toBe(false)
    expect(existsSync(joinPath(credentialsDir, 'openclaw-weixin-wx-account-allowFrom.json'))).toBe(false)
    expect(
      JSON.parse(await readFile(joinPath(weixinStateDir, 'accounts.json'), 'utf-8'))
    ).toEqual(['keep-account'])
  })
})
