// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  defaultDynamicEntities,
  defaultNoFlyZones,
  defaultObstacles,
  defaultPlanParams,
  defaultTerrain,
  defaultThreats,
  defaultWaypoints,
  defaultWeights
} from '@/core/defaults'
import type { WorkerRequest, WorkerResponse } from '@/workers/planner.worker'

/**
 * Node 下无 DedicatedWorkerGlobalScope，构造一个假的 self，
 * 捕获 worker 模块注册的 onmessage，并接收其 postMessage 结果。
 */
interface WorkerHarness {
  send: (m: WorkerRequest) => void
  received: WorkerResponse[]
}

function loadWorker(): Promise<WorkerHarness> {
  return new Promise((resolve) => {
    const received: WorkerResponse[] = []
    const fakeGlobal: any = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(m: WorkerResponse) {
        received.push(m)
      }
    }
    const prevSelf = (globalThis as any).self
    ;(globalThis as any).self = fakeGlobal
    import('@/workers/planner.worker.ts').then(() => {
      ;(globalThis as any).self = prevSelf
      resolve({
        received,
        send: (m: WorkerRequest) =>
          fakeGlobal.onmessage?.({ data: m } as MessageEvent)
      })
    })
  })
}

describe('planner.worker 消息协议', () => {
  it('plan 请求返回 plan-done（默认场景成功）', async () => {
    const w = await loadWorker()
    w.send({
      type: 'plan',
      terrain: defaultTerrain,
      threats: defaultThreats(),
      noflyZones: defaultNoFlyZones(),
      obstacles: defaultObstacles(),
      dynamics: defaultDynamicEntities(),
      waypoints: defaultWaypoints(),
      planParams: defaultPlanParams,
      weights: defaultWeights,
      smoothing: 'bspline'
    })
    // 等待若干轮事件循环（worker 内为同步计算后 postMessage）
    await vi.waitFor(
      () => expect(w.received.length).toBe(1),
      { timeout: 10000 }
    )
    const res = w.received[0]
    expect(res.type).toBe('plan-done')
    if (res.type === 'plan-done') {
      expect(res.result.success).toBe(true)
      expect(res.workerMs).toBeGreaterThanOrEqual(0)
      expect(res.result.smoothPath.length).toBeGreaterThan(5)
    }
  })
})
