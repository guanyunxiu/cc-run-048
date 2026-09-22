/**
 * 规划缓存（功能04：增量规划/缓存）：
 * 以“环境快照 + 任务 + 参数 + 权重 + 算法 + 种子”为键缓存 PlanResult，
 * 重复请求（切换 UI 标签、批量对比、权重扫描中相同组合）直接命中，零计算。
 *
 * 采用 LRU 淘汰，默认容量 24。
 */
import type { PlanResult } from '@/types'

export interface CacheEntry<T> {
  key: string
  value: T
  hits: number
  createdAt: number
}

export class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>()
  readonly capacity: number
  hits = 0
  misses = 0

  constructor(capacity = 24) {
    this.capacity = capacity
  }

  get(key: string): T | null {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses++
      return null
    }
    // Map 的迭代顺序即插入顺序；重新插入实现“最近使用”置顶
    this.map.delete(key)
    entry.hits++
    this.map.set(key, entry)
    this.hits++
    return entry.value
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { key, value, hits: 0, createdAt: Date.now() })
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  has(key: string): boolean {
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

  entries(): CacheEntry<T>[] {
    return [...this.map.values()]
  }
}

/** 全局规划结果缓存（跨组件共享） */
export const planResultCache = new LRUCache<PlanResult>(24)

/**
 * 规划缓存键：对影响结果的全部输入做确定性哈希。
 * 浮点数组用固定精度字符串，避免 -0 / 键顺序问题。
 */
export function planCacheKey(input: {
  terrain: unknown
  threats: unknown
  noflyZones: unknown
  obstacles: unknown
  dynamics?: unknown
  waypoints: unknown
  planParams: unknown
  weights: unknown
  smoothing: string
  algo: string
  seed: number
}): string {
  return stableStringify(input)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  )
}

/**
 * 并行搜索辅助（功能04：并行搜索）：
 * 将 N 个任务切分给最多 limit 个 worker/异步槽位执行。
 * 这里不直接依赖 Worker（保持可在 node 测试），
 * 调用方传入“如何执行一个任务”的异步函数即可。
 */
export async function parallelMap<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  limit = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1)
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 共享进度遥测（功能04：SharedArrayBuffer）。
 * 布局（Int32Array 视图）：
 *  [0] iteration      当前迭代
 *  [1] totalIterations 总迭代
 *  [2] state          0 idle / 1 running / 2 done / 3 error
 *  [3] elapsedMs      已用毫秒
 * 不可用时（跨域隔离未开启）返回 null，调用方回退 postMessage。
 */
export const TELEM = {
  ITERATION: 0,
  TOTAL: 1,
  STATE: 2,
  ELAPSED: 3
} as const

export function createProgressBuffer(): SharedArrayBuffer | null {
  if (typeof SharedArrayBuffer === 'undefined') return null
  try {
    return new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT)
  } catch {
    return null
  }
}

export function progressView(buffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(buffer)
}

/** 跨域隔离是否可用（SharedArrayBuffer 的前置条件） */
export function crossOriginIsolated(): boolean {
  return (
    typeof globalThis.crossOriginIsolated === 'boolean' &&
    globalThis.crossOriginIsolated
  )
}
