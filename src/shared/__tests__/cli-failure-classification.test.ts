import { describe, expect, it } from 'vitest'

import {
  buildCliFailureClassificationCorpus,
  classifySharedCliFailure,
  normalizeCliFailureClassificationInput,
} from '../cli-failure-classification'

describe('cli-failure-classification', () => {
  it('normalizes ansi and non-printable control sequences before classification', () => {
    expect(
      normalizeCliFailureClassificationInput(
        '\u001b[31mpermission denied\u001b[0m\u0007\r\nGateway did not become reachable'
      )
    ).toBe('permission denied\nGateway did not become reachable')
  })

  it('builds a trimmed combined corpus from stderr/stdout-like inputs', () => {
    expect(buildCliFailureClassificationCorpus(' permission denied ', '', ' timed out ')).toBe(
      'permission denied\ntimed out'
    )
  })

  it.each([
    ['invalid api key', 'api_invalid'],
    ['permission denied: failed to write', 'write_failure'],
    ['Gateway did not become reachable at ws://127.0.0.1:18789.', 'gateway_unready'],
    ['token mismatch', 'gateway_unready'],
    ['fetch failed via proxy timeout', 'network_blocked'],
  ] as const)('classifies %s as %s', (corpus, expected) => {
    expect(classifySharedCliFailure(corpus)).toBe(expected)
  })

  it('treats token mismatch as gateway-unready even when mixed with other local gateway signals', () => {
    expect(classifySharedCliFailure('token mismatch\nconnection refused')).toBe('gateway_unready')
  })
})
