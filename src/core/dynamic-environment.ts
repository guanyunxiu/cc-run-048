import type { DynamicEntity, Vec3 } from '@/types'
import { Environment } from './environment'
import type {
  BuildingObstacle,
  NoFlyZone,
  TerrainParams,
  ThreatZone
} from '@/types'
import { clamp } from '@/utils/math3d'

export interface DynamicState {
  position: Vec3
  active: boolean
}

/**
 * 动态环境（功能02）：在静态 Environment 之上叠加
 * 移动障碍物（硬碰撞球）与突发/动态威胁（时变圆柱场）。
 * t=0 时动态实体退化为按初始状态判定，全局规划口径与迭代一一致
 * （默认场景中静态威胁与建筑承担主要约束）。
 */
export class DynamicEnvironment extends Environment {
  dynamics: DynamicEntity[]

  constructor(
    terrainParams: TerrainParams,
    threats: ThreatZone[],
    noflyZones: NoFlyZone[],
    obstacles: BuildingObstacle[],
    dynamics: DynamicEntity[] = []
  ) {
    super(terrainParams, threats, noflyZones, obstacles)
    this.dynamics = dynamics
  }

  /** 某实体在仿真时刻 t 的状态（位置 + 是否激活）。
   * 激活条件：实体总开关 active 且处于调度时间窗 [enableAt, disableAt)。 */
  stateAt(e: DynamicEntity, t: number): DynamicState {
      const active = e.active && t >= e.enableAt && t < e.disableAt
    return { position: entityPosition(e, t), active }
  }

  /** 当前激活的移动障碍状态（t 时刻） */
  activeObstacles(t: number): { entity: DynamicEntity; position: Vec3 }[] {
    const out: { entity: DynamicEntity; position: Vec3 }[] = []
    for (const e of this.dynamics) {
      if (e.kind !== 'obstacle') continue
      const st = this.stateAt(e, t)
      if (st.active) out.push({ entity: e, position: st.position })
    }
    return out
  }

  /** 点是否被移动障碍球（按 clearance 膨胀）阻挡；球心为实体位置 */
  hitsDynamicObstacle(p: Vec3, clearance: number, t: number): boolean {
    for (const e of this.dynamics) {
      if (e.kind !== 'obstacle') continue
      const st = this.stateAt(e, t)
      if (!st.active) continue
      const r = e.radius + clearance
      if (
        Math.hypot(
          p.x - st.position.x,
          p.y - st.position.y,
          p.z - st.position.z
        ) <= r
      ) {
        return true
      }
    }
    return false
  }

  /** 点是否进入激活的动态威胁圆柱（按 clearance 膨胀，t 时刻） */
  hitsDynamicThreat(p: Vec3, clearance: number, t: number): boolean {
    for (const e of this.dynamics) {
      if (e.kind !== 'threat') continue
      const st = this.stateAt(e, t)
      if (!st.active) continue
      if (p.y < e.heightMin - clearance || p.y > e.heightMax + clearance)
        continue
      const d = Math.hypot(p.x - st.position.x, p.z - st.position.z)
      if (d <= e.threatRadius + clearance) return true
    }
    return false
  }

  /** 单个动态威胁实体在 p 点、t 时刻的场强（0 表示在威胁场外） */
  dynamicThreatIntensityBy(e: DynamicEntity, p: Vec3, t: number): number {
    if (e.kind !== 'threat') return 0
    const st = this.stateAt(e, t)
    if (!st.active) return 0
    if (p.y < e.heightMin || p.y > e.heightMax) return 0
    const d = Math.hypot(p.x - st.position.x, p.z - st.position.z)
    if (d >= e.threatRadius) return 0
    const f = 1 - d / e.threatRadius
    return (clamp(e.level, 1, 5) / 5) * f * f
  }

  /** 综合碰撞（静态 + 动态，时刻 t） */
  isBlockedAt(p: Vec3, clearance: number, t: number): boolean {
    if (this.isBlocked(p, clearance)) return true
    return this.hitsDynamicObstacle(p, clearance, t)
  }

  /** 动态威胁强度（t 时刻，激活的 threat 实体按圆柱场叠加） */
  dynamicThreatIntensity(p: Vec3, t: number): number {
    let sum = 0
    for (const e of this.dynamics) {
      sum += this.dynamicThreatIntensityBy(e, p, t)
    }
    return sum
  }

  /** 含动态威胁的总暴露强度 */
  totalThreatAt(p: Vec3, t: number): number {
    return this.threatIntensity(p) + this.dynamicThreatIntensity(p, t)
  }

  /**
   * 时空航段可行性（在线重规划核心）：
   * 无人机沿 a->b 由 t0 运动到 t1 时，是否与各时刻移动障碍碰撞。
   * 使用端点时刻线性插值（调用方按轨迹相邻采样点传入即可对齐）。
   * avoidThreats=true 时把激活的动态威胁圆柱也视为不可进入
   * （局部绕飞突发威胁用；全局评估口径不变）。
   */
  isSegmentFeasibleSpacetime(
    a: Vec3,
    b: Vec3,
    clearance: number,
    t0: number,
    t1: number,
    sampleStep = 8,
    avoidThreats = false
  ): boolean {
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const steps = Math.max(1, Math.ceil(length / sampleStep))
    for (let i = 0; i <= steps; i++) {
      const f = i / steps
      const p: Vec3 = {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f
      }
      if (this.isBlocked(p, clearance)) return false
      const time = t0 + (t1 - t0) * f
      if (this.hitsDynamicObstacle(p, clearance, time)) return false
      if (avoidThreats && this.hitsDynamicThreat(p, clearance, time)) {
        return false
      }
    }
    return true
  }

  /** 时空航段可行性（恒定速度便捷重载） */
  isSegmentFeasibleSpacetimeSpeed(
    a: Vec3,
    b: Vec3,
    clearance: number,
    t0: number,
    speed: number,
    sampleStep = 8,
    avoidThreats = false
  ): boolean {
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const t1 = t0 + length / Math.max(speed, 1)
    return this.isSegmentFeasibleSpacetime(
      a,
      b,
      clearance,
      t0,
      t1,
      sampleStep,
      avoidThreats
    )
  }

  /**
   * 动态障碍物对已时间对齐航段（a@t0 -> b@t1）的时空最近距离。
   * 返回最近球心距减去障碍半径；Infinity 表示附近无激活障碍。
   */
  spacetimeClearance(
    a: Vec3,
    b: Vec3,
    t0: number,
    t1: number,
    sampleStep = 10
  ): number {
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const steps = Math.max(1, Math.ceil(length / sampleStep))
    let best = Infinity
    for (const e of this.dynamics) {
      if (e.kind !== 'obstacle') continue
      for (let i = 0; i <= steps; i++) {
        const f = i / steps
        const px = a.x + (b.x - a.x) * f
        const py = a.y + (b.y - a.y) * f
        const pz = a.z + (b.z - a.z) * f
        const time = t0 + (t1 - t0) * f
        const st = this.stateAt(e, time)
        if (!st.active) continue
        const centerDist = Math.hypot(
          px - st.position.x,
          py - st.position.y,
          pz - st.position.z
        )
        const d = centerDist - e.radius
        if (d < best) best = d
      }
    }
    return best
  }
}

/**
 * 实体在时刻 t 的位置：
 * - static：初始位置
 * - linear：position -> target 往返
 * - patrol：沿 patrolPoints 折线往返（乒乓）
 */
export function entityPosition(e: DynamicEntity, t: number): Vec3 {
  if (e.motion === 'static' || e.speed <= 0) return { ...e.position }
  const pts = e.motion === 'patrol' && e.patrolPoints.length >= 2
    ? e.patrolPoints
    : [e.position, e.target]
  if (pts.length < 2) return { ...e.position }

  // 各段长度与一圈（去+回）总长度
  const segLens: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(
      pts[i].x - pts[i - 1].x,
      pts[i].y - pts[i - 1].y,
      pts[i].z - pts[i - 1].z
    )
    segLens.push(l)
    total += l
  }
  const cycle = total * 2
  if (cycle < 1e-6) return { ...pts[0] }

  let s = (e.speed * t) % cycle
  if (s < 0) s += cycle
  const forward = s < total
  if (!forward) s = cycle - s // 回程：距离反向映射

  // 沿正向折线定位
  let acc = 0
  for (let i = 0; i < segLens.length; i++) {
    if (s <= acc + segLens[i] || i === segLens.length - 1) {
      const local = Math.max(0, s - acc)
      const k = segLens[i] > 1e-9 ? local / segLens[i] : 0
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * k,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * k,
        z: pts[i].z + (pts[i + 1].z - pts[i].z) * k
      }
    }
    acc += segLens[i]
  }
  return { ...pts[pts.length - 1] }
}

/** 预测轨迹点（t0 起 horizon 秒内，等间隔采样） */
export function predictPath(
  e: DynamicEntity,
  t0: number,
  horizon: number,
  samples = 24
): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i <= samples; i++) {
    out.push(entityPosition(e, t0 + (horizon * i) / samples))
  }
  return out
}
