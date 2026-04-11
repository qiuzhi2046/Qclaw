import { describe, expect, it } from 'vitest'
import {
  sanitizeManagedInstallerEnv,
  shouldDropManagedInstallerEnvKey,
} from '../managed-installer-env'
import { shouldRetryWithNpmTlsFallback } from '../cli'
import { buildTestEnv } from './test-env'

describe('managed-installer-env', () => {
  it('drops high-risk runtime and package manager environment keys', () => {
    expect(shouldDropManagedInstallerEnvKey('NODE_OPTIONS')).toBe(true)
    expect(shouldDropManagedInstallerEnvKey('npm_config_registry')).toBe(true)
    expect(shouldDropManagedInstallerEnvKey('NPM_CONFIG_CAFILE')).toBe(true)
    expect(shouldDropManagedInstallerEnvKey('YARN_CACHE_FOLDER')).toBe(true)
    expect(shouldDropManagedInstallerEnvKey('VOLTA_HOME')).toBe(true)
    expect(shouldDropManagedInstallerEnvKey('ASDF_DIR')).toBe(true)
  })

  it('keeps network proxy variables while removing installer pollution', () => {
    const sanitized = sanitizeManagedInstallerEnv(
      buildTestEnv({
        PATH: '/usr/bin',
        HOME: '/Users/tester',
        HTTP_PROXY: 'http://127.0.0.1:8080',
        HTTPS_PROXY: 'http://127.0.0.1:8080',
        NO_PROXY: 'localhost,127.0.0.1',
        NODE_OPTIONS: '--use-bundled-ca',
        npm_config_registry: 'https://bad.example.com',
        NPM_CONFIG_CACHE: '/tmp/custom-cache',
        YARN_CACHE_FOLDER: '/tmp/yarn',
      })
    )

    expect(sanitized.PATH).toBe('/usr/bin')
    expect(sanitized.HOME).toBe('/Users/tester')
    expect(sanitized.HTTP_PROXY).toBe('http://127.0.0.1:8080')
    expect(sanitized.HTTPS_PROXY).toBe('http://127.0.0.1:8080')
    expect(sanitized.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(sanitized.NODE_OPTIONS).toBeUndefined()
    expect(sanitized.npm_config_registry).toBeUndefined()
    expect(sanitized.NPM_CONFIG_CACHE).toBeUndefined()
    expect(sanitized.YARN_CACHE_FOLDER).toBeUndefined()
  })

  it('extends managed npm tls fallback coverage to plugin-install and weixin-installer npx commands', () => {
    const tlsFailureResult = {
      ok: false,
      stdout: '',
      stderr: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      code: 1,
    }

    expect(shouldRetryWithNpmTlsFallback('npx', tlsFailureResult, 'plugin-install')).toBe(true)
    expect(shouldRetryWithNpmTlsFallback('npx.cmd', tlsFailureResult, 'weixin-installer')).toBe(true)
  })

  it('does not apply npm tls fallback to non-managed domains or non-npm commands', () => {
    const tlsFailureResult = {
      ok: false,
      stdout: '',
      stderr: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      code: 1,
    }

    expect(shouldRetryWithNpmTlsFallback('npx', tlsFailureResult, 'gateway')).toBe(false)
    expect(shouldRetryWithNpmTlsFallback('brew', tlsFailureResult, 'plugin-install')).toBe(false)
  })
})
