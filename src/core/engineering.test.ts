import { describe, expect, it, beforeEach } from 'vitest'
import {
  detectWebGPU,
  webgpuLikelySupported,
  tryComputeThreatFieldGPU
} from '@/core/webgpu-field'
import { offscreenSupported, renderHeatTile } from '@/core/offscreen-heat'
import { buildFieldGrid } from '@/core/field-grid'
import { Environment } from '@/core/environment'
import type {
  BuildingObstacle,
  NoFlyZone,
  TerrainParams,
  ThreatZone
} from '@/types'

/**
 * 功能04 工程能力测试：
 * 无头/无 GPU 环境下 WebGPU 必须安全降级（available=false / 返回 null），
 * 不抛异常；OffscreenCanvas 不可用时同样回退。
 */

const terrain: TerrainParams = {
  size: 400,
  segments: 24,
  seed: 1,
  heightScale: 50,
  noiseScale: 0.003,
  ridgeScale: 10,
  canyon: false
}

describe('WebGPU 能力检测与降级', () => {
  beforeEach(() => {
    // node 环境无 navigator.gpu
    ;(globalThis as { navigator?: Navigator }).navigator ??=
      { hardwareConcurrency: 4 } as Navigator
  })

  it('webgpuLikelySupported 返回布尔', () => {
    expect(typeof webgpuLikelySupported()).toBe('boolean')
  })

  it('detectWebGPU 不抛异常并给出明确结论', async () => {
    const support = await detectWebGPU()
    if (!('gpu' in navigator)) {
      expect(support.available).toBe(false)
      expect(support.reason).toBeTruthy()
    }
  })

  it('tryComputeThreatFieldGPU 在无设备时返回 null（走 CPU 回退）', async () => {
    const result = await tryComputeThreatFieldGPU([], 16, 200, 100)
    // node 无 WebGPU -> null
    if (!('gpu' in navigator)) expect(result).toBeNull()
  })
})

describe('OffscreenCanvas 热力图回退', () => {
  it('offscreenSupported 不抛异常', () => {
    expect(() => offscreenSupported()).not.toThrow()
  })

  it('renderHeatTile 在 jsdom/node 缺 canvas 时优雅处理', async () => {
    const env = new Environment(
      terrain,
      [] as ThreatZone[],
      [] as NoFlyZone[],
      [] as BuildingObstacle[]
    )
    const grid = buildFieldGrid(env, 'threat', { resolution: 8 })
    // jsdom 没有真正 2d 上下文时应返回 tile 对象而不抛错
    let threw = false
    try {
      const tile = await renderHeatTile(grid, { cellPx: 2 })
      expect(tile.width).toBe(16)
      expect(tile.height).toBe(16)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
