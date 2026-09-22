import { describe, expect, it } from 'vitest'
import { detectCapabilities, resetCapabilitiesCache } from '@/core/capabilities'
import { computeFieldGrid } from '@/core/webgpu-field'
import { PerfMonitor } from '@/core/perf-monitor'
import type { TerrainParams } from '@/types'

const terrain: TerrainParams = {
  size: 400, segments: 24, seed: 1, heightScale: 60,
  noiseScale: 0.003, ridgeScale: 20, canyon: false
}

describe('迭代三：能力检测', () => {
  it('返回完整能力对象且检测结果缓存', () => {
    resetCapabilitiesCache()
    const caps = detectCapabilities()
    expect(typeof caps.webgpu).toBe('boolean')
    expect(typeof caps.webgl2).toBe('boolean')
    expect(typeof caps.webWorker).toBe('boolean')
    expect(typeof caps.offscreenCanvas).toBe('boolean')
    expect(caps.hardwareConcurrency).toBeGreaterThan(0)
    // 第二次走缓存
    expect(detectCapabilities()).toBe(caps)
    resetCapabilitiesCache()
  })
})

describe('迭代三：WebGPU 场计算（无 GPU 时 CPU 回退）', () => {
  it('威胁场返回正确尺寸网格，CPU 后端可用', async () => {
    const res = await computeFieldGrid(
      terrain,
      {
        threats: [
          { x: 0, z: 0, radius: 100, level: 5, heightMin: 0, heightMax: 300 }
        ],
        nofly: []
      },
      'threat',
      100
    )
    expect(res.gridSize).toBe(25)
    expect(res.data).toHaveLength(25 * 25)
    // node 环境无 WebGPU，应回退 CPU
    expect(res.backend).toBe('cpu')
    expect(res.computeMs).toBeGreaterThanOrEqual(0)
    // 威胁中心（网格中心）强度最高
    const center = res.data[12 * 25 + 12]
    const corner = res.data[0]
    expect(center).toBeGreaterThan(corner)
    expect(center).toBeGreaterThan(0)
  })

  it('clearance 模式地形低处值更大', async () => {
    const res = await computeFieldGrid(
      terrain,
      { threats: [], nofly: [] },
      'clearance',
      100
    )
    // 至少有非零值（净空不足区域）
    let nonZero = 0
    for (const v of res.data) if (v > 0.01) nonZero++
    expect(nonZero).toBeGreaterThan(0)
  })
})

describe('迭代三：性能监控', () => {
  it('采样后产出 FPS/帧耗时统计并可导出 CSV', () => {
    const mon = new PerfMonitor()
    for (let i = 0; i < 120; i++) {
      mon.sample(i * 16.7, { render: { calls: 10 + i, triangles: 5000 } })
    }
    const latest = mon.latest
    expect(latest.calls).toBeGreaterThanOrEqual(0)
    // 120 帧 × 16.7ms ≈ 2s，应有 1~2 个秒级采样
    expect(mon.history.length).toBeGreaterThanOrEqual(1)
    mon.setPlanTime(42.5)
    expect(mon.latest.planMs).toBe(42.5)
    const csv = mon.toCsv()
    expect(csv.startsWith('fps,frameMs,drawCalls,triangles,heapMB')).toBe(true)
  })

  it('空监控瞬时 FPS 为 0', () => {
    const mon = new PerfMonitor()
    expect(mon.instantFps).toBe(0)
  })
})
