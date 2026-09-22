import type {
  AlgoType,
  CostWeights,
  ExperimentConfig,
  ExperimentRun,
  ExperimentSummary,
  ObjectiveVector,
  PlanParams,
  SmoothingType,
  Vec3,
  Waypoint
} from '@/types'
import type { Environment } from './environment'
import { planMission } from './planning'
import { pathObjectives } from './cost'
import { densify } from './smoothing'

/**
 * 批量实验（功能02）：
 * - 多算法 × 多种子重复运行
 * - 成功率、航程、暴露、规划时间、平滑度、能耗等统计
 * - 均值/标准差/最优最差，支持配置保存与完全复现
 */

/** 路径平滑度：平均转角（度），越小越平滑；同时兼容曲率口径 */
export function pathSmoothness(path: Vec3[]): number {
  if (path.length < 3) return 0
  let sum = 0
  let n = 0
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]
    const b = path[i]
    const c = path[i + 1]
    const v1x = b.x - a.x
    const v1y = b.y - a.y
    const v1z = b.z - a.z
    const v2x = c.x - b.x
    const v2y = c.y - b.y
    const v2z = c.z - b.z
    const l1 = Math.hypot(v1x, v1y, v1z)
    const l2 = Math.hypot(v2x, v2y, v2z)
    if (l1 < 1e-6 || l2 < 1e-6) continue
    const dot = (v1x * v2x + v1y * v2y + v1z * v2z) / (l1 * l2)
    sum += Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI)
    n++
  }
  return n > 0 ? sum / n : 0
}

/** 一次完整规划运行 -> ExperimentRun */
export function runSingleExperiment(
  env: Environment,
  waypoints: Waypoint[],
  plan: PlanParams,
  weights: CostWeights,
  smoothing: SmoothingType,
  algo: AlgoType,
  seed: number,
  runIndex: number
): ExperimentRun {
  const result = planMission(env, waypoints, plan, weights, {
    smoothing,
    algoOverride: algo,
    seed
  })
  const st = result.stats
  const objectives: ObjectiveVector =
    st.objectives ??
    (result.smoothPath.length >= 2
      ? pathObjectives(env, result.smoothPath, plan)
      : {
          distance: 0,
          threat: 0,
          altitude: 0,
          nofly: 0,
          smooth: 0,
          energy: 0,
          dynamics: 0
        })

  // 以固定间距加密点计算平滑度，避免不同算法点密度差异
  const dense = result.success
    ? densify(result.smoothPath, Math.max(plan.cellSize * 0.5, 4))
    : []
  const smoothness = pathSmoothness(dense.length >= 3 ? dense : result.smoothPath)

  return {
    runIndex,
    seed,
    algo,
    success: result.success,
    message: result.message,
    distance: st.distance,
    planTimeMs: st.planTimeMs,
    expandedNodes: st.expandedNodes,
    totalCost: st.totalCost,
    threatExposure: st.threatExposure,
    exposureTime: st.exposureTime,
    smoothness,
    satisfactionRate: st.constraints?.satisfactionRate ?? 100,
    energy: objectives.energy,
    objectives,
    path: result.smoothPath
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))))
}

/** 对同一算法的多次运行做统计汇总 */
export function summarizeRuns(
  algo: AlgoType,
  label: string,
  runs: ExperimentRun[]
): ExperimentSummary {
  const ok = runs.filter((r) => r.success)
  const pick = (f: (r: ExperimentRun) => number) => ok.map(f)

  const distances = pick((r) => r.distance)
  const times = pick((r) => r.planTimeMs)
  const exposures = pick((r) => r.threatExposure)
  const exposureTimes = pick((r) => r.exposureTime)
  const smooths = pick((r) => r.smoothness)
  const satis = pick((r) => r.satisfactionRate)
  const energies = pick((r) => r.energy)
  const costs = pick((r) => r.totalCost)

  let best: ExperimentRun | null = null
  let worst: ExperimentRun | null = null
  for (const r of ok) {
    if (!best || r.totalCost < best.totalCost) best = r
    if (!worst || r.totalCost > worst.totalCost) worst = r
  }

  return {
    label,
    algo,
    runs: runs.length,
    successRate: runs.length > 0 ? ok.length / runs.length : 0,
    distanceMean: mean(distances),
    distanceStd: std(distances),
    planTimeMean: mean(times),
    planTimeStd: std(times),
    exposureMean: mean(exposures),
    exposureTimeMean: mean(exposureTimes),
    smoothnessMean: mean(smooths),
    satisfactionMean: mean(satis),
    energyMean: mean(energies),
    costMean: mean(costs),
    costStd: std(costs),
    best,
    worst,
    runs_: runs
  }
}

export interface BatchResult {
  config: ExperimentConfig
  summaries: ExperimentSummary[]
  runs: ExperimentRun[]
  totalWallMs: number
}

/**
 * 执行批量实验：每个算法用 baseSeed+0..repetitions-1 重复运行。
 * onProgress 回调可驱动 UI 进度条（Worker 中同样可用）。
 */
export function runBatchExperiment(
  env: Environment,
  config: ExperimentConfig,
  onProgress?: (done: number, total: number, currentLabel: string) => void
): BatchResult {
  const t0 =
    typeof performance !== 'undefined' ? performance.now() : Date.now()
  const summaries: ExperimentSummary[] = []
  const allRuns: ExperimentRun[] = []
  const total = config.algos.length * config.repetitions
  let done = 0

  for (const algo of config.algos) {
    const runs: ExperimentRun[] = []
    for (let i = 0; i < config.repetitions; i++) {
      const seed = config.baseSeed + i * 7919
      const run = runSingleExperiment(
        env,
        config.waypoints,
        config.planParams,
        config.weights,
        config.smoothing,
        algo,
        seed,
        i
      )
      runs.push(run)
      allRuns.push(run)
      done++
      onProgress?.(done, total, algo)
    }
    summaries.push(summarizeRuns(algo, algo, runs))
  }

  return {
    config,
    summaries,
    runs: allRuns,
    totalWallMs:
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  }
}

/** 创建可复现的实验配置 */
export function makeExperimentConfig(
  patch: Partial<ExperimentConfig> & Pick<ExperimentConfig, 'planParams' | 'weights'>
): ExperimentConfig {
  return {
    name: patch.name ?? `实验-${new Date().toISOString().slice(0, 19)}`,
    createdAt: new Date().toISOString(),
    terrain: patch.terrain!,
    threats: patch.threats ?? [],
    noflyZones: patch.noflyZones ?? [],
    obstacles: patch.obstacles ?? [],
    dynamics: patch.dynamics ?? [],
    waypoints: patch.waypoints ?? [],
    planParams: patch.planParams,
    weights: patch.weights,
    smoothing: patch.smoothing ?? 'bspline',
    algos: patch.algos ?? [],
    repetitions: patch.repetitions ?? 10,
    baseSeed: patch.baseSeed ?? 20260920
  }
}

/** 导出批量实验报告（JSON 字符串，含配置与汇总，可复现） */
export function exportExperimentReport(result: BatchResult): string {
  const report = {
    ...result,
    summaries: result.summaries.map((s) => {
      const { runs_, ...rest } = s
      void runs_
      return {
        ...rest,
        best: s.best ? stripPath(s.best) : null,
        worst: s.worst ? stripPath(s.worst) : null
      }
    }),
    runs: result.runs.map(stripPath)
  }
  return JSON.stringify(report, null, 2)
}

function stripPath(r: ExperimentRun): Omit<ExperimentRun, 'path'> & {
  pathPointCount: number
} {
  const { path, ...rest } = r
  return { ...rest, pathPointCount: path.length }
}

/** 导出全部运行的指标 CSV */
export function exportRunsCsv(result: BatchResult): string {
  const header = [
    'run',
    'algo',
    'seed',
    'success',
    'distance',
    'planTimeMs',
    'expandedNodes',
    'totalCost',
    'threatExposure',
    'exposureTime',
    'smoothness',
    'satisfactionRate',
    'energy',
    'obj_threat',
    'obj_altitude',
    'obj_nofly',
    'obj_smooth',
    'obj_dynamics'
  ]
  const rows = result.runs.map((r) =>
    [
      r.runIndex,
      r.algo,
      r.seed,
      r.success ? 1 : 0,
      r.distance.toFixed(2),
      r.planTimeMs.toFixed(2),
      r.expandedNodes,
      r.totalCost.toFixed(2),
      r.threatExposure.toFixed(3),
      r.exposureTime.toFixed(2),
      r.smoothness.toFixed(3),
      r.satisfactionRate.toFixed(1),
      r.energy.toFixed(3),
      r.objectives.threat.toFixed(3),
      r.objectives.altitude.toFixed(3),
      r.objectives.nofly.toFixed(3),
      r.objectives.smooth.toFixed(3),
      r.objectives.dynamics.toFixed(3)
    ].join(',')
  )
  return [header.join(','), ...rows].join('\n')
}
