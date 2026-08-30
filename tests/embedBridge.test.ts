import { describe, expect, it } from 'vitest'

import { isAllowedEmbedParentOrigin } from '../src/client/embedBridge'

describe('Diff Review embed bridge', () => {
  it('accepts only HTTP loopback parent origins', () => {
    expect(isAllowedEmbedParentOrigin('http://127.0.0.1:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('http://localhost:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('http://[::1]:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('https://127.0.0.1:4899')).toBe(false)
    expect(isAllowedEmbedParentOrigin('http://example.test:4899')).toBe(false)
    expect(isAllowedEmbedParentOrigin('not an origin')).toBe(false)
  })
})
