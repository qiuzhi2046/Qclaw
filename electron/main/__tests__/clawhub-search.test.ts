import { describe, expect, it } from 'vitest'

import { parseClawHubSearchResults } from '../clawhub-search'

describe('parseClawHubSearchResults', () => {
  it('parses current clawhub CLI output that includes a version token after the slug', () => {
    const stdout = [
      '- Searching',
      'self-improver v3.2.1  Self Improving Agent  (66.021)',
      'self-improvement v1.0.0  Self Improvement  (43.979)',
    ].join('\n')

    expect(parseClawHubSearchResults(stdout)).toEqual([
      { slug: 'self-improver', name: 'Self Improving Agent', score: 66.021 },
      { slug: 'self-improvement', name: 'Self Improvement', score: 43.979 },
    ])
  })

  it('keeps parsing legacy output without a version token', () => {
    const stdout = 'multi-search-engine  Multi search engine integration with 16 engines  (89.5)'

    expect(parseClawHubSearchResults(stdout)).toEqual([
      {
        slug: 'multi-search-engine',
        name: 'Multi search engine integration with 16 engines',
        score: 89.5,
      },
    ])
  })
})
