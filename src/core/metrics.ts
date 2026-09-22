import type { PathMetrics, PlanParams, Vec3 } from '@/types'
import { densify, planTrajectory, type TrajectorySample } from './smoothing'
import {
  climbAngleRad,
  horizontalCurvature,
  turnAngleRad
} from './dynamics'
import { dist } from '@/utils/math3d'

const RAD2DEG = 180 / Math.PI

/**
 * 计算航迹综合指标（功能04）：航程、曲率、转角、爬升角、
 * 速度、加速度、抖动（jerk）。
 * 几何量在均匀加密点上计算；加速度/抖动来自时间参数化轨迹。
 */
export function evaluateMetrics(
  path: Vec3[],
  plan: PlanParams
): PathMetrics {
  const empty: PathMetrics = {
    length: 0,
    maxCurvature: 0,
    meanCurvature: 0,
    maxTurnAngle: 0,
    maxClimbAngle: 0,
    maxSpeed: 0,
    maxAccel: 0,
    maxJerk: 0
  }
  if (path.length < 2) return empty

  const spacing = Math.max(plan.cellSize * 0.4, 4)
  const dense = densify(path, spacing)
  let length = 0
  let maxTurn = 0
  let maxClimb = 0
  let maxCurv = 0
  let curvSum = 0
  let curvN = 0

  for (let i = 1; i < dense.length; i++) {
    length += dist(dense[i - 1], dense[i])
    const climb = Math.abs(climbAngleRad(dense[i - 1], dense[i])) * RAD2DEG
    if (climb > maxClimb) maxClimb = climb
    if (i >= 2) {
      const turn =
        turnAngleRad(dense[i - 2], dense[i - 1], dense[i]) * RAD2DEG
      if (turn > maxTurn) maxTurn = turn
      const curv = horizontalCurvature(dense[i - 2], dense[i - 1], dense[i])
      if (curv > maxCurv) maxCurv = curv
      curvSum += curv
      curvN++
    }
  }

  const traj = planTrajectory(path, plan)
  let maxSpeed = 0
  let maxAccel = 0
  let maxJerk = 0
  for (let i = 0; i < traj.length; i++) {
    if (traj[i].speed > maxSpeed) maxSpeed = traj[i].speed
    if (i >= 1 && i < traj.length - 1) {
      const dt = traj[i + 1].time - traj[i - 1].time
      if (dt > 1e-6) {
        const ax = (traj[i + 1].velocity.x - traj[i - 1].velocity.x) / dt
        const ay = (traj[i + 1].velocity.y - traj[i - 1].velocity.y) / dt
        const az = (traj[i + 1].velocity.z - traj[i - 1].velocity.z) / dt
        const a = Math.hypot(ax, ay, az)
        if (a > maxAccel) maxAccel = a
      }
    }
    if (i >= 2 && i < traj.length - 2) {
      const jerk = jerkMagnitude(traj[i - 2], traj[i - 1], traj[i], traj[i + 1], traj[i + 2])
      if (jerk > maxJerk) maxJerk = jerk
    }
  }

  return {
    length: Math.round(length * 10) / 10,
    maxCurvature: Math.round(maxCurv * 1e5) / 1e5,
    meanCurvature: Math.round((curvN ? curvSum / curvN : 0) * 1e5) / 1e5,
    maxTurnAngle: Math.round(maxTurn * 10) / 10,
    maxClimbAngle: Math.round(maxClimb * 10) / 10,
    maxSpeed: Math.round(maxSpeed * 10) / 10,
    maxAccel: Math.round(maxAccel * 100) / 100,
    maxJerk: Math.round(maxJerk * 100) / 100
  }
}

function jerkMagnitude(
  p0: TrajectorySample,
  p1: TrajectorySample,
  p2: TrajectorySample,
  p3: TrajectorySample,
  p4: TrajectorySample
): number {
  const accelAt = (a: TrajectorySample, b: TrajectorySample, c: TrajectorySample) => {
    const dt = c.time - a.time
    if (dt <= 1e-6) return { x: 0, y: 0, z: 0 }
    return {
      x: (c.velocity.x - a.velocity.x) / dt,
      y: (c.velocity.y - a.velocity.y) / dt,
      z: (c.velocity.z - a.velocity.z) / dt
    }
  }
  const a1 = accelAt(p0, p1, p2)
  const a2 = accelAt(p2, p3, p4)
  const dt = (p4.time - p0.time) / 2
  if (dt <= 1e-6) return 0
  return Math.hypot(a2.x - a1.x, a2.y - a1.y, a2.z - a1.z) / dt
}

export interface MetricsDelta {
  raw: PathMetrics
  smooth: PathMetrics
  /** 平滑后相对原始的变化率（%，负值表示下降） */
  lengthDeltaPct: number
  curvatureDeltaPct: number
  turnDeltaPct: number
  accelDeltaPct: number
  jerkDeltaPct: number
}

export function compareMetrics(raw: PathMetrics, smooth: PathMetrics): MetricsDelta {
  const pct = (a: number, b: number) =>
    a > 1e-9 ? Math.round(((b - a) / a) * 1000) / 10 : 0
  return {
    raw,
    smooth,
    lengthDeltaPct: pct(raw.length, smooth.length),
    curvatureDeltaPct: pct(raw.maxCurvature, smooth.maxCurvature),
    turnDeltaPct: pct(raw.maxTurnAngle, smooth.maxTurnAngle),
    accelDeltaPct: pct(raw.maxAccel, smooth.maxAccel),
    jerkDeltaPct: pct(raw.maxJerk, smooth.maxJerk)
  }
}
