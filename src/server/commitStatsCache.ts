import type { CommitStats } from '../shared/types.js'

/** Process-local bounded LRU, isolated by canonical repository root. */
export class CommitStatsCache<T = CommitStats> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly capacity = 5000) {}

  get(root: string, oid: string): T | undefined {
    const key = `${root}\x00${oid}`
    const stats = this.entries.get(key)
    if (stats !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, stats)
    }
    return stats
  }

  set(root: string, oid: string, stats: T): void {
    const key = `${root}\x00${oid}`
    this.entries.delete(key)
    this.entries.set(key, stats)
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }
}
