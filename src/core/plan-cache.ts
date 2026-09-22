/**
 * 规划结果缓存（迭代三功能04：缓存/增量规划）。
 * 键 = 场景与规划参数的规范化哈希，值 = PlanResult。
 * LRU 淘汰 + 命中计数，供 UI 显示命中率。
 */
export class PlanCache<K, V> {
  private map = new Map<K, V>()
  private hits = 0
  private misses = 0

  constructor(private capacity = 8) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) {
      this.misses++
      return undefined
    }
    this.hits++
    // LRU：重新插入刷新顺序
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
    this.hits = 0
    this.misses = 0
  }

  get size(): number {
    return this.map.size
  }

  get stats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.map.size
    }
  }
}

/**
 * 规划缓存键：对发送给规划器的请求参数做稳定序列化。
 * 字段顺序固定，数值直接入串（同参数同键）。
 */
export function planCacheKey(input: unknown): string {
  return stableStringify(input)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
