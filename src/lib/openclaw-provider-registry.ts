import { canonicalizeModelProviderId } from './model-provider-aliases'

export type ProviderRegion = 'global' | 'china'

export interface ProviderMethodMetadata {
  authChoice: string
  envKey?: string
  secretPlaceholder?: string
}

export interface ProviderMetadata {
  id: string
  name: string
  logo: string
  region: ProviderRegion
  signupUrl?: string
  description?: string
  primaryEnvKey?: string
  methods?: ProviderMethodMetadata[]
}

export interface ProviderCatalogEntry {
  id: string
  name: string
  logo: string
}

const KNOWN_PROVIDER_METADATA: ProviderMetadata[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    logo: '🤖',
    region: 'global',
    signupUrl: 'https://platform.openai.com/signup',
    description: 'GPT-5, GPT-4o, o3',
    primaryEnvKey: 'OPENAI_API_KEY',
    methods: [{ authChoice: 'openai-api-key', envKey: 'OPENAI_API_KEY', secretPlaceholder: 'sk-...' }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: '🔮',
    region: 'global',
    signupUrl: 'https://console.anthropic.com/',
    description: 'Claude Opus 4.6, Sonnet 4.6',
    primaryEnvKey: 'ANTHROPIC_API_KEY',
    methods: [{ authChoice: 'anthropic-api-key', envKey: 'ANTHROPIC_API_KEY', secretPlaceholder: 'sk-ant-...' }],
  },
  {
    id: 'gemini',
    name: '谷歌 Gemini',
    logo: '✨',
    region: 'global',
    signupUrl: 'https://aistudio.google.com/apikey',
    description: 'Gemini 3 Flash, Gemini 2.5 Pro',
    primaryEnvKey: 'GEMINI_API_KEY',
    methods: [{ authChoice: 'gemini-api-key', envKey: 'GEMINI_API_KEY', secretPlaceholder: 'AIza...' }],
  },
  {
    id: 'zai',
    name: '智谱',
    logo: '🧠',
    region: 'china',
    signupUrl: 'https://open.bigmodel.cn/',
    description: 'GLM-5, GLM-4.7',
    primaryEnvKey: 'ZAI_API_KEY',
    methods: [{ authChoice: 'zai-api-key', envKey: 'ZAI_API_KEY' }],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: '⚡',
    region: 'china',
    signupUrl: 'https://api.minimax.chat/',
    description: 'MiniMax M2.5',
    primaryEnvKey: 'MINIMAX_API_KEY',
    methods: [{ authChoice: 'minimax-api-key-cn', envKey: 'MINIMAX_API_KEY' }],
  },
  {
    id: 'moonshot',
    name: '月之暗面',
    logo: '🌙',
    region: 'china',
    signupUrl: 'https://platform.moonshot.cn/',
    description: 'Kimi K2.5',
    primaryEnvKey: 'MOONSHOT_API_KEY',
    methods: [{ authChoice: 'moonshot-api-key', envKey: 'MOONSHOT_API_KEY' }],
  },
  {
    id: 'qwen',
    name: '千问',
    logo: '🌸',
    region: 'china',
    description: 'Qwen 3, Qwen-Max',
  },
  {
    id: 'volcengine',
    name: '火山引擎',
    logo: '🌋',
    region: 'china',
    signupUrl: 'https://www.volcengine.com/',
    description: '豆包 Seed, DeepSeek',
    primaryEnvKey: 'VOLCENGINE_API_KEY',
    methods: [{ authChoice: 'volcengine-api-key', envKey: 'VOLCENGINE_API_KEY' }],
  },
  {
    id: 'qianfan',
    name: '千帆',
    logo: '🔵',
    region: 'china',
    signupUrl: 'https://cloud.baidu.com/product/wenxinworkshop',
    description: '文心一言',
    primaryEnvKey: 'QIANFAN_API_KEY',
    methods: [{ authChoice: 'qianfan-api-key', envKey: 'QIANFAN_API_KEY' }],
  },
  {
    id: 'xiaomi',
    name: '小米',
    logo: '📱',
    region: 'china',
    description: '小米大模型',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    logo: '🐙',
    region: 'global',
    description: 'GitHub Copilot 订阅用户',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: '🌐',
    region: 'global',
    signupUrl: 'https://openrouter.ai/',
    description: '统一接口访问多个模型',
    primaryEnvKey: 'OPENROUTER_API_KEY',
    methods: [{ authChoice: 'openrouter-api-key', envKey: 'OPENROUTER_API_KEY', secretPlaceholder: 'sk-or-...' }],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    logo: '🌪️',
    region: 'global',
    signupUrl: 'https://console.mistral.ai/',
    description: 'Mistral Large',
    primaryEnvKey: 'MISTRAL_API_KEY',
    methods: [{ authChoice: 'mistral-api-key', envKey: 'MISTRAL_API_KEY' }],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    logo: '🚀',
    region: 'global',
    signupUrl: 'https://x.ai/',
    description: 'Grok 3',
    primaryEnvKey: 'XAI_API_KEY',
    methods: [{ authChoice: 'xai-api-key', envKey: 'XAI_API_KEY', secretPlaceholder: 'xai-...' }],
  },
  {
    id: 'together',
    name: 'Together AI',
    logo: '🤝',
    region: 'global',
    signupUrl: 'https://api.together.xyz/',
    description: 'DeepSeek, Llama 4, Kimi',
    primaryEnvKey: 'TOGETHER_API_KEY',
    methods: [{ authChoice: 'together-api-key', envKey: 'TOGETHER_API_KEY' }],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    logo: '🤗',
    region: 'global',
    signupUrl: 'https://huggingface.co/settings/tokens',
    description: '开源模型推理',
    primaryEnvKey: 'HF_TOKEN',
    methods: [{ authChoice: 'huggingface-api-key', envKey: 'HF_TOKEN', secretPlaceholder: 'hf_...' }],
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    logo: '🔷',
    region: 'global',
    signupUrl: 'https://www.byteplus.com/',
    description: '字节跳动国际版',
    primaryEnvKey: 'BYTEPLUS_API_KEY',
    methods: [{ authChoice: 'byteplus-api-key', envKey: 'BYTEPLUS_API_KEY' }],
  },
  {
    id: 'venice',
    name: 'Venice AI',
    logo: '🎭',
    region: 'global',
    signupUrl: 'https://venice.ai/',
    description: '隐私优先的 AI',
    primaryEnvKey: 'VENICE_API_KEY',
    methods: [{ authChoice: 'venice-api-key', envKey: 'VENICE_API_KEY' }],
  },
  {
    id: 'chutes',
    name: 'Chutes',
    logo: '🪂',
    region: 'global',
    description: 'Chutes AI 平台',
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    logo: '🦙',
    region: 'global',
    description: '本地 LLM 环境',
  },
  {
    id: 'vllm',
    name: 'vLLM (本地)',
    logo: '⚡',
    region: 'global',
    description: 'OpenAI 兼容推理服务器',
  },
  {
    id: 'custom-openai',
    name: '自定义 OpenAI 兼容',
    logo: '🔧',
    region: 'global',
    description: 'LM Studio / LocalAI / 其他兼容端点',
  },
]

const PROVIDER_METADATA_BY_ID = new Map(
  KNOWN_PROVIDER_METADATA.map((provider) => [provider.id, provider] as const)
)

const RUNTIME_PROVIDER_METADATA_ALIASES: Record<string, string> = {
  google: 'gemini',
}

interface AuthChoiceEnvOverride {
  providerId: string
  envKey: string
}

const AUTH_CHOICE_ENV_OVERRIDES: Record<string, AuthChoiceEnvOverride> = {
  'moonshot-api-key-cn': { providerId: 'moonshot', envKey: 'MOONSHOT_API_KEY' },
  'kimi-code-api-key': { providerId: 'moonshot', envKey: 'MOONSHOT_API_KEY' },
  'zai-coding-global': { providerId: 'zai', envKey: 'ZAI_API_KEY' },
  'zai-coding-cn': { providerId: 'zai', envKey: 'ZAI_API_KEY' },
  'zai-global': { providerId: 'zai', envKey: 'ZAI_API_KEY' },
  'zai-cn': { providerId: 'zai', envKey: 'ZAI_API_KEY' },
  'minimax-api': { providerId: 'minimax', envKey: 'MINIMAX_API_KEY' },
  'minimax-api-key-cn': { providerId: 'minimax', envKey: 'MINIMAX_API_KEY' },
  'minimax-api-lightning': { providerId: 'minimax', envKey: 'MINIMAX_API_KEY' },
  'xiaomi-api-key': { providerId: 'xiaomi', envKey: 'XIAOMI_API_KEY' },
  'huggingface-api-key': { providerId: 'huggingface', envKey: 'HF_TOKEN' },
}

const AUTH_CHOICE_CLI_FLAG_OVERRIDES: Record<string, string> = {
  'moonshot-api-key-cn': '--moonshot-api-key',
  'kimi-code-api-key': '--kimi-code-api-key',
  'zai-coding-global': '--zai-api-key',
  'zai-coding-cn': '--zai-api-key',
  'zai-global': '--zai-api-key',
  'zai-cn': '--zai-api-key',
  'minimax-api': '--minimax-api-key',
  'minimax-api-lightning': '--minimax-api-key',
}

const ADDITIONAL_PROVIDER_ENV_KEYS: Record<string, string[]> = {
  ollama: ['OLLAMA_HOST', 'OLLAMA_API_KEY'],
  vllm: ['VLLM_BASE_URL', 'VLLM_API_KEY'],
  'custom-openai': ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
}

function listProviderAuthChoiceEnvMappings(providerId: string): Array<{ authChoice: string; envKey: string }> {
  const normalizedProviderId = resolveProviderMetadataLookupId(providerId)
  const provider = PROVIDER_METADATA_BY_ID.get(normalizedProviderId)
  const methodMappings = (provider?.methods || [])
    .filter((method) => method.envKey)
    .map((method) => ({
      authChoice: normalizeProviderId(method.authChoice),
      envKey: String(method.envKey || '').trim(),
    }))

  const overrideMappings = Object.entries(AUTH_CHOICE_ENV_OVERRIDES)
    .filter(([, override]) => normalizeProviderId(override.providerId) === normalizedProviderId)
    .map(([authChoice, override]) => ({
      authChoice: normalizeProviderId(authChoice),
      envKey: override.envKey,
    }))

  return [...methodMappings, ...overrideMappings].filter((entry) => entry.authChoice && entry.envKey)
}

function cloneMethods(methods?: ProviderMethodMetadata[]): ProviderMethodMetadata[] | undefined {
  if (!methods) return undefined
  return methods.map((method) => ({ ...method }))
}

function cloneProviderMetadata(provider: ProviderMetadata): ProviderMetadata {
  return {
    ...provider,
    ...(provider.methods ? { methods: cloneMethods(provider.methods) } : {}),
  }
}

function normalizeProviderId(providerId: string): string {
  return String(providerId || '').trim().toLowerCase()
}

function resolveProviderMetadataLookupId(providerId: string): string {
  const normalizedProviderId = normalizeProviderId(providerId)
  if (!normalizedProviderId) return ''
  if (PROVIDER_METADATA_BY_ID.has(normalizedProviderId)) return normalizedProviderId

  const canonicalProviderId = canonicalizeModelProviderId(normalizedProviderId)
  if (PROVIDER_METADATA_BY_ID.has(canonicalProviderId)) return canonicalProviderId

  return (
    RUNTIME_PROVIDER_METADATA_ALIASES[normalizedProviderId] ||
    RUNTIME_PROVIDER_METADATA_ALIASES[canonicalProviderId] ||
    normalizedProviderId
  )
}

function toDisplayName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function listKnownProviderMetadata(): ProviderMetadata[] {
  return KNOWN_PROVIDER_METADATA.map(cloneProviderMetadata)
}

export function getProviderMetadata(providerId: string): ProviderMetadata | null {
  const normalized = resolveProviderMetadataLookupId(providerId)
  const provider = PROVIDER_METADATA_BY_ID.get(normalized)
  return provider ? cloneProviderMetadata(provider) : null
}

export function getKnownProviderCatalog(): ProviderCatalogEntry[] {
  return KNOWN_PROVIDER_METADATA.map((provider) => ({
    id: provider.id,
    name: provider.name,
    logo: provider.logo,
  }))
}

export function buildKnownProviderNameMap(): Record<string, string> {
  return Object.fromEntries(KNOWN_PROVIDER_METADATA.map((provider) => [provider.id, provider.name]))
}

export function buildKnownProviderEnvKeyMap(): Record<string, string> {
  return Object.fromEntries(
    KNOWN_PROVIDER_METADATA
      .filter((provider) => provider.primaryEnvKey)
      .map((provider) => [provider.id, provider.primaryEnvKey as string])
  )
}

export function listKnownProviderEnvKeys(providerId: string): string[] {
  const normalizedProviderId = resolveProviderMetadataLookupId(providerId) || normalizeProviderId(providerId)
  if (!normalizedProviderId) return []

  const envKeys = new Set<string>()
  const provider = PROVIDER_METADATA_BY_ID.get(normalizedProviderId)
  if (provider?.primaryEnvKey) {
    envKeys.add(provider.primaryEnvKey)
  }

  for (const method of provider?.methods || []) {
    const envKey = String(method.envKey || '').trim()
    if (envKey) {
      envKeys.add(envKey)
    }
  }

  for (const override of Object.values(AUTH_CHOICE_ENV_OVERRIDES)) {
    if (normalizeProviderId(override.providerId) !== normalizedProviderId) continue
    const envKey = String(override.envKey || '').trim()
    if (envKey) {
      envKeys.add(envKey)
    }
  }

  for (const envKey of ADDITIONAL_PROVIDER_ENV_KEYS[normalizedProviderId] || []) {
    const normalizedEnvKey = String(envKey || '').trim()
    if (normalizedEnvKey) {
      envKeys.add(normalizedEnvKey)
    }
  }

  return Array.from(envKeys)
}

export function listKnownProvidersForEnvKey(envKey: string): string[] {
  const normalizedEnvKey = String(envKey || '').trim().toUpperCase()
  if (!normalizedEnvKey) return []

  const providerIds = new Set<string>([
    ...KNOWN_PROVIDER_METADATA.map((provider) => provider.id),
    ...Object.keys(ADDITIONAL_PROVIDER_ENV_KEYS),
  ])

  return Array.from(providerIds).filter((providerId) =>
    listKnownProviderEnvKeys(providerId).some((candidate) => candidate.toUpperCase() === normalizedEnvKey)
  )
}

export function resolveProviderDisplayName(providerId: string, fallbackLabel?: string): string {
  const provider = PROVIDER_METADATA_BY_ID.get(resolveProviderMetadataLookupId(providerId))
  if (provider?.name) return provider.name
  if (String(fallbackLabel || '').trim()) return String(fallbackLabel).trim()
  return toDisplayName(normalizeProviderId(providerId))
}

export function resolveProviderLogo(providerId: string): string {
  return PROVIDER_METADATA_BY_ID.get(resolveProviderMetadataLookupId(providerId))?.logo || '🧩'
}

export function resolveProviderEnvKey(providerId: string): string | undefined {
  return PROVIDER_METADATA_BY_ID.get(resolveProviderMetadataLookupId(providerId))?.primaryEnvKey
}

export function resolveProviderMethodEnvKey(providerId: string, authChoice?: string): string | undefined {
  const provider = PROVIDER_METADATA_BY_ID.get(resolveProviderMetadataLookupId(providerId))
  const normalizedAuthChoice = normalizeProviderId(authChoice || '')
  if (normalizedAuthChoice) {
    const methodEnvKey = provider?.methods?.find(
      (method) => normalizeProviderId(method.authChoice) === normalizedAuthChoice
    )?.envKey
    if (methodEnvKey) return methodEnvKey

    const overriddenEnvKey = AUTH_CHOICE_ENV_OVERRIDES[normalizedAuthChoice]?.envKey
    if (overriddenEnvKey) return overriddenEnvKey
  }

  return provider?.primaryEnvKey
}

export function resolveProviderMethodOnboardCliFlag(providerId: string, authChoice?: string): string | undefined {
  const normalizedProviderId = resolveProviderMetadataLookupId(providerId)
  const normalizedAuthChoice = normalizeProviderId(authChoice || '')
  if (!normalizedProviderId || !normalizedAuthChoice) return undefined

  const provider = PROVIDER_METADATA_BY_ID.get(normalizedProviderId)
  const methodExists = provider?.methods?.some(
    (method) => normalizeProviderId(method.authChoice) === normalizedAuthChoice
  )
  if (!methodExists && !AUTH_CHOICE_ENV_OVERRIDES[normalizedAuthChoice]) return undefined

  return AUTH_CHOICE_CLI_FLAG_OVERRIDES[normalizedAuthChoice] || `--${normalizedAuthChoice}`
}

export function resolveKnownProviderIdForAuthChoice(authChoice?: string): string | undefined {
  const normalizedAuthChoice = normalizeProviderId(authChoice || '')
  if (!normalizedAuthChoice) return undefined

  for (const provider of KNOWN_PROVIDER_METADATA) {
    if (provider.methods?.some((method) => normalizeProviderId(method.authChoice) === normalizedAuthChoice)) {
      return provider.id
    }
  }

  return AUTH_CHOICE_ENV_OVERRIDES[normalizedAuthChoice]?.providerId
}

export function supportsProviderMethodRealtimeValidation(providerId: string, authChoice?: string): boolean {
  const normalizedProviderId = resolveProviderMetadataLookupId(providerId)
  const normalizedAuthChoice = normalizeProviderId(authChoice || '')
  if (!normalizedProviderId || !normalizedAuthChoice) return false

  const envKey = resolveProviderMethodEnvKey(normalizedProviderId, normalizedAuthChoice)
  if (!envKey) return false

  const siblingAuthChoices = listProviderAuthChoiceEnvMappings(normalizedProviderId)
    .filter((entry) => entry.envKey === envKey)
    .map((entry) => entry.authChoice)

  return new Set(siblingAuthChoices).size === 1 && siblingAuthChoices[0] === normalizedAuthChoice
}
