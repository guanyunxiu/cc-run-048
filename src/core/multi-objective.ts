import type {
  AlgoType,
  CostWeights,
  ObjectiveVector,
  ParetoPoint,
  PlanParams,
  SensitivityPoint,
  SensitivityResult,
  SmoothingType,
  Vec3,
  Waypoint
} from '@/types'
import type { Environment } from './environment'
import { evaluatePath } from './cost'
import { planMission } from './planning'

/**
 * 多目标优化（功能01）：
 * - 七维目标向量（航程/威胁/高度/禁飞/平滑/能耗/动力学）
 * - 权重扫描生成候选解，Pareto 非支配排序提取前沿
 * - 单轴权重敏感性分析
 */

export const OBJECTIVE_KEYS: (keyof ObjectiveVector)[] = [
  'distance',
  'threat',
  'altitude',
  'nofly',
  'smooth',
  'energy',
  'dynamics'
]

export const OBJECTIVE_LABELS: Record<keyof ObjectiveVector, string> = {
  distance: '航程',
  threat: '威胁暴露',
  altitude: '高度偏差',
  nofly: '禁飞惩罚',
  smooth: '平滑度',
  energy: '能耗',
  dynamics: '动力学违反'
}

/** 归一化目标向量（用于拥挤距离），bounds 为各维 min/max */
export function normalizeObjective(
  o: ObjectiveVector,
  bounds: { min: ObjectiveVector; max: ObjectiveVector }
): ObjectiveVector {
  const out = {} as ObjectiveVector
  for (const k of OBJECTIVE_KEYS) {
    const span = Math.max(bounds.max[k] - bounds.min[k], 1e-9)
    out[k] = (o[k] - bounds.min[k]) / span
  }
  return out
}

/** a 是否支配 b（a 在所有维度不差且至少一维严格更优，全部按最小化） */
export function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
  let strictlyBetter = false
  for (const k of OBJECTIVE_KEYS) {
    if (a[k] > b[k] + 1e-12) return false // a 在某维更差
    if (a[k] < b[k] - 1e-12) strictlyBetter = true
  }
  return strictlyBetter
}

/** 非支配排序：标记每个解是否被支配 */
export function markParetoFront(points: ParetoPoint[]): ParetoPoint[] {
  for (let i = 0; i < points.length; i++) {
    points[i].dominated = false
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue
      // j 支配 i
      if (dominates(points[j].objectives, points[i].objectives)) {
        points[i].dominated = true
        break
      }
    }
  }
  return points
}

export function paretoFront(points: ParetoPoint[]): ParetoPoint[] {
  return markParetoFront(points).filter((p) => !p.dominated)
}

/**
 * NSGA-II 风格拥挤距离（在指定目标轴上），
 * 用于在三维散点图中挑选标注点/限定前沿显示数量。
 */
export function crowdingDistance(
  front: ParetoPoint[],
  axes: (keyof ObjectiveVector)[]
): number[] {
  const n = front.length
  const dist = new Array<number>(n).fill(0)
  if (n <= 2) return dist.fill(Infinity)
  for (const axis of axes) {
    const order = front
      .map((p, i) => ({ i, v: p.objectives[axis] }))
      .sort((a, b) => a.v - b.v)
    dist[order[0].i] = Infinity
    dist[order[n - 1].i] = Infinity
    const span = order[n - 1].v - order[0].v || 1
    for (let k = 1; k < n - 1; k++) {
      dist[order[k].i] += (order[k + 1].v - order[k - 1].v) / span
    }
  }
  return dist
}

export interface ParetoScanOptions {
  /** 扫描的权重组合（缺省为内置多策略组合） */
  weightSets?: CostWeights[]
  /** 是否包含基准权重 */
  baselineWeights?: CostWeights
  algo?: AlgoType
  smoothing: SmoothingType
  seed?: number
  /** 进度回调（已完成/总数） */
  onProgress?: (done: number, total: number) => void
}

/**
 * 权重扫描：对每组权重跑一次完整规划，收集七维目标向量，
 * 返回带 Pareto 支配标记的全部候选点。
 */
export function paretoWeightScan(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  options: ParetoScanOptions
): ParetoPoint[] {
  const algo = options.algo ?? plan.algo
  const sets = options.weightSets ?? defaultWeightSets(options.baselineWeights)
  const points: ParetoPoint[] = []
  let done = 0

  for (const weights of sets) {
    const result = planMission(env, waypoints, plan, weights, {
      smoothing: options.smoothing,
      algoOverride: options.algo,
      seed: options.seed ?? 20260920
    })
    if (result.success && result.smoothPath.length >= 2) {
      const evalRes = evaluatePath(env, result.smoothPath, weights, plan)
      points.push({
        objectives: evalRes.objectives,
        weights,
        path: result.smoothPath,
        algo,
        scalarCost: evalRes.total,
        dominated: false
      })
    }
    done++
    options.onProgress?.(done, sets.length)
  }
  return markParetoFront(points)
}

/**
 * 内置权重组合：以基准权重为中心，沿各目标轴放大/缩小，
 * 覆盖“最短路 / 最安全 / 最省油 / 最平缓 / 最守规矩”等典型策略。
 */
export function defaultWeightSets(baseline?: CostWeights): CostWeights[] {
  const b = baseline ?? {
    distance: 1,
    threat: 25,
    altitude: 8,
    nofly: 60,
    smooth: 0.15,
    energy: 30,
    dynamics: 40
  }
  const clone = (patch: Partial<CostWeights>): CostWeights => ({ ...b, ...patch })
  return [
    { ...b }, // 均衡
    clone({ distance: 6, threat: 5, energy: 5, dynamics: 10 }), // 最短路
    clone({ distance: 0.5, threat: 120, nofly: 200 }), // 最安全
    clone({ distance: 0.8, threat: 10, energy: 160, altitude: 3 }), // 最省油
    clone({ smooth: 2.5, dynamics: 200 }), // 最平缓/动力学优先
    clone({ altitude: 50, energy: 80 }), // 高空省油
    clone({ threat: 60, energy: 70 }), // 安全-省油折中
    clone({ distance: 3, dynamics: 120 }), // 航程-动力学折中
    clone({ threat: 90, smooth: 1 }), // 威胁-平滑折中
    clone({ nofly: 300, threat: 40 }), // 强禁飞
    clone({ distance: 2, threat: 30, energy: 90, dynamics: 80 }), // 工程实用
    clone({ distance: 4, threat: 15, altitude: 20, energy: 40, dynamics: 30 }) // 快速突防
  ]
}

/**
 * 权重敏感性分析（功能01）：
 * 单轴权重在 [min,max] 上取 steps 个值，其余权重固定，
 * 逐次规划并记录七维目标，得到该轴的权衡曲线。
 */
export function weightSensitivity(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  baseWeights: CostWeights,
  axis: keyof CostWeights,
  values: number[],
  smoothing: SmoothingType,
  algo?: AlgoType,
  seed = 20260920
): SensitivityResult {
  const points: SensitivityPoint[] = []
  for (const weight of values) {
    const weights = { ...baseWeights, [axis]: weight }
    const result = planMission(env, waypoints, plan, weights, {
      smoothing,
      algoOverride: algo,
      seed
    })
    if (result.success && result.smoothPath.length >= 2) {
      const evalRes = evaluatePath(env, result.smoothPath, weights, plan)
      points.push({
        axis,
        weight,
        objectives: evalRes.objectives,
        scalarCost: evalRes.total,
        success: true
      })
    } else {
      points.push({
        axis,
        weight,
        objectives: {
          distance: 0,
          threat: 0,
          altitude: 0,
          nofly: 0,
          smooth: 0,
          energy: 0,
          dynamics: 0
        },
        scalarCost: 0,
        success: false
      })
    }
  }
  return { axis, points }
}

/** 计算一组 ParetoPoint 的目标边界 */
export function objectiveBounds(points: ParetoPoint[]): {
  min: ObjectiveVector
  max: ObjectiveVector
} {
  const min = {
    distance: Infinity,
    threat: Infinity,
    altitude: Infinity,
    nofly: Infinity,
    smooth: Infinity,
    energy: Infinity,
    dynamics: Infinity
  }
  const max = {
    distance: -Infinity,
    threat: -Infinity,
    altitude: -Infinity,
    nofly: -Infinity,
    smooth: -Infinity,
    energy: -Infinity,
    dynamics: -Infinity
  }
  for (const p of points) {
    for (const k of OBJECTIVE_KEYS) {
      min[k] = Math.min(min[k], p.objectives[k])
      max[k] = Math.max(max[k], p.objectives[k])
    }
  }
  if (!points.length) {
    for (const k of OBJECTIVE_KEYS) {
      min[k] = 0
      max[k] = 1
    }
  }
  return { min, max }
}

/** 在二维目标平面上做 Pareto 前沿散点（供 2D 图） */
export function selectAxes(
  preferred?: (keyof ObjectiveVector)[]
): { x: keyof ObjectiveVector; y: keyof ObjectiveVector; z?: keyof ObjectiveVector } {
  const axes = preferred ?? ['distance', 'threat', 'energy']
  return {
    x: axes[0] ?? 'distance',
    y: axes[1] ?? 'threat',
    z: axes[2] ?? 'energy'
  }
}

/** 由一条航迹直接构造 ParetoPoint（用于把当前解叠加到前沿图上） */
export function makeParetoPoint(
  env: Environment,
  path: Vec3[],
  plan: PlanParams,
  weights: CostWeights,
  algo: AlgoType
): ParetoPoint | null {
  if (path.length < 2) return null
  const evalRes = evaluatePath(env, path, weights, plan)
  return {
    objectives: evalRes.objectives,
    weights,
    path,
    algo,
    scalarCost: evalRes.total,
    dominated: false
  }
}
