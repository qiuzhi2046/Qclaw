import { describe, expect, it } from 'vitest'
import { buildCliPathWithCandidates, listExecutablePathCandidates } from '../runtime-path-discovery'
import { buildWindowsActiveRuntimeSnapshot } from '../platforms/windows/windows-runtime-policy'
import { buildTestEnv } from './test-env'

describe('buildCliPathWithCandidates', () => {
  it('prepends override, tool-manager, npm-prefix, and common dirs ahead of the current PATH', () => {
    const pathValue = buildCliPathWithCandidates({
      platform: 'darwin',
      currentPath: '/usr/bin:/bin',
      detectedNodeBinDir: '/opt/custom/node/bin',
      npmPrefix: '/Users/alice/.npm-global',
      env: buildTestEnv({
        HOME: '/Users/alice',
        QCLAW_CLI_EXTRA_BIN_DIRS: '/custom/shared/bin',
        QCLAW_NODE_EXTRA_BIN_DIRS: '/custom/node/bin',
        QCLAW_OPENCLAW_EXTRA_BIN_DIRS: '/custom/openclaw/bin',
        NVM_BIN: '/Users/alice/.nvm/versions/node/v22.14.0/bin',
        VOLTA_HOME: '/Users/alice/.volta',
        FNM_MULTISHELL_PATH: '/Users/alice/.local/state/fnm_multishells/1234',
        ASDF_DATA_DIR: '/Users/alice/.asdf',
        PNPM_HOME: '/Users/alice/Library/pnpm',
        MISE_SHIMS_DIR: '/Users/alice/.local/share/mise/shims',
      }),
    })

    const entries = pathValue.split(':')
    expect(entries.slice(0, 10)).toEqual([
      '/custom/shared/bin',
      '/custom/node/bin',
      '/custom/openclaw/bin',
      '/opt/custom/node/bin',
      '/Users/alice/.nvm/versions/node/v22.14.0/bin',
      '/Users/alice/.volta/bin',
      '/Users/alice/.local/state/fnm_multishells/1234/bin',
      '/Users/alice/.asdf/shims',
      '/Users/alice/Library/pnpm',
      '/Users/alice/.local/share/mise/shims',
    ])
    expect(entries).toContain('/Users/alice/homebrew/bin')
    expect(entries).toContain('/Users/alice/.npm-global/bin')
    expect(entries).toContain('/opt/homebrew/bin')
    expect(entries).toContain('/usr/local/bin')
    expect(entries.slice(-2)).toEqual(['/usr/bin', '/bin'])
  })
})

describe('listExecutablePathCandidates', () => {
  it('includes Node override and manager bins before static node fallbacks', () => {
    const candidates = listExecutablePathCandidates('node', {
      platform: 'darwin',
      currentPath: '/usr/bin:/bin',
      detectedNodeBinDir: '/opt/custom/node/bin',
      env: buildTestEnv({
        HOME: '/Users/alice',
        QCLAW_NODE_EXTRA_BIN_DIRS: '/custom/node/bin',
        NVM_BIN: '/Users/alice/.nvm/versions/node/v22.14.0/bin',
        VOLTA_HOME: '/Users/alice/.volta',
      }),
    })

    expect(candidates.slice(0, 5)).toEqual([
      '/custom/node/bin/node',
      '/usr/bin/node',
      '/bin/node',
      '/opt/custom/node/bin/node',
      '/Users/alice/.nvm/versions/node/v22.14.0/bin/node',
    ])
    expect(candidates).toContain('/Users/alice/.volta/bin/node')
    expect(candidates).toContain('/Users/alice/homebrew/bin/node')
    expect(candidates).toContain('/opt/homebrew/bin/node')
  })

  it('prefers the Windows private Node runtime before system Node fallbacks', () => {
    const candidates = listExecutablePathCandidates('node', {
      platform: 'win32',
      currentPath: 'C:\\Windows\\System32',
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      }),
    })

    const privateNode =
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node.exe'
    const systemNode = 'C:\\Program Files\\nodejs\\node.exe'
    expect(candidates).toContain(privateNode)
    expect(candidates).toContain(systemNode)
    expect(candidates.indexOf(privateNode)).toBeLessThan(candidates.indexOf(systemNode))
    expect(candidates.every((candidate) => !candidate.endsWith('\\node.cmd'))).toBe(true)
    expect(candidates.every((candidate) => !candidate.endsWith('\\node'))).toBe(true)
  })

  it('includes openclaw override and npm-prefix bins before Windows roaming fallbacks', () => {
    const candidates = listExecutablePathCandidates('openclaw', {
      platform: 'win32',
      currentPath: 'C:\\Windows\\System32',
      npmPrefix: 'D:\\Tools\\npm-global',
      env: buildTestEnv({
        QCLAW_OPENCLAW_EXTRA_BIN_DIRS: 'E:\\OpenClaw\\bin',
        VOLTA_HOME: 'C:\\Users\\alice\\.volta',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
    })

    expect(candidates.slice(0, 6)).toEqual([
      'E:\\OpenClaw\\bin\\openclaw.cmd',
      'E:\\OpenClaw\\bin\\openclaw.exe',
      'E:\\OpenClaw\\bin\\openclaw',
      'C:\\Windows\\System32\\openclaw.cmd',
      'C:\\Windows\\System32\\openclaw.exe',
      'C:\\Windows\\System32\\openclaw',
    ])
    expect(candidates).toContain('D:\\Tools\\npm-global\\openclaw.cmd')
    expect(candidates).toContain('C:\\Users\\alice\\.volta\\bin\\openclaw.cmd')
    expect(candidates).toContain('C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd')
  })

  it('includes the Windows private runtime openclaw shim before roaming fallbacks', () => {
    const candidates = listExecutablePathCandidates('openclaw', {
      platform: 'win32',
      currentPath: 'C:\\Windows\\System32',
      env: buildTestEnv({
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
    })

    const privateOpenClaw =
      'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd'
    const roamingOpenClaw = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\openclaw.cmd'

    expect(candidates).toContain(privateOpenClaw)
    expect(candidates).toContain(roamingOpenClaw)
    expect(candidates.indexOf(privateOpenClaw)).toBeLessThan(candidates.indexOf(roamingOpenClaw))
  })

  it('includes the user Homebrew bin in macOS openclaw fallback candidates', () => {
    const candidates = listExecutablePathCandidates('openclaw', {
      platform: 'darwin',
      currentPath: '/usr/bin:/bin',
      env: buildTestEnv({
        HOME: '/Users/alice',
      }),
    })

    expect(candidates).toContain('/Users/alice/homebrew/bin/openclaw')
    expect(candidates).toContain('/opt/homebrew/bin/openclaw')
    expect(candidates).toContain('/usr/local/bin/openclaw')
  })

  it('prefers the active Windows runtime snapshot openclaw bin before command-path fallbacks', () => {
    const snapshot = buildWindowsActiveRuntimeSnapshot({
      openclawExecutable: 'C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw.cmd',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmPrefix: 'C:\\Users\\qiuzh\\AppData\\Roaming\\npm',
      configPath: 'C:\\Users\\qiuzh\\.openclaw\\config.json',
      stateDir: 'C:\\Users\\qiuzh\\.openclaw',
      extensionsDir: 'C:\\Users\\qiuzh\\.openclaw\\extensions',
    })

    const candidates = listExecutablePathCandidates('openclaw', {
      platform: 'win32',
      currentPath: 'C:\\Windows\\System32',
      activeRuntimeSnapshot: snapshot,
      env: buildTestEnv({
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\alice',
      }),
    })

    expect(candidates.slice(0, 3)).toEqual([
      'C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw.cmd',
      'C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw.exe',
      'C:\\Users\\qiuzh\\AppData\\Roaming\\npm\\openclaw',
    ])
  })
})
