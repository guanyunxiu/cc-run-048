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
 * Node 下无 DedicatedWorkerGlobalScope。用共享 fake self 加载 worker 模块
 * 一次，postMessage 路由到按 id 注册的接收器；无 id 的消息广播给最近接收者。
 */
interface Inbox {
  messages: (WorkerResponse | { type: 'progress'; progress: number })[]
}

let workerPromise: Promise<void> | null = null
let currentInbox: Inbox | null = null
let fakeSelf: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: any) => void } | null = null

function ensureWorker(): Promise<void> {
  if (!workerPromise) {
    workerPromise = new Promise((resolve) => {
      fakeSelf = {
        onmessage: null,
        postMessage(m: any) {
          currentInbox?.messages.push(m)
        }
      }
      const prevSelf = (globalThis as any).self
      ;(globalThis as any).self = fakeSelf
      import('@/workers/planner.worker.ts').then(() => {
        ;(globalThis as any).self = prevSelf
        resolve()
      })
    })
  }
  return workerPromise
}

function send(m: WorkerRequest): Inbox {
  const inbox: Inbox = { messages: [] }
  currentInbox = inbox
  fakeSelf!.onmessage?.({ data: m } as MessageEvent)
  return inbox
}

const base = {
  terrain: defaultTerrain,
  threats: defaultThreats(),
  noflyZones: defaultNoFlyZones(),
  obstacles: defaultObstacles(),
  dynamics: defaultDynamicEntities(),
  waypoints: defaultWaypoints(),
  planParams: defaultPlanParams,
  weights: defaultWeights
}

describe('迭代三：planner.worker 扩展协议', () => {
  it('batch 请求返回批量实验报告（含聚合统计）', async () => {
    await ensureWorker()
    const inbox = send({
      type: 'batch',
      ...base,
      smoothing: 'polyline',
      algos: ['astar', 'rrt'],
      runsPerAlgo: 2,
      baseSeed: 20260920,
      name: '协议测试'
    })
    await vi.waitFor(
      () => expect(inbox.messages.some((m) => m.type === 'batch-done')).toBe(true),
      { timeout: 20000 }
    )
    const res = inbox.messages.find((m) => m.type === 'batch-done')!
    if (res.type === 'batch-done') {
      expect(res.report.runs).toHaveLength(4)
      expect(res.report.aggregates.astar).toBeDefined()
      expect(res.report.aggregates.astar!.successRate).toBe(100)
      expect(res.report.config.name).toBe('协议测试')
      const progress = inbox.messages.filter((m) => m.type === 'progress') as { progress: number }[]
      expect(progress.length).toBeGreaterThanOrEqual(2)
      expect(progress[progress.length - 1].progress).toBe(1)
    }
  }, 30000)

  it('pareto 请求返回 Pareto 前沿点集', async () => {
    await ensureWorker()
    const inbox = send({
      type: 'pareto',
      ...base,
      smoothing: 'polyline',
      algo: 'astar',
      samples: 8
    })
    await vi.waitFor(
      () => expect(inbox.messages.some((m) => m.type === 'pareto-done')).toBe(true),
      { timeout: 20000 }
    )
    const res = inbox.messages.find((m) => m.type === 'pareto-done')!
    if (res.type === 'pareto-done') {
      expect(res.front.length).toBeGreaterThanOrEqual(1)
      expect(res.all.length).toBeGreaterThanOrEqual(res.front.length)
      for (const p of res.front) expect(p.rank).toBe(0)
    }
  }, 30000)

  it('响应携带请求 id（Worker 池路由）', async () => {
    await ensureWorker()
    const inbox = send({
      type: 'plan',
      ...base,
      smoothing: 'polyline',
      id: 77
    } as WorkerRequest)
    await vi.waitFor(
      () => expect(inbox.messages.some((m) => m.type === 'plan-done')).toBe(true),
      { timeout: 15000 }
    )
    const res = inbox.messages.find((m) => m.type === 'plan-done')!
    expect((res as { id?: number }).id).toBe(77)
  }, 20000)
})
