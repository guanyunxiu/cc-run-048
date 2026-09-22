// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { installWebGLMock } from './webgl-mock'

installWebGLMock()
;(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 16) as unknown as number
;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id)

beforeEach(() => setActivePinia(createPinia()))

import { generateTerrain } from '@/core/terrain'
import { createChunkedTerrain } from '@/three/chunked-terrain'
import * as THREE from 'three'
import type { TerrainParams } from '@/types'
import { defaultTerrain } from '@/core/defaults'

describe('迭代三：分块 LOD 地形', () => {
  it('按 chunks 数量生成独立网格，LOD 切换不抛错', () => {
    const params: TerrainParams = { ...defaultTerrain, segments: 48, size: 600 }
    const terrain = generateTerrain(params)
    const chunked = createChunkedTerrain(terrain, { chunks: 4, lodNear: 300, lodFar: 700 })
    expect(chunked.chunkCount).toBe(16)
    expect(chunked.group.children).toHaveLength(16)
    // 近相机 -> 高 LOD
    chunked.update(new THREE.Vector3(0, 200, 0))
    // 远相机 -> 低 LOD（重建几何不抛错）
    expect(() => chunked.update(new THREE.Vector3(5000, 2000, 5000))).not.toThrow()
    // overlay 不抛错
    expect(() =>
      chunked.applyOverlay(() => null, false)
    ).not.toThrow()
    expect(() =>
      chunked.applyOverlay((x, z) => (x + z > 0 ? new THREE.Color(1, 0, 0) : null), true)
    ).not.toThrow()
    chunked.dispose()
  })
})

describe('迭代三：实例化建筑（InstancedMesh）', () => {
  it('每栋建筑一个实例，拾取可按 instanceId 反查', async () => {
    const { createBuildingsInstanced } = await import('@/three/factory')
    const terrain = generateTerrain({ ...defaultTerrain, segments: 24, size: 400 })
    const buildings = [
      { id: 'b1', name: 'A', position: { x: 0, y: 0, z: 0 }, size: { x: 30, z: 30 }, height: 40 },
      { id: 'b2', name: 'B', position: { x: 80, y: 0, z: 80 }, size: { x: 20, z: 20 }, height: 30 }
    ]
    const inst = createBuildingsInstanced(buildings, terrain)
    expect(inst.mesh.count).toBe(2)
    expect(inst.ids).toEqual(['b1', 'b2'])
    // instanceId 反查
    expect(inst.ids[0]).toBe('b1')
    expect(inst.ids[1]).toBe('b2')
    inst.dispose()
  })
})
