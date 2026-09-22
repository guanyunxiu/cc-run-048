/**
 * 确定性伪随机数（mulberry32）：
 * RRT / 蚁群 / 粒子群 / 遗传等随机算法用它保证结果可复现、可测试。
 */
export class Random {
  private state: number

  constructor(seed = 1) {
    // 避免 seed=0 退化
    this.state = seed >>> 0 || 0x9e3779b9
  }

  /** [0,1) 均匀分布 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** [min,max) 均匀分布 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** 整数 [min,max] */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** 按离散权重抽取索引 */
  weightedIndex(weights: number[]): number {
    let sum = 0
    for (const w of weights) sum += Math.max(0, w)
    if (sum <= 1e-12) return this.int(0, weights.length - 1)
    let r = this.next() * sum
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i])
      if (r <= 0) return i
    }
    return weights.length - 1
  }

  /** 标准正态近似（Box-Muller） */
  gaussian(): number {
    const u = Math.max(this.next(), 1e-12)
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** 默认随机源（固定种子，保证刷新后演示一致） */
let globalSeed = 20260920
export function defaultRandom(): Random {
  return new Random(globalSeed)
}
export function setGlobalSeed(seed: number): void {
  globalSeed = seed >>> 0
}
