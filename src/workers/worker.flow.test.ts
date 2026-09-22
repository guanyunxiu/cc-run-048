// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * jsdom 无原生 Worker。用假 Worker 直接执行与 planner.worker 完全一致的
 * 规划逻辑（同一套 core 模块），验证 store 的 postMessage/onmessage/超时/状态流。
 */
class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  terminated = false
  terminate() {
    this.terminated = true
  }
  async postMessage(msg: any) {
    const [{ Environment }, { planMission }] = await Promise.all([
      import('@/core/environment'),
      import('@/core/planning')
    ])
    if (msg.type === 'plan') {
      const env = new Environment(
        msg.terrain,
        msg.threats,
        msg.noflyZones,
        msg.obstacles
      )
      const result = planMission(
        env,
        msg.waypoints,
        msg.planParams,
        msg.weights,
        { smoothing: msg.smoothing }
      )
      queueMicrotask(() =>
        this.onmessage?.({
          data: { type: 'plan-done', result, workerMs: 12.3 }
        } as MessageEvent)
      )
    }
  }
}

beforeEach(() => {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  setActivePinia(createPinia())
  ;(globalThis as any).Worker = FakeWorker
})

describe('Web Worker 规划链路（store.plan）', () => {
  it('Worker 返回规划结果并生成轨迹、代价曲线、统计', async () => {
    const { useSimStore } = await import('@/stores/sim')
    const { useSceneStore } = await import('@/stores/scene')
    const sim = useSimStore()
    const scene = useSceneStore()

    const result = await sim.plan()
    expect(result.success).toBe(true)
    expect(sim.status).toBe('done')
    expect(sim.smoothPath.length).toBeGreaterThan(10)
    expect(sim.trajectory.length).toBeGreaterThan(10)
    expect(sim.duration).toBeGreaterThan(0)
    expect(sim.stats).not.toBeNull()
    expect(sim.stats!.distance).toBeGreaterThan(300)
    expect(sim.costCurve.length).toBeGreaterThan(5)
    expect(sim.message).toContain('规划成功')

    for (let i = 1; i < sim.costCurve.length; i++) {
      expect(sim.costCurve[i].cumulative).toBeGreaterThanOrEqual(
        sim.costCurve[i - 1].cumulative
      )
    }

    const mid = sim.sampleAt(sim.duration / 2)
    expect(mid).not.toBeNull()
    expect(mid!.speed).toBeGreaterThan(0)

    scene.planParams.algo = 'dijkstra'
    const r2 = await sim.plan()
    expect(r2.success).toBe(true)
  }, 30000)

  it('Worker 报错时进入 failed 状态且不卡死', async () => {
    const { useSimStore } = await import('@/stores/sim')
    const sim = useSimStore()

    class BoomWorker extends FakeWorker {
      async postMessage() {
        queueMicrotask(() =>
          this.onerror?.(new ErrorEvent('error', { message: 'boom' }))
        )
      }
    }
    ;(globalThis as any).Worker = BoomWorker
    const r = await sim.plan()
    expect(r.success).toBe(false)
    expect(sim.status).toBe('failed')
    expect(sim.message).toContain('boom')
  })

  it('发往 Worker 的规划请求可结构化克隆（响应式代理不泄漏）', async () => {
    const { useSimStore } = await import('@/stores/sim')
    const sim = useSimStore()

    let captured: unknown = null
    class CaptureWorker extends FakeWorker {
      async postMessage(msg: any) {
        captured = msg
        await super.postMessage(msg)
      }
    }
    ;(globalThis as any).Worker = CaptureWorker
    const r = await sim.plan()
    expect(r.success).toBe(true)
    expect(captured).not.toBeNull()
    // 浏览器 postMessage 走结构化克隆；响应式 Proxy 会在此抛错
    expect(() => structuredClone(captured)).not.toThrow()
    const cloned = structuredClone(captured) as any
    expect(cloned.terrain.size).toBeGreaterThan(0)
    expect(cloned.waypoints.length).toBeGreaterThan(1)
  })
})
