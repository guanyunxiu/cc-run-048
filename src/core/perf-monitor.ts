import type { PerfSample, RenderBackend } from '@/types'

/**
 * 实时性能监控（功能04）：
 * - FPS / 帧耗时（滑动窗口）
 * - 规划耗时（由 Worker/本地规划上报）
 * - 内存占用（performance.memory，Chromium 口径，其他浏览器为 0）
 * - draw calls / triangles（由渲染器每帧上报）
 * 环形缓冲保留最近 maxSamples 个采样。
 */

interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number

}

export class PerformanceMonitor {
  private samples: PerfSample[] = []
  private maxSamples = 240
  private frameTimes: number[] = []
  private lastFrame = 0
  private startTime =
    typeof performance !== 'undefined' ? performance.now() : 0
  private _fps = 0
  private _frameMs = 0
  private _planMs = 0
  private _drawCalls = 0
  private _triangles = 0
  private _usedMB = 0
  backend: RenderBackend = 'webgl2'
  /** 累计规划调用数 */
  planCount = 0
  /** 累计 Worker 池排队任务数 */
  queuedTasks = 0
  private accumulator = 0

  /** 每帧调用，dtMs 为本帧间隔毫秒 */
  recordFrame(dtMs: number, renderInfo?: { calls: number; triangles: number }) {
    this.frameTimes.push(dtMs)
    if (this.frameTimes.length > 60) this.frameTimes.shift()
    this._frameMs = average(this.frameTimes)
    this._fps = this._frameMs > 0 ? 1000 / this._frameMs : 0

    if (renderInfo) {
      this._drawCalls = renderInfo.calls
      this._triangles = renderInfo.triangles
    }

    this.accumulator += dtMs
    // 约每 0.5 秒落一个采样点，避免缓冲膨胀
    if (this.accumulator >= 500) {
      this.accumulator = 0
      this._usedMB = this.readMemoryMB()
      const now =
        (typeof performance !== 'undefined' ? performance.now() : 0) -
        this.startTime
      this.samples.push({
        time: now / 1000,
        fps: this._fps,
        frameMs: this._frameMs,
        planMs: this._planMs,
        usedMB: this._usedMB,
        drawCalls: this._drawCalls,
        triangles: this._triangles
      })
      if (this.samples.length > this.maxSamples) this.samples.shift()
    }
  }

  /** 一次规划结束上报耗时 */
  recordPlan(planMs: number) {
    this._planMs = planMs
    this.planCount++
  }

  private readMemoryMB(): number {
    if (typeof performance === 'undefined') return 0
    const mem = (
      performance as Performance & { memory?: MemoryInfo }
    ).memory
    return mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0
  }

  get fps() {
    return this._fps
  }
  get frameMs() {
    return this._frameMs
  }
  get planMs() {
    return this._planMs
  }
  get drawCalls() {
    return this._drawCalls
  }
  get triangles() {
    return this._triangles
  }
  get usedMB() {
    return this._usedMB
  }
  get history(): readonly PerfSample[] {
    return this.samples
  }

  /** 最近窗口均值 */
  summary(): {
    fps: number
    frameMs: number
    planMs: number
    usedMB: number
    drawCalls: number
    triangles: number
    planCount: number
  } {
    return {
      fps: this._fps,
      frameMs: this._frameMs,
      planMs: this._planMs,
      usedMB: this._usedMB,
      drawCalls: this._drawCalls,
      triangles: this._triangles,
      planCount: this.planCount
    }
  }

  reset() {
    this.samples = []
    this.frameTimes = []
    this.planCount = 0
    this._planMs = 0
    this.accumulator = 0
  }

  /** 由渲染循环驱动：内部用 RAF 时间戳自动计算 dt */
  tick(renderInfo?: { calls: number; triangles: number }) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (this.lastFrame > 0) {
      this.recordFrame(now - this.lastFrame, renderInfo)
    }
    this.lastFrame = now
  }
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/** 全局单例（渲染器与 Worker 回调共用） */
export const perfMonitor = new PerformanceMonitor()
