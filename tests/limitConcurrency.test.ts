import { describe, expect, test } from 'vitest'

import { createLimiter } from '../src/client/limitConcurrency.js'

describe('createLimiter', () => {
  test('never runs more than the limit at once', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0

    await Promise.all(Array.from({ length: 6 }, (_, index) => limit(async () => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return index
    })))

    expect(peak).toBe(2)
  })
})
