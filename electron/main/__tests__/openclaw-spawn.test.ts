import { describe, expect, it } from 'vitest'
import { normalizeAuthChoice, resolveOpenClawCommand } from '../openclaw-spawn'

describe('normalizeAuthChoice', () => {
  it('maps deprecated codex-cli to openai-codex', () => {
    expect(normalizeAuthChoice('codex-cli')).toBe('openai-codex')
    expect(normalizeAuthChoice('openai-codex')).toBe('openai-codex')
  })
})

describe('resolveOpenClawCommand', () => {
  it('uses plain openclaw command for non-oauth calls', () => {
    const resolved = resolveOpenClawCommand(['status', '--json'], 'darwin')
    expect(resolved).toEqual({
      command: 'openclaw',
      args: ['status', '--json'],
      shell: false,
    })
  })

  it('uses the injected command path for non-oauth calls', () => {
    const resolved = resolveOpenClawCommand(['status', '--json'], {
      platform: 'darwin',
      commandPath: '/Users/demo/.nvm/versions/node/v24.9.0/bin/openclaw',
    })

    expect(resolved).toEqual({
      command: '/Users/demo/.nvm/versions/node/v24.9.0/bin/openclaw',
      args: ['status', '--json'],
      shell: false,
    })
  })

  it('uses pty wrapper for oauth command on darwin', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      { platform: 'darwin' }
    )
    expect(resolved.command).toBe('script')
    expect(resolved.args.slice(0, 4)).toEqual(['-q', '/dev/null', 'openclaw', 'models'])
    expect(resolved.shell).toBe(false)
  })

  it('passes the injected command path through the darwin pty wrapper', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      {
        platform: 'darwin',
        commandPath: '/Users/demo/.nvm/versions/node/v24.9.0/bin/openclaw',
      }
    )

    expect(resolved.command).toBe('script')
    expect(resolved.args.slice(0, 4)).toEqual([
      '-q',
      '/dev/null',
      '/Users/demo/.nvm/versions/node/v24.9.0/bin/openclaw',
      'models',
    ])
  })

  it('uses expect wrapper for google-gemini-cli oauth login on darwin when available', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'google-gemini-cli', '--method', 'oauth'],
      {
        platform: 'darwin',
        expectAvailable: true,
      }
    )

    expect(resolved.command).toBe('expect')
    expect(resolved.args[0]).toBe('-c')
    expect(resolved.args[1]).toContain('spawn -noecho "openclaw" "models" "auth" "login"')
    expect(resolved.args[1]).toContain('C\\s*o\\s*n\\s*t\\s*i\\s*n\\s*u\\s*e')
    expect(resolved.shell).toBe(false)
  })

  it('uses pty wrapper on darwin regardless of parent stdin type', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      { platform: 'darwin' }
    )
    expect(resolved.command).toBe('script')
    expect(resolved.args.slice(0, 4)).toEqual(['-q', '/dev/null', 'openclaw', 'models'])
    expect(resolved.shell).toBe(false)
  })

  it('uses pty wrapper for oauth command on linux', () => {
    const resolved = resolveOpenClawCommand(
      ['onboard', '--flow', 'quickstart', '--auth-choice', 'openai-codex'],
      { platform: 'linux' }
    )
    expect(resolved.command).toBe('script')
    expect(resolved.args[0]).toBe('-q')
    expect(resolved.args[1]).toBe('-e')
    expect(resolved.args[2]).toBe('-c')
    expect(resolved.args[4]).toBe('/dev/null')
    expect(resolved.shell).toBe(false)
  })

  it('uses pty wrapper on linux regardless of parent stdin type', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      { platform: 'linux' }
    )
    expect(resolved.command).toBe('script')
    expect(resolved.args[0]).toBe('-q')
    expect(resolved.args[1]).toBe('-e')
    expect(resolved.args[2]).toBe('-c')
    expect(resolved.args[4]).toBe('/dev/null')
    expect(resolved.shell).toBe(false)
  })

  it('falls back to direct command on windows', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      'win32'
    )
    expect(resolved).toEqual({
      command: 'openclaw',
      args: ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      shell: true,
    })
  })

  it('falls back to direct openclaw execution when script is unavailable on POSIX', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'openai', '--method', 'openai-codex'],
      {
        platform: 'linux',
        scriptAvailable: false,
        scriptWarning: 'Interactive OAuth requires the script command.',
      }
    )

    expect(resolved.command).toBe('openclaw')
    expect(resolved.args).toEqual([
      'models',
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'openai-codex',
    ])
    expect(resolved.shell).toBe(false)
    expect(resolved.capabilityWarning).toContain('script command')
  })

  it('keeps the script wrapper but surfaces a warning when expect is unavailable for google-gemini-cli oauth login', () => {
    const resolved = resolveOpenClawCommand(
      ['models', 'auth', 'login', '--provider', 'google-gemini-cli', '--method', 'oauth'],
      {
        platform: 'darwin',
        expectAvailable: false,
        expectWarning: 'Gemini CLI OAuth prompt automation requires expect.',
      }
    )

    expect(resolved.command).toBe('script')
    expect(resolved.args.slice(0, 4)).toEqual(['-q', '/dev/null', 'openclaw', 'models'])
    expect(resolved.capabilityWarning).toContain('requires expect')
  })
})
