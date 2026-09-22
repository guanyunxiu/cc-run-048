/// <reference lib="webworker" />
import { Environment } from '@/core/environment'
import { DynamicEnvironment } from '@/core/dynamic-environment'
import { compareAlgorithms, planMission } from '@/core/planning'
import { planTrajectory, type TrajectorySample } from '@/core/smoothing'
import {
  paretoWeightScan,
  weightSensitivity
} from '@/core/multi-objective'
import {
  runBatchExperiment,
  type BatchResult
} from '@/core/experiment'
import { planFleet, type FleetPlanResult } from '@/core/fleet'
import type {
  AlgoType,
  BuildingObstacle,
  CostWeights,
  DynamicEntity,
  FleetSpec,
  NoFlyZone,
  ParetoPoint,
  PlanParams,
  PlanResult,
  SensitivityResult,
  SmoothingType,
  TerrainParams,
  ThreatZone,
  Vec3,
  Waypoint
} from '@/types'
import type { AlgoCompareEntry } from '@/core/planning'
import type { ExperimentConfig } from '@/types'

export interface PlanRequest {
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

export interface PlanResponse {
  type: 'plan-done'
  result: PlanResult
  /** 规划用时（Worker 内测量） */
  workerMs: number
}

export interface TrajRequest {
  type: 'trajectory'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  smoothPath: Vec3[]
  planParams: PlanParams
  cruiseSpeed?: number
}

export interface TrajResponse {
  type: 'trajectory-done'
  trajectory: TrajectorySample[]
}

export interface CompareRequest {
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

export interface CompareResponse {
  type: 'compare-done'
  entries: AlgoCompareEntry[]
  workerMs: number
}

/** 批量实验（功能02） */
export interface BatchRequest {
  type: 'batch'
  config: ExperimentConfig
}
export interface BatchResponse {
  type: 'batch-done'
  result: BatchResult
}

/** Pareto 权重扫描（功能01） */
export interface ParetoRequest {
  type: 'pareto'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  waypoints: Waypoint[]
  planParams: PlanParams
  baselineWeights: CostWeights
  smoothing: SmoothingType
  algo?: AlgoType
}
export interface ParetoResponse {
  type: 'pareto-done'
  points: ParetoPoint[]
  workerMs: number
}

/** 权重敏感性（功能01） */
export interface SensitivityRequest {
  type: 'sensitivity'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  waypoints: Waypoint[]
  planParams: PlanParams
  baseWeights: CostWeights
  smoothing: SmoothingType
  algo?: AlgoType
  axis: keyof CostWeights
  values: number[]
}
export interface SensitivityResponse {
  type: 'sensitivity-done'
  result: SensitivityResult
}

/** 多无人机编队规划（功能03） */
export interface FleetRequest {
  type: 'fleet'
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  fleet: FleetSpec
  planParams: PlanParams
  weights: CostWeights
  smoothing: SmoothingType
}
export interface FleetResponse {
  type: 'fleet-done'
  result: FleetPlanResult
}

export type WorkerRequest =
  | PlanRequest
  | TrajRequest
  | CompareRequest
  | BatchRequest
  | ParetoRequest
  | SensitivityRequest
  | FleetRequest
export type WorkerResponse =
  | PlanResponse
  | TrajResponse
  | CompareResponse
  | BatchResponse
  | ParetoResponse
  | SensitivityResponse
  | FleetResponse

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data

  if (msg.type === 'trajectory') {
    const trajectory = planTrajectory(
      msg.smoothPath,
      msg.planParams,
      msg.cruiseSpeed
    )
    const res: TrajResponse = { type: 'trajectory-done', trajectory }
    ctx.postMessage(res)
    return
  }

  // 其余请求都需要静态环境
  const envParams =
    msg.type === 'batch'
      ? {
          terrain: msg.config.terrain,
          threats: msg.config.threats,
          noflyZones: msg.config.noflyZones,
          obstacles: msg.config.obstacles
        }
      : {
          terrain: (msg as Exclude<WorkerRequest, BatchRequest | TrajRequest>).terrain,
          threats: (msg as Exclude<WorkerRequest, BatchRequest | TrajRequest>).threats,
          noflyZones: (msg as Exclude<WorkerRequest, BatchRequest | TrajRequest>).noflyZones,
          obstacles: (msg as Exclude<WorkerRequest, BatchRequest | TrajRequest>).obstacles
        }
  const env = new Environment(
    envParams.terrain,
    envParams.threats,
    envParams.noflyZones,
    envParams.obstacles
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
    const res: PlanResponse = {
      type: 'plan-done',
      result,
      workerMs: Math.round(workerMs * 100) / 100
    }
    ctx.postMessage(res)
  } else if (msg.type === 'compare') {
    void new DynamicEnvironment(
      msg.terrain,
      msg.threats,
      msg.noflyZones,
      msg.obstacles,
      msg.dynamics
    )
    const t0 = performance.now()
    const entries = compareAlgorithms(
      env,
      msg.waypoints,
      msg.planParams,
      msg.weights,
      msg.algos,
      msg.smoothing
    )
    const res: CompareResponse = {
      type: 'compare-done',
      entries,
      workerMs: Math.round((performance.now() - t0) * 100) / 100
    }
    ctx.postMessage(res)
  } else if (msg.type === 'batch') {
    // 批量实验内部循环多种子规划；进度暂以完成消息回传
    const result = runBatchExperiment(env, msg.config)
    const res: BatchResponse = { type: 'batch-done', result }
    ctx.postMessage(res)
  } else if (msg.type === 'pareto') {
    const t0 = performance.now()
    const points = paretoWeightScan(
      env,
      msg.waypoints,
      msg.planParams,
      {
        baselineWeights: msg.baselineWeights,
        smoothing: msg.smoothing,
        algo: msg.algo
      }
    )
    const res: ParetoResponse = {
      type: 'pareto-done',
      points,
      workerMs: Math.round((performance.now() - t0) * 100) / 100
    }
    ctx.postMessage(res)
  } else if (msg.type === 'sensitivity') {
    const result = weightSensitivity(
      env,
      msg.waypoints,
      msg.planParams,
      msg.baseWeights,
      msg.axis,
      msg.values,
      msg.smoothing,
      msg.algo
    )
    const res: SensitivityResponse = {
      type: 'sensitivity-done',
      result
    }
    ctx.postMessage(res)
  } else if (msg.type === 'fleet') {
    const result = planFleet(
      env,
      msg.fleet.drones,
      msg.planParams,
      msg.weights,
      msg.smoothing
    )
    const res: FleetResponse = { type: 'fleet-done', result }
    ctx.postMessage(res)
  }
}
