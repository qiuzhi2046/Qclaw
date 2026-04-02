import type { AuthMethodType } from './openclaw-capabilities'
import { resolveOpenClawPackageRoot } from './openclaw-package'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const path = process.getBuiltinModule('path') as typeof import('node:path')
const vm = process.getBuiltinModule('vm') as typeof import('node:vm')

export type AuthRouteKind =
  | 'models-auth-login'
  | 'models-auth-login-github-copilot'
  | 'models-auth-setup-token'
  | 'models-auth-paste-token'
  | 'onboard'
  | 'onboard-custom'
  | 'unsupported'

export type OpenClawAuthRegistrySource =
  | 'openclaw-public-json'
  | 'openclaw-public-export'
  | 'openclaw-internal-registry'
  | 'unsupported-openclaw-layout'
  | 'unknown'

export interface OpenClawAuthExtraOptionDescriptor {
  id: string
  label: string
  hint?: string
}

export interface OpenClawAuthRouteDescriptor {
  kind: AuthRouteKind
  providerId?: string
  methodId?: string
  pluginId?: string
  cliFlag?: string
  requiresSecret?: boolean
  requiresBrowser?: boolean
  extraOptions?: OpenClawAuthExtraOptionDescriptor[]
}

export interface OpenClawAuthMethodDescriptor {
  authChoice: string
  label: string
  hint?: string
  kind: AuthMethodType
  route: OpenClawAuthRouteDescriptor
}

export interface OpenClawAuthProviderDescriptor {
  id: string
  label: string
  hint?: string
  methods: OpenClawAuthMethodDescriptor[]
}

export interface OpenClawAuthRegistry {
  ok: boolean
  source: OpenClawAuthRegistrySource
  providers: OpenClawAuthProviderDescriptor[]
  message?: string
}

interface LoadOpenClawAuthRegistryOptions {
  packageRoot?: string
  forceRefresh?: boolean
}

interface AuthChoiceGroup {
  value: string
  label: string
  hint?: string
  choices: string[]
}

interface AuthChoiceOption {
  value: string
  label: string
  hint?: string
  groupId?: string
  groupLabel?: string
  groupHint?: string
}

interface OnboardProviderAuthFlag {
  optionKey?: string
  authChoice: string
  cliFlag: string
  description: string
}

interface ParsedPluginAuthMethod {
  id: string
  label: string
  hint?: string
  kind: string
  authChoice?: string
}

interface ParsedPluginProvider {
  pluginId: string
  providerId: string
  label: string
  docsPath?: string
  aliases: string[]
  methods: ParsedPluginAuthMethod[]
}

interface ParsedPluginAuthChoice {
  pluginId: string
  providerId: string
  authChoice: string
  methodId: string
  label: string
  hint?: string
  groupId?: string
  groupLabel?: string
  groupHint?: string
  optionKey?: string
  cliFlag?: string
  cliOption?: string
  description?: string
}

interface ParsedPluginDiscovery {
  providers: Map<string, ParsedPluginProvider>
  authChoices: ParsedPluginAuthChoice[]
  authChoiceById: Map<string, ParsedPluginAuthChoice>
}

interface InternalMetadataSnapshot {
  packageRoot: string
  version: string
  source: 'openclaw-internal-registry'
  authChoiceOptionsFileName: string
  authChoiceFileName: string | null
  onboardProviderAuthFlagsFileName: string | null
}

interface CachedAuthRegistryEntry {
  key: string
  registry: OpenClawAuthRegistry
}

const BROWSER_AUTH_KINDS = new Set(['oauth', 'device', 'device_code', 'oauth-cn'])
let cachedInternalRegistry: CachedAuthRegistryEntry | null = null

export function createOpenClawAuthRegistry(
  input: Partial<OpenClawAuthRegistry> = {}
): OpenClawAuthRegistry {
  const source = input.source ?? 'unknown'
  return {
    ok: input.ok ?? source !== 'unsupported-openclaw-layout',
    source,
    providers: input.providers ? [...input.providers] : [],
    ...(input.message ? { message: input.message } : {}),
  }
}

export async function loadOpenClawAuthRegistry(
  options: LoadOpenClawAuthRegistryOptions = {}
): Promise<OpenClawAuthRegistry> {
  const publicJsonRegistry = await tryLoadPublicJsonRegistry()
  if (publicJsonRegistry) return publicJsonRegistry

  const publicExportRegistry = await tryLoadPublicExportRegistry()
  if (publicExportRegistry) return publicExportRegistry

  try {
    const packageRoot = options.packageRoot?.trim() || (await resolveInstalledOpenClawPackageRoot())
    const metadataSnapshot = await collectInternalMetadataSnapshot(packageRoot)
    const cacheKey = buildInternalRegistryCacheKey(metadataSnapshot)

    if (!options.forceRefresh && cachedInternalRegistry?.key === cacheKey) {
      return cachedInternalRegistry.registry
    }

    const registry = await loadInternalOpenClawAuthRegistry(metadataSnapshot)
    cachedInternalRegistry = {
      key: cacheKey,
      registry,
    }
    return registry
  } catch (error: any) {
    return createOpenClawAuthRegistry({
      ok: false,
      source: 'unsupported-openclaw-layout',
      message: error?.message || 'OpenClaw auth metadata is unavailable.',
    })
  }
}

async function tryLoadPublicJsonRegistry(): Promise<OpenClawAuthRegistry | null> {
  return null
}

async function tryLoadPublicExportRegistry(): Promise<OpenClawAuthRegistry | null> {
  return null
}

async function resolveInstalledOpenClawPackageRoot(): Promise<string> {
  return resolveOpenClawPackageRoot()
}

async function collectInternalMetadataSnapshot(packageRoot: string): Promise<InternalMetadataSnapshot> {
  return {
    packageRoot,
    version: await readPackageVersion(packageRoot),
    source: 'openclaw-internal-registry',
    onboardProviderAuthFlagsFileName: await findDistJavaScriptFileContainingToken(
      packageRoot,
      'ONBOARD_PROVIDER_AUTH_FLAGS',
      {
        preferredPrefixes: ['onboard-provider-auth-flags'],
        allowMissing: true,
      }
    ),
    authChoiceOptionsFileName: await findDistJavaScriptFileContainingOneOf(
      packageRoot,
      ['AUTH_CHOICE_GROUP_DEFS', 'CORE_AUTH_CHOICE_OPTIONS'],
      {
        preferredPrefixes: ['auth-choice-options'],
      }
    ),
    authChoiceFileName: await findDistJavaScriptFileContainingToken(
      packageRoot,
      'PREFERRED_PROVIDER_BY_AUTH_CHOICE',
      {
        preferredPrefixes: ['auth-choice.preferred-provider', 'auth-choice'],
        allowMissing: true,
      }
    ),
  }
}

function buildInternalRegistryCacheKey(snapshot: InternalMetadataSnapshot): string {
  return JSON.stringify({
    source: snapshot.source,
    version: snapshot.version,
    packageRoot: snapshot.packageRoot,
    metadataFiles: [
      snapshot.onboardProviderAuthFlagsFileName,
      snapshot.authChoiceOptionsFileName,
      snapshot.authChoiceFileName,
    ],
  })
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  const packageJsonPath = path.join(packageRoot, 'package.json')
  const rawPackageJson = await fs.promises.readFile(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(rawPackageJson) as Record<string, unknown>
  const version = String(packageJson.version || '').trim()
  if (!version) {
    throw new Error(`Resolved OpenClaw package.json is missing a version: ${packageJsonPath}`)
  }
  return version
}

async function loadInternalOpenClawAuthRegistry(snapshot: InternalMetadataSnapshot): Promise<OpenClawAuthRegistry> {
  const authFlagsText = snapshot.onboardProviderAuthFlagsFileName
    ? await fs.promises.readFile(path.join(snapshot.packageRoot, 'dist', snapshot.onboardProviderAuthFlagsFileName), 'utf8')
    : ''
  const authChoiceOptionsText = await fs.promises.readFile(
    path.join(snapshot.packageRoot, 'dist', snapshot.authChoiceOptionsFileName),
    'utf8'
  )
  const authChoiceText = snapshot.authChoiceFileName
    ? await fs.promises.readFile(path.join(snapshot.packageRoot, 'dist', snapshot.authChoiceFileName), 'utf8')
    : ''

  const pluginDiscovery = await parsePluginProviders(snapshot.packageRoot)
  const onboardFlags = mergeOnboardProviderAuthFlags(
    authFlagsText ? parseOnboardProviderAuthFlags(authFlagsText) : [],
    buildManifestOnboardProviderAuthFlags(pluginDiscovery.authChoices)
  )
  const { groups, optionByChoice } = parseAuthChoiceOptions(
    authChoiceOptionsText,
    onboardFlags,
    pluginDiscovery.authChoices
  )
  let preferredProviderByChoice: Record<string, string> = {}
  if (authChoiceText) {
    try {
      preferredProviderByChoice = parsePreferredProviderByAuthChoice(authChoiceText)
    } catch {
      preferredProviderByChoice = {}
    }
  }
  const pluginProviders = pluginDiscovery.providers

  const providers: OpenClawAuthProviderDescriptor[] = groups.map((group) => ({
    id: group.value,
    label: group.label,
    ...(group.hint ? { hint: group.hint } : {}),
    methods: group.choices.map((authChoice) =>
      buildMethodDescriptor({
        providerId: group.value,
        authChoice,
        option: optionByChoice.get(authChoice),
        onboardFlags,
        preferredProviderByChoice,
        pluginProviders,
        pluginAuthChoiceById: pluginDiscovery.authChoiceById,
      })
    ),
  }))

  return createOpenClawAuthRegistry({
    source: 'openclaw-internal-registry',
    providers,
  })
}

interface DistJavaScriptFileLookupOptions {
  preferredPrefixes?: string[]
  allowMissing?: boolean
}

async function findDistJavaScriptFileContainingToken(
  packageRoot: string,
  requiredContent: string,
  options?: DistJavaScriptFileLookupOptions & { allowMissing?: false | undefined }
): Promise<string>
async function findDistJavaScriptFileContainingToken(
  packageRoot: string,
  requiredContent: string,
  options: DistJavaScriptFileLookupOptions & { allowMissing: true }
): Promise<string | null>
async function findDistJavaScriptFileContainingToken(
  packageRoot: string,
  requiredContent: string,
  options: DistJavaScriptFileLookupOptions = {}
): Promise<string | null> {
  if (options.allowMissing) {
    return findDistJavaScriptFileContainingOneOf(packageRoot, [requiredContent], {
      preferredPrefixes: options.preferredPrefixes,
      allowMissing: true,
    })
  }
  return findDistJavaScriptFileContainingOneOf(packageRoot, [requiredContent], {
    preferredPrefixes: options.preferredPrefixes,
  })
}

async function findDistJavaScriptFileContainingOneOf(
  packageRoot: string,
  requiredContents: string[],
  options?: DistJavaScriptFileLookupOptions & { allowMissing?: false | undefined }
): Promise<string>
async function findDistJavaScriptFileContainingOneOf(
  packageRoot: string,
  requiredContents: string[],
  options: DistJavaScriptFileLookupOptions & { allowMissing: true }
): Promise<string | null>
async function findDistJavaScriptFileContainingOneOf(
  packageRoot: string,
  requiredContents: string[],
  options: DistJavaScriptFileLookupOptions = {}
): Promise<string | null> {
  const distDir = path.join(packageRoot, 'dist')
  let entries: string[]
  try {
    entries = await fs.promises.readdir(distDir)
  } catch {
    throw new Error(`OpenClaw auth metadata directory is missing: ${distDir}`)
  }
  const preferredPrefixes = options.preferredPrefixes || []
  const candidates = entries
    .filter((entry) => entry.endsWith('.js'))
    .sort((left, right) => {
      const leftPriority = getDistFilePriority(left, preferredPrefixes)
      const rightPriority = getDistFilePriority(right, preferredPrefixes)
      if (leftPriority !== rightPriority) return leftPriority - rightPriority
      return left.localeCompare(right)
    })

  for (const name of candidates) {
    const content = await fs.promises.readFile(path.join(distDir, name), 'utf8')
    if (requiredContents.some((requiredContent) => content.includes(requiredContent))) {
      return name
    }
  }

  if (options.allowMissing) return null

  throw new Error(`Unable to locate OpenClaw auth metadata tokens "${requiredContents.join(', ')}" in ${distDir}`)
}

function getDistFilePriority(name: string, preferredPrefixes: string[]): number {
  for (let index = 0; index < preferredPrefixes.length; index += 1) {
    const prefix = preferredPrefixes[index]
    if (name === `${prefix}.js` || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`)) {
      return index
    }
  }
  return preferredPrefixes.length
}

function parseOnboardProviderAuthFlags(text: string): OnboardProviderAuthFlag[] {
  const expression = extractConstExpression(text, 'ONBOARD_PROVIDER_AUTH_FLAGS')
  return evaluateLiteral<OnboardProviderAuthFlag[]>(expression)
}

function parsePreferredProviderByAuthChoice(text: string): Record<string, string> {
  const expression = extractConstExpression(text, 'PREFERRED_PROVIDER_BY_AUTH_CHOICE')
  return evaluateLiteral<Record<string, string>>(expression)
}

function parseAuthChoiceOptions(
  text: string,
  onboardFlags: OnboardProviderAuthFlag[],
  manifestAuthChoices: ParsedPluginAuthChoice[] = []
): {
  groups: AuthChoiceGroup[]
  optionByChoice: Map<string, AuthChoiceOption>
} {
  if (!text.includes('AUTH_CHOICE_GROUP_DEFS')) {
    return parseModernAuthChoiceOptions(text, onboardFlags, manifestAuthChoices)
  }

  const groups = evaluateLiteral<AuthChoiceGroup[]>(extractConstExpression(text, 'AUTH_CHOICE_GROUP_DEFS'))
  const hintOverrides = evaluateLiteral<Record<string, string>>(
    extractConstExpression(text, 'PROVIDER_AUTH_CHOICE_OPTION_HINTS')
  )
  const labelOverrides = evaluateLiteral<Record<string, string>>(
    extractConstExpression(text, 'PROVIDER_AUTH_CHOICE_OPTION_LABELS')
  )
  const baseOptionsExpression = extractConstExpression(text, 'BASE_AUTH_CHOICE_OPTIONS').replace(
    /\.\.\.buildProviderAuthChoiceOptions\(\)\s*,?/g,
    ''
  )
  const baseOptions = evaluateLiteral<AuthChoiceOption[]>(baseOptionsExpression)

  const optionByChoice = new Map<string, AuthChoiceOption>()
  for (const option of baseOptions) {
    optionByChoice.set(option.value, option)
  }

  for (const flag of onboardFlags) {
    optionByChoice.set(flag.authChoice, {
      value: flag.authChoice,
      label: labelOverrides[flag.authChoice] || flag.description,
      ...(hintOverrides[flag.authChoice] ? { hint: hintOverrides[flag.authChoice] } : {}),
    })
  }

  return { groups, optionByChoice }
}

function parseModernAuthChoiceOptions(
  text: string,
  onboardFlags: OnboardProviderAuthFlag[],
  manifestAuthChoices: ParsedPluginAuthChoice[]
): {
  groups: AuthChoiceGroup[]
  optionByChoice: Map<string, AuthChoiceOption>
} {
  const coreOptions = evaluateLiteral<AuthChoiceOption[]>(extractConstExpression(text, 'CORE_AUTH_CHOICE_OPTIONS'))
  const optionByChoice = new Map<string, AuthChoiceOption>()

  for (const option of coreOptions) {
    upsertAuthChoiceOption(optionByChoice, option)
  }

  for (const choice of manifestAuthChoices) {
    upsertAuthChoiceOption(optionByChoice, {
      value: choice.authChoice,
      label: choice.label,
      ...(choice.hint ? { hint: choice.hint } : {}),
      ...(choice.groupId ? { groupId: choice.groupId } : {}),
      ...(choice.groupLabel ? { groupLabel: choice.groupLabel } : {}),
      ...(choice.groupHint ? { groupHint: choice.groupHint } : {}),
    })
  }

  for (const flag of onboardFlags) {
    if (optionByChoice.has(flag.authChoice)) continue
    upsertAuthChoiceOption(optionByChoice, {
      value: flag.authChoice,
      label: flag.description,
    })
  }

  return {
    groups: buildAuthChoiceGroupsFromOptions([...optionByChoice.values()]),
    optionByChoice,
  }
}

function upsertAuthChoiceOption(target: Map<string, AuthChoiceOption>, option: AuthChoiceOption): void {
  const value = String(option.value || '').trim()
  if (!value) return

  const existing = target.get(value)
  if (!existing) {
    target.set(value, { ...option, value })
    return
  }

  target.set(value, {
    ...existing,
    ...option,
    value,
    label: String(option.label || '').trim() || existing.label,
    hint: String(option.hint || '').trim() || existing.hint,
    groupId: String(option.groupId || '').trim() || existing.groupId,
    groupLabel: String(option.groupLabel || '').trim() || existing.groupLabel,
    groupHint: String(option.groupHint || '').trim() || existing.groupHint,
  })
}

function buildAuthChoiceGroupsFromOptions(options: AuthChoiceOption[]): AuthChoiceGroup[] {
  const groupsById = new Map<
    string,
    {
      label: string
      hint?: string
      options: AuthChoiceOption[]
    }
  >()

  for (const option of options) {
    const groupId = String(option.groupId || '').trim()
    const groupLabel = String(option.groupLabel || '').trim()
    if (!groupId || !groupLabel) continue

    const existing = groupsById.get(groupId)
    if (existing) {
      existing.options.push(option)
      if (!existing.hint && option.groupHint) existing.hint = option.groupHint
      continue
    }

    groupsById.set(groupId, {
      label: groupLabel,
      ...(option.groupHint ? { hint: option.groupHint } : {}),
      options: [option],
    })
  }

  return [...groupsById.entries()]
    .map(([value, group]) => ({
      value,
      label: group.label,
      ...(group.hint ? { hint: group.hint } : {}),
      choices: [...group.options]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((option) => option.value),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

function mergeOnboardProviderAuthFlags(
  legacyFlags: OnboardProviderAuthFlag[],
  manifestFlags: OnboardProviderAuthFlag[]
): OnboardProviderAuthFlag[] {
  const merged: OnboardProviderAuthFlag[] = []
  const seen = new Set<string>()

  for (const flag of [...legacyFlags, ...manifestFlags]) {
    const authChoice = String(flag.authChoice || '').trim()
    const cliFlag = String(flag.cliFlag || '').trim()
    if (!authChoice || !cliFlag) continue
    const key = `${authChoice}::${cliFlag}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(flag)
  }

  return merged
}

function buildManifestOnboardProviderAuthFlags(authChoices: ParsedPluginAuthChoice[]): OnboardProviderAuthFlag[] {
  const flags: OnboardProviderAuthFlag[] = []
  const seen = new Set<string>()

  for (const choice of authChoices) {
    const optionKey = String(choice.optionKey || '').trim()
    const cliFlag = String(choice.cliFlag || '').trim()
    const authChoice = String(choice.authChoice || '').trim()
    if (!optionKey || !cliFlag || !authChoice) continue

    const key = `${optionKey}::${cliFlag}`
    if (seen.has(key)) continue
    seen.add(key)
    flags.push({
      optionKey,
      authChoice,
      cliFlag,
      description: String(choice.description || choice.label || authChoice).trim(),
    })
  }

  return flags
}

async function parsePluginProviders(packageRoot: string): Promise<ParsedPluginDiscovery> {
  const providers = new Map<string, ParsedPluginProvider>()
  const authChoices: ParsedPluginAuthChoice[] = []
  const authChoiceById = new Map<string, ParsedPluginAuthChoice>()

  for (const extensionsDir of [path.join(packageRoot, 'extensions'), path.join(packageRoot, 'dist', 'extensions')]) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.promises.readdir(extensionsDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = path.join(extensionsDir, entry.name)
      const manifestDiscovery = await parsePluginManifestProvider(pluginDir)
      if (manifestDiscovery) {
        mergeParsedPluginDiscovery(providers, authChoices, authChoiceById, manifestDiscovery)
        continue
      }

      const sourcePath = await resolvePluginSourcePath(pluginDir)
      if (!sourcePath) continue
      const text = await fs.promises.readFile(sourcePath, 'utf8')
      const parsed = parsePluginProvider(text)
      if (!parsed) continue
      mergeParsedPluginProvider(providers, parsed)
    }
  }

  return {
    providers,
    authChoices,
    authChoiceById,
  }
}

async function parsePluginManifestProvider(pluginDir: string): Promise<ParsedPluginDiscovery | null> {
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json')
  if (!fs.existsSync(manifestPath)) return null

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }

  const pluginId = String(manifest.id || path.basename(pluginDir)).trim()
  const rawChoices = Array.isArray(manifest.providerAuthChoices) ? manifest.providerAuthChoices : []
  if (!pluginId || rawChoices.length === 0) {
    return {
      providers: new Map(),
      authChoices: [],
      authChoiceById: new Map(),
    }
  }

  const providers = new Map<string, ParsedPluginProvider>()
  const authChoices: ParsedPluginAuthChoice[] = []
  const authChoiceById = new Map<string, ParsedPluginAuthChoice>()

  for (const rawChoice of rawChoices) {
    const choice = rawChoice as Record<string, unknown>
    const providerId = String(choice.provider || '').trim()
    const authChoice = String(choice.choiceId || '').trim()
    const methodId = String(choice.method || '').trim()
    const label = String(choice.choiceLabel || authChoice).trim()
    if (!providerId || !authChoice || !methodId || !label) continue

    const parsedChoice: ParsedPluginAuthChoice = {
      pluginId,
      providerId,
      authChoice,
      methodId,
      label,
      ...(String(choice.choiceHint || '').trim() ? { hint: String(choice.choiceHint).trim() } : {}),
      ...(String(choice.groupId || '').trim() ? { groupId: String(choice.groupId).trim() } : {}),
      ...(String(choice.groupLabel || '').trim() ? { groupLabel: String(choice.groupLabel).trim() } : {}),
      ...(String(choice.groupHint || '').trim() ? { groupHint: String(choice.groupHint).trim() } : {}),
      ...(String(choice.optionKey || '').trim() ? { optionKey: String(choice.optionKey).trim() } : {}),
      ...(String(choice.cliFlag || '').trim() ? { cliFlag: String(choice.cliFlag).trim() } : {}),
      ...(String(choice.cliOption || '').trim() ? { cliOption: String(choice.cliOption).trim() } : {}),
      ...(String(choice.cliDescription || '').trim() ? { description: String(choice.cliDescription).trim() } : {}),
    }
    authChoices.push(parsedChoice)
    authChoiceById.set(authChoice, parsedChoice)

    const method: ParsedPluginAuthMethod = {
      id: methodId,
      authChoice,
      label,
      ...(parsedChoice.hint ? { hint: parsedChoice.hint } : {}),
      kind: methodId,
    }

    const existingProvider = providers.get(providerId)
    if (existingProvider) {
      if (!existingProvider.methods.some((entry) => entry.id === method.id && entry.authChoice === method.authChoice)) {
        existingProvider.methods.push(method)
      }
      continue
    }

    providers.set(providerId, {
      pluginId,
      providerId,
      label: parsedChoice.groupLabel || providerId,
      aliases: [],
      methods: [method],
    })
  }

  return {
    providers,
    authChoices,
    authChoiceById,
  }
}

function mergeParsedPluginDiscovery(
  providers: Map<string, ParsedPluginProvider>,
  authChoices: ParsedPluginAuthChoice[],
  authChoiceById: Map<string, ParsedPluginAuthChoice>,
  discovery: ParsedPluginDiscovery
): void {
  for (const provider of discovery.providers.values()) {
    mergeParsedPluginProvider(providers, provider)
  }

  for (const choice of discovery.authChoices) {
    if (authChoiceById.has(choice.authChoice)) continue
    authChoiceById.set(choice.authChoice, choice)
    authChoices.push(choice)
  }
}

function mergeParsedPluginProvider(target: Map<string, ParsedPluginProvider>, provider: ParsedPluginProvider): void {
  const existing = target.get(provider.providerId)
  if (!existing) {
    target.set(provider.providerId, {
      ...provider,
      aliases: [...provider.aliases],
      methods: [...provider.methods],
    })
    return
  }

  if (!existing.docsPath && provider.docsPath) existing.docsPath = provider.docsPath
  for (const alias of provider.aliases) {
    if (!existing.aliases.includes(alias)) existing.aliases.push(alias)
  }
  for (const method of provider.methods) {
    if (existing.methods.some((entry) => entry.id === method.id && entry.authChoice === method.authChoice)) continue
    existing.methods.push(method)
  }
}

async function resolvePluginSourcePath(pluginDir: string): Promise<string | null> {
  const packageJsonPath = path.join(pluginDir, 'package.json')
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>
      const openclaw = packageJson.openclaw as Record<string, unknown> | undefined
      const extensions = Array.isArray(openclaw?.extensions) ? openclaw.extensions : []
      for (const extension of extensions) {
        const relative = String(extension || '').trim()
        if (!relative) continue
        const resolved = path.resolve(pluginDir, relative)
        if (fs.existsSync(resolved)) return resolved
      }
    } catch {
      // Ignore malformed package metadata and fall back to legacy source probing.
    }
  }

  for (const candidate of ['index.ts', 'index.js', path.join('dist', 'index.js')]) {
    const resolved = path.join(pluginDir, candidate)
    if (fs.existsSync(resolved)) return resolved
  }

  return null
}

function parsePluginProvider(text: string): ParsedPluginProvider | null {
  try {
    const providerBlock = extractObjectExpressionAfter(text, 'registerProvider(')
    if (!providerBlock) return null

    const pluginBlock = extractExportDefaultObjectExpression(text)
    if (!pluginBlock) return null

    const pluginId = resolveObjectField(pluginBlock, text, 'id')
    const providerId = resolveObjectField(providerBlock, text, 'id')
    const label = resolveObjectField(providerBlock, text, 'label')
    if (!pluginId || !providerId || !label) return null

    const authArrayExpression = extractPropertyExpression(providerBlock, 'auth')
    if (!authArrayExpression) return null

    const methods = Array.from(
      authArrayExpression.matchAll(
        /\{\s*id:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"(?:\s*,\s*hint:\s*"([^"]+)")?\s*,\s*kind:\s*"([^"]+)"/gms
      )
    ).map((match) => ({
      id: match[1],
      label: match[2],
      ...(match[3] ? { hint: match[3] } : {}),
      kind: match[4],
    }))

    if (methods.length === 0) return null

    return {
      pluginId,
      providerId,
      label,
      ...(resolveObjectField(providerBlock, text, 'docsPath')
        ? { docsPath: resolveObjectField(providerBlock, text, 'docsPath')! }
        : {}),
      aliases: parseStringArray(extractPropertyExpression(providerBlock, 'aliases') || '[]'),
      methods,
    }
  } catch {
    return null
  }
}

function resolveObjectField(block: string, sourceText: string, fieldName: string): string | undefined {
  const matched = block.match(new RegExp(`\\b${fieldName}:\\s*([^,\\n]+)`, 'm'))
  if (!matched?.[1]) return undefined
  return resolveStaticStringExpression(matched[1].trim(), sourceText)
}

function extractExportDefaultObjectExpression(text: string): string | null {
  const exportDefaultMatch = text.match(/\bexport\s+default\s+([A-Za-z0-9_]+)\s*;?/m)
  if (exportDefaultMatch?.[1]) {
    const variableName = exportDefaultMatch[1]
    const declarationMatch = text.match(new RegExp(`\\b(?:const|let|var)\\s+${variableName}\\s*=\\s*`, 'm'))
    if (!declarationMatch || declarationMatch.index === undefined) return null
    const start = declarationMatch.index + declarationMatch[0].length
    return extractExpressionFromIndex(text, start)
  }

  const inlineExportMatch = /\bexport\s+default\s+/.exec(text)
  if (!inlineExportMatch) return null
  const start = inlineExportMatch.index + inlineExportMatch[0].length
  return extractExpressionFromIndex(text, start)
}

function extractPropertyExpression(text: string, propertyName: string): string | null {
  const match = new RegExp(`\\b${propertyName}:\\s*`, 'm').exec(text)
  if (!match) return null
  const start = match.index + match[0].length
  return extractExpressionFromIndex(text, start)
}

function extractObjectExpressionAfter(text: string, token: string): string | null {
  const tokenIndex = text.indexOf(token)
  if (tokenIndex < 0) return null
  const objectStart = text.indexOf('{', tokenIndex)
  if (objectStart < 0) return null
  return extractBalancedExpression(text, objectStart)
}

function buildMethodDescriptor(params: {
  providerId: string
  authChoice: string
  option?: AuthChoiceOption
  onboardFlags: OnboardProviderAuthFlag[]
  preferredProviderByChoice: Record<string, string>
  pluginProviders: Map<string, ParsedPluginProvider>
  pluginAuthChoiceById: Map<string, ParsedPluginAuthChoice>
}): OpenClawAuthMethodDescriptor {
  const providerId = String(params.providerId || '').trim()
  const authChoice = params.authChoice
  const option = params.option
  const preferredProviderId = params.preferredProviderByChoice[authChoice]
  const onboardFlag = params.onboardFlags.find((flag) => flag.authChoice === authChoice)
  const pluginAuthChoice = params.pluginAuthChoiceById.get(authChoice)
  const pluginProvider =
    (pluginAuthChoice ? params.pluginProviders.get(pluginAuthChoice.providerId) : undefined) ||
    (preferredProviderId ? params.pluginProviders.get(preferredProviderId) : undefined) ||
    params.pluginProviders.get(authChoice) ||
    (providerId ? params.pluginProviders.get(providerId) : undefined)

  let route: OpenClawAuthRouteDescriptor = { kind: 'unsupported' }
  let kind: AuthMethodType = 'unknown'

  if (pluginAuthChoice?.cliFlag) {
    route = {
      kind: 'onboard',
      providerId: pluginAuthChoice.providerId,
      pluginId: pluginAuthChoice.pluginId,
      cliFlag: pluginAuthChoice.cliFlag,
      requiresSecret: true,
    }
    kind = normalizePluginMethodKind(pluginAuthChoice.methodId)
  } else if (pluginAuthChoice && authChoice === 'github-copilot') {
    route = {
      kind: 'models-auth-login-github-copilot',
      providerId: pluginAuthChoice.providerId,
      methodId: pluginAuthChoice.methodId,
      pluginId: pluginAuthChoice.pluginId,
      requiresBrowser: true,
    }
    kind = normalizePluginMethodKind(pluginAuthChoice.methodId)
  } else if (pluginAuthChoice) {
    route = {
      kind: 'models-auth-login',
      providerId: pluginAuthChoice.providerId,
      methodId: pluginAuthChoice.methodId,
      pluginId: pluginAuthChoice.pluginId,
      requiresBrowser: pluginMethodRequiresBrowser(pluginAuthChoice.methodId),
    }
    kind = normalizePluginMethodKind(pluginAuthChoice.methodId)
  } else if (onboardFlag) {
    route = {
      kind: 'onboard',
      providerId: preferredProviderId || providerId,
      cliFlag: onboardFlag.cliFlag,
      requiresSecret: true,
    }
    kind = 'apiKey'
  } else if (authChoice === 'custom-api-key') {
    route = {
      kind: 'onboard-custom',
      providerId: preferredProviderId || providerId,
    }
    kind = 'custom'
  } else if (authChoice === 'openai-codex') {
    route = {
      kind: 'models-auth-login',
      providerId: preferredProviderId || authChoice,
      requiresBrowser: true,
    }
    kind = 'oauth'
  } else if (authChoice === 'github-copilot') {
    route = {
      kind: 'models-auth-login-github-copilot',
      providerId: preferredProviderId || authChoice,
      requiresBrowser: true,
    }
    kind = 'oauth'
  } else if (authChoice === 'token') {
    route = {
      kind: 'models-auth-paste-token',
      providerId: preferredProviderId || providerId,
      requiresSecret: true,
    }
    kind = 'token'
  } else if (authChoice === 'setup-token') {
    route = {
      kind: 'models-auth-setup-token',
      providerId: preferredProviderId || providerId,
    }
    kind = 'token'
  } else if (pluginProvider) {
    const normalizedKinds = pluginProvider.methods.map((method) => normalizePluginMethodKind(method.kind))
    const resolvedKind =
      normalizedKinds.length > 0 && normalizedKinds.every((item) => item === normalizedKinds[0])
        ? normalizedKinds[0]
        : 'unknown'

    route = {
      kind: 'models-auth-login',
      providerId: pluginProvider.providerId,
      ...(pluginProvider.methods.length === 1 ? { methodId: pluginProvider.methods[0].id } : {}),
      pluginId: pluginProvider.pluginId,
      requiresBrowser: pluginProvider.methods.some((method) => BROWSER_AUTH_KINDS.has(method.kind)),
      ...(pluginProvider.methods.length > 1
        ? {
            extraOptions: pluginProvider.methods.map((method) => ({
              id: method.id,
              label: method.label,
              ...(method.hint ? { hint: method.hint } : {}),
            })),
          }
        : {}),
    }
    kind = resolvedKind
  } else {
    const providerScopedOnboardFlag = preferredProviderId
      ? resolveProviderScopedOnboardFlag(preferredProviderId, params.onboardFlags, params.preferredProviderByChoice)
      : providerId
        ? resolveProviderScopedOnboardFlag(providerId, params.onboardFlags, params.preferredProviderByChoice)
      : undefined
    if (providerScopedOnboardFlag) {
      route = {
        kind: 'onboard',
        providerId: preferredProviderId || providerId,
        cliFlag: providerScopedOnboardFlag.cliFlag,
        requiresSecret: true,
      }
      kind = 'apiKey'
    }
  }

  const hint = buildMethodHint(authChoice, option?.hint)

  return {
    authChoice,
    label: option?.label || authChoice,
    ...(hint ? { hint } : {}),
    kind,
    route,
  }
}

function buildMethodHint(authChoice: string, hint?: string): string | undefined {
  const normalizedChoice = normalizeForMatching(authChoice)
  const baseHint = String(hint || '').trim()

  if (normalizedChoice !== 'google-gemini-cli') {
    return baseHint || undefined
  }

  const requirementHint =
    '需要先在本机安装 Gemini 命令行工具，或显式设置 GEMINI_CLI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_SECRET。'
  if (!baseHint) return requirementHint
  if (/gemini cli|gemini_cli_oauth_client_id/i.test(baseHint)) return baseHint
  return `${baseHint}; ${requirementHint}`
}

function resolveProviderScopedOnboardFlag(
  providerId: string,
  onboardFlags: OnboardProviderAuthFlag[],
  preferredProviderByChoice: Record<string, string>
): OnboardProviderAuthFlag | undefined {
  const normalizedProviderId = normalizeForMatching(providerId)
  if (!normalizedProviderId) return undefined

  const providerFlags = onboardFlags.filter(
    (flag) => normalizeForMatching(preferredProviderByChoice[flag.authChoice] || '') === normalizedProviderId
  )
  if (providerFlags.length === 0) return undefined

  return providerFlags.find((flag) => isApiKeyLikeAuthChoice(flag.authChoice)) || providerFlags[0]
}

function isApiKeyLikeAuthChoice(authChoice: string): boolean {
  const normalized = normalizeForMatching(authChoice).replace(/_/g, '-')
  if (!normalized) return false
  if (normalized === 'apikey' || normalized === 'api-key') return true
  if (normalized.includes('api-key')) return true
  if (normalized.endsWith('-api')) return true
  return false
}

function normalizeForMatching(value: string): string {
  return String(value || '').trim().toLowerCase()
}

function normalizePluginMethodKind(kind: string): AuthMethodType {
  const normalized = normalizeForMatching(kind).replace(/_/g, '-')
  if (!normalized) return 'unknown'
  if (normalized === 'token') return 'token'
  if (normalized === 'custom' || normalized === 'local') return 'custom'
  if (normalized === 'oauth' || normalized === 'device' || normalized === 'device-code') return 'oauth'
  if (normalized.startsWith('oauth-')) return 'oauth'
  if (normalized === 'api-key' || normalized === 'apikey' || normalized.startsWith('api-')) return 'apiKey'
  return 'unknown'
}

function pluginMethodRequiresBrowser(methodId: string): boolean {
  const normalized = normalizeForMatching(methodId).replace(/_/g, '-')
  return normalized === 'oauth' || normalized === 'device' || normalized === 'device-code' || normalized.startsWith('oauth-')
}

function resolveStaticStringExpression(expression: string, sourceText: string): string | undefined {
  const directMatch = expression.match(/^"([^"]*)"$/)
  if (directMatch?.[1] !== undefined) return directMatch[1]

  const identifierMatch = expression.match(/^([A-Z0-9_]+)$/)
  if (!identifierMatch?.[1]) return undefined
  const constMatch = sourceText.match(new RegExp(`const\\s+${identifierMatch[1]}\\s*=\\s*"([^"]*)"`, 'm'))
  return constMatch?.[1]
}

function parseStringArray(expression: string): string[] {
  return evaluateLiteral<string[]>(expression)
}

function extractConstExpression(text: string, constName: string): string {
  const match = new RegExp(`const\\s+${constName}\\s*=\\s*`, 'm').exec(text)
  if (!match) {
    throw new Error(`Failed to find const ${constName} in OpenClaw metadata`)
  }
  const start = match.index + match[0].length
  return extractExpressionFromIndex(text, start)
}

function extractExpressionFromIndex(text: string, startIndex: number): string {
  let index = startIndex
  while (index < text.length && /\s/.test(text[index])) index += 1
  return extractBalancedExpression(text, index)
}

function extractBalancedExpression(text: string, startIndex: number): string {
  const startChar = text[startIndex]
  const pairs: Record<string, string> = {
    '[': ']',
    '{': '}',
    '(': ')',
  }
  const expectedClose = pairs[startChar]
  if (!expectedClose) {
    const semicolonIndex = text.indexOf(';', startIndex)
    if (semicolonIndex < 0) {
      throw new Error('Failed to find the end of the expression in OpenClaw metadata')
    }
    return text.slice(startIndex, semicolonIndex).trim()
  }

  const stack = [expectedClose]
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (pairs[char]) {
      stack.push(pairs[char])
      continue
    }

    if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) {
        return text.slice(startIndex, index + 1).trim()
      }
    }
  }

  throw new Error('Failed to extract a balanced expression from OpenClaw metadata')
}

function evaluateLiteral<T>(expression: string): T {
  return vm.runInNewContext(`(${expression})`, Object.create(null)) as T
}
