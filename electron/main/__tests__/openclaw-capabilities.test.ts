import { describe, expect, it, vi } from 'vitest'
import {
  type CliCommandResult,
  discoverOpenClawCapabilities,
  parseAuthChoicesFromOnboardHelp,
  parseLongFlags,
  parseModelsCommands,
} from '../openclaw-capabilities'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'

function ok(stdout: string): CliCommandResult {
  return { ok: true, stdout, stderr: '', code: 0 }
}

describe('parseLongFlags', () => {
  it('parses long flags while preserving order', () => {
    const help = `
Usage: openclaw onboard [options]
Options:
  --auth-choice <choice>                   Auth choice
  --accept-risk                            accept risk
  --skip-ui                                skip ui
`
    expect(parseLongFlags(help)).toEqual(['--auth-choice', '--accept-risk', '--skip-ui'])
  })
})

describe('parseModelsCommands', () => {
  it('parses model subcommands while preserving order', () => {
    const help = `
Usage: openclaw models [options] [command]
Commands:
  auth
  list
  status
  help
`
    expect(parseModelsCommands(help)).toEqual(['auth', 'list', 'status'])
  })

  it('parses commands when OpenClaw marks subcommand groups with a trailing star', () => {
    const help = `
Usage: openclaw [options] [command]
Commands:
  acp *                Agent Control Protocol tools
  models *             Discover, scan, and configure models
  onboard              Interactive onboarding wizard
  plugins *            Manage OpenClaw plugins and extensions
  help                 Display help for command
`
    expect(parseModelsCommands(help)).toEqual(['acp', 'models', 'onboard', 'plugins'])
  })
})

describe('parseAuthChoicesFromOnboardHelp', () => {
  it('parses auth choices from the onboard help Auth section', () => {
    const help = `
Usage: openclaw onboard [options]
Options:
  --auth-choice <choice> Auth: openai-codex|qwen-portal|google-gemini-cli
  --accept-risk          accept risk
`

    expect(parseAuthChoicesFromOnboardHelp(help)).toEqual([
      'openai-codex',
      'qwen-portal',
      'google-gemini-cli',
    ])
  })
})

describe('discoverOpenClawCapabilities', () => {
  it('embeds auth registry metadata and exposes registry source', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [
          {
            id: 'openai-official',
            label: 'OpenAI',
            methods: [
              {
                authChoice: 'openai-codex',
                label: 'OAuth · openai-codex',
                kind: 'oauth',
                route: {
                  kind: 'models-auth-login',
                  providerId: 'openai-codex',
                  requiresBrowser: true,
                },
              },
            ],
          },
          {
            id: 'qwen-official',
            label: 'Qwen',
            methods: [
              {
                authChoice: 'qwen-portal',
                label: 'OAuth · qwen-portal',
                kind: 'oauth',
                route: {
                  kind: 'models-auth-login',
                  providerId: 'qwen-portal',
                  methodId: 'device',
                  requiresBrowser: true,
                },
              },
            ],
          },
          {
            id: 'google-official',
            label: 'Google',
            methods: [
              {
                authChoice: 'google-gemini-cli',
                label: 'OAuth · google-gemini-cli',
                kind: 'oauth',
                route: {
                  kind: 'models-auth-login',
                  providerId: 'google-gemini-cli',
                  methodId: 'oauth',
                  requiresBrowser: true,
                },
              },
            ],
          },
        ],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') {
        return ok('OpenClaw 2026.3.8 (3caab92)')
      }
      if (args[0] === '--help') {
        return ok(
          'Usage: openclaw [options] [command]\nCommands:\n  gateway *\n  onboard\n  models *\n  plugins *\n  sessions *\n'
        )
      }
      if (args[0] === 'onboard') {
        return ok(
          'Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice> Auth: totally-different-choice\n  --accept-risk accept risk\n  --non-interactive disable prompts\n'
        )
      }
      if (args[0] === 'agent' && args[1] === '--help') {
        return ok('Usage: openclaw agent [options]\nOptions:\n  --model <key>\n  --session-id <id>\n')
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok(
          'Usage: openclaw models [options] [command]\nCommands:\n  auth\n  aliases\n  list\n  status\n'
        )
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all show all\n  --json print json\n')
      }
      if (args[0] === 'models' && args[1] === 'status') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json print json\n')
      }
      if (args[0] === 'models' && args[1] === 'auth') {
        if (args[2] === 'login') {
          return ok('Usage: openclaw models auth login [options]\nOptions:\n  --provider <id>\n  --method <id>\n')
        }
        if (args[2] === 'paste-token') {
          return ok('Usage: openclaw models auth paste-token [options]\nOptions:\n  --provider <id>\n')
        }
        if (args[2] === 'setup-token') {
          return ok('Usage: openclaw models auth setup-token [options]\nOptions:\n  --provider <id>\n')
        }
        return ok(
          'Usage: openclaw models auth [options] [command]\nCommands:\n  login\n  paste-token\n  setup-token\n'
        )
      }
      if (args[0] === 'plugins' && args[1] === '--help') {
        return ok('Usage: openclaw plugins [options] [command]\nCommands:\n  enable\n  install\n')
      }
      return { ok: false, stdout: '', stderr: 'unknown command', code: 1 }
    })

    const caps = await discoverOpenClawCapabilities({
      runCommand,
      loadAuthRegistry,
      now: () => new Date('2026-03-12T00:00:00.000Z'),
    })

    expect(loadAuthRegistry).toHaveBeenCalledTimes(1)
    expect(caps.authRegistrySource).toBe('openclaw-internal-registry')
    expect(caps.authRegistry.providers.map((provider) => provider.id)).toEqual([
      'openai-official',
      'qwen-official',
      'google-official',
    ])
    expect(caps.authChoices).toEqual([
      {
        id: 'openai-codex',
        providerId: 'openai-official',
        methodType: 'oauth',
        source: 'auth-registry',
      },
      {
        id: 'qwen-portal',
        providerId: 'qwen-official',
        methodType: 'oauth',
        source: 'auth-registry',
      },
      {
        id: 'google-gemini-cli',
        providerId: 'google-official',
        methodType: 'oauth',
        source: 'auth-registry',
      },
    ])
    expect(caps.supports.modelsAuthLogin).toBe(true)
    expect(caps.supports.modelsAuthPasteToken).toBe(true)
    expect(caps.supports.modelsAuthSetupToken).toBe(true)
    expect(caps.supports.aliases).toBe(true)
    expect(caps.supports.plugins).toBe(true)
    expect(caps.supports.pluginsEnable).toBe(true)
    expect(caps.supports.chatAgentModelFlag).toBe(true)
    expect(caps.supports.chatGatewaySendModel).toBe(true)
    expect(caps.supports.chatInThreadModelSwitch).toBe(true)
  })

  it('treats gateway-backed switching as supported even when agent --model is absent', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') {
        return ok('OpenClaw 2026.3.23-2 (7ffe7e4)')
      }
      if (args[0] === '--help') {
        return ok(
          'Usage: openclaw [options] [command]\nCommands:\n  gateway *\n  models *\n  onboard\n  sessions *\n'
        )
      }
      if (args[0] === 'onboard') {
        return ok('Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice>\n')
      }
      if (args[0] === 'agent' && args[1] === '--help') {
        return ok('Usage: openclaw agent [options]\nOptions:\n  --session-id <id>\n  --message <text>\n')
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok('Usage: openclaw models [options] [command]\nCommands:\n  list\n  status\n')
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'status') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'auth') {
        return ok('Usage: openclaw models auth [options] [command]\n')
      }
      return { ok: false, stdout: '', stderr: 'unknown command', code: 1 }
    })

    const caps = await discoverOpenClawCapabilities({ runCommand, loadAuthRegistry })

    expect(caps.supports.chatAgentModelFlag).toBe(false)
    expect(caps.supports.chatGatewaySendModel).toBe(true)
    expect(caps.supports.chatInThreadModelSwitch).toBe(true)
  })

  it('keeps registry failure visible while recovering a minimal provider list from onboard help', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        ok: false,
        source: 'unsupported-openclaw-layout',
        message: 'unsupported layout',
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') {
        return ok('OpenClaw 2026.3.8 (3caab92)')
      }
      if (args[0] === '--help') {
        return ok('Usage: openclaw [options] [command]\nCommands:\n  onboard\n  models\n')
      }
      if (args[0] === 'onboard') {
        return ok(
          'Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice> Auth: openai-codex|qwen-portal|google-gemini-cli\n  --accept-risk accept risk\n  --non-interactive disable prompts\n'
        )
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok('Usage: openclaw models [options] [command]\nCommands:\n  auth\n  list\n  status\n')
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all show all\n  --json print json\n')
      }
      if (args[0] === 'models' && args[1] === 'status') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json print json\n')
      }
      if (args[0] === 'models' && args[1] === 'auth') {
        if (args[2] === 'login') {
          return ok('Usage: openclaw models auth login [options]\nOptions:\n  --provider <id>\n')
        }
        return ok('Usage: openclaw models auth [options] [command]\nCommands:\n  login\n')
      }
      return { ok: false, stdout: '', stderr: 'unknown command', code: 1 }
    })

    const caps = await discoverOpenClawCapabilities({ runCommand, loadAuthRegistry })

    expect(caps.authRegistry.ok).toBe(false)
    expect(caps.authRegistrySource).toBe('unsupported-openclaw-layout')
    expect(caps.authRegistry.providers.map((provider) => provider.id)).toEqual(['openai', 'qwen', 'google'])
    expect(caps.authRegistry.providers.find((provider) => provider.id === 'openai')?.methods[0]?.route.kind).toBe(
      'models-auth-login'
    )
    expect(caps.authRegistry.providers.find((provider) => provider.id === 'qwen')?.methods[0]?.route.kind).toBe(
      'onboard'
    )
    expect(caps.authRegistry.providers.find((provider) => provider.id === 'google')?.methods[0]?.route.kind).toBe(
      'onboard'
    )
    expect(caps.authRegistry.providers.find((provider) => provider.id === 'qwen')?.methods[0]?.hint || '').toContain(
      '回退到官方 onboard 认证入口'
    )
    expect(caps.authChoices).toEqual([
      {
        id: 'openai-codex',
        providerId: 'openai',
        methodType: 'oauth',
        source: 'fallback',
      },
      {
        id: 'qwen-portal',
        providerId: 'qwen',
        methodType: 'oauth',
        source: 'fallback',
      },
      {
        id: 'google-gemini-cli',
        providerId: 'google',
        methodType: 'oauth',
        source: 'fallback',
      },
    ])
    expect(caps.authRegistry.message).toContain('恢复部分 Provider 列表')
  })

  it('requests a forced auth-registry refresh when capability refresh asks for it', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') return ok('OpenClaw 2026.3.8 (3caab92)')
      if (args[0] === '--help') {
        return ok('Usage: openclaw [options] [command]\nCommands:\n  onboard\n  models\n')
      }
      if (args[0] === 'onboard') {
        return ok('Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice>\n  --non-interactive\n')
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok('Usage: openclaw models [options] [command]\nCommands:\n  auth\n  list\n  status\n')
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'status') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'auth') {
        if (args[2] === 'login') {
          return ok('Usage: openclaw models auth login [options]\nOptions:\n  --provider <id>\n')
        }
        return ok('Usage: openclaw models auth [options] [command]\nCommands:\n  login\n')
      }
      return { ok: false, stdout: '', stderr: 'unknown command', code: 1 }
    })

    await discoverOpenClawCapabilities({
      runCommand,
      loadAuthRegistry,
      refreshAuthRegistry: true,
    })

    expect(loadAuthRegistry).toHaveBeenCalledWith({ forceRefresh: true })
  })

  it('keeps plugin capability discovery alive when root help omits the plugins command listing', async () => {
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') return ok('OpenClaw 2026.4.11 (4dcc39c)')
      if (args[0] === '--help') {
        return ok('Usage: openclaw [options] [command]\nCommands:\n  onboard\n  models\n')
      }
      if (args[0] === 'onboard') {
        return ok('Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice>\n  --non-interactive\n')
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok('Usage: openclaw models [options] [command]\nCommands:\n  auth\n  list\n  status\n')
      }
      if (args[0] === 'models' && args[1] === 'auth') {
        if (args[2] === 'login') {
          return ok('Usage: openclaw models auth login [options]\nOptions:\n  --provider <id>\n')
        }
        return ok('Usage: openclaw models auth [options] [command]\nCommands:\n  login\n')
      }
      if (args[0] === 'models' && args[1] === 'list') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'status') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json\n')
      }
      if (args[0] === 'plugins' && args[1] === '--help') {
        return ok('Usage: openclaw plugins [options] [command]\nCommands:\n  enable\n  install\n')
      }
      return { ok: false, stdout: '', stderr: 'unknown command', code: 1 }
    })

    const caps = await discoverOpenClawCapabilities({ runCommand, loadAuthRegistry })

    expect(caps.pluginsCommands).toEqual(['enable', 'install'])
    expect(caps.supports.plugins).toBe(true)
    expect(caps.supports.pluginsEnable).toBe(true)
    expect(caps.supports.pluginsInstall).toBe(true)
  })

  it('supports a bootstrap discovery profile that skips heavy compatibility probes', async () => {
    const invokedCommands: string[] = []
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      invokedCommands.push(args.join(' '))

      if (args[0] === '--version') {
        return ok('OpenClaw 2026.4.9 (bootstrap-profile)')
      }
      if (args[0] === '--help') {
        return ok(
          'Usage: openclaw [options] [command]\nCommands:\n  gateway *\n  onboard\n  models *\n  plugins *\n  sessions *\n'
        )
      }
      if (args[0] === 'onboard') {
        return ok(
          'Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice>\n  --openai-api-key <key>\n'
        )
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return ok(
          'Usage: openclaw models [options] [command]\nCommands:\n  auth\n  list\n  status\n  scan\n  aliases\n  fallbacks\n  image-fallbacks\n'
        )
      }
      if (args[0] === 'models' && args[1] === 'auth' && args[2] === '--help') {
        return ok(
          'Usage: openclaw models auth [options] [command]\nCommands:\n  login\n  paste-token\n  setup-token\n  login-github-copilot\n  order\n'
        )
      }
      if (args[0] === 'models' && args[1] === 'list' && args[2] === '--help') {
        return ok('Usage: openclaw models list [options]\nOptions:\n  --all\n  --json\n')
      }
      if (args[0] === 'models' && args[1] === 'status' && args[2] === '--help') {
        return ok('Usage: openclaw models status [options]\nOptions:\n  --json\n')
      }

      return { ok: false, stdout: '', stderr: `unexpected command: ${args.join(' ')}`, code: 1 }
    })

    const caps = await discoverOpenClawCapabilities({
      runCommand,
      loadAuthRegistry,
      profile: 'bootstrap',
    } as any)

    expect(invokedCommands).toEqual([
      '--version',
      '--help',
      'onboard --help',
      'models --help',
      'models auth --help',
      'models list --help',
      'models status --help',
    ])
    expect(caps.supports.pluginsEnable).toBe(true)
    expect(caps.supports.modelsAuthLogin).toBe(true)
    expect(caps.supports.modelsAuthPasteToken).toBe(true)
    expect(caps.supports.modelsAuthSetupToken).toBe(true)
    expect(caps.supports.modelsAuthLoginGitHubCopilot).toBe(true)
    expect(caps.supports.modelsAuthOrder).toBe(true)
    expect(caps.supports.chatGatewaySendModel).toBe(true)
    expect(caps.supports.chatInThreadModelSwitch).toBe(true)
    expect(caps.supports.aliases).toBe(true)
    expect(caps.supports.fallbacks).toBe(true)
    expect(caps.supports.imageFallbacks).toBe(true)
    expect(caps.supports.modelsScan).toBe(true)
    expect(caps.pluginsCommands).toEqual([])
  })

  it('runs CLI capability probes serially so help probes never fan out concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0

    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        source: 'openclaw-internal-registry',
        providers: [],
      })
    )
    const runCommand = vi.fn(async (args: string[]) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()

      try {
        if (args[0] === '--version') {
          return ok('OpenClaw 2026.4.9 (serial-probe)')
        }
        if (args[0] === '--help') {
          return ok('Usage: openclaw [options] [command]\nCommands:\n  onboard\n  models\n  plugins\n')
        }
        if (args[0] === 'onboard') {
          return ok('Usage: openclaw onboard [options]\nOptions:\n  --auth-choice <choice>\n  --non-interactive\n')
        }
        if (args[0] === 'agent' && args[1] === '--help') {
          return ok('Usage: openclaw agent [options]\nOptions:\n  --session-id <id>\n')
        }
        if (args[0] === 'models' && args[1] === '--help') {
          return ok('Usage: openclaw models [options] [command]\nCommands:\n  auth\n  list\n')
        }
        if (args[0] === 'models' && args[1] === 'auth' && args[2] === '--help') {
          return ok('Usage: openclaw models auth [options] [command]\n')
        }
        if (args[0] === 'models' && args[1] === 'list' && args[2] === '--help') {
          return ok('Usage: openclaw models list [options]\nOptions:\n  --all\n  --json\n')
        }
        if (args[0] === 'plugins' && args[1] === '--help') {
          return ok('Usage: openclaw plugins [options] [command]\nCommands:\n  enable\n')
        }
        return { ok: false, stdout: '', stderr: `unknown command: ${args.join(' ')}`, code: 1 }
      } finally {
        inFlight -= 1
      }
    })

    await discoverOpenClawCapabilities({
      runCommand,
      loadAuthRegistry,
    })

    expect(maxInFlight).toBe(1)
  })
})
