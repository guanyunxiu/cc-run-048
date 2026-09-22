import * as THREE from 'three'
import type { TerrainData } from '@/core/terrain'
import { sampleHeight } from '@/core/terrain'

/**
 * 分块地形 + LOD（迭代三功能04：大场景分块、LOD、视锥裁剪）。
 * - 将整块 DEM 切成 chunk×chunk 个独立网格，Three.js 自动做视锥裁剪；
 * - 每块根据到相机距离选择两级细分（高/低 LOD），距离阈值切换；
 * - 顶点色在 CPU 侧按 overlay 回调写入，LOD 切换时复用同一颜色逻辑。
 */

export interface ChunkedTerrainOptions {
  chunks?: number
  /** 低 LOD 抽稀步长（格点） */
  lodLowStep?: number
  /** 高 LOD 步长 */
  lodHighStep?: number
  /** 进入高 LOD 的距离（世界单位） */
  lodNear?: number
  /** 低于该距离强制高 LOD */
  lodFar?: number
}

export interface ChunkedTerrain {
  group: THREE.Group
  /** 按当前相机位置更新各块 LOD */
  update(cameraPos: THREE.Vector3): void
  /** 重新计算顶点色（overlay 回调给定每个世界 (x,z) 的 RGB） */
  applyOverlay(
    colorAt: (x: number, z: number) => THREE.Color | null,
    enabled: boolean
  ): void
  dispose(): void
  /** 当前可见块数（视锥裁剪统计由外部 renderer.info 给出） */
  chunkCount: number
}

interface ChunkMesh {
  mesh: THREE.Mesh
  /** 该块覆盖的 DEM 格点范围 [i0,i1] × [j0,j1] */
  i0: number
  i1: number
  j0: number
  j1: number
  cx: number
  cz: number
  currentStep: number
  geometry: THREE.BufferGeometry
}

/** 地形高程配色（与 factory.ts 保持一致） */
function terrainGradient(h: number, maxH: number, out: THREE.Color): THREE.Color {
  const t = Math.max(0, Math.min(1, h / maxH))
  if (t < 0.25) out.setRGB(0.83 + t * 0.3, 0.76 + t * 0.25, 0.52)
  else if (t < 0.55) out.setRGB(0.36 - (t - 0.25) * 0.4, 0.55 - (t - 0.25) * 0.15, 0.28)
  else if (t < 0.8) out.setRGB(0.34 + (t - 0.55) * 0.9, 0.31 + (t - 0.55) * 0.8, 0.28)
  else out.setRGB(0.9, 0.92, 0.95)
  return out
}

export function createChunkedTerrain(
  terrain: TerrainData,
  options: ChunkedTerrainOptions = {}
): ChunkedTerrain {
  const chunks = options.chunks ?? 4
  const lowStep = options.lodLowStep ?? 4
  const highStep = options.lodHighStep ?? 2
  const lodNear = options.lodNear ?? 600
  const lodFar = options.lodFar ?? 1400

  const group = new THREE.Group()
  group.name = 'terrain-chunks'
  const n = terrain.gridSize
  const { size } = terrain.params
  const half = size / 2
  const maxH = Math.max(...terrain.heights, 1)

  const chunkMeshes: ChunkMesh[] = []

  const buildGeometry = (
    i0: number,
    i1: number,
    j0: number,
    j1: number,
    step: number
  ) => {
    const positions: number[] = []
    const colors: number[] = []
    // 本地索引映射：记录每个原始格点 -> 本地顶点索引
    const cols = Math.ceil((i1 - i0) / step) + 1
    const rows = Math.ceil((j1 - j0) / step) + 1
    const indexMap = new Int32Array(cols * rows).fill(-1)

    let vert = 0
    let ci = 0
    for (let j = j0; j <= j1; j += step) {
      let cj = 0
      for (let i = i0; i <= i1; i += step) {
        const x = (i / (n - 1)) * size - half
        const z = (j / (n - 1)) * size - half
        const y = terrain.heights[j * n + i]
        positions.push(x, y, z)
        const c = terrainGradient(y, maxH, new THREE.Color())
        colors.push(c.r, c.g, c.b)
        indexMap[ci * cols + cj] = vert
        vert++
        cj++
      }
      ci++
    }

    const indices: number[] = []
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = indexMap[r * cols + c]
        const b = indexMap[r * cols + c + 1]
        const d = indexMap[(r + 1) * cols + c]
        const e = indexMap[(r + 1) * cols + c + 1]
        indices.push(a, d, b, b, d, e)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    return geo
  }

  const span = Math.ceil((n - 1) / chunks)
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const i0 = cx * span
      const i1 = Math.min((cx + 1) * span, n - 1)
      const j0 = cz * span
      const j1 = Math.min((cz + 1) * span, n - 1)
      const geo = buildGeometry(i0, i1, j0, j1, highStep)
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.02
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.receiveShadow = true
      mesh.name = 'terrain'
      mesh.frustumCulled = true
      group.add(mesh)
      const wcx = (((i0 + i1) / 2) / (n - 1)) * size - half
      const wcz = (((j0 + j1) / 2) / (n - 1)) * size - half
      chunkMeshes.push({
        mesh,
        i0, i1, j0, j1, cx: wcx, cz: wcz,
        currentStep: highStep,
        geometry: geo
      })
    }
  }

  const rebuildChunk = (chunk: ChunkMesh, step: number) => {
    const old = chunk.mesh.geometry
    chunk.geometry = buildGeometry(chunk.i0, chunk.i1, chunk.j0, chunk.j1, step)
    chunk.mesh.geometry = chunk.geometry
    old.dispose()
    chunk.currentStep = step
  }

  return {
    group,
    chunkCount: chunkMeshes.length,
    update(cameraPos: THREE.Vector3) {
      for (const chunk of chunkMeshes) {
        const d = Math.hypot(cameraPos.x - chunk.cx, cameraPos.z - chunk.cz)
        const wantStep = d < lodNear ? highStep : d < lodFar ? Math.min(highStep + 1, lowStep) : lowStep
        if (wantStep !== chunk.currentStep) rebuildChunk(chunk, wantStep)
      }
    },
    applyOverlay(colorAt: (x: number, z: number) => THREE.Color | null, enabled: boolean) {
      for (const chunk of chunkMeshes) {
        const geo = chunk.mesh.geometry
        const pos = geo.getAttribute('position') as THREE.BufferAttribute
        let col = geo.getAttribute('color') as THREE.BufferAttribute | undefined
        if (!col) {
          col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3)
          geo.setAttribute('color', col)
        }
        const c = new THREE.Color()
        for (let v = 0; v < pos.count; v++) {
          const x = pos.getX(v)
          const z = pos.getZ(v)
          const y = pos.getY(v)
          if (enabled) {
            const ov = colorAt(x, z)
            if (ov) {
              col.setXYZ(v, ov.r, ov.g, ov.b)
              continue
            }
          }
          terrainGradient(y, maxH, c)
          col.setXYZ(v, c.r, c.g, c.b)
        }
        col.needsUpdate = true
      }
    },
    dispose() {
      for (const chunk of chunkMeshes) {
        chunk.geometry.dispose()
        ;(chunk.mesh.material as THREE.Material).dispose()
      }
    }
  }
}

/** 便捷：世界 (x,z) 地表高程（供 overlay 计算复用） */
export function groundHeightAt(terrain: TerrainData, x: number, z: number): number {
  return sampleHeight(terrain, x, z)
}
