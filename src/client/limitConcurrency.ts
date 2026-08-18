export function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []

  return function limitRun<T>(run: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1
        run().then(resolve, reject).finally(() => {
          active -= 1
          waiting.shift()?.()
        })
      }
      if (active < limit) start()
      else waiting.push(start)
    })
  }
}

/** Keep heavy file bodies from filling the 6 HTTP/1.1 sockets per origin. */
export const limitHeavyRequest = createLimiter(2)
