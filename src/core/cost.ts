import type {
  CostWeights,
  ObjectiveKey,
  ObjectiveVector,
  PlanParams,
  Vec3
} from '@/types'
import type { Environment } from './environment'
import { climbAngleRad, turnAngleRad } from './dynamics'

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
  /** 能耗代价（千焦 kJ，迭代三） */
  energy: number
  /** 动力学惩罚（转角/爬升越限的无量纲积分，迭代三） */
  dynamics: number
}

export const OBJECTIVE_KEYS: ObjectiveKey[] = [
  'distance',
  'threat',
  'altitude',
  'nofly',
  'smooth',
  'energy',
  'dynamics'
]

export function zeroObjectives(): ObjectiveVector {
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
 * 单段能耗估算（简化能量模型，迭代三）：
 * - 平飞：阻力功率 × 时间，阻力 = 寄生阻力 cd·v² + 诱导阻力 K/v²
 * - 爬升/下降：势能变化 / 爬升效率（下降回收部分能量）
 * 返回该段总耗能（kJ）。
 */
export function segmentEnergy(a: Vec3, b: Vec3, plan: PlanParams): number {
  const e = plan.energy
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const distance = Math.hypot(dx, dy, dz)
  if (distance < 1e-9) return 0
  const v = Math.max((plan.speedMin + plan.speedMax) / 2, 1)
  const dt = distance / v
  // 阻力（N）：寄生 + 诱导
  const drag = e.dragCoeff * v * v + (e.inducedFactor * e.mass * e.gravity) / (v * v)
  // 平飞克服阻力做功
  let work = drag * distance
  // 爬升势能（正），下降回收（按效率的倒数折减，不做负功惩罚）
  const dh = b.y - a.y
  if (dh > 0) work += (e.mass * e.gravity * dh) / Math.max(e.climbEfficiency, 1e-3)
  else work += e.mass * e.gravity * dh * e.climbEfficiency
  // J -> kJ
  return Math.max(0, work) / 1000
}

/**
 * 单段动力学惩罚（迭代三）：
 * 水平转角超过最大转弯角、爬升角超过最大爬升角的越限量积分。
 * 返回无量纲惩罚量（按段长归一，避免长航程天然吃亏）。
 */
export function segmentDynamicsPenalty(
  prev: Vec3 | null,
  a: Vec3,
  b: Vec3,
  plan: PlanParams
): number {
  const dyn = plan.dynamics
  const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  if (distance < 1e-9) return 0
  let penalty = 0
  if (prev) {
    const turn = turnAngleRad(prev, a, b) * (180 / Math.PI)
    if (turn > dyn.maxTurnAngle) {
      penalty += (turn - dyn.maxTurnAngle) / dyn.maxTurnAngle
    }
  }
  const climb = Math.abs(climbAngleRad(a, b)) * (180 / Math.PI)
  if (climb > dyn.maxClimbAngle) {
    penalty += (climb - dyn.maxClimbAngle) / dyn.maxClimbAngle
  }
  // 归一化到每 100m
  return penalty * (distance / 100)
}

/**
 * 计算航段 a->b 的基础（未加权）代价分量。
 * prev 为 a 的前一节点，用于转角平滑惩罚。
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
  const altitude =
    env.integrateField(
      a,
      b,
      (p) => Math.abs(p.y - plan.cruiseAlt) / Math.max(plan.cruiseAlt, 1)
    )

  let smooth = 0
  if (prev) {
    const v1x = a.x - prev.x
    const v1y = a.y - prev.y
    const v1z = a.z - prev.z
    const l1 = Math.hypot(v1x, v1y, v1z)
    if (l1 > 1e-6) {
      const dot = (v1x * dx + v1y * dy + v1z * dz) / (l1 * distance)
      const c = Math.max(-1, Math.min(1, dot))
      // 偏转 180° -> 2，直线 -> 0
      smooth = 1 - c
    }
  }

  return {
    distance,
    threat,
    altitude,
    nofly,
    smooth,
    energy: segmentEnergy(a, b, plan),
    dynamics: segmentDynamicsPenalty(prev, a, b, plan)
  }
}

/** 加权汇总单段代价 */
export function weightedCost(c: SegmentCosts, w: CostWeights): number {
  return (
    c.distance * w.distance +
    c.threat * w.threat +
    c.altitude * w.altitude +
    c.nofly * w.nofly +
    c.smooth * c.distance * w.smooth +
    c.energy * (w.energy ?? 0) +
    c.dynamics * (w.dynamics ?? 0)
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

/** 汇总整条路径的加权代价、加权分量与未加权目标向量 */
export function evaluatePath(
  env: Environment,
  path: Vec3[],
  w: CostWeights,
  plan: PlanParams
): { total: number; breakdown: CostWeights; objectives: ObjectiveVector } {
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
      energy: raw.energy * (w.energy ?? 0),
      dynamics: raw.dynamics * (w.dynamics ?? 0)
    }
  }
}

/** 仅计算未加权目标向量（Pareto / 指标对比用，避免重复采样） */
export function pathObjectives(
  env: Environment,
  path: Vec3[],
  plan: PlanParams
): ObjectiveVector {
  const raw = zeroObjectives()
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
  }
  return raw
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
