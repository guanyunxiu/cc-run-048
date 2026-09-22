import type {
  BuildingObstacle,
  NoFlyZone,
  ThreatZone,
  Vec3
} from '@/types'
import {
  generateTerrain,
  isInsideTerrain,
  sampleHeight,
  type TerrainData
} from './terrain'
import type { TerrainParams } from '@/types'
import { clamp } from '@/utils/math3d'

/**
 * 环境模型：聚合地形 / 威胁区 / 禁飞区 / 建筑障碍，
 * 提供碰撞检测、威胁暴露强度、禁飞软惩罚等查询，
 * 供规划器（Worker）与渲染/评估共用。
 */
export class Environment {
  terrain: TerrainData
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]

  constructor(
    terrainParams: TerrainParams,
    threats: ThreatZone[],
    noflyZones: NoFlyZone[],
    obstacles: BuildingObstacle[]
  ) {
    this.terrain = generateTerrain(terrainParams)
    this.threats = threats
    this.noflyZones = noflyZones
    this.obstacles = obstacles
  }

  get maxAltitude(): number {
    return Math.max(this.terrain.params.size * 0.3, 200)
  }

  groundHeight(x: number, z: number): number {
    return sampleHeight(this.terrain, x, z)
  }

  inBounds(p: Vec3, margin = 0): boolean {
    return isInsideTerrain(this.terrain, p, margin)
  }

  /** 点是否在某建筑障碍（按 clearance 膨胀）内 */
  private hitsObstacle(p: Vec3, clearance: number): boolean {
    for (const b of this.obstacles) {
      if (
        Math.abs(p.x - b.position.x) <= b.size.x / 2 + clearance &&
        Math.abs(p.z - b.position.z) <= b.size.z / 2 + clearance &&
        p.y <= b.position.y + b.height + clearance &&
        p.y >= b.position.y - clearance
      ) {
        return true
      }
    }
    return false
  }

  /** 点是否进入硬禁飞圆柱（含安全距离膨胀） */
  private hitsHardNoFly(p: Vec3, clearance: number): boolean {
    for (const z of this.noflyZones) {
      if (!z.hardBlock) continue
      const planar = Math.hypot(p.x - z.position.x, p.z - z.position.z)
      if (
        planar <= z.radius + clearance &&
        p.y <= z.heightMax + clearance &&
        p.y >= z.heightMin - clearance
      ) {
        return true
      }
    }
    return false
  }

  /** 点是否满足地形净空（离地 >= clearance） */
  hitsGround(p: Vec3, clearance: number): boolean {
    return p.y < this.groundHeight(p.x, p.z) + clearance
  }

  /** 综合碰撞检测：地形 + 建筑 + 硬禁飞 + 边界 */
  isBlocked(p: Vec3, clearance: number): boolean {
    if (!this.inBounds(p)) return true
    if (this.hitsGround(p, clearance)) return true
    if (this.hitsObstacle(p, clearance)) return true
    if (this.hitsHardNoFly(p, clearance)) return true
    return false
  }

  /**
   * 威胁暴露强度（0..1 量级）：
   * 各威胁区按 level/5 * (1 - d/r)^2 叠加（高度范围内、半径内）。
   */
  threatIntensity(p: Vec3): number {
    let sum = 0
    for (const t of this.threats) {
      if (p.y < t.heightMin || p.y > t.heightMax) continue
      const d = Math.hypot(p.x - t.position.x, p.z - t.position.z)
      if (d >= t.radius) continue
      const f = 1 - d / t.radius
      sum += (clamp(t.level, 1, 5) / 5) * f * f
    }
    return sum
  }

  /** 禁飞区软惩罚强度（hardBlock 的禁飞区不应被进入，此处仅作冗余计罚） */
  noflyPenalty(p: Vec3): number {
    let sum = 0
    for (const z of this.noflyZones) {
      if (p.y < z.heightMin || p.y > z.heightMax) continue
      const d = Math.hypot(p.x - z.position.x, p.z - z.position.z)
      if (d >= z.radius) continue
      const f = 1 - d / z.radius
      sum += z.penalty * f * f
    }
    return sum
  }

  /**
   * 航段可行性检查：沿线密集采样，任何点碰撞即不可行。
   * sampleStep 为采样间距，默认取 clearance 同量级。
   */
  isSegmentFeasible(a: Vec3, b: Vec3, clearance: number, sampleStep = 8): boolean {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    const length = Math.hypot(dx, dy, dz)
    const steps = Math.max(1, Math.ceil(length / sampleStep))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const p: Vec3 = {
        x: a.x + dx * t,
        y: a.y + dy * t,
        z: a.z + dz * t
      }
      if (this.isBlocked(p, clearance)) return false
    }
    return true
  }

  /** 沿线段积分某标量场（用于威胁暴露/惩罚统计） */
  integrateField(
    a: Vec3,
    b: Vec3,
    field: (p: Vec3) => number,
    sampleStep = 10
  ): number {
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const steps = Math.max(1, Math.ceil(length / sampleStep))
    let sum = 0
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps
      const t1 = (i + 1) / steps
      const p0: Vec3 = {
        x: a.x + (b.x - a.x) * t0,
        y: a.y + (b.y - a.y) * t0,
        z: a.z + (b.z - a.z) * t0
      }
      const p1: Vec3 = {
        x: a.x + (b.x - a.x) * t1,
        y: a.y + (b.y - a.y) * t1,
        z: a.z + (b.z - a.z) * t1
      }
      sum += ((field(p0) + field(p1)) / 2) * (length / steps)
    }
    return sum
  }
}
