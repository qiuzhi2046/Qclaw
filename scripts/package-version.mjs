const { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } = process.getBuiltinModule('node:fs')
const { dirname, resolve } = process.getBuiltinModule('node:path')

function fail(message) {
  throw new Error(`[package-version] ${message}`)
}

const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4))

export const DEFAULT_PACKAGE_VERSION_STATE_PATH = '.qclaw-package-version.json'
export const PACKAGE_VERSION_LOCK_SUFFIX = '.lock'
export const DEFAULT_PACKAGE_VERSION_LOCK_TIMEOUT_MS = 5000
export const PACKAGE_VERSION_SEQUENCE_SLOT_SIZE = 100

function resolveEnv(env) {
  return env || process.env
}

function sleepForLockRetry(delayMs) {
  Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, delayMs)
}

function resolveLockTimeoutMs(options = {}) {
  const env = resolveEnv(options.env)
  const candidate = Number(options.lockTimeoutMs ?? env.QCLAW_PACKAGE_VERSION_LOCK_TIMEOUT_MS)
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_PACKAGE_VERSION_LOCK_TIMEOUT_MS
  }
  return Math.floor(candidate)
}

function parseDateVersion(baseVersion) {
  const parts = String(baseVersion || '')
    .trim()
    .split('.')
    .map((part) => Number(part))

  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    fail(`日期版本号 ${JSON.stringify(baseVersion)} 非法，必须是 YYYY.M.D。`)
  }

  return {
    year: parts[0],
    month: parts[1],
    day: parts[2],
  }
}

function normalizeSequence(sequence) {
  const normalized = Number(sequence)
  if (!Number.isInteger(normalized) || normalized < 0) {
    fail(`打包序号 ${JSON.stringify(sequence)} 非法，必须是大于等于 0 的整数。`)
  }
  if (normalized >= PACKAGE_VERSION_SEQUENCE_SLOT_SIZE) {
    fail(
      `当天打包次数已达到上限 ${PACKAGE_VERSION_SEQUENCE_SLOT_SIZE}。如需继续，请设置 QCLAW_PACKAGE_VERSION 手动覆盖版本号。`
    )
  }
  return normalized
}

function buildDisplayVersion(baseVersion, sequence) {
  return `${baseVersion}-v${normalizeSequence(sequence)}`
}

function buildStablePackageVersion(baseVersion, sequence) {
  const normalizedSequence = normalizeSequence(sequence)
  const { year, month, day } = parseDateVersion(baseVersion)
  return `${year}.${month}.${day * PACKAGE_VERSION_SEQUENCE_SLOT_SIZE + normalizedSequence}`
}

function buildResolvedPackageVersion({ baseVersion, sequence, timeZone, statePath, version, displayVersion, fromOverride }) {
  return {
    version,
    displayVersion,
    baseVersion,
    sequence,
    buildLabel: sequence === null ? null : `v${sequence}`,
    timeZone,
    fromOverride,
    statePath,
  }
}

function buildStatePayload(input) {
  return {
    dateKey: input.dateKey,
    lastAllocatedSequence: input.lastAllocatedSequence,
    activeClaimSequences: input.activeClaimSequences ?? [],
    lastCompletedSequence: input.lastCompletedSequence ?? null,
    version: input.version,
    displayVersion: input.displayVersion,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt ?? null,
  }
}

function writePackageVersionState(statePath, input) {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(buildStatePayload(input), null, 2)}\n`)
}

function removePackageVersionState(statePath) {
  try {
    unlinkSync(statePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

function normalizeState(parsed, statePath) {
  const dateKey = String(parsed?.dateKey || '').trim()
  const parsedLastAllocatedSequence = Number(
    parsed?.lastAllocatedSequence ?? parsed?.lastSequence ?? parsed?.lastCompletedSequence ?? parsed?.sequence
  )
  const completedCandidate = parsed?.lastCompletedSequence ?? parsed?.lastSequence
  const lastCompletedSequence =
    completedCandidate === undefined || completedCandidate === null || completedCandidate === ''
      ? null
      : Number(completedCandidate)
  const activeClaimSequences = Array.isArray(parsed?.activeClaimSequences)
    ? [...new Set(parsed.activeClaimSequences.map((value) => Number(value)))]
    : []

  if (!dateKey) {
    fail(`打包计数文件 ${JSON.stringify(statePath)} 缺少 dateKey。`)
  }

  if (!Number.isInteger(parsedLastAllocatedSequence) || parsedLastAllocatedSequence < 0) {
    fail(`打包计数文件 ${JSON.stringify(statePath)} 的 lastAllocatedSequence 非法。`)
  }

  if (lastCompletedSequence !== null && (!Number.isInteger(lastCompletedSequence) || lastCompletedSequence < 0)) {
    fail(`打包计数文件 ${JSON.stringify(statePath)} 的 lastCompletedSequence 非法。`)
  }

  for (const sequence of activeClaimSequences) {
    if (!Number.isInteger(sequence) || sequence < 0) {
      fail(`打包计数文件 ${JSON.stringify(statePath)} 的 activeClaimSequences 非法。`)
    }
  }

  const inferredActiveClaimSequences =
    activeClaimSequences.length > 0
      ? activeClaimSequences
      : parsedLastAllocatedSequence > (lastCompletedSequence ?? -1)
        ? [parsedLastAllocatedSequence]
        : []
  const lastAllocatedSequence = Math.max(
    parsedLastAllocatedSequence,
    lastCompletedSequence ?? -1,
    ...inferredActiveClaimSequences
  )

  return {
    dateKey,
    lastAllocatedSequence,
    activeClaimSequences: inferredActiveClaimSequences,
    lastCompletedSequence,
    version: String(parsed?.version || '').trim() || undefined,
    displayVersion: String(parsed?.displayVersion || '').trim() || undefined,
    updatedAt: String(parsed?.updatedAt || '').trim() || undefined,
    completedAt: String(parsed?.completedAt || '').trim() || undefined,
    statePath,
  }
}

const LOCK_PID_FILE = 'pid'

function writeLockPid(lockPath) {
  try {
    writeFileSync(`${lockPath}/${LOCK_PID_FILE}`, String(process.pid))
  } catch {
    // non-critical: best-effort, lock is still held via the directory
  }
}

function readLockPid(lockPath) {
  try {
    const value = Number(readFileSync(`${lockPath}/${LOCK_PID_FILE}`, 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tryRemoveStaleLock(lockPath) {
  const pid = readLockPid(lockPath)
  if (isProcessAlive(pid)) return false
  try {
    rmSync(lockPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function withPackageVersionLock(options, action) {
  const lockPath = resolvePackageVersionLockPath(options)
  const timeoutMs = resolveLockTimeoutMs(options)
  const startedAt = Date.now()

  for (;;) {
    try {
      mkdirSync(lockPath)
      writeLockPid(lockPath)
      break
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        if (tryRemoveStaleLock(lockPath)) continue
        if (Date.now() - startedAt >= timeoutMs) {
          fail(`等待打包版本锁超时：${lockPath}`)
        }
        sleepForLockRetry(50)
        continue
      }
      throw error
    }
  }

  try {
    return action()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

export function resolveVersionTimeZone(env = process.env) {
  return String(resolveEnv(env).QCLAW_VERSION_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai'
}

export function buildDateVersion(date = new Date(), timeZone = resolveVersionTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  if (!year || !month || !day) {
    fail(`无法根据时区 ${JSON.stringify(timeZone)} 生成日期版本号。`)
  }

  return `${Number(year)}.${Number(month)}.${Number(day)}`
}

export function isValidPackageVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || '').trim())
}

export function resolvePackageVersionStatePath(options = {}) {
  const env = resolveEnv(options.env)
  const configuredPath =
    String(options.statePath || env.QCLAW_PACKAGE_VERSION_STATE_PATH || DEFAULT_PACKAGE_VERSION_STATE_PATH).trim() ||
    DEFAULT_PACKAGE_VERSION_STATE_PATH
  const cwd = options.cwd || process.cwd()
  return resolve(cwd, configuredPath)
}

export function resolvePackageVersionLockPath(options = {}) {
  return `${resolvePackageVersionStatePath(options)}${PACKAGE_VERSION_LOCK_SUFFIX}`
}

export function readPackageVersionState(options = {}) {
  const statePath = resolvePackageVersionStatePath(options)

  try {
    const raw = readFileSync(statePath, 'utf8')
    return normalizeState(JSON.parse(raw), statePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    if (error instanceof SyntaxError) {
      fail(`打包计数文件 ${JSON.stringify(statePath)} 不是合法 JSON。`)
    }

    throw error
  }
}

export function resolveNextPackageSequence(baseVersion, state) {
  if (!state || state.dateKey !== baseVersion) return 0
  return Math.max(state.lastAllocatedSequence, ...(state.activeClaimSequences || [])) + 1
}

function buildStateVersionMetadata(baseVersion, sequence) {
  return {
    version: buildStablePackageVersion(baseVersion, sequence),
    displayVersion: buildDisplayVersion(baseVersion, sequence),
  }
}

export function resolvePackageVersion(options = {}) {
  const env = resolveEnv(options.env)
  const timeZone = options.timeZone || resolveVersionTimeZone(env)
  const override = String(env.QCLAW_PACKAGE_VERSION || '').trim()
  const displayOverride = String(env.QCLAW_DISPLAY_VERSION || '').trim()
  const baseVersion = buildDateVersion(options.date, timeZone)
  const statePath = resolvePackageVersionStatePath({
    statePath: options.statePath,
    cwd: options.cwd,
    env,
  })

  if (override) {
    if (!isValidPackageVersion(override)) {
      fail(
        `版本号 ${JSON.stringify(override)} 非法。请使用类似 2026.3.2700 的稳定 semver，或使用合法的 semver 预发布后缀。`
      )
    }

    return buildResolvedPackageVersion({
      version: override,
      displayVersion: displayOverride || override,
      baseVersion,
      sequence: null,
      timeZone,
      statePath,
      fromOverride: true,
    })
  }

  const sequence =
    options.sequence ??
    resolveNextPackageSequence(
      baseVersion,
      options.state !== undefined
        ? options.state
        : readPackageVersionState({
            statePath,
            cwd: options.cwd,
            env,
          })
    )

  return buildResolvedPackageVersion({
    version: buildStablePackageVersion(baseVersion, sequence),
    displayVersion: buildDisplayVersion(baseVersion, sequence),
    baseVersion,
    sequence: normalizeSequence(sequence),
    timeZone,
    statePath,
    fromOverride: false,
  })
}

export function claimPackageVersion(options = {}) {
  const preview = resolvePackageVersion(options)
  if (preview.fromOverride) return preview

  return withPackageVersionLock(options, () => {
    const existingState = readPackageVersionState(options)
    const claimed = resolvePackageVersion({
      ...options,
      state: existingState,
    })
    const now = new Date().toISOString()
    const activeClaimSequences =
      existingState?.dateKey === claimed.baseVersion
        ? [...new Set([...(existingState.activeClaimSequences || []), claimed.sequence])]
        : [claimed.sequence]

    writePackageVersionState(claimed.statePath, {
      dateKey: claimed.baseVersion,
      lastAllocatedSequence: Math.max(claimed.sequence, ...(activeClaimSequences || [])),
      activeClaimSequences,
      lastCompletedSequence: existingState?.dateKey === claimed.baseVersion ? existingState.lastCompletedSequence : null,
      version: claimed.version,
      displayVersion: claimed.displayVersion,
      updatedAt: now,
      completedAt: existingState?.dateKey === claimed.baseVersion ? existingState.completedAt : null,
    })

    return claimed
  })
}

export function persistPackageVersionState(resolvedVersion, options = {}) {
  if (!resolvedVersion || resolvedVersion.fromOverride) return null

  return withPackageVersionLock(
    {
      statePath: options.statePath || resolvedVersion.statePath,
      cwd: options.cwd,
      env: options.env,
      lockTimeoutMs: options.lockTimeoutMs,
    },
    () => {
      const statePath = resolvePackageVersionStatePath({
        statePath: options.statePath || resolvedVersion.statePath,
        cwd: options.cwd,
        env: options.env,
      })
      const currentState = readPackageVersionState({ statePath, cwd: options.cwd, env: options.env })
      const now = new Date().toISOString()

      if (currentState && currentState.dateKey !== resolvedVersion.baseVersion) {
        return {
          statePath,
          skipped: true,
          reason: 'date_mismatch',
        }
      }

      const activeClaimSequences = (currentState?.activeClaimSequences || []).filter(
        (sequence) => sequence !== resolvedVersion.sequence
      )
      const lastCompletedSequence =
        currentState?.lastCompletedSequence === null || currentState?.lastCompletedSequence === undefined
          ? resolvedVersion.sequence
          : Math.max(currentState.lastCompletedSequence, resolvedVersion.sequence)
      const lastAllocatedSequence = Math.max(lastCompletedSequence, ...activeClaimSequences)
      const stateVersionMetadata = buildStateVersionMetadata(resolvedVersion.baseVersion, lastAllocatedSequence)
      const payload = {
        dateKey: resolvedVersion.baseVersion,
        lastAllocatedSequence,
        activeClaimSequences,
        lastCompletedSequence,
        version: stateVersionMetadata.version,
        displayVersion: stateVersionMetadata.displayVersion,
        updatedAt: now,
        completedAt: now,
      }

      writePackageVersionState(statePath, payload)

      return {
        statePath,
        ...payload,
      }
    }
  )
}

export function releasePackageVersionClaim(resolvedVersion, options = {}) {
  if (!resolvedVersion || resolvedVersion.fromOverride) return null

  return withPackageVersionLock(
    {
      statePath: options.statePath || resolvedVersion.statePath,
      cwd: options.cwd,
      env: options.env,
      lockTimeoutMs: options.lockTimeoutMs,
    },
    () => {
      const statePath = resolvePackageVersionStatePath({
        statePath: options.statePath || resolvedVersion.statePath,
        cwd: options.cwd,
        env: options.env,
      })
      const currentState = readPackageVersionState({ statePath, cwd: options.cwd, env: options.env })

      if (!currentState) {
        return {
          statePath,
          released: false,
          reason: 'missing_state',
        }
      }

      if (currentState.dateKey !== resolvedVersion.baseVersion) {
        return {
          statePath,
          released: false,
          reason: 'state_date_mismatch',
        }
      }

      const activeClaimSequences = (currentState.activeClaimSequences || []).filter(
        (sequence) => sequence !== resolvedVersion.sequence
      )
      const removedClaim = activeClaimSequences.length !== (currentState.activeClaimSequences || []).length
      if (!removedClaim) {
        return {
          statePath,
          released: false,
          reason: 'claim_not_active',
        }
      }

      const lastCompletedSequence = currentState.lastCompletedSequence
      const lastAllocatedSequence = Math.max(lastCompletedSequence ?? -1, ...activeClaimSequences)
      if (lastAllocatedSequence < 0) {
        removePackageVersionState(statePath)
        return {
          statePath,
          released: true,
          removed: true,
        }
      }

      const now = new Date().toISOString()
      const stateVersionMetadata = buildStateVersionMetadata(resolvedVersion.baseVersion, lastAllocatedSequence)
      const payload = {
        dateKey: resolvedVersion.baseVersion,
        lastAllocatedSequence,
        activeClaimSequences,
        lastCompletedSequence,
        version: stateVersionMetadata.version,
        displayVersion: stateVersionMetadata.displayVersion,
        updatedAt: now,
        completedAt: lastCompletedSequence !== null ? currentState.completedAt || now : null,
      }

      writePackageVersionState(statePath, payload)

      return {
        statePath,
        released: true,
        removed: false,
        ...payload,
      }
    }
  )
}
