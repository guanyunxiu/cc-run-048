import type {
  AlgoType,
  CostWeights,
  ExperimentAggregate,
  ExperimentConfig,
  ExperimentReport,
  ExperimentRun,
  ObjectiveVector,
  PlanParams,
  SmoothingType,
  Waypoint,
  BuildingObstacle,
  DynamicEntity,
  NoFlyZone,
  TerrainParams,
  ThreatZone
} from '@/types'
import type { Environment } from './environment'
import { planMission } from './planning'

/**
 * 批量实验框架（迭代三功能02）：
 * 多算法 × 多种子重复运行，统计成功率、航程、威胁暴露、暴露时间、
 * 规划耗时、平滑度、能耗、约束满足率的均值/标准差/极值，
 * 支持报告导出与配置保存复现。
 */

export interface BatchRunOptions {
  /** 进度回调（0~1），用于 Worker/UI 进度条 */
  onProgress?: (done: number, total: number) => void
  /** 取消令牌：返回 true 时提前终止（已完成的运行仍计入报告） */
  shouldCancel?: () => boolean
}

const ZERO_OBJ: ObjectiveVector = {
  distance: 0,
  threat: 0,
  altitude: 0,
  nofly: 0,
  smooth: 0,
  energy: 0,
  dynamics: 0
}

/** 汇总一组运行记录的统计量 */
export function aggregateRuns(runs: ExperimentRun[]): ExperimentAggregate | null {
  if (runs.length === 0) return null
  const ok = runs.filter((r) => r.success)
  const nums = (sel: (r: ExperimentRun) => number) =>
    ok.length ? ok.map(sel) : runs.map(sel)

  const stats = (sel: (r: ExperimentRun) => number) => {
    const v = nums(sel)
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const variance =
      v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0
    return {
      mean: round(mean, 3),
      std: round(Math.sqrt(variance), 3),
      min: round(Math.min(...v), 3),
      max: round(Math.max(...v), 3)
    }
  }

  return {
    runs: runs.length,
    successRate: round((ok.length / runs.length) * 100, 2),
    distance: stats((r) => r.distance),
    planTimeMs: stats((r) => r.planTimeMs),
    threatExposure: stats((r) => r.threatExposure),
    exposureTime: stats((r) => r.exposureTime),
    smoothness: stats((r) => r.smoothness),
    energyKJ: stats((r) => r.energyKJ),
    satisfactionRate: stats((r) => r.satisfactionRate)
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/**
 * 执行批量实验（纯函数，可在主线程或 Worker 内调用）。
 * 每种算法用不同随机种子重复 runsPerAlgo 次，结果可复现。
 */
export function runBatchExperiment(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  weights: CostWeights,
  smoothing: SmoothingType,
  algos: AlgoType[],
  runsPerAlgo: number,
  baseSeed: number,
  options: BatchRunOptions = {}
): { runs: ExperimentRun[]; aggregates: Partial<Record<AlgoType, ExperimentAggregate>> } {
  const runs: ExperimentRun[] = []
  const total = algos.length * runsPerAlgo
  let done = 0

  for (const algo of algos) {
    for (let i = 0; i < runsPerAlgo; i++) {
      if (options.shouldCancel?.()) break
      const seed = baseSeed + i * 7919
      const result = planMission(env, waypoints, plan, weights, {
        smoothing,
        algoOverride: algo,
        seed
      })
      const s = result.stats
      runs.push({
        runIndex: i,
        seed,
        algo,
        success: result.success,
        message: result.message,
        distance: s.distance,
        planTimeMs: s.planTimeMs,
        expandedNodes: s.expandedNodes,
        totalCost: s.totalCost,
        threatExposure: s.threatExposure,
        exposureTime: s.exposureTime,
        satisfactionRate: s.constraints?.satisfactionRate ?? 100,
        obstacleAvoidanceRate: s.obstacleAvoidanceRate,
        smoothness: s.smoothness ?? 0,
        energyKJ: s.energyKJ ?? 0,
        maxCurvature: s.smoothMetrics?.maxCurvature ?? 0,
        objectives: s.objectives ?? { ...ZERO_OBJ }
      })
      done++
      options.onProgress?.(done, total)
    }
    if (options.shouldCancel?.()) break
  }

  const aggregates: Partial<Record<AlgoType, ExperimentAggregate>> = {}
  for (const algo of algos) {
    const agg = aggregateRuns(runs.filter((r) => r.algo === algo))
    if (agg) aggregates[algo] = agg
  }
  return { runs, aggregates }
}

/** 构造可保存/复现的实验配置 */
export function buildExperimentConfig(
  terrain: TerrainParams,
  threats: ThreatZone[],
  noflyZones: NoFlyZone[],
  obstacles: BuildingObstacle[],
  dynamics: DynamicEntity[],
  waypoints: Waypoint[],
  planParams: PlanParams,
  weights: CostWeights,
  smoothing: SmoothingType,
  algos: AlgoType[],
  runsPerAlgo: number,
  baseSeed: number,
  name = '批量实验'
): ExperimentConfig {
  return {
    name,
    createdAt: new Date().toISOString(),
    terrain,
    threats,
    noflyZones,
    obstacles,
    dynamics,
    waypoints,
    planParams,
    weights,
    smoothing,
    algos,
    runsPerAlgo,
    baseSeed
  }
}

/** 汇总为可导出的实验报告 */
export function buildExperimentReport(
  config: ExperimentConfig,
  runs: ExperimentRun[],
  aggregates: Partial<Record<AlgoType, ExperimentAggregate>>
): ExperimentReport {
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    config,
    runs,
    aggregates
  }
}

/** 将实验报告序列化为 CSV（每算法一行聚合） */
export function reportToCsv(report: ExperimentReport): string {
  const header = [
    'algo', 'runs', 'successRate%',
    'distance_mean', 'distance_std', 'distance_min', 'distance_max',
    'planMs_mean', 'planMs_std',
    'threat_mean', 'threat_std',
    'exposureTime_mean',
    'smoothness_mean',
    'energyKJ_mean',
    'satisfaction_mean'
  ]
  const lines = [header.join(',')]
  for (const [algo, agg] of Object.entries(report.aggregates)) {
    if (!agg) continue
    lines.push([
      algo,
      agg.runs,
      agg.successRate,
      agg.distance.mean, agg.distance.std, agg.distance.min, agg.distance.max,
      agg.planTimeMs.mean, agg.planTimeMs.std,
      agg.threatExposure.mean, agg.threatExposure.std,
      agg.exposureTime.mean,
      agg.smoothness.mean,
      agg.energyKJ.mean,
      agg.satisfactionRate.mean
    ].join(','))
  }
  return lines.join('\n')
}

/** 将全部运行明细序列化为 CSV（每次运行一行） */
export function runsToCsv(report: ExperimentReport): string {
  const header = [
    'algo', 'runIndex', 'seed', 'success',
    'distance', 'planTimeMs', 'expandedNodes', 'totalCost',
    'threatExposure', 'exposureTime',
    'satisfactionRate', 'avoidanceRate', 'smoothness',
    'energyKJ', 'maxCurvature'
  ]
  const lines = [header.join(',')]
  for (const r of report.runs) {
    lines.push([
      r.algo, r.runIndex, r.seed, r.success ? 1 : 0,
      r.distance, r.planTimeMs, r.expandedNodes, r.totalCost,
      r.threatExposure, r.exposureTime,
      r.satisfactionRate, r.obstacleAvoidanceRate, r.smoothness,
      r.energyKJ, r.maxCurvature
    ].join(','))
  }
  return lines.join('\n')
}
