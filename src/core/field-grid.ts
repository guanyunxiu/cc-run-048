import type { FieldLayerMode, TerrainParams, Vec3 } from '@/types'
import type { Environment } from './environment'
import { clamp } from '@/utils/math3d'

/**
 * 标量场网格（功能03 可视化 / 功能04 分块+LOD）：
 * 在地形包围盒内以规则栅格采样综合代价/威胁强度/安全裕度，
 * 供三维热力图叠加与二维图例使用。
 *
 * 分块（chunking）：栅格按 chunkSize 切块，
 * 视锥裁剪与 LOD 在渲染层按块进行；此处只负责数据。
 */

export type ScalarFieldKind = 'threat' | 'clearance' | 'cost'

export interface FieldGrid {
  kind: ScalarFieldKind
  /** 每维格点数（含边界） */
  resolution: number
  halfSize: number
  /** 采样高度（米，水平面切片） */
  altitude: number
  /** resolution*resolution 行优先（z 外层、x 内层） */
  values: Float32Array
  min: number
  max: number
  /** 分块边长（格点数） */
  chunkSize: number
  chunksX: number
  chunksZ: number
}

export interface FieldGridOptions {
  resolution?: number
  altitude?: number
  chunkSize?: number
  /** 安全距离口径（clearance 模式归一化用） */
  clearance?: number
  /** 巡航高度（cost 模式高度项基准） */
  cruiseAlt?: number
}

/**
 * 构建标量场。
 * - threat：威胁强度（静态环境口径）
 * - clearance：安全裕度 0..1（最近净空/期望净空）
 * - cost：综合代价密度（威胁 + 禁飞 + 高度偏差 + 地形贴近）
 */
export function buildFieldGrid(
  env: Environment,
  kind: ScalarFieldKind,
  options: FieldGridOptions = {}
): FieldGrid {
  const resolution = options.resolution ?? 96
  const altitude = options.altitude ?? env.terrain.params.size * 0.12
  const chunkSize = options.chunkSize ?? 16
  const clearance = options.clearance ?? 12
  const cruiseAlt = options.cruiseAlt ?? 120
  const half = env.terrain.params.size / 2
  const values = new Float32Array(resolution * resolution)

  let min = Infinity
  let max = -Infinity

  for (let iz = 0; iz < resolution; iz++) {
    const z = -half + (iz / (resolution - 1)) * 2 * half
    for (let ix = 0; ix < resolution; ix++) {
      const x = -half + (ix / (resolution - 1)) * 2 * half
      const v = sampleField(
        env,
        kind,
        { x, y: altitude, z },
        clearance,
        cruiseAlt
      )
      values[iz * resolution + ix] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!isFinite(min)) {
    min = 0
    max = 1
  }

  return {
    kind,
    resolution,
    halfSize: half,
    altitude,
    values,
    min,
    max,
    chunkSize,
    chunksX: Math.ceil(resolution / chunkSize),
    chunksZ: Math.ceil(resolution / chunkSize)
  }
}

/** 单点采样（渲染器按高度层动态查询也可直接调用） */
export function sampleField(
  env: Environment,
  kind: ScalarFieldKind,
  p: Vec3,
  clearance: number,
  cruiseAlt: number
): number {
  if (kind === 'threat') {
    return clamp(env.threatIntensity(p), 0, 1.5)
  }
  if (kind === 'clearance') {
    const groundGap = p.y - env.groundHeight(p.x, p.z)
    let minGap = groundGap
    for (const b of env.obstacles) {
      const dx = Math.max(Math.abs(p.x - b.position.x) - b.size.x / 2, 0)
      const dz = Math.max(Math.abs(p.z - b.position.z) - b.size.z / 2, 0)
      const dy = Math.max(b.position.y + b.height - p.y, 0)
      const gap = Math.hypot(dx, dz, dy)
      if (gap < minGap) minGap = gap
    }
    return clamp(minGap / Math.max(clearance, 1), 0, 2)
  }
  // cost：威胁 + 禁飞 + 高度偏差 + 地形净空不足
  const threat = env.threatIntensity(p)
  const nofly = env.noflyPenalty(p) * 0.05
  const altPen = Math.abs(p.y - cruiseAlt) / Math.max(cruiseAlt, 1)
  const groundGap = p.y - env.groundHeight(p.x, p.z)
  const clearPen = groundGap < clearance ? (clearance - groundGap) / clearance : 0
  return threat * 2 + nofly + altPen * 0.5 + clearPen
}

/** 取某个分块的世界包围盒（供视锥裁剪） */
export function chunkBounds(
  grid: FieldGrid,
  cx: number,
  cz: number
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const r = grid.resolution
  const x0 = Math.max(0, cx * grid.chunkSize)
  const x1 = Math.min(r - 1, (cx + 1) * grid.chunkSize - 1)
  const z0 = Math.max(0, cz * grid.chunkSize)
  const z1 = Math.min(r - 1, (cz + 1) * grid.chunkSize - 1)
  const toWorld = (i: number) =>
    -grid.halfSize + (i / (r - 1)) * 2 * grid.halfSize
  return {
    minX: toWorld(x0),
    maxX: toWorld(x1),
    minZ: toWorld(z0),
    maxZ: toWorld(z1)
  }
}

/** 分块内最大值（LOD：远块可用块均值/最大值降采样显示） */
export function chunkMax(grid: FieldGrid, cx: number, cz: number): number {
  let m = -Infinity
  const r = grid.resolution
  const x1 = Math.min(r, (cx + 1) * grid.chunkSize)
  const z1 = Math.min(r, (cz + 1) * grid.chunkSize)
  for (let z = cz * grid.chunkSize; z < z1; z++) {
    for (let x = cx * grid.chunkSize; x < x1; x++) {
      const v = grid.values[z * r + x]
      if (v > m) m = v
    }
  }
  return m
}

/**
 * 生成 LOD 降采样栅格（2×2 平均），
 * 远场景用低分辨率块，配合视锥裁剪降低顶点处理。
 */
export function downsampleGrid(grid: FieldGrid): FieldGrid {
  const r = Math.max(2, Math.floor(grid.resolution / 2))
  const values = new Float32Array(r * r)
  for (let iz = 0; iz < r; iz++) {
    for (let ix = 0; ix < r; ix++) {
      const sx = Math.min(grid.resolution - 1, ix * 2)
      const sz = Math.min(grid.resolution - 1, iz * 2)
      const sx2 = Math.min(grid.resolution - 1, sx + 1)
      const sz2 = Math.min(grid.resolution - 1, sz + 1)
      values[iz * r + ix] =
        (grid.values[sz * grid.resolution + sx] +
          grid.values[sz * grid.resolution + sx2] +
          grid.values[sz2 * grid.resolution + sx] +
          grid.values[sz2 * grid.resolution + sx2]) /
        4
    }
  }
  return {
    ...grid,
    resolution: r,
    values,
    chunkSize: Math.max(8, Math.floor(grid.chunkSize / 2))
  }
}

/** 标量值 -> RGB 颜色（热力图：蓝(低) → 青 → 黄 → 红(高)） */
export function heatColor(t: number, out: [number, number, number]): void {
  const x = clamp(t, 0, 1)
  // 四段渐变
  const stops: [number, [number, number, number]][] = [
    [0, [0.1, 0.25, 0.6]],
    [0.35, [0.05, 0.6, 0.75]],
    [0.65, [0.95, 0.85, 0.2]],
    [1, [0.9, 0.12, 0.12]]
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (x <= t1) {
      const k = (x - t0) / Math.max(t1 - t0, 1e-9)
      out[0] = c0[0] + (c1[0] - c0[0]) * k
      out[1] = c0[1] + (c1[1] - c0[1]) * k
      out[2] = c0[2] + (c1[2] - c0[2]) * k
      return
    }
  }
  out[0] = stops[stops.length - 1][1][0]
  out[1] = stops[stops.length - 1][1][1]
  out[2] = stops[stops.length - 1][1][2]
}

/** 安全裕度值 -> RGB（红(不足) → 黄 → 绿(充足)） */
export function clearanceColor(t: number, out: [number, number, number]): void {
  const x = clamp(t, 0, 1)
  out[0] = 0.9 * (1 - x) + 0.12 * x
  out[1] = 0.15 * (1 - x) + 0.8 * x
  out[2] = 0.12 * (1 - x) + 0.25 * x
}

export function modeToKind(mode: FieldLayerMode): ScalarFieldKind | null {
  if (mode === 'off') return null
  return mode
}

/** 离屏栅格化参数序列化键（缓存用，功能04：缓存） */
export function fieldCacheKey(
  terrain: TerrainParams,
  kind: ScalarFieldKind,
  resolution: number,
  altitude: number
): string {
  return `${kind}|${resolution}|${altitude}|${terrain.size}|${terrain.seed}|${terrain.segments}`
}
