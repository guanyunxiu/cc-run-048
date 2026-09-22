/// <reference lib="webworker" />
import { Environment } from '@/core/environment'
import { compareAlgorithms, planMission } from '@/core/planning'
import { planTrajectory, type TrajectorySample } from '@/core/smoothing'
import {
  buildExperimentReport,
  runBatchExperiment
} from '@/core/experiment'
import { scanWeightedPareto } from '@/core/pareto'
import type {
  AlgoType,
  BuildingObstacle,
  CostWeights,
  DynamicEntity,
  ExperimentReport,
  NoFlyZone,
  ParetoPoint,
  PlanParams,
  PlanResult,
  SmoothingType,
  TerrainParams,
  ThreatZone,
  Vec3,
  Waypoint
} from '@/types'
import type { AlgoCompareEntry } from '@/core/planning'

/** 所有请求可携带 id（Worker 池路由用，无 id 时为单 Worker 兼容模式） */
export interface WithId {
  id?: number
}

export interface PlanRequest extends WithId {
  type: 'plan'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  /** 动态实体（全局规划在 t=0 口径下不参与碰撞，仅用于在线重规划） */
  dynamics: DynamicEntity[]
  waypoints: Waypoint[]
  planParams: PlanParams
  weights: CostWeights
  smoothing: SmoothingType
}

export interface PlanResponse extends WithId {
  type: 'plan-done'
  result: PlanResult
  /** 规划用时（Worker 内测量） */
  workerMs: number
}

export interface TrajRequest extends WithId {
  type: 'trajectory'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  smoothPath: Vec3[]
  planParams: PlanParams
  cruiseSpeed?: number
}

export interface TrajResponse extends WithId {
  type: 'trajectory-done'
  trajectory: TrajectorySample[]
}

export interface CompareRequest extends WithId {
  type: 'compare'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  dynamics: DynamicEntity[]
  waypoints: Waypoint[]
  planParams: PlanParams
  weights: CostWeights
  smoothing: SmoothingType
  algos: AlgoType[]
}

export interface CompareResponse extends WithId {
  type: 'compare-done'
  entries: AlgoCompareEntry[]
  workerMs: number
}

/** 迭代三：批量实验请求 */
export interface BatchRequest extends WithId {
  type: 'batch'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  dynamics: DynamicEntity[]
  waypoints: Waypoint[]
  planParams: PlanParams
  weights: CostWeights
  smoothing: SmoothingType
  algos: AlgoType[]
  runsPerAlgo: number
  baseSeed: number
  /** 实验名（写入报告） */
  name?: string
}

export interface BatchResponse extends WithId {
  type: 'batch-done'
  report: ExperimentReport
  workerMs: number
}

/** 迭代三：Pareto 权重扫描请求 */
export interface ParetoRequest extends WithId {
  type: 'pareto'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  dynamics: DynamicEntity[]
  waypoints: Waypoint[]
  planParams: PlanParams
  weights: CostWeights
  smoothing: SmoothingType
  algo: AlgoType
  samples: number
  keepPath?: boolean
}

export interface ParetoResponse extends WithId {
  type: 'pareto-done'
  front: ParetoPoint[]
  all: ParetoPoint[]
  workerMs: number
}

/** 迭代三：进度回报（batch/pareto 长任务） */
export interface ProgressResponse {
  type: 'progress'
  id?: number
  progress: number
}

export type WorkerRequest =
  | PlanRequest
  | TrajRequest
  | CompareRequest
  | BatchRequest
  | ParetoRequest
export type WorkerResponse =
  | PlanResponse
  | TrajResponse
  | CompareResponse
  | BatchResponse
  | ParetoResponse

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (msg: unknown) => void
}

function post(res: WorkerResponse, req: WithId): void {
  ctx.postMessage({ ...res, id: req.id })
}

function reportProgress(req: WithId, progress: number): void {
  const msg: ProgressResponse = { type: 'progress', id: req.id, progress }
  ctx.postMessage(msg)
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  // 全局规划使用静态环境（动态威胁/障碍在回放期由在线重规划处理）
  const env = new Environment(
    msg.terrain,
    msg.threats,
    msg.noflyZones,
    msg.obstacles
  )

  if (msg.type === 'plan') {
    const t0 = performance.now()
    const result = planMission(
      env,
      msg.waypoints,
      msg.planParams,
      msg.weights,
      { smoothing: msg.smoothing }
    )
    const workerMs = performance.now() - t0
    post(
      {
        type: 'plan-done',
        result,
        workerMs: Math.round(workerMs * 100) / 100
      },
      msg
    )
  } else if (msg.type === 'trajectory') {
    const trajectory = planTrajectory(
      msg.smoothPath,
      msg.planParams,
      msg.cruiseSpeed
    )
    post({ type: 'trajectory-done', trajectory }, msg)
  } else if (msg.type === 'compare') {
    const t0 = performance.now()
    const entries = compareAlgorithms(
      env,
      msg.waypoints,
      msg.planParams,
      msg.weights,
      msg.algos,
      msg.smoothing
    )
    post(
      {
        type: 'compare-done',
        entries,
        workerMs: Math.round((performance.now() - t0) * 100) / 100
      },
      msg
    )
  } else if (msg.type === 'batch') {
    const t0 = performance.now()
    const { runs, aggregates } = runBatchExperiment(
      env,
      msg.waypoints,
      msg.planParams,
      msg.weights,
      msg.smoothing,
      msg.algos,
      msg.runsPerAlgo,
      msg.baseSeed,
      {
        onProgress: (done, total) =>
          reportProgress(msg, Math.round((done / total) * 100) / 100)
      }
    )
    const config = {
      name: msg.name ?? '批量实验',
      createdAt: new Date().toISOString(),
      terrain: msg.terrain,
      threats: msg.threats,
      noflyZones: msg.noflyZones,
      obstacles: msg.obstacles,
      dynamics: msg.dynamics,
      waypoints: msg.waypoints,
      planParams: msg.planParams,
      weights: msg.weights,
      smoothing: msg.smoothing,
      algos: msg.algos,
      runsPerAlgo: msg.runsPerAlgo,
      baseSeed: msg.baseSeed
    }
    const report = buildExperimentReport(config, runs, aggregates)
    post(
      {
        type: 'batch-done',
        report,
        workerMs: Math.round((performance.now() - t0) * 100) / 100
      },
      msg
    )
  } else if (msg.type === 'pareto') {
    const t0 = performance.now()
    const { front, all } = scanWeightedPareto(
      env,
      msg.waypoints,
      msg.planParams,
      msg.weights,
      msg.algo,
      msg.smoothing,
      {
        samples: msg.samples,
        keepPath: msg.keepPath
      }
    )
    post(
      {
        type: 'pareto-done',
        front,
        all,
        workerMs: Math.round((performance.now() - t0) * 100) / 100
      },
      msg
    )
  }
}
