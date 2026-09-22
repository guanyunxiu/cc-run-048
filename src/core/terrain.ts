import type { TerrainParams, Vec3 } from '@/types'
import { SimplexNoise } from '@/utils/noise'
import { clamp } from '@/utils/math3d'

export interface TerrainData {
  params: TerrainParams
  /** 世界坐标范围（以原点为中心） */
  halfSize: number
  /** (segments+1) x (segments+1) 高程网格 */
  heights: Float32Array
  gridSize: number
}

let cached: { key: string; data: TerrainData } | null = null

function cacheKey(p: TerrainParams): string {
  return JSON.stringify(p)
}

/** 程序化生成地形高程（FBM + 山脊 + 可选峡谷） */
export function generateTerrain(params: TerrainParams): TerrainData {
  const key = cacheKey(params)
  if (cached && cached.key === key) return cached.data

  const { size, segments, seed, heightScale, noiseScale, ridgeScale, canyon } =
    params
  const n = segments + 1
  const heights = new Float32Array(n * n)
  const noise = new SimplexNoise(seed)
  const half = size / 2

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = (ix / segments) * size - half
      const wz = (iz / segments) * size - half

      // 基础起伏：多层 FBM
      const base =
        noise.fbm((wx + 1000) * noiseScale, (wz + 1000) * noiseScale, 5) *
          0.5 +
        0.5 // 0..1

      // 山脊噪声：1-|noise| 形成锐利山脊
      const ridge =
        Math.pow(
          1 - Math.abs(noise.noise2D(wx * noiseScale * 1.6, wz * noiseScale * 1.6)),
          2
        )

      let h = base * heightScale * 0.55 + ridge * ridgeScale

      // 峡谷：沿世界 x 轴方向挖出一条蜿蜒低谷
      if (canyon) {
        const meander =
          noise.noise2D(wx * 0.004 + 50, 7.3) * size * 0.06
        const d = Math.abs(wz - meander)
        const canyonWidth = size * 0.05
        const cut = Math.exp(-(d * d) / (2 * canyonWidth * canyonWidth))
        h = h * (1 - cut * 0.92) + 2 * cut
      }

      // 边缘略抬，形成围合地形
      const edge =
        Math.max(Math.abs(wx), Math.abs(wz)) / half // 0 中心 -> 1 边缘
      const edgeRamp = Math.max(0, (edge - 0.8) / 0.2)
      h += edgeRamp * edgeRamp * heightScale * 0.35

      heights[iz * n + ix] = Math.max(0, h)
    }
  }

  const data: TerrainData = {
    params,
    halfSize: half,
    heights,
    gridSize: n
  }
  cached = { key, data }
  return data
}

/** 双线性插值查询任意世界 (x,z) 处的地表高程 */
export function sampleHeight(terrain: TerrainData, x: number, z: number): number {
  const { halfSize, heights, gridSize, params } = terrain
  const gx = ((x + halfSize) / params.size) * (gridSize - 1)
  const gz = ((z + halfSize) / params.size) * (gridSize - 1)
  const x0 = Math.floor(gx)
  const z0 = Math.floor(gz)
  const x1 = Math.min(x0 + 1, gridSize - 1)
  const z1 = Math.min(z0 + 1, gridSize - 1)
  const cx = clamp(x0, 0, gridSize - 1)
  const cz = clamp(z0, 0, gridSize - 1)
  const tx = clamp(gx - x0, 0, 1)
  const tz = clamp(gz - z0, 0, 1)

  const h00 = heights[cz * gridSize + cx]
  const h10 = heights[cz * gridSize + x1]
  const h01 = heights[z1 * gridSize + cx]
  const h11 = heights[z1 * gridSize + x1]
  const a = h00 + (h10 - h00) * tx
  const b = h01 + (h11 - h01) * tx
  return a + (b - a) * tz
}

export function isInsideTerrain(terrain: TerrainData, p: Vec3, margin = 0): boolean {
  const b = terrain.halfSize - margin
  return (
    p.x >= -b && p.x <= b && p.z >= -b && p.z <= b && p.y >= 0
  )
}
