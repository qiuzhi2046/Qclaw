import { describe, expect, it } from 'vitest'
import { createOpenClawAuthRegistry, loadOpenClawAuthRegistry } from '../openclaw-auth-registry'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const os = process.getBuiltinModule('os') as typeof import('node:os')
const path = process.getBuiltinModule('path') as typeof import('node:path')

const fixturePackageRoot = path.resolve(
  process.cwd(),
  'electron/main/__tests__/fixtures/openclaw-dist'
)

function createFixtureCopy(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-auth-registry-fixture-'))
  fs.cpSync(fixturePackageRoot, tempRoot, { recursive: true })
  return tempRoot
}

function findDistFile(root: string, prefix: string): string {
  const distDir = path.join(root, 'dist')
  const matched = fs
    .readdirSync(distDir)
    .filter((entry) => entry === `${prefix}.js` || (entry.startsWith(`${prefix}-`) && entry.endsWith('.js')))
    .sort((left, right) => left.localeCompare(right))[0]

  if (!matched) {
    throw new Error(`Unable to find dist file for prefix "${prefix}" in ${distDir}`)
  }

  return path.join(distDir, matched)
}

function resolveLineBreakSeparator(text: string): string {
  return text.match(/\r?\n\r?\n/)?.[0] || '\n\n'
}

function replaceFixtureBlock(
  text: string,
  marker: string,
  replacement: string
): string {
  const separator = resolveLineBreakSeparator(text)
  return text.replace(
    marker.replaceAll('\n\n', separator),
    replacement.replaceAll('\n\n', separator)
  )
}

function replaceFixturePattern(
  text: string,
  pattern: RegExp,
  replacement: string
): string {
  const separator = resolveLineBreakSeparator(text)
  return text.replace(pattern, replacement.replaceAll('\n\n', separator))
}

function addUnsupportedAuthChoiceVariant(
  root: string,
  input: {
    providerId: string
    providerLabel: string
    providerHint: string
    authChoice: string
    optionLabel: string
    optionsFileHash?: string
    version?: string
  }
) {
  const optionsPath = findDistFile(root, 'auth-choice-options')
  const optionsText = fs.readFileSync(optionsPath, 'utf8')
  const nextOptionsText = replaceFixtureBlock(
    replaceFixtureBlock(
      optionsText,
      '];\n\nconst PROVIDER_AUTH_CHOICE_OPTION_HINTS = {',
      `,\n  {\n    value: "${input.providerId}",\n    label: "${input.providerLabel}",\n    hint: "${input.providerHint}",\n    choices: ["${input.authChoice}"]\n  }\n];\n\nconst PROVIDER_AUTH_CHOICE_OPTION_HINTS = {`
    ),
    '];\n\nfunction formatAuthChoiceChoicesForCli(params) {',
    `,\n  {\n    value: "${input.authChoice}",\n    label: "${input.optionLabel}"\n  }\n];\n\nfunction formatAuthChoiceChoicesForCli(params) {`
  )

  if (nextOptionsText === optionsText) {
    throw new Error('Failed to patch auth-choice-options fixture text')
  }

  const targetOptionsPath = input.optionsFileHash
    ? path.join(path.dirname(optionsPath), `auth-choice-options-${input.optionsFileHash}.js`)
    : optionsPath
  fs.writeFileSync(targetOptionsPath, nextOptionsText)
  if (targetOptionsPath !== optionsPath) {
    fs.rmSync(optionsPath, { force: true })
  }

  const authChoicePath = findDistFile(root, 'auth-choice')
  const authChoiceText = fs.readFileSync(authChoicePath, 'utf8')
  const nextAuthChoiceText = replaceFixtureBlock(
    authChoiceText,
    '};\n\nfunction resolvePreferredProviderForAuthChoice(choice) {',
    `,\n  "${input.authChoice}": "${input.providerId}"\n};\n\nfunction resolvePreferredProviderForAuthChoice(choice) {`
  )

  if (nextAuthChoiceText === authChoiceText) {
    throw new Error('Failed to patch auth-choice fixture text')
  }
  fs.writeFileSync(authChoicePath, nextAuthChoiceText)

  if (input.version) {
    const packageJsonPath = path.join(root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    packageJson.version = input.version
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2))
  }
}

function addProviderScopedOnboardApiKeyFlag(
  root: string,
  input: {
    providerId: string
    authChoice: string
    cliFlag: string
    description: string
  }
) {
  const flagsPath = findDistFile(root, 'onboard-provider-auth-flags')
  const flagsText = fs.readFileSync(flagsPath, 'utf8')
  const optionKey = `${input.providerId}ApiKey`
  const nextFlagsText = replaceFixturePattern(
    flagsText,
    /\];\r?\nexport \{ AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI as n, ONBOARD_PROVIDER_AUTH_FLAGS as t \};/,
    `,\n  {\n    optionKey: "${optionKey}",\n    authChoice: "${input.authChoice}",\n    cliFlag: "${input.cliFlag}",\n    cliOption: "${input.cliFlag} <key>",\n    description: "${input.description}"\n  }\n];\nexport { AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI as n, ONBOARD_PROVIDER_AUTH_FLAGS as t };`
  )
  if (nextFlagsText === flagsText) {
    throw new Error('Failed to patch onboard-provider-auth-flags fixture text')
  }
  fs.writeFileSync(flagsPath, nextFlagsText)

  const authChoicePath = findDistFile(root, 'auth-choice')
  const authChoiceText = fs.readFileSync(authChoicePath, 'utf8')
  if (authChoiceText.includes(`"${input.authChoice}":`)) return

  const nextAuthChoiceText = replaceFixtureBlock(
    authChoiceText,
    '};\n\nfunction resolvePreferredProviderForAuthChoice(choice) {',
    `,\n  "${input.authChoice}": "${input.providerId}"\n};\n\nfunction resolvePreferredProviderForAuthChoice(choice) {`
  )
  if (nextAuthChoiceText === authChoiceText) {
    throw new Error('Failed to patch auth-choice fixture text for onboard fallback')
  }
  fs.writeFileSync(authChoicePath, nextAuthChoiceText)
}

function movePreferredProviderMetadata(root: string, targetFileName: string) {
  const authChoicePath = findDistFile(root, 'auth-choice')
  const targetPath = path.join(path.dirname(authChoicePath), targetFileName)
  fs.copyFileSync(authChoicePath, targetPath)
  fs.rmSync(authChoicePath, { force: true })
}

function removePreferredProviderMetadata(root: string) {
  const authChoicePath = findDistFile(root, 'auth-choice')
  fs.rmSync(authChoicePath, { force: true })
}

function createModernManifestPackageRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-auth-registry-modern-'))
  const distDir = path.join(tempRoot, 'dist')
  const extensionsDir = path.join(distDir, 'extensions')
  fs.mkdirSync(extensionsDir, { recursive: true })

  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'openclaw',
        version: '2026.3.22-test',
      },
      null,
      2
    )
  )

  fs.writeFileSync(
    path.join(distDir, 'auth-choice-options-modern.js'),
    [
      'const CORE_AUTH_CHOICE_OPTIONS = [',
      '  {',
      '    value: "custom-api-key",',
      '    label: "Custom Provider",',
      '    hint: "Any OpenAI or Anthropic compatible endpoint",',
      '    groupId: "custom",',
      '    groupLabel: "Custom Provider",',
      '    groupHint: "Any OpenAI or Anthropic compatible endpoint"',
      '  }',
      '];',
      'function formatAuthChoiceChoicesForCli() { return ""; }',
      'function buildAuthChoiceGroups() { return []; }',
      '',
    ].join('\n')
  )

  fs.writeFileSync(
    path.join(distDir, 'provider-auth-choice-preference-modern.js'),
    [
      'const PREFERRED_PROVIDER_BY_AUTH_CHOICE = {',
      '  "custom-api-key": "custom"',
      '};',
      'function resolvePreferredProviderForAuthChoice(choice) {',
      '  return PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice]',
      '}',
      '',
    ].join('\n')
  )

  const pluginManifests = [
    {
      id: 'google',
      providerAuthChoices: [
        {
          provider: 'google',
          method: 'api-key',
          choiceId: 'gemini-api-key',
          choiceLabel: 'Google Gemini API key',
          groupId: 'google',
          groupLabel: 'Google',
          groupHint: 'Gemini API key + OAuth',
          optionKey: 'geminiApiKey',
          cliFlag: '--gemini-api-key',
          cliOption: '--gemini-api-key <key>',
          cliDescription: 'Gemini API key',
        },
        {
          provider: 'google-gemini-cli',
          method: 'oauth',
          choiceId: 'google-gemini-cli',
          choiceLabel: 'Gemini CLI OAuth',
          choiceHint: 'Google OAuth with project-aware token payload',
          groupId: 'google',
          groupLabel: 'Google',
          groupHint: 'Gemini API key + OAuth',
        },
      ],
    },
    {
      id: 'qwen-portal-auth',
      providerAuthChoices: [
        {
          provider: 'qwen-portal',
          method: 'device',
          choiceId: 'qwen-portal',
          choiceLabel: 'Qwen OAuth',
          choiceHint: 'Device code login',
          groupId: 'qwen',
          groupLabel: 'Qwen',
          groupHint: 'OAuth',
        },
      ],
    },
    {
      id: 'minimax',
      providerAuthChoices: [
        {
          provider: 'minimax-portal',
          method: 'oauth',
          choiceId: 'minimax-global-oauth',
          choiceLabel: 'MiniMax OAuth (Global)',
          choiceHint: 'Global endpoint - api.minimax.io',
          groupId: 'minimax',
          groupLabel: 'MiniMax',
          groupHint: 'M2.7 (recommended)',
        },
        {
          provider: 'minimax',
          method: 'api-global',
          choiceId: 'minimax-global-api',
          choiceLabel: 'MiniMax API key (Global)',
          choiceHint: 'Global endpoint - api.minimax.io',
          groupId: 'minimax',
          groupLabel: 'MiniMax',
          groupHint: 'M2.7 (recommended)',
          optionKey: 'minimaxApiKey',
          cliFlag: '--minimax-api-key',
          cliOption: '--minimax-api-key <key>',
          cliDescription: 'MiniMax API key',
        },
        {
          provider: 'minimax-portal',
          method: 'oauth-cn',
          choiceId: 'minimax-cn-oauth',
          choiceLabel: 'MiniMax OAuth (CN)',
          choiceHint: 'CN endpoint - api.minimaxi.com',
          groupId: 'minimax',
          groupLabel: 'MiniMax',
          groupHint: 'M2.7 (recommended)',
        },
        {
          provider: 'minimax',
          method: 'api-cn',
          choiceId: 'minimax-cn-api',
          choiceLabel: 'MiniMax API key (CN)',
          choiceHint: 'CN endpoint - api.minimaxi.com',
          groupId: 'minimax',
          groupLabel: 'MiniMax',
          groupHint: 'M2.7 (recommended)',
          optionKey: 'minimaxApiKey',
          cliFlag: '--minimax-api-key',
          cliOption: '--minimax-api-key <key>',
          cliDescription: 'MiniMax API key',
        },
      ],
    },
    {
      id: 'openai',
      providerAuthChoices: [
        {
          provider: 'openai-codex',
          method: 'oauth',
          choiceId: 'openai-codex',
          choiceLabel: 'OpenAI Codex (ChatGPT OAuth)',
          choiceHint: 'Browser sign-in',
          groupId: 'openai',
          groupLabel: 'OpenAI',
          groupHint: 'Codex OAuth + API key',
        },
        {
          provider: 'openai',
          method: 'api-key',
          choiceId: 'openai-api-key',
          choiceLabel: 'OpenAI API key',
          groupId: 'openai',
          groupLabel: 'OpenAI',
          groupHint: 'Codex OAuth + API key',
          optionKey: 'openaiApiKey',
          cliFlag: '--openai-api-key',
          cliOption: '--openai-api-key <key>',
          cliDescription: 'OpenAI API key',
        },
      ],
    },
  ]

  for (const manifest of pluginManifests) {
    const pluginDir = path.join(extensionsDir, manifest.id)
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify(manifest, null, 2))
  }

  return tempRoot
}

describe('createOpenClawAuthRegistry', () => {
  it('preserves provider, method, and route descriptors without local inference', () => {
    const registry = createOpenClawAuthRegistry({
      source: 'openclaw-internal-registry',
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          hint: 'Codex OAuth + API key',
          methods: [
            {
              authChoice: 'openai-codex',
              label: 'OpenAI Codex (ChatGPT OAuth)',
              hint: 'Official Codex OAuth login',
              kind: 'oauth',
              route: {
                kind: 'models-auth-login',
                providerId: 'openai-codex',
                requiresBrowser: true,
              },
            },
          ],
        },
      ],
    })

    expect(registry.ok).toBe(true)
    expect(registry.source).toBe('openclaw-internal-registry')
    expect(registry.providers).toHaveLength(1)
    expect(registry.providers[0]).toMatchObject({
      id: 'openai',
      label: 'OpenAI',
      methods: [
        expect.objectContaining({
          authChoice: 'openai-codex',
          kind: 'oauth',
          route: expect.objectContaining({
            kind: 'models-auth-login',
            providerId: 'openai-codex',
          }),
        }),
      ],
    })
  })

  it('discovers official auth metadata from hashed internal openclaw files and provider extensions', async () => {
    const registry = await loadOpenClawAuthRegistry({
      packageRoot: fixturePackageRoot,
    })

    expect(registry.ok).toBe(true)
    expect(registry.source).toBe('openclaw-internal-registry')

    expect(registry.providers).toEqual([
      {
        id: 'openai',
        label: 'OpenAI',
        hint: 'Codex OAuth + API key',
        methods: [
          {
            authChoice: 'openai-codex',
            label: 'OpenAI Codex (ChatGPT OAuth)',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'openai-codex',
              requiresBrowser: true,
            },
          },
          {
            authChoice: 'openai-api-key',
            label: 'OpenAI API key',
            kind: 'apiKey',
            route: {
              kind: 'onboard',
              providerId: 'openai',
              cliFlag: '--openai-api-key',
              requiresSecret: true,
            },
          },
        ],
      },
      {
        id: 'google',
        label: 'Google',
        hint: 'Gemini API key + OAuth',
        methods: [
          {
            authChoice: 'gemini-api-key',
            label: 'Gemini API key',
            hint: 'Gemini API key from Google AI Studio',
            kind: 'apiKey',
            route: {
              kind: 'onboard',
              providerId: 'google',
              cliFlag: '--gemini-api-key',
              requiresSecret: true,
            },
          },
          {
            authChoice: 'google-gemini-cli',
            label: 'Google Gemini CLI OAuth',
            hint:
              'Unofficial flow; review account-risk warning before use; Requires local Gemini CLI or GEMINI_CLI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_SECRET.',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'google-gemini-cli',
              methodId: 'oauth',
              pluginId: 'google-gemini-cli-auth',
              requiresBrowser: true,
            },
          },
        ],
      },
      {
        id: 'qwen',
        label: 'Qwen',
        hint: 'OAuth',
        methods: [
          {
            authChoice: 'qwen-portal',
            label: 'Qwen OAuth',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'qwen-portal',
              methodId: 'device',
              pluginId: 'qwen-portal-auth',
              requiresBrowser: true,
            },
          },
        ],
      },
      {
        id: 'minimax',
        label: 'MiniMax',
        hint: 'M2.5 (recommended)',
        methods: [
          {
            authChoice: 'minimax-portal',
            label: 'MiniMax OAuth',
            hint: 'Oauth plugin for MiniMax',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'minimax-portal',
              pluginId: 'minimax-portal-auth',
              requiresBrowser: true,
              extraOptions: [
                {
                  id: 'oauth',
                  label: 'MiniMax OAuth (Global)',
                  hint: 'Global endpoint - api.minimax.io',
                },
                {
                  id: 'oauth-cn',
                  label: 'MiniMax OAuth (CN)',
                  hint: 'CN endpoint - api.minimaxi.com',
                },
              ],
            },
          },
          {
            authChoice: 'minimax-api',
            label: 'MiniMax M2.5',
            kind: 'apiKey',
            route: {
              kind: 'onboard',
              providerId: 'minimax',
              cliFlag: '--minimax-api-key',
              requiresSecret: true,
            },
          },
        ],
      },
    ])
  })

  it('discovers manifest-backed auth metadata from dist/extensions when legacy auth tokens are absent', async () => {
    const root = createModernManifestPackageRoot()

    try {
      const registry = await loadOpenClawAuthRegistry({
        packageRoot: root,
        forceRefresh: true,
      })

      expect(registry.ok).toBe(true)
      expect(registry.source).toBe('openclaw-internal-registry')

      const googleProvider = registry.providers.find((provider) => provider.id === 'google')
      expect(googleProvider?.methods).toEqual([
        {
          authChoice: 'google-gemini-cli',
          label: 'Gemini CLI OAuth',
          hint: 'Google OAuth with project-aware token payload; Requires local Gemini CLI or GEMINI_CLI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_SECRET.',
          kind: 'oauth',
          route: {
            kind: 'models-auth-login',
            providerId: 'google-gemini-cli',
            methodId: 'oauth',
            pluginId: 'google',
            requiresBrowser: true,
          },
        },
        {
          authChoice: 'gemini-api-key',
          label: 'Google Gemini API key',
          kind: 'apiKey',
          route: {
            kind: 'onboard',
            providerId: 'google',
            pluginId: 'google',
            cliFlag: '--gemini-api-key',
            requiresSecret: true,
          },
        },
      ])

      expect(
        registry.providers.find((provider) => provider.id === 'qwen')?.methods.find((method) => method.authChoice === 'qwen-portal')
      ).toMatchObject({
        kind: 'oauth',
        route: {
          kind: 'models-auth-login',
          providerId: 'qwen-portal',
          methodId: 'device',
          pluginId: 'qwen-portal-auth',
          requiresBrowser: true,
        },
      })

      expect(
        registry.providers
          .find((provider) => provider.id === 'minimax')
          ?.methods.filter((method) => method.authChoice.includes('oauth'))
      ).toEqual([
        {
          authChoice: 'minimax-cn-oauth',
          label: 'MiniMax OAuth (CN)',
          hint: 'CN endpoint - api.minimaxi.com',
          kind: 'oauth',
          route: {
            kind: 'models-auth-login',
            providerId: 'minimax-portal',
            methodId: 'oauth-cn',
            pluginId: 'minimax',
            requiresBrowser: true,
          },
        },
        {
          authChoice: 'minimax-global-oauth',
          label: 'MiniMax OAuth (Global)',
          hint: 'Global endpoint - api.minimax.io',
          kind: 'oauth',
          route: {
            kind: 'models-auth-login',
            providerId: 'minimax-portal',
            methodId: 'oauth',
            pluginId: 'minimax',
            requiresBrowser: true,
          },
        },
      ])

      expect(
        registry.providers
          .find((provider) => provider.id === 'minimax')
          ?.methods.filter((method) => method.authChoice.includes('-api'))
      ).toEqual([
        {
          authChoice: 'minimax-cn-api',
          label: 'MiniMax API key (CN)',
          hint: 'CN endpoint - api.minimaxi.com',
          kind: 'apiKey',
          route: {
            kind: 'onboard',
            providerId: 'minimax',
            pluginId: 'minimax',
            cliFlag: '--minimax-api-key',
            requiresSecret: true,
          },
        },
        {
          authChoice: 'minimax-global-api',
          label: 'MiniMax API key (Global)',
          hint: 'Global endpoint - api.minimax.io',
          kind: 'apiKey',
          route: {
            kind: 'onboard',
            providerId: 'minimax',
            pluginId: 'minimax',
            cliFlag: '--minimax-api-key',
            requiresSecret: true,
          },
        },
      ])

      expect(
        registry.providers.find((provider) => provider.id === 'openai')?.methods.find((method) => method.authChoice === 'openai-codex')
      ).toMatchObject({
        kind: 'oauth',
        route: {
          kind: 'models-auth-login',
          providerId: 'openai-codex',
          methodId: 'oauth',
          pluginId: 'openai',
          requiresBrowser: true,
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps custom-api-key into a dedicated supported custom onboard route', async () => {
    const root = createFixtureCopy()
    addUnsupportedAuthChoiceVariant(root, {
      providerId: 'custom',
      providerLabel: 'Custom Provider',
      providerHint: 'Any OpenAI or Anthropic compatible endpoint',
      authChoice: 'custom-api-key',
      optionLabel: 'Custom Provider',
      version: '2026.3.8-custom',
    })

    const registry = await loadOpenClawAuthRegistry({
      packageRoot: root,
      forceRefresh: true,
    })

    const provider = registry.providers.find((entry) => entry.id === 'custom')
    expect(provider).toBeTruthy()
    expect(provider?.methods).toContainEqual(
      expect.objectContaining({
        authChoice: 'custom-api-key',
        kind: 'custom',
        route: expect.objectContaining({
          kind: 'onboard-custom',
          providerId: 'custom',
        }),
      })
    )
  })

  it('discovers preferred-provider metadata from dot-prefixed filenames with underscore hashes', async () => {
    const tempRoot = createFixtureCopy()

    try {
      movePreferredProviderMetadata(tempRoot, 'auth-choice.preferred-provider-fixture_hash.js')

      const registry = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
        forceRefresh: true,
      })

      expect(registry.ok).toBe(true)
      expect(registry.source).toBe('openclaw-internal-registry')
      expect(
        registry.providers
          .find((provider) => provider.id === 'google')
          ?.methods.find((method) => method.authChoice === 'google-gemini-cli')
          ?.route
      ).toMatchObject({
        kind: 'models-auth-login',
        providerId: 'google-gemini-cli',
        pluginId: 'google-gemini-cli-auth',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps the registry usable when preferred-provider metadata is unavailable', async () => {
    const tempRoot = createFixtureCopy()

    try {
      removePreferredProviderMetadata(tempRoot)

      const registry = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
        forceRefresh: true,
      })

      expect(registry.ok).toBe(true)
      expect(registry.source).toBe('openclaw-internal-registry')
      expect(
        registry.providers
          .find((provider) => provider.id === 'openai')
          ?.methods.find((method) => method.authChoice === 'openai-codex')
          ?.route
      ).toMatchObject({
        kind: 'models-auth-login',
        providerId: 'openai-codex',
      })
      expect(
        registry.providers
          .find((provider) => provider.id === 'minimax')
          ?.methods.find((method) => method.authChoice === 'minimax-portal')
          ?.route
      ).toMatchObject({
        kind: 'models-auth-login',
        providerId: 'minimax-portal',
        pluginId: 'minimax-portal-auth',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('degrades only the missing method to unsupported when one plugin metadata source disappears', async () => {
    const tempRoot = createFixtureCopy()

    try {
      fs.rmSync(path.join(tempRoot, 'extensions', 'google-gemini-cli-auth', 'index.ts'), { force: true })

      const registry = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
        forceRefresh: true,
      })

      expect(registry.ok).toBe(true)
      const googleProvider = registry.providers.find((provider) => provider.id === 'google')
      expect(googleProvider?.methods.find((method) => method.authChoice === 'gemini-api-key')?.route).toMatchObject({
        kind: 'onboard',
        cliFlag: '--gemini-api-key',
      })
      expect(
        googleProvider?.methods.find((method) => method.authChoice === 'google-gemini-cli')
      ).toMatchObject({
        kind: 'unknown',
        route: {
          kind: 'unsupported',
        },
      })
      expect(
        registry.providers
          .find((provider) => provider.id === 'qwen')
          ?.methods.find((method) => method.authChoice === 'qwen-portal')
          ?.route
      ).toMatchObject({
        kind: 'models-auth-login',
        providerId: 'qwen-portal',
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('ignores non-provider plugins even when their source shape confuses the lightweight parser', async () => {
    const registry = await loadOpenClawAuthRegistry({
      packageRoot: fixturePackageRoot,
      forceRefresh: true,
    })

    expect(registry.ok).toBe(true)
    expect(registry.providers.find((provider) => provider.id === 'minimax')).toBeTruthy()
    expect(registry.providers.find((provider) => provider.id === 'qwen')).toBeTruthy()
  })

  it('fails closed when required official metadata files are unavailable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-auth-registry-missing-'))
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '2026.3.8' }, null, 2)
    )

    try {
      const registry = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })

      expect(registry.ok).toBe(false)
      expect(registry.source).toBe('unsupported-openclaw-layout')
      expect(registry.message).toMatch(/metadata/i)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('reuses the cached registry when version and metadata filenames stay the same', async () => {
    const tempRoot = createFixtureCopy()

    try {
      const first = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })
      const second = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })

      expect(second).toBe(first)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('invalidates the cached registry when the OpenClaw version changes', async () => {
    const tempRoot = createFixtureCopy()

    try {
      const first = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })
      const cached = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })
      expect(cached).toBe(first)

      addUnsupportedAuthChoiceVariant(tempRoot, {
        providerId: 'anthropic',
        providerLabel: 'Anthropic',
        providerHint: 'Beta',
        authChoice: 'claude-max',
        optionLabel: 'Claude Max Beta',
        version: '2026.3.9',
      })

      const refreshed = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })

      expect(refreshed).not.toBe(cached)
      expect(refreshed.providers.find((provider) => provider.id === 'anthropic')?.methods.map((method) => method.authChoice)).toEqual([
        'claude-max',
      ])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('invalidates the cached registry when discovered dist filenames change and surfaces new auth choices', async () => {
    const tempRoot = createFixtureCopy()

    try {
      const first = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })
      const cached = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })
      expect(cached).toBe(first)

      addUnsupportedAuthChoiceVariant(tempRoot, {
        providerId: 'anthropic',
        providerLabel: 'Anthropic',
        providerHint: 'Preview',
        authChoice: 'claude-sonnet',
        optionLabel: 'Claude Sonnet Preview',
        optionsFileHash: 'fixtureHash42',
      })

      const refreshed = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
      })

      expect(refreshed).not.toBe(cached)
      expect(refreshed.providers.find((provider) => provider.id === 'anthropic')?.methods.map((method) => method.authChoice)).toEqual([
        'claude-sonnet',
      ])
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('reuses provider api-key onboard flags for provider-scoped auth choices', async () => {
    const tempRoot = createFixtureCopy()

    try {
      addUnsupportedAuthChoiceVariant(tempRoot, {
        providerId: 'zai',
        providerLabel: 'Z.AI',
        providerHint: 'GLM Coding Plan / Global / CN',
        authChoice: 'zai-coding-global',
        optionLabel: 'Coding-Plan-Global',
      })
      addProviderScopedOnboardApiKeyFlag(tempRoot, {
        providerId: 'zai',
        authChoice: 'zai-api-key',
        cliFlag: '--zai-api-key',
        description: 'Z.AI API key',
      })

      const registry = await loadOpenClawAuthRegistry({
        packageRoot: tempRoot,
        forceRefresh: true,
      })

      const zaiProvider = registry.providers.find((provider) => provider.id === 'zai')
      const zaiMethod = zaiProvider?.methods.find((method) => method.authChoice === 'zai-coding-global')
      expect(zaiMethod).toBeTruthy()
      expect(zaiMethod?.kind).toBe('apiKey')
      expect(zaiMethod?.route).toMatchObject({
        kind: 'onboard',
        cliFlag: '--zai-api-key',
        requiresSecret: true,
      })
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
