import PlannerWorker from '@/workers/planner.worker.ts?worker'
import type {
  BatchRequest,
  BatchResponse,
  ParetoRequest,
  ParetoResponse,
  PlanRequest,
  PlanResponse,
  ProgressResponse,
  WorkerRequest,
  WorkerResponse
} from '@/workers/planner.worker'

/**
 * 规划 Worker 池（迭代三功能04：并行搜索 / 批量实验）。
 * - 懒创建、容量上限（不超过 hardwareConcurrency-1）
 * - 每个请求带 id，响应按 id 路由（单个 Worker 可串行处理多任务）
 * - 支持 batch / pareto 重任务与 progress 进度回调
 */
export class PlannerWorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: {
    req: WorkerRequest
    resolve: (res: WorkerResponse) => void
    reject: (err: Error) => void
    onProgress?: (p: number) => void
  }[] = []
  private seq = 1
  private capacity: number

  constructor(capacity?: number) {
    const cores =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4
    this.capacity = capacity ?? Math.max(1, Math.min(4, cores - 1))
  }

  private getId(): number {
    return this.seq++
  }

  private acquire(): Worker {
    let w = this.idle.pop()
    if (!w && this.workers.length < this.capacity) {
      w = new PlannerWorker()
      this.workers.push(w)
    }
    return w!
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const w = this.acquire.bind(this)()
      if (!w) break // 全部繁忙，等回收
      const job = this.queue.shift()!
      const { req, resolve, reject, onProgress } = job
      const id = this.getId()
      const tagged = { ...req, id } as WorkerRequest & { id: number }

      const cleanup = () => {
        w.onmessage = null
        w.onerror = null
        this.idle.push(w)
        this.pump()
      }
      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as WorkerResponse | ProgressResponse
        if (msg.type === 'progress') {
          onProgress?.(msg.progress)
          return
        }
        cleanup()
        resolve(msg)
      }
      w.onerror = (e: ErrorEvent) => {
        cleanup()
        reject(new Error(e.message))
      }
      try {
        w.postMessage(tagged)
      } catch (err) {
        cleanup()
        reject(err as Error)
      }
    }
  }

  exec(req: WorkerRequest, onProgress?: (p: number) => void): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject, onProgress })
      this.pump()
    })
  }

  /** 单次规划（类型安全封装） */
  plan(req: Omit<PlanRequest, 'type'>): Promise<PlanResponse> {
    return this.exec({ ...req, type: 'plan' } as PlanRequest).then((r) => r as PlanResponse)
  }

  /** 批量实验 */
  batch(req: Omit<BatchRequest, 'type'>, onProgress?: (p: number) => void): Promise<BatchResponse> {
    return this.exec({ ...req, type: 'batch' } as BatchRequest, onProgress).then(
      (r) => r as BatchResponse
    )
  }

  /** Pareto 权重扫描 */
  pareto(req: Omit<ParetoRequest, 'type'>, onProgress?: (p: number) => void): Promise<ParetoResponse> {
    return this.exec({ ...req, type: 'pareto' } as ParetoRequest, onProgress).then(
      (r) => r as ParetoResponse
    )
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.idle = []
    this.queue = []
  }
}
