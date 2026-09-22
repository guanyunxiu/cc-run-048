import { defineStore } from 'pinia'
import type {
  DroneRuntime,
  FieldLayerMode,
  RenderBackend,
  ViewLayerOptions
} from '@/types'
import { webgpuLikelySupported } from '@/core/webgpu-field'
import { perfMonitor } from '@/core/perf-monitor'

interface EngineState {
  /** 可视化图层（功能03） */
  layers: ViewLayerOptions
  /** 渲染后端（功能04：WebGPU 可选升级） */
  backend: RenderBackend
  /** WebGPU 是否实际可用（异步探测后回填） */
  webgpuAvailable: boolean
  webgpuReason: string
  /** 是否启用 WebGPU 加速标量场 */
  webgpuEnabled: boolean
  /** 实时帧率 */
  fps: number
  frameMs: number
  /** 最近一次规划耗时 */
  planMs: number
  /** JS 堆占用（MB，不支持时为 0） */
  usedMB: number
  drawCalls: number
  triangles: number
  /** 性能 HUD 显隐 */
  showPerfHud: boolean
  /** 多无人机运行时（功能03） */
  fleetRuntimes: DroneRuntime[]
  fleetMaxDuration: number
  fleetPlanning: boolean
  fleetActive: boolean
  /** 多机最小安全间隔（实时） */
  fleetMinSeparation: number
}

export const useEngineStore = defineStore('engine', {
  state: (): EngineState => ({
    layers: {
      fieldLayer: 'off',
      showSensorRange: false,
      showCommRange: false,
      showCommLinks: false,
      lodEnabled: true,
      frustumCulling: true
    },
    backend: 'webgl2',
    webgpuAvailable: webgpuLikelySupported(),
    webgpuReason: '',
    webgpuEnabled: false,
    fps: 0,
    frameMs: 0,
    planMs: 0,
    usedMB: 0,
    drawCalls: 0,
    triangles: 0,
    showPerfHud: false,
    fleetRuntimes: [],
    fleetMaxDuration: 0,
    fleetPlanning: false,
    fleetActive: false,
    fleetMinSeparation: Infinity
  }),

  getters: {
    fieldOn: (s) => s.layers.fieldLayer !== 'off',
    perfSummary: () => perfMonitor.summary()
  },

  actions: {
    setFieldLayer(mode: FieldLayerMode) {
      this.layers.fieldLayer = mode
    },
    updateLayer(patch: Partial<ViewLayerOptions>) {
      Object.assign(this.layers, patch)
    },
    setBackend(b: RenderBackend) {
      this.backend = b
    },
    setWebgpuStatus(available: boolean, reason = '') {
      this.webgpuAvailable = available
      this.webgpuReason = reason
    },
    setWebgpuEnabled(v: boolean) {
      this.webgpuEnabled = v && this.webgpuAvailable
    },
    togglePerfHud() {
      this.showPerfHud = !this.showPerfHud
    },
    /** 由渲染循环每帧（约每 0.5s 采样）调用 */
    updatePerf(renderInfo?: { calls: number; triangles: number }) {
      perfMonitor.tick(renderInfo)
      this.fps = Math.round(perfMonitor.fps)
      this.frameMs = Math.round(perfMonitor.frameMs * 100) / 100
      this.planMs = Math.round(perfMonitor.planMs * 100) / 100
      this.usedMB = perfMonitor.usedMB
      this.drawCalls = renderInfo?.calls ?? perfMonitor.drawCalls
      this.triangles = renderInfo?.triangles ?? perfMonitor.triangles
    },
    recordPlan(ms: number) {
      perfMonitor.recordPlan(ms)
      this.planMs = Math.round(ms * 100) / 100
    },
    setFleetResult(runtimes: DroneRuntime[], maxDuration: number) {
      this.fleetRuntimes = runtimes
      this.fleetMaxDuration = maxDuration
      this.fleetPlanning = false
      this.fleetActive = runtimes.some((r) => r.path.length >= 2)
    },
    clearFleet() {
      this.fleetRuntimes = []
      this.fleetMaxDuration = 0
      this.fleetActive = false
      this.fleetMinSeparation = Infinity
    },
    setFleetMinSeparation(d: number) {
      this.fleetMinSeparation = d
    }
  }
})
