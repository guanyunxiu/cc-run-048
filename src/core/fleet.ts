import type {
  DroneRuntime,
  DroneSpec,
  PlanParams,
  CostWeights,
  Vec3
} from '@/types'
import type { Environment } from './environment'
import { planMission } from './planning'
import { planTrajectory, type TrajectorySample } from './smoothing'
import { Random } from './rng'

/**
 * 多无人机同时仿真（功能03）：
 * 每架无人机独立任务（航点/算法/起飞时刻），共享同一环境与代价口径；
 * 统一规划后在同一时间轴回放，计算机间安全间隔与通信链路。
 */

export interface FleetPlanResult {
  runtimes: DroneRuntime[]
  /** 全部无人机的最大时长（时间轴上限） */
  maxDuration: number
  failures: { id: string; message: string }[]
}

/** 为编队内每架无人机规划并生成时间参数化轨迹 */
export function planFleet(
  env: Environment,
  fleet: DroneSpec[],
  plan: PlanParams,
  weights: CostWeights,
  smoothing: import('@/types').SmoothingType,
  seedBase = 20260920
): FleetPlanResult {
  const runtimes: DroneRuntime[] = []
  const failures: { id: string; message: string }[] = []
  let maxDuration = 0

  fleet.forEach((spec, i) => {
    const result = planMission(
      env,
      spec.waypoints,
      { ...plan, algo: spec.algoOverride ?? plan.algo },
      weights,
      { smoothing, seed: seedBase + i * 101 }
    )
    if (!result.success || result.smoothPath.length < 2) {
      failures.push({ id: spec.id, message: result.message })
      runtimes.push({
        spec,
        path: [],
        trajectory: [],
        duration: 0,
        active: false,
        separation: Infinity
      })
      return
    }
    const trajectory: TrajectorySample[] = planTrajectory(
      result.smoothPath,
      plan
    ).map((s) => ({ ...s, time: s.time + (spec.launchDelay || 0) }))
    const duration =
      trajectory.length > 0
        ? trajectory[trajectory.length - 1].time
        : 0
    maxDuration = Math.max(maxDuration, duration)
    runtimes.push({
      spec,
      path: result.smoothPath,
      trajectory,
      duration,
      active: false,
      separation: Infinity
    })
  })

  return { runtimes, maxDuration, failures }
}

/** 在时刻 t 取某无人机采样（含起飞延迟：延迟期位于起点） */
export function sampleFleetDrone(
  rt: DroneRuntime,
  t: number
): TrajectorySample | null {
  const traj = rt.trajectory
  if (traj.length === 0) return null
  if (t <= traj[0].time) return traj[0]
  const last = traj[traj.length - 1]
  if (t >= last.time) return last
  let lo = 0
  let hi = traj.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (traj[mid].time <= t) lo = mid
    else hi = mid
  }
  const a = traj[lo]
  const b = traj[lo + 1]
  const dt = b.time - a.time
  const k = dt > 1e-6 ? (t - a.time) / dt : 0
  return {
    time: t,
    s: a.s + (b.s - a.s) * k,
    speed: a.speed + (b.speed - a.speed) * k,
    position: {
      x: a.position.x + (b.position.x - a.position.x) * k,
      y: a.position.y + (b.position.y - a.position.y) * k,
      z: a.position.z + (b.position.z - a.position.z) * k
    },
    velocity: {
      x: a.velocity.x + (b.velocity.x - a.velocity.x) * k,
      y: a.velocity.y + (b.velocity.y - a.velocity.y) * k,
      z: a.velocity.z + (b.velocity.z - a.velocity.z) * k
    }
  }
}

/** 某时刻各机是否激活（起飞后、到达前） */
export function fleetActiveAt(rt: DroneRuntime, t: number): boolean {
  return (
    rt.trajectory.length > 0 &&
    t >= rt.trajectory[0].time &&
    t <= rt.trajectory[rt.trajectory.length - 1].time
  )
}

/**
 * 机间安全间隔矩阵（功能03：多机防撞评估）。
 * 返回与 runtimes 等长的最小间距数组（每架机到最近邻的距离）。
 */
export function fleetSeparation(
  runtimes: DroneRuntime[],
  t: number
): number[] {
  const pos: (Vec3 | null)[] = runtimes.map((rt) =>
    fleetActiveAt(rt, t) ? sampleFleetDrone(rt, t)?.position ?? null : null
  )
  return runtimes.map((_, i) => {
    if (!pos[i]) return Infinity
    let best = Infinity
    for (let j = 0; j < runtimes.length; j++) {
      if (j === i || !pos[j]) continue
      const d = Math.hypot(
        pos[i]!.x - pos[j]!.x,
        pos[i]!.y - pos[j]!.y,
        pos[i]!.z - pos[j]!.z
      )
      if (d < best) best = d
    }
    return best
  })
}

/** 通信链路：返回所有距离小于双方通信范围的机对（下标对） */
export function fleetCommLinks(
  runtimes: DroneRuntime[],
  t: number
): [number, number, Vec3, Vec3][] {
  const pos: (Vec3 | null)[] = runtimes.map((rt) =>
    fleetActiveAt(rt, t) ? sampleFleetDrone(rt, t)?.position ?? null : null
  )
  const links: [number, number, Vec3, Vec3][] = []
  for (let i = 0; i < runtimes.length; i++) {
    for (let j = i + 1; j < runtimes.length; j++) {
      if (!pos[i] || !pos[j]) continue
      const d = Math.hypot(
        pos[i]!.x - pos[j]!.x,
        pos[i]!.y - pos[j]!.y,
        pos[i]!.z - pos[j]!.z
      )
      if (d <= Math.min(runtimes[i].spec.commRange, runtimes[j].spec.commRange)) {
        links.push([i, j, pos[i]!, pos[j]!])
      }
    }
  }
  return links
}

/** 默认编队：2 架不同任务的无人机（演示多机同时仿真） */
export function defaultFleet(): { drones: DroneSpec[] } {
  return {
    drones: [
      {
        id: 'uav-A',
        name: '长机-A',
        color: '#1abc9c',
        launchDelay: 0,
        sensorRange: 120,
        commRange: 260,
        waypoints: [
          { id: 'a-start', role: 'start', position: { x: -420, y: 120, z: -320 }, speed: 30 },
          { id: 'a-end', role: 'end', position: { x: 420, y: 110, z: 300 }, speed: 30 }
        ]
      },
      {
        id: 'uav-B',
        name: '僚机-B',
        color: '#e84393',
        launchDelay: 2,
        sensorRange: 100,
        commRange: 240,
        waypoints: [
          { id: 'b-start', role: 'start', position: { x: -380, y: 150, z: 300 }, speed: 32 },
          { id: 'b-via', role: 'via', position: { x: 60, y: 170, z: 40 }, speed: 32 },
          { id: 'b-end', role: 'end', position: { x: 400, y: 120, z: -320 }, speed: 32 }
        ]
      }
    ]
  }
}

// 让 Random 导入在未来扩展（确定性编队种子）中可用
void Random
