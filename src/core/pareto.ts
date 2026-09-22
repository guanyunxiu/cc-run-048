import type {
  AlgoType,
  CostWeights,
  ObjectiveKey,
  ObjectiveVector,
  ParetoPoint,
  PlanParams,
  SensitivityPoint,
  SmoothingType,
  Vec3,
  Waypoint
} from '@/types'
import type { Environment } from './environment'
import { OBJECTIVE_KEYS, pathObjectives } from './cost'
import { planMission } from './planning'
import { Random } from './rng'

/**
 * Pareto 多目标优化（迭代三功能01）。
 * - 非支配排序（NSGA-II 风格，返回前沿层级与拥挤距离）
 * - 权重扫描：在归一化权重单纯形上采样，用同一规划器生成折中解集
 * - 权重敏感性：固定其他权重、扫描单一权重
 */

/** 判断 a 是否支配 b（目标均越小越优；相等不算支配） */
export function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
  let strictlyBetter = false
  for (const k of OBJECTIVE_KEYS) {
    if (a[k] > b[k] + 1e-12) return false
    if (a[k] < b[k] - 1e-12) strictlyBetter = true
  }
  return strictlyBetter
}

/**
 * 非支配排序：为每个点写入 rank（0 为第一前沿）与同层拥挤距离。
 * 返回按前沿层级排序后的点数组（输入不会被修改顺序要求）。
 */
export function nonDominatedSort(points: ParetoPoint[]): ParetoPoint[] {
  const n = points.length
  const dominatedBy: number[][] = Array.from({ length: n }, () => [])
  const domCount = new Array<number>(n).fill(0)
  const ranks = new Array<number>(n).fill(-1)

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (dominates(points[i].objectives, points[j].objectives)) {
        dominatedBy[i].push(j)
      } else if (dominates(points[j].objectives, points[i].objectives)) {
        domCount[i]++
      }
    }
  }

  let front: number[] = []
  for (let i = 0; i < n; i++) if (domCount[i] === 0) front.push(i)
  let rank = 0
  while (front.length > 0) {
    const next: number[] = []
    for (const i of front) {
      ranks[i] = rank
      for (const j of dominatedBy[i]) {
        domCount[j]--
        if (domCount[j] === 0) next.push(j)
      }
    }
    rank++
    front = next
  }

  // 拥挤距离（同层内按各目标极值间距之和）
  const crowding = new Array<number>(n).fill(0)
  for (let r = 0; r < rank; r++) {
    const members = []
    for (let i = 0; i < n; i++) if (ranks[i] === r) members.push(i)
    if (members.length <= 2) {
      for (const i of members) crowding[i] = Infinity
      continue
    }
    for (const k of OBJECTIVE_KEYS) {
      const sorted = [...members].sort((a, b) =>
        points[a].objectives[k] - points[b].objectives[k]
      )
      crowding[sorted[0]] = Infinity
      crowding[sorted[sorted.length - 1]] = Infinity
      const min = points[sorted[0]].objectives[k]
      const max = points[sorted[sorted.length - 1]].objectives[k]
      const span = max - min
      if (span <= 1e-12) continue
      for (let m = 1; m < sorted.length - 1; m++) {
        if (crowding[sorted[m]] === Infinity) continue
        crowding[sorted[m]] +=
          (points[sorted[m + 1]].objectives[k] -
            points[sorted[m - 1]].objectives[k]) /
          span
      }
    }
  }

  return points
    .map((p, i) => ({
      ...p,
      rank: ranks[i] < 0 ? rank : ranks[i],
      crowdingDistance: crowding[i]
    }))
    .sort((a, b) => (a.rank! - b.rank!) || (b.crowdingDistance! - a.crowdingDistance!))
}

/** 仅取第一前沿（Pareto 最优集） */
export function paretoFront(points: ParetoPoint[]): ParetoPoint[] {
  const sorted = nonDominatedSort(points)
  return sorted.filter((p) => p.rank === 0)
}

/**
 * 从成功解中构造 ParetoPoint（失败解不参与前沿）。
 */
function toParetoPoint(
  objectives: ObjectiveVector,
  weights: CostWeights,
  weightedCost: number,
  algo: AlgoType,
  success: boolean,
  path?: Vec3[]
): ParetoPoint {
  return { objectives, weights, weightedCost, algo, success, path }
}

export interface WeightScanOptions {
  /** 采样的权重组合数量（沿若干偏好方向） */
  samples?: number
  /** 参与扫描的目标维（其余维度权重保持基准值） */
  keys?: ObjectiveKey[]
  /** 随机种子基数 */
  seed?: number
  /** 是否在结果中携带航迹（前端点击前沿点展示） */
  keepPath?: boolean
}

/** 经典偏好预设：在权重单纯形上覆盖航程/威胁/能耗/平滑等折中方向 */
export const PARETO_WEIGHT_PRESETS: { name: string; scale: Partial<Record<ObjectiveKey, number>> }[] = [
  { name: '均衡', scale: { distance: 1, threat: 25, altitude: 8, nofly: 60, smooth: 0.15, energy: 1.5, dynamics: 3 } },
  { name: '最短航程', scale: { distance: 6, threat: 4, altitude: 2, nofly: 20, smooth: 0.05, energy: 0.5, dynamics: 1 } },
  { name: '低威胁', scale: { distance: 0.6, threat: 90, altitude: 6, nofly: 120, smooth: 0.1, energy: 1, dynamics: 2 } },
  { name: '低能耗', scale: { distance: 1.4, threat: 10, altitude: 4, nofly: 30, smooth: 0.2, energy: 8, dynamics: 2 } },
  { name: '高平滑', scale: { distance: 0.8, threat: 18, altitude: 4, nofly: 40, smooth: 1.2, energy: 1, dynamics: 10 } },
  { name: '贴巡航高度', scale: { distance: 0.8, threat: 18, altitude: 40, nofly: 40, smooth: 0.15, energy: 1.2, dynamics: 3 } },
  { name: '规避禁飞', scale: { distance: 0.7, threat: 20, altitude: 6, nofly: 200, smooth: 0.1, energy: 1, dynamics: 2 } },
  { name: '机动优先', scale: { distance: 0.8, threat: 20, altitude: 4, nofly: 50, smooth: 0.6, energy: 1, dynamics: 16 } }
]

/**
 * 权重扫描生成 Pareto 折中解集（功能01）。
 * 使用偏好预设 + 在单纯形上的随机权重组合，对每组权重重新规划，
 * 成功解经非支配排序后返回（默认仅返回第一前沿，含全部排序结果可选）。
 */
export function scanWeightedPareto(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  baseWeights: CostWeights,
  algo: AlgoType,
  smoothing: SmoothingType,
  options: WeightScanOptions = {}
): { front: ParetoPoint[]; all: ParetoPoint[] } {
  const samples = options.samples ?? 24
  const seed = options.seed ?? 20260920
  const rng = new Random(seed)

  // 生成权重组合：预设方向 + 随机 Dirichlet 采样
  const combos: CostWeights[] = PARETO_WEIGHT_PRESETS.map((p) => ({
    ...baseWeights,
    ...p.scale
  }))
  const keys = options.keys ?? (['distance', 'threat', 'altitude', 'energy', 'smooth', 'dynamics'] as ObjectiveKey[])
  while (combos.length < samples) {
    const w: CostWeights = { ...baseWeights }
    // 抽 2~4 个维度做随机强调
    const k = 2 + Math.floor(rng.next() * 3)
    const chosen = [...keys].sort(() => rng.next() - 0.5).slice(0, k)
    for (const key of chosen) {
      const base = baseWeights[key] || 1
      w[key] = base * (0.2 + rng.next() * 6)
    }
    combos.push(w)
  }

  const points: ParetoPoint[] = []
  const seen = new Set<string>()
  combos.forEach((weights, idx) => {
    const result = planMission(env, waypoints, plan, weights, {
      smoothing,
      algoOverride: algo,
      seed: seed + idx * 13
    })
    if (!result.success || !result.stats.objectives) return
    const objs = result.stats.objectives
    // 去重：目标向量近似相同的点只保留一个
    const sig = OBJECTIVE_KEYS.map((k) => objs[k].toFixed(1)).join('|')
    if (seen.has(sig)) return
    seen.add(sig)
    points.push(
      toParetoPoint(
        objs,
        weights,
        result.stats.totalCost,
        algo,
        true,
        options.keepPath ? result.smoothPath : undefined
      )
    )
  })

  const all = nonDominatedSort(points)
  return { front: all.filter((p) => p.rank === 0), all }
}

/**
 * 多算法 Pareto：各算法在基准权重下的成功解合并后做非支配排序。
 */
export function multiAlgoPareto(
  entries: {
    algo: AlgoType
    success: boolean
    objectives?: ObjectiveVector
    totalCost: number
    weights: CostWeights
    path?: Vec3[]
  }[]
): ParetoPoint[] {
  const points = entries
    .filter((e) => e.success && e.objectives)
    .map((e) =>
      toParetoPoint(e.objectives!, e.weights, e.totalCost, e.algo, true, e.path)
    )
  return nonDominatedSort(points)
}

/**
 * 权重敏感性分析（功能01）：
 * 固定其余权重为基准值，在 [minScale, maxScale] 区间扫描单一权重，
 * 重新规划并记录各目标原始值随权重的变化。
 */
export function weightSensitivity(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  baseWeights: CostWeights,
  algo: AlgoType,
  smoothing: SmoothingType,
  key: ObjectiveKey,
  steps = 9,
  minScale = 0,
  maxScale = 4,
  seed = 20260920
): SensitivityPoint[] {
  const base = baseWeights[key] || 1
  const out: SensitivityPoint[] = []
  for (let i = 0; i < steps; i++) {
    const scale = minScale + ((maxScale - minScale) * i) / Math.max(1, steps - 1)
    const weights = { ...baseWeights, [key]: base * scale }
    const result = planMission(env, waypoints, plan, weights, {
      smoothing,
      algoOverride: algo,
      seed
    })
    out.push({
      key,
      weight: weights[key],
      objectives: result.stats.objectives ?? {
        distance: 0, threat: 0, altitude: 0, nofly: 0, smooth: 0, energy: 0, dynamics: 0
      },
      totalCost: result.stats.totalCost,
      algo,
      success: result.success
    })
  }
  return out
}
