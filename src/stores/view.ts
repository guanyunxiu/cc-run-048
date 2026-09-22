import { defineStore } from 'pinia'
import type { OverlayMode, PerfSettings, UavSensor } from '@/types'
import { defaultPerfSettings, defaultSensor } from '@/core/defaults'
import { detectCapabilities, type PlatformCapabilities } from '@/core/capabilities'

/**
 * 视图与工程性能 UI 状态（迭代三功能03/04）。
 * 与场景数据解耦：仅保存可视化开关、性能开关、能力信息。
 */
interface ViewState {
  /** 地形叠加层模式 */
  overlayMode: OverlayMode
  /** 回放是否循环 */
  loop: boolean
  /** 编队仿真开关（与 fleet.enabled 同步，但放这里便于视图层订阅） */
  fleetVisible: boolean
  /** 性能开关 */
  perf: PerfSettings
  /** 单机传感器参数（视图口径） */
  sensor: UavSensor
  /** 能力检测结果 */
  caps: PlatformCapabilities | null
  /** WebGPU 场计算是否实际启用（能力 + 开关 + 适配器成功） */
  webgpuActive: boolean
  /** 最近一次场计算后端与耗时 */
  fieldBackend: 'webgpu' | 'cpu' | null
  fieldMs: number | null
  /** 规划缓存命中率（来自 PlanCache.stats） */
  cacheHitRate: number
  cacheSize: number
}

export const useViewStore = defineStore('view', {
  state: (): ViewState => ({
    overlayMode: 'none',
    loop: false,
    fleetVisible: false,
    perf: { ...defaultPerfSettings },
    sensor: { ...defaultSensor },
    caps: null,
    webgpuActive: false,
    fieldBackend: null,
    fieldMs: null,
    cacheHitRate: 0,
    cacheSize: 0
  }),

  actions: {
    setOverlay(mode: OverlayMode) {
      this.overlayMode = mode
    },
    toggleLoop() {
      this.loop = !this.loop
    },
    setPerf(patch: Partial<PerfSettings>) {
      this.perf = { ...this.perf, ...patch }
    },
    setSensor(patch: Partial<UavSensor>) {
      this.sensor = { ...this.sensor, ...patch }
    },
    detect() {
      this.caps = detectCapabilities()
      return this.caps
    },
    setWebgpuActive(v: boolean) {
      this.webgpuActive = v
    },
    setFieldResult(backend: 'webgpu' | 'cpu', ms: number) {
      this.fieldBackend = backend
      this.fieldMs = ms
    },
    setCacheStats(hitRate: number, size: number) {
      this.cacheHitRate = hitRate
      this.cacheSize = size
    }
  }
})
