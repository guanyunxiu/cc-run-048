import type { CostWeights, ObjectiveVector, PlanParams, Vec3 } from '@/types'
import type { Environment } from './environment'

/**
 * 七维航段代价（功能01：多目标代价优化）。
 * distance 航程 / threat 威胁暴露 / altitude 高度偏差 / nofly 禁飞 /
 * smooth 平滑 / energy 能耗 / dynamics 动力学违反惩罚。
 */
export interface SegmentCosts {
  /** 航程代价（米） */
  distance: number
  /** 威胁暴露代价（暴露强度沿航程积分） */
  threat: number
  /** 高度代价（相对巡航高度的偏差积分） */
  altitude: number
  /** 禁飞软惩罚积分 */
  nofly: number
  /** 平滑代价（转角惩罚，0~2 偏转角） */
  smooth: number
  /** 能耗代价（归一化：平飞推进 + 爬升/下滑势能变化） */
  energy: number
  /** 动力学违反惩罚（基于三点航向变化的超限幅值积分） */
  dynamics: number
}

const RAD2DEG = 180 / Math.PI

/**
 * 计算航段 a->b 的基础（未加权）代价分量。
 * prev 为 a 的前一节点，用于转角平滑/动力学惩罚。
 */
export function segmentCosts(
  env: Environment,
  prev: Vec3 | null,
  a: Vec3,
  b: Vec3,
  plan: PlanParams
): SegmentCosts {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const distance = Math.hypot(dx, dy, dz)

  const threat = env.integrateField(a, b, (p) => env.threatIntensity(p))
  const nofly = env.integrateField(a, b, (p) => env.noflyPenalty(p))
  const altitude = env.integrateField(
    a,
    b,
    (p) => Math.abs(p.y - plan.cruiseAlt) / Math.max(plan.cruiseAlt, 1)
  )

  let smooth = 0
  /** 动力学违反幅值（转弯角 + 爬升角超限量，按度归一化） */
  let dynamics = 0
  if (prev && distance > 1e-6) {
    const v1x = a.x - prev.x
    const v1y = a.y - prev.y
    const v1z = a.z - prev.z
    const l1 = Math.hypot(v1x, v1y, v1z)
    if (l1 > 1e-6) {
      const dot = (v1x * dx + v1y * dy + v1z * dz) / (l1 * distance)
      const c = Math.max(-1, Math.min(1, dot))
      // 偏转 180° -> 2，直线 -> 0
      smooth = 1 - c

      // 转弯角（水平面投影）
      const h1 = Math.hypot(v1x, v1z)
      const h2 = Math.hypot(dx, dz)
      if (h1 > 1e-6 && h2 > 1e-6) {
        const hd = (v1x * dx + v1z * dz) / (h1 * h2)
        const turn = Math.acos(Math.max(-1, Math.min(1, hd))) * RAD2DEG
        if (turn > plan.dynamics.maxTurnAngle) {
          dynamics += (turn - plan.dynamics.maxTurnAngle) / plan.dynamics.maxTurnAngle
        }
      }
      // 爬升角
      const climb = Math.atan2(Math.abs(dy), Math.max(h2, 1e-6)) * RAD2DEG
      if (climb > plan.dynamics.maxClimbAngle) {
        dynamics += (climb - plan.dynamics.maxClimbAngle) / plan.dynamics.maxClimbAngle
      }
    }
  }

  // 能耗模型（归一化 kJ 当量）：
  // 平飞克服诱导/寄生阻力的单位距离功 ~ 巡航速度比的平方；
  // 高度变化做正/负功（爬升耗能、下滑回收 30%）。
  const speed = (plan.speedMin + plan.speedMax) / 2
  const speedRatio = speed / Math.max(plan.speedMax, 1)
  const levelWork = distance * (0.35 + 0.65 * speedRatio * speedRatio)
  const climbWork = dy > 0 ? dy * 2.2 : dy * 0.6
  const energy = Math.max(0, levelWork + climbWork) / 1000

  return { distance, threat, altitude, nofly, smooth, energy, dynamics }
}

/** 加权汇总单段代价（七维） */
export function weightedCost(c: SegmentCosts, w: CostWeights): number {
  return (
    c.distance * w.distance +
    c.threat * w.threat +
    c.altitude * w.altitude +
    c.nofly * w.nofly +
    c.smooth * c.distance * w.smooth +
    c.energy * w.energy +
    c.dynamics * c.distance * w.dynamics
  )
}

export function zeroWeights(): CostWeights {
  return {
    distance: 0,
    threat: 0,
    altitude: 0,
    nofly: 0,
    smooth: 0,
    energy: 0,
    dynamics: 0
  }
}

function zeroObjectives(): ObjectiveVector {
  return {
    distance: 0,
    threat: 0,
    altitude: 0,
    nofly: 0,
    smooth: 0,
    energy: 0,
    dynamics: 0
  }
}

/**
 * 汇总整条路径：
 * - total 加权标量代价
 * - objectives 七维未加权目标向量（多目标/Pareto 口径）
 * - breakdown 各维度加权后代价（UI 分量条）
 */
export function evaluatePath(
  env: Environment,
  path: Vec3[],
  w: CostWeights,
  plan: PlanParams
): {
  total: number
  breakdown: CostWeights
  objectives: ObjectiveVector
} {
  const raw = zeroObjectives()
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const prev = i >= 2 ? path[i - 2] : null
    const c = segmentCosts(env, prev, path[i - 1], path[i], plan)
    raw.distance += c.distance
    raw.threat += c.threat
    raw.altitude += c.altitude
    raw.nofly += c.nofly
    raw.smooth += c.smooth
    raw.energy += c.energy
    raw.dynamics += c.dynamics
    total += weightedCost(c, w)
  }
  return {
    total,
    objectives: { ...raw },
    breakdown: {
      distance: raw.distance * w.distance,
      threat: raw.threat * w.threat,
      altitude: raw.altitude * w.altitude,
      nofly: raw.nofly * w.nofly,
      smooth: raw.smooth * w.smooth,
      energy: raw.energy * w.energy,
      dynamics: raw.dynamics * w.dynamics
    }
  }
}

/** 每段的累积加权代价曲线（用于 UI 代价曲线） */
export function cumulativeCostCurve(
  env: Environment,
  path: Vec3[],
  w: CostWeights,
  plan: PlanParams
): { distance: number; cumulative: number; point: Vec3 }[] {
  const curve: { distance: number; cumulative: number; point: Vec3 }[] = [
    { distance: 0, cumulative: 0, point: path[0] }
  ]
  let cum = 0
  let d = 0
  for (let i = 1; i < path.length; i++) {
    const prev = i >= 2 ? path[i - 2] : null
    const c = segmentCosts(env, prev, path[i - 1], path[i], plan)
    cum += weightedCost(c, w)
    d += c.distance
    curve.push({ distance: d, cumulative: cum, point: path[i] })
  }
  return curve
}

/** 单独评估路径的七维未加权目标向量（批量实验/Pareto 复用） */
export function pathObjectives(
  env: Environment,
  path: Vec3[],
  plan: PlanParams
): ObjectiveVector {
  if (path.length < 2) return zeroObjectives()
  return evaluatePath(env, path, zeroWeights(), plan).objectives
}
