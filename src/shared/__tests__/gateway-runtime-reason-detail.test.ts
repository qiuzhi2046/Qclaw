import { describe, expect, it } from 'vitest'
import {
  describeGatewayRuntimeReasonDetail,
  sanitizeGatewayRuntimeReasonDetail,
} from '../gateway-runtime-reason-detail'

describe('describeGatewayRuntimeReasonDetail', () => {
  it('returns access denied message for service-install source', () => {
    const result = describeGatewayRuntimeReasonDetail({
      source: 'service-install',
      code: 'access_denied',
      message: '创建 Windows 计划任务被拒绝，需要管理员权限',
    })
    expect(result).toContain('管理员权限')
  })

  it('returns fallback message for unknown service-install code', () => {
    const result = describeGatewayRuntimeReasonDetail({
      source: 'service-install',
      code: 'unknown_error',
      message: '未知安装错误',
    })
    expect(result).toBe('未知安装错误')
  })

  it('returns control-ui-app detail for device_token_mismatch', () => {
    const result = describeGatewayRuntimeReasonDetail({
      source: 'control-ui-app',
      code: 'device_token_mismatch',
      message: 'device token mismatch',
    })
    expect(result).toContain('device token')
  })

  it('returns null for null input', () => {
    expect(describeGatewayRuntimeReasonDetail(null)).toBeNull()
  })
})

describe('sanitizeGatewayRuntimeReasonDetail', () => {
  it('accepts service-install source', () => {
    const result = sanitizeGatewayRuntimeReasonDetail({
      source: 'service-install',
      code: 'access_denied',
      message: '创建 Windows 计划任务被拒绝，需要管理员权限',
    })
    expect(result).toMatchObject({
      source: 'service-install',
      code: 'access_denied',
    })
  })

  it('accepts control-ui-app source', () => {
    const result = sanitizeGatewayRuntimeReasonDetail({
      source: 'control-ui-app',
      code: 'device_token_mismatch',
      message: 'device token mismatch',
    })
    expect(result).toMatchObject({
      source: 'control-ui-app',
      code: 'device_token_mismatch',
    })
  })

  it('rejects unknown source', () => {
    const result = sanitizeGatewayRuntimeReasonDetail({
      source: 'bogus',
      code: 'test',
      message: 'test',
    })
    expect(result).toBeNull()
  })

  it('rejects null input', () => {
    expect(sanitizeGatewayRuntimeReasonDetail(null)).toBeNull()
  })

  it('rejects missing code', () => {
    const result = sanitizeGatewayRuntimeReasonDetail({
      source: 'service-install',
      code: '',
      message: 'test',
    })
    expect(result).toBeNull()
  })
})
