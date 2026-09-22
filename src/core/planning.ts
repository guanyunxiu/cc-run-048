import type {
  AlgoType,
  CostWeights,
  PlanLegResult,
  PlanParams,
  PlanResult,
  PlanningStats,
  SmoothingType,
  Vec3,
  Waypoint
} from '@/types'
import type { Environment } from './environment'
import { Random } from './rng'
import { createPlanner } from './planners/registry'
import type { PlannerContext } from './planners/types'
import {
  densify,
  pathDistance,
  smoothBezier,
  smoothBSpline,
  smoothClothoid,
  smoothDubins,
  smoothPolynomial,
  smoothPolyline
} from './smoothing'
import { cumulativeCostCurve, evaluatePath, zeroObjectives, zeroWeights } from './cost'
import {
  checkPathConstraints,
  repairPathDynamics
} from './dynamics'
import { evaluateMetrics } from './metrics'
import { planTrajectory } from './smoothing'

/** 威胁暴露判定阈值（暴露强度高于此值视为处于威胁中） */
export const EXPOSURE_THRESHOLD = 0.15

export interface PlanOptions {
  smoothing: SmoothingType
  /** 指定算法（覆盖 plan.algo），用于多算法对比 */
  algoOverride?: AlgoType
  /** 随机算法种子 */
  seed?: number
}

/** 根据选择应用平滑算法（功能04：可插拔平滑） */
export function applySmoothing(
  env: Environment,
  rawPath: Vec3[],
  plan: PlanParams,
  smoothing: SmoothingType
): Vec3[] {
  if (rawPath.length < 3) return rawPath.map((p) => ({ ...p }))
  switch (smoothing) {
    case 'polyline':
      return smoothPolyline(env, rawPath, plan.smoothIterations, plan.clearance)
    case 'bspline':
    case 'bezier':
    case 'polynomial': {
      // 高阶曲线先做碰撞感知折线松弛，使控制点多边形角度温和，
      // 避免曲线在尖角处产生过大曲率（最小转弯半径约束）
      const relaxed = smoothPolyline(
        env,
        rawPath,
        Math.max(plan.smoothIterations, 10),
        plan.clearance,
        0.4
      )
      if (smoothing === 'bspline') return smoothBSpline(env, relaxed, plan.clearance)
      if (smoothing === 'bezier') return smoothBezier(env, relaxed, plan.clearance)
      return smoothPolynomial(env, relaxed, plan.clearance)
    }
    case 'dubins':
      return smoothDubins(
        env,
        rawPath,
        plan.clearance,
        Math.max(plan.dynamics.minTurnRadius, 30)
      )
    case 'clothoid':
      return smoothClothoid(
        env,
        rawPath,
        plan.clearance,
        Math.max(plan.dynamics.minTurnRadius, 30)
      )
    case 'none':
    default:
      return rawPath
  }
}

/**
 * 单无人机多航点全局规划：
 * 依次规划 start -> via... -> end 各航段，合并后统一平滑并统计。
 */
export function planMission(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  weights: CostWeights,
  options: PlanOptions
): PlanResult {
  const t0 = performance.now()
  const ordered = [...waypoints].sort((a, b) => {
    const rank = (r: Waypoint['role']) =>
      r === 'start' ? 0 : r === 'end' ? 2 : 1
    return rank(a.role) - rank(b.role)
  })

  if (ordered.length < 2) {
    return failResult('至少需要起点和终点', 0)
  }

  const algo = options.algoOverride ?? plan.algo
  const ctx: PlannerContext = {
    env,
    plan,
    weights,
    rng: new Random(options.seed ?? 20260920)
  }

  let totalExpanded = 0
  const rawPath: Vec3[] = []
  const legs: PlanLegResult[] = []
  let allOk = true
  let lastMessage = '规划成功'
  const candidates = []
  /** 迭代三：收集随机算法收敛曲线（各航段代数偏移拼接） */
  const convergence: NonNullable<PlanResult['stats']['convergence']> = []

  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i].position
    const b = ordered[i + 1].position
    const planner = createPlanner(algo, ctx, (options.seed ?? 20260920) + i * 101)
    const res = planner.plan(a, b)
    totalExpanded += res.expandedNodes

    const leg: PlanLegResult = {
      legIndex: i,
      points: res.path,
      success: res.success,
      expandedNodes: res.expandedNodes,
      costBreakdown: {
        distance: 0,
        threat: 0,
        altitude: 0,
        nofly: 0,
        smooth: 0,
        energy: 0,
        dynamics: 0
      },
      cumulativeCost: 0
    }
    legs.push(leg)

    if (res.candidates && res.candidates.length > 0) {
      candidates.push(...res.candidates.slice(0, 30))
    }

    // 收敛曲线：各航段按代数偏移拼接（多航段时仍可连续展示）
    if (res.convergence && res.convergence.length > 0) {
      const offset = convergence.length
      for (const cp of res.convergence) {
        convergence.push({ ...cp, iteration: cp.iteration + offset })
      }
    }

    if (!res.success) {
      allOk = false
      lastMessage = `航段 ${i + 1} 规划失败：${res.message}`
      // 失败航段用直线连接，便于观察失败位置
      if (rawPath.length === 0) rawPath.push({ ...a })
      rawPath.push({ ...b })
      continue
    }

    const seg = res.path
    for (let k = 0; k < seg.length; k++) {
      if (i > 0 && k === 0) continue // 合并重复连接点
      rawPath.push(seg[k])
    }
  }

  // 平滑：逐航段进行再拼接。
  // 途经点是相邻航段的公共端点，各平滑方法都插值/保留端点，
  // 因此平滑后的航迹精确经过起点、途经点、终点；
  // 若对合并后的整条折线统一平滑，途经点只作为普通控制点会被曲线拉偏。
  let smoothPath: Vec3[] = rawPath
  if (allOk) {
    const merged: Vec3[] = []
    for (const leg of legs) {
      if (leg.points.length < 2) continue
      let pts = applySmoothing(env, leg.points, plan, options.smoothing)
      // 动力学自动修正（功能03），航段端点固定不动
      if (plan.dynamics.autoRepair) {
        pts = repairPathDynamics(env, pts, plan)
      }
      for (let k = 0; k < pts.length; k++) {
        if (merged.length > 0 && k === 0) continue // 合并重复连接点
        merged.push(pts[k])
      }
    }
    if (merged.length >= 2) smoothPath = merged
  }

  const planTimeMs = performance.now() - t0

  // 评估
  const dense = allOk ? densify(smoothPath, Math.max(plan.cellSize * 0.5, 4)) : []
  const stats = computeStats(
    env,
    rawPath,
    smoothPath,
    dense,
    weights,
    plan,
    options.smoothing,
    algo,
    allOk,
    totalExpanded,
    planTimeMs,
    ordered.length - 1,
    legs.filter((l) => l.success).length,
    convergence
  )

  return {
    success: allOk,
    rawPath,
    smoothPath,
    stats,
    legs,
    message: lastMessage,
    candidates: candidates.length > 0 ? candidates : undefined
  }
}

function computeStats(
  env: Environment,
  rawPath: Vec3[],
  path: Vec3[],
  dense: Vec3[],
  weights: CostWeights,
  plan: PlanParams,
  smoothing: SmoothingType,
  algo: AlgoType,
  allOk: boolean,
  expanded: number,
  planTimeMs: number,
  legCount: number,
  legsOk: number,
  convergence: NonNullable<PlanResult['stats']['convergence']>
): PlanningStats {
  const distance = pathDistance(path)
  const evalRes =
    path.length >= 2
      ? evaluatePath(env, path, weights, plan)
      : { total: 0, breakdown: zeroWeights(), objectives: zeroObjectives() }

  // 威胁暴露航程 / 时间（基于加密点）
  let exposedLength = 0
  let threatExposure = 0
  for (let i = 1; i < dense.length; i++) {
    const i0 = env.threatIntensity(dense[i - 1])
    const i1 = env.threatIntensity(dense[i])
    const d = Math.hypot(
      dense[i].x - dense[i - 1].x,
      dense[i].y - dense[i - 1].y,
      dense[i].z - dense[i - 1].z
    )
    threatExposure += ((i0 + i1) / 2) * d
    if ((i0 + i1) / 2 > EXPOSURE_THRESHOLD) exposedLength += d
  }
  const cruiseSpeed = (plan.speedMin + plan.speedMax) / 2
  const exposureTime = cruiseSpeed > 0 ? exposedLength / cruiseSpeed : 0

  // 避障成功率：航段成功率 × 加密点无碰撞率
  const legRate = legCount > 0 ? legsOk / legCount : 0
  let freeSamples = 0
  for (const p of dense) {
    if (!env.isBlocked(p, plan.clearance)) freeSamples++
  }
  const sampleRate = dense.length > 0 ? freeSamples / dense.length : 0
  const obstacleAvoidanceRate =
    allOk && dense.length > 0
      ? Math.round(legRate * sampleRate * 1000) / 10
      : Math.round(legRate * 1000) / 10

  // 动力学约束检查（功能03）
  const traj = allOk && path.length >= 2 ? planTrajectory(path, plan) : []
  const constraints =
    dense.length >= 2 ? checkPathConstraints(dense, plan.dynamics, traj) : undefined

  // 平滑前后指标（功能04）
  const rawMetrics =
    rawPath.length >= 2 ? evaluateMetrics(rawPath, plan) : undefined
  const smoothMetrics = path.length >= 2 ? evaluateMetrics(path, plan) : undefined

  return {
    distance: Math.round(distance * 10) / 10,
    threatExposure: Math.round(threatExposure * 100) / 100,
    exposureTime: Math.round(exposureTime * 10) / 10,
    planTimeMs: Math.round(planTimeMs * 100) / 100,
    expandedNodes: expanded,
    success: allOk,
    segments: Math.max(0, path.length - 1),
    obstacleAvoidanceRate,
    totalCost: Math.round(evalRes.total * 100) / 100,
    algo,
    smoothing,
    constraints,
    rawMetrics,
    smoothMetrics,
    energyKJ: Math.round(evalRes.objectives.energy * 100) / 100,
    smoothness:
      distance > 0
        ? Math.round((evalRes.objectives.smooth / distance) * 1e6) / 1e4
        : 0,
    objectives: {
      distance: Math.round(evalRes.objectives.distance * 100) / 100,
      threat: Math.round(evalRes.objectives.threat * 100) / 100,
      altitude: Math.round(evalRes.objectives.altitude * 100) / 100,
      nofly: Math.round(evalRes.objectives.nofly * 100) / 100,
      smooth: Math.round(evalRes.objectives.smooth * 1000) / 1000,
      energy: Math.round(evalRes.objectives.energy * 100) / 100,
      dynamics: Math.round(evalRes.objectives.dynamics * 1000) / 1000
    },
    convergence: convergence.length > 0 ? convergence : undefined,
    costBreakdown: {
      distance: Math.round(evalRes.breakdown.distance * 100) / 100,
      threat: Math.round(evalRes.breakdown.threat * 100) / 100,
      altitude: Math.round(evalRes.breakdown.altitude * 100) / 100,
      nofly: Math.round(evalRes.breakdown.nofly * 100) / 100,
      smooth: Math.round(evalRes.breakdown.smooth * 100) / 100,
      energy: Math.round(evalRes.breakdown.energy * 100) / 100,
      dynamics: Math.round(evalRes.breakdown.dynamics * 100) / 100
    }
  }
}

/** 代价曲线（供 UI 图表） */
export function getCostCurve(
  env: Environment,
  path: Vec3[],
  weights: CostWeights,
  plan: PlanParams
) {
  return cumulativeCostCurve(env, path, weights, plan)
}

/** 多算法对比结果项（功能01：规划策略切换与结果对比；迭代三扩展能耗/平滑/目标向量） */
export interface AlgoCompareEntry {
  algo: AlgoType
  success: boolean
  message: string
  distance: number
  planTimeMs: number
  expandedNodes: number
  totalCost: number
  threatExposure: number
  satisfactionRate: number
  maxCurvature: number
  /** 迭代三：总能耗 kJ */
  energyKJ: number
  /** 迭代三：平滑度（rad/100m） */
  smoothness: number
  /** 迭代三：暴露时间 s */
  exposureTime: number
  /** 迭代三：未加权目标向量（Pareto 展示用） */
  objectives?: import('@/types').ObjectiveVector
  /** 迭代三：收敛曲线 */
  convergence?: import('@/types').ConvergencePoint[]
  path: Vec3[]
}

/** 用同一环境/任务批量运行多个算法并汇总指标 */
export function compareAlgorithms(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  weights: CostWeights,
  algos: AlgoType[],
  smoothing: SmoothingType,
  seed = 20260920
): AlgoCompareEntry[] {
  return algos.map((algo) => {
    const result = planMission(env, waypoints, plan, weights, {
      smoothing,
      algoOverride: algo,
      seed
    })
    return {
      algo,
      success: result.success,
      message: result.message,
      distance: result.stats.distance,
      planTimeMs: result.stats.planTimeMs,
      expandedNodes: result.stats.expandedNodes,
      totalCost: result.stats.totalCost,
      threatExposure: result.stats.threatExposure,
      satisfactionRate: result.stats.constraints?.satisfactionRate ?? 100,
      maxCurvature: result.stats.smoothMetrics?.maxCurvature ?? 0,
      energyKJ: result.stats.energyKJ ?? 0,
      smoothness: result.stats.smoothness ?? 0,
      exposureTime: result.stats.exposureTime,
      objectives: result.stats.objectives,
      convergence: result.stats.convergence,
      path: result.smoothPath
    }
  })
}

function failResult(message: string, planTimeMs: number): PlanResult {
  return {
    success: false,
    rawPath: [],
    smoothPath: [],
    stats: {
      distance: 0,
      threatExposure: 0,
      exposureTime: 0,
      planTimeMs,
      expandedNodes: 0,
      success: false,
      segments: 0,
      obstacleAvoidanceRate: 0,
      totalCost: 0,
      costBreakdown: { distance: 0, threat: 0, altitude: 0, nofly: 0, smooth: 0, energy: 0, dynamics: 0 }
    },
    legs: [],
    message
  }
}
