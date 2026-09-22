/**
 * 运行时性能监控（迭代三功能04）。
 * 在渲染循环中采样 FPS/帧耗时/drawCall/三角形/JS 堆，
 * 保留滑动窗口供面板展示与导出。
 */
export interface RendererInfoLike {
  render: { calls: number; triangles: number }
}

export class PerfMonitor {
  private frameTimes: { t: number; dt: number }[] = []
  private samples: { fps: number; frameMs: number; calls: number; tris: number; heap: number | null }[] = []
  private lastT = 0
  private frameCount = 0
  private accMs = 0
  private planMs: number | null = null
  private readonly windowSec = 60

  /** 每帧调用；每秒产出一个采样点 */
  sample(now: number, info: RendererInfoLike | null): void {
    if (this.lastT === 0) this.lastT = now
    const dt = now - this.lastT
    this.lastT = now
    this.frameCount++
    this.accMs += dt
    if (dt > 0) this.frameTimes.push({ t: now, dt })
    // 保留最近 2s 的帧时间用于瞬时 FPS
    const cutoff = now - 2000
    while (this.frameTimes.length > 0 && this.frameTimes[0].t < cutoff) this.frameTimes.shift()

    if (this.accMs >= 1000) {
      const fps = (this.frameCount * 1000) / this.accMs
      const heap = this.readHeap()
      this.samples.push({
        fps,
        frameMs: this.accMs / this.frameCount,
        calls: info?.render.calls ?? 0,
        tris: info?.render.triangles ?? 0,
        heap
      })
      const since = now - this.windowSec * 1000
      void since
      // samples 不带时间戳，直接按长度截断（每秒一个）
      if (this.samples.length > this.windowSec) this.samples.shift()
      this.frameCount = 0
      this.accMs = 0
    }
  }

  private readHeap(): number | null {
    const mem = (performance as Performance & {
      memory?: { usedJSHeapSize: number }
    }).memory
    return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null
  }

  setPlanTime(ms: number): void {
    this.planMs = ms
  }

  get instantFps(): number {
    if (this.frameTimes.length < 2) return 0
    const span =
      this.frameTimes[this.frameTimes.length - 1].t - this.frameTimes[0].t
    return span > 0 ? ((this.frameTimes.length - 1) * 1000) / span : 0
  }

  get latest() {
    const s = this.samples[this.samples.length - 1]
    return s
      ? { ...s, planMs: this.planMs }
      : { fps: this.instantFps, frameMs: 0, calls: 0, tris: 0, heap: null as number | null, planMs: this.planMs }
  }

  get history(): readonly { fps: number; frameMs: number; calls: number; tris: number; heap: number | null }[] {
    return this.samples
  }

  /** 导出监控历史 CSV */
  toCsv(): string {
    const rows = ['fps,frameMs,drawCalls,triangles,heapMB']
    for (const s of this.samples) {
      rows.push([
        s.fps.toFixed(1),
        s.frameMs.toFixed(2),
        s.calls,
        s.tris,
        s.heap ?? ''
      ].join(','))
    }
    return rows.join('\n')
  }
}
