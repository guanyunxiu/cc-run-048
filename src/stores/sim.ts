import { defineStore } from 'pinia'
import PlannerWorker from '@/workers/planner.worker.ts?worker'
import type {
  PlanRequest,
  PlanResponse,
  WorkerRequest,
  WorkerResponse
} from '@/workers/planner.worker'
import type {
  AlgoType,
  CameraMode,
  CandidatePath,
  PlanParams,
  PlanResult,
  PlanningStats,
  ReplanEvent,
  ReplanReason,
  SerializedScene,
  SmoothingType,
  Vec3
} from '@/types'
import type { TrajectorySample } from '@/core/smoothing'
import { Environment } from '@/core/environment'
import { DynamicEnvironment } from '@/core/dynamic-environment'
import { getCostCurve, planMission } from '@/core/planning'
import { planTrajectory } from '@/core/smoothing'
import {
  checkReplanTriggers,
  localReplan,
  makeReplanEvent
} from '@/core/replanning'
import {
  simulateTracking,
  type TrackingState,
  type TrackingSummary
} from '@/core/tracking'
import { perfMonitor } from '@/core/perf-monitor'
import { useSceneStore } from './scene'
import { useEngineStore } from './engine'
import { useFleetStore } from './fleet'

export interface CostCurvePoint {
  distance: number
  cumulative: number
}

function EMPTY_STATS(): PlanningStats {
  return {
    distance: 0,
    threatExposure: 0,
    exposureTime: 0,
    planTimeMs: 0,
    expandedNodes: 0,
    success: false,
    segments: 0,
    obstacleAvoidanceRate: 0,
    totalCost: 0,
    costBreakdown: { distance: 0, threat: 0, altitude: 0, nofly: 0, smooth: 0, energy: 0, dynamics: 0 }
  }
}

type PlanStatus = 'idle' | 'planning' | 'done' | 'failed'

interface SimState {
  status: PlanStatus
  message: string
  smoothing: SmoothingType
  rawPath: Vec3[]
  smoothPath: Vec3[]
  trajectory: TrajectorySample[]
  stats: PlanningStats | null
  costCurve: CostCurvePoint[]
  /** RRT 等候选航迹（功能05） */
  candidates: CandidatePath[]
  /** 在线局部重规划的候选航迹（最近一次） */
  localCandidates: Vec3[][]
  /** 局部重规划窗口（[起点, 接入点]），供渲染高亮 */
  replanWindow: Vec3[]
  /** 重规划事件历史（功能02/05） */
  replanEvents: ReplanEvent[]
  /** 最近一次触发提示（功能05：触发原因提示） */
  lastReplanEvent: ReplanEvent | null
  /** 触发风险位置（渲染高亮） */
  hazardPoint: Vec3 | null
  /** 跟踪仿真状态 */
  tracking: TrackingState[]
  trackingSummary: TrackingSummary | null
  /** 播放状态 */
  playing: boolean
  simTime: number
  duration: number
  playbackSpeed: number
  /** 当前无人机所在位置/朝向（由渲染循环回写） */
  dronePosition: Vec3
  droneHeading: number
  cameraMode: CameraMode
  /** 本次规划是否参数脏（环境/参数变更后置 true） */
  dirty: boolean
  autoReplan: boolean
  /** 在线重规划开关（功能02） */
  onlineReplan: boolean
  showThreatHeatmap: boolean
  /** 显示候选航迹 */
  showCandidates: boolean
  /** 显示安全裕度颜色映射 */
  showClearanceMap: boolean
  /** 显示跟踪误差 */
  showTracking: boolean
  /** 触发冷却剩余（秒） */
  cooldown: number
  /** 原始计划总航程（触发判断基准） */
  plannedLength: number
}

export const useSimStore = defineStore('sim', {
  state: (): SimState => ({
    status: 'idle',
    message: '就绪',
    smoothing: 'bspline',
    rawPath: [],
    smoothPath: [],
    trajectory: [],
    stats: null,
    costCurve: [],
    candidates: [],
    localCandidates: [],
    replanWindow: [],
    replanEvents: [],
    lastReplanEvent: null,
    hazardPoint: null,
    tracking: [],
    trackingSummary: null,
    playing: false,
    simTime: 0,
    duration: 0,
    playbackSpeed: 1,
    dronePosition: { x: 0, y: 0, z: 0 },
    droneHeading: 0,
    cameraMode: 'orbit',
    dirty: true,
    autoReplan: false,
    onlineReplan: true,
    showThreatHeatmap: false,
    showCandidates: true,
    showClearanceMap: false,
    showTracking: false,
    cooldown: 0,
    plannedLength: 0
  }),

  getters: {
    progress: (s) => (s.duration > 0 ? Math.min(1, s.simTime / s.duration) : 0)
  },

  actions: {
    setCameraMode(mode: CameraMode) {
      this.cameraMode = mode
    },

    setSmoothing(mode: SmoothingType) {
      this.smoothing = mode
      this.dirty = true
    },

    setAlgo(algo: AlgoType) {
      const scene = useSceneStore()
      scene.planParams.algo = algo
      this.dirty = true
    },

    markDirty() {
      this.dirty = true
    },

    setPlaybackSpeed(v: number) {
      this.playbackSpeed = v
    },

    setDroneTransform(p: Vec3, heading: number) {
      this.dronePosition = p
      this.droneHeading = heading
    },

    play() {
      const engine = useEngineStore()
      if (this.trajectory.length < 2 && !engine.fleetActive) return
      const timeLimit = engine.fleetActive
        ? Math.max(this.duration, engine.fleetMaxDuration)
        : this.duration
      if (this.simTime >= timeLimit) {
        // 重新播放：重置动态与重规划状态
        this.simTime = 0
        this.resetReplayState()
      }
      this.playing = true
    },

    pause() {
      this.playing = false
    },

    togglePlay() {
      if (this.playing) this.pause()
      else this.play()
    },

    seek(t: number) {
      this.simTime = Math.max(0, Math.min(this.duration, t))
    },

    resetReplayState() {
      this.replanEvents = []
      this.lastReplanEvent = null
      this.hazardPoint = null
      this.localCandidates = []
      this.replanWindow = []
      this.cooldown = 0
    },

    /** 渲染循环每帧调用，推进仿真时钟并处理在线重规划 */
    advance(dt: number) {
      if (!this.playing) return
      // 多机编队模式：无单机轨迹也可推进时间轴
      const engine = useEngineStore()
      if (this.trajectory.length < 2 && !engine.fleetActive) return
      this.simTime += dt * this.playbackSpeed
      this.cooldown = Math.max(0, this.cooldown - dt * this.playbackSpeed)
      const timeLimit = engine.fleetActive
        ? Math.max(this.duration, engine.fleetMaxDuration)
        : this.duration
      if (this.simTime >= timeLimit) {
        this.simTime = timeLimit
        this.playing = false
        return
      }
      if (this.onlineReplan && this.trajectory.length >= 2) this.handleOnlineReplan()
    },

    /** 迭代三：编队规划后，把时间轴切换到编队时长（复用播放条） */
    useFleetTimeline(duration: number) {
      this.pause()
      this.duration = duration
      this.simTime = 0
    },

    /** 在线重规划主逻辑（功能02），在渲染帧中同步执行（局部 RRT 轻量） */
    handleOnlineReplan() {
      const scene = useSceneStore()
      if (scene.dynamics.length === 0) return
      const env = this.buildDynamicEnv()
      const cur = this.sampleAt(this.simTime)
      if (!cur) return

      const trigger = checkReplanTriggers({
        env,
        plan: scene.planParams,
        weights: scene.weights,
        triggers: scene.replanTriggers,
        traj: this.trajectory,
        time: this.simTime,
        position: cur.position,
        heading: this.droneHeading,
        plannedTotalLength: this.plannedLength,
        cooldownLeft: this.cooldown
      })

      if (trigger.triggered && trigger.reason && this.cooldown <= 0) {
        const result = localReplan(
          env,
          scene.planParams,
          scene.weights,
          this.trajectory,
          this.simTime,
          scene.replanTriggers.windowRadius
        )
        // 成功绕飞后短暂冷却即可；未找到绕飞或绕飞无收益时延长冷却，
        // 避免对同一风险反复尝试、航迹被改来改去
        this.cooldown = result.success ? 2.5 : 6
        this.hazardPoint = trigger.hazard ?? null
        if (result.success) {
          this.spliceReplan(result.localPath, result.mergeIndex)
          const event = makeReplanEvent(
            trigger.reason,
            trigger.detail,
            this.simTime,
            cur.position,
            result.costBefore,
            result.costAfter,
            result.planMs
          )
          this.recordReplan(event)
        } else {
          // 未找到绕飞路径：仍记录触发事件（代价不变）
          const event = makeReplanEvent(
            trigger.reason,
            `${trigger.detail}；${result.message}`,
            this.simTime,
            cur.position,
            result.costBefore,
            result.costAfter,
            result.planMs
          )
          this.recordReplan(event)
        }
        this.localCandidates = result.candidates
        const w0 = result.localPath[0]
        const w1 = result.localPath[result.localPath.length - 1]
        this.replanWindow = w0 && w1 ? [w0, w1] : []
      }
    },

    recordReplan(event: ReplanEvent) {
      this.replanEvents.push(event)
      this.lastReplanEvent = event
      if (this.stats) {
        this.stats.replanCount = (this.stats.replanCount ?? 0) + 1
      }
    },

    /** 将局部重规划路径拼接到当前轨迹（保持时间连续） */
    spliceReplan(localPath: Vec3[], mergeIndex: number) {
      const scene = useSceneStore()
      if (localPath.length < 2 || mergeIndex <= 0) return
      const traj = this.trajectory
      const curIdx = (() => {
        let i = 0
        for (let k = 0; k < traj.length; k++) if (traj[k].time <= this.simTime) i = k
        return i
      })()

      // 用速度规划生成局部新轨迹段（相对时间从 0 起）
      const localTraj = planTrajectory(localPath, scene.planParams)
      if (localTraj.length < 2) return
      const tBase = this.simTime
      const newLocal = localTraj.map((s) => ({
        ...s,
        position: { ...s.position },
        velocity: { ...s.velocity },
        time: tBase + s.time
      }))

      // 拼接：保留 curIdx 之前，接入 mergeIndex 之后（后者时间整体平移）
      const offset = newLocal[newLocal.length - 1].time - traj[mergeIndex].time
      const after = traj.slice(mergeIndex + 1).map((s) => ({
        ...s,
        position: { ...s.position },
        velocity: { ...s.velocity },
        time: s.time + offset
      }))
      const before = traj.slice(0, curIdx)
      this.trajectory = [...before, ...newLocal, ...after]
      this.duration = this.trajectory[this.trajectory.length - 1].time

      // 更新平滑航迹几何（用于渲染/着色），重采样到点集
      this.smoothPath = this.trajectory.map((s) => s.position)
    },

    buildDynamicEnv(): DynamicEnvironment {
      const scene = useSceneStore()
      return new DynamicEnvironment(
        scene.terrain,
        scene.threats,
        scene.noflyZones,
        scene.obstacles,
        scene.dynamics
      )
    },

    resetPlayback() {
      this.playing = false
      this.simTime = 0
      this.resetReplayState()
    },

    /** 手动插入一次突发威胁（功能02 演示按钮） */
    triggerSuddenThreat(): ReplanEvent | null {
      if (!this.playing) return null
      const env = this.buildDynamicEnv()
      const cur = this.sampleAt(this.simTime)
      if (!cur) return null
      const event = makeReplanEvent(
        'manual',
        '手动触发突发威胁',
        this.simTime,
        cur.position,
        0,
        0,
        0
      )
      this.recordReplan(event)
      void env
      return event
    },

    /** 主线程规划（同步，用于测试 / Worker 不可用时兜底） */
    planLocally(): PlanResult {
      const scene = useSceneStore()
      const env = new Environment(
        scene.terrain,
        scene.threats,
        scene.noflyZones,
        scene.obstacles
      )
      const t0 = performance.now()
      const result = planMission(env, scene.waypoints, scene.planParams, scene.weights, {
        smoothing: this.smoothing
      })
      perfMonitor.recordPlan(performance.now() - t0)
      this.applyPlanResult(result, scene.planParams, scene.weights, env)
      return result
    },

    /** 通过 Web Worker 执行规划（并行，不阻塞渲染） */
    plan(): Promise<PlanResult> {
      const scene = useSceneStore()
      this.status = 'planning'
      this.message = '规划中…'
      this.pause()

      return new Promise((resolve) => {
        const worker = new PlannerWorker()
        // 注意：Pinia state 是 Vue 响应式 Proxy，无法被结构化克隆，
        // 发往 Worker 前必须全部深拷贝为普通对象（terrain 也不能漏）
        const req: PlanRequest = {
          type: 'plan',
          terrain: JSON.parse(JSON.stringify(scene.terrain)),
          threats: JSON.parse(JSON.stringify(scene.threats)),
          noflyZones: JSON.parse(JSON.stringify(scene.noflyZones)),
          obstacles: JSON.parse(JSON.stringify(scene.obstacles)),
          dynamics: JSON.parse(JSON.stringify(scene.dynamics), (k, v) =>
            v === Infinity ? 1e9 : v
          ),
          waypoints: JSON.parse(JSON.stringify(scene.waypoints)),
          planParams: JSON.parse(JSON.stringify(scene.planParams)),
          weights: JSON.parse(JSON.stringify(scene.weights)),
          smoothing: this.smoothing
        }

        const timer = setTimeout(() => {
          worker.terminate()
          this.status = 'failed'
          this.message = '规划超时（请增大栅格分辨率或减少最大节点数）'
          resolve({
            success: false,
            rawPath: [],
            smoothPath: [],
            stats: EMPTY_STATS(),
            legs: [],
            message: this.message
          })
        }, 30000)

        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          clearTimeout(timer)
          const msg = ev.data
          if (msg.type === 'plan-done') {
            const env = new Environment(
              scene.terrain,
              scene.threats,
              scene.noflyZones,
              scene.obstacles
            )
            this.applyPlanResult(
              msg.result,
              scene.planParams,
              scene.weights,
              env
            )
            perfMonitor.recordPlan(msg.workerMs)
            this.message = msg.result.success
              ? `规划成功（Worker ${msg.workerMs} ms）`
              : msg.result.message
            worker.terminate()
            resolve(msg.result)
          }
        }
        worker.onerror = (e) => {
          clearTimeout(timer)
          this.status = 'failed'
          this.message = `Worker 错误：${e.message}`
          worker.terminate()
          resolve({
            success: false,
            rawPath: [],
            smoothPath: [],
            stats: EMPTY_STATS(),
            legs: [],
            message: this.message
          })
        }
        try {
          worker.postMessage(req as WorkerRequest)
        } catch (err) {
          // 结构化克隆失败等同步异常：进入 failed 而不是未捕获拒绝
          clearTimeout(timer)
          this.status = 'failed'
          this.message = `规划请求发送失败：${(err as Error).message}`
          worker.terminate()
          resolve({
            success: false,
            rawPath: [],
            smoothPath: [],
            stats: EMPTY_STATS(),
            legs: [],
            message: this.message
          })
        }
      })
    },

    applyPlanResult(
      result: PlanResult,
      planParams: PlanParams,
      weights: SerializedScene['weights'],
      env: Environment
    ) {
      this.rawPath = result.rawPath
      this.smoothPath = result.smoothPath
      this.stats = result.stats
      this.status = result.success ? 'done' : 'failed'
      this.dirty = false
      this.simTime = 0
      this.playing = false
      this.candidates = result.candidates ?? []
      this.replanEvents = []
      this.lastReplanEvent = null
      this.hazardPoint = null
      this.localCandidates = []
      this.replanWindow = []
      this.cooldown = 0

      if (result.success && result.smoothPath.length >= 2) {
        this.costCurve = getCostCurve(
          env,
          result.smoothPath,
          weights,
          planParams
        ).map((c) => ({ distance: c.distance, cumulative: c.cumulative }))
        this.requestTrajectory(env, result.smoothPath, planParams)
        this.plannedLength = result.stats.distance
      } else {
        this.costCurve = []
        this.trajectory = []
        this.duration = 0
        this.tracking = []
        this.trackingSummary = null
      }
    },

    requestTrajectory(
      env: Environment,
      smoothPath: Vec3[],
      planParams: PlanParams
    ) {
      this.trajectory = planTrajectory(smoothPath, planParams)
      this.duration =
        this.trajectory.length > 0
          ? this.trajectory[this.trajectory.length - 1].time
          : 0
      this.simTime = 0
      // 无人机放到起点
      if (this.trajectory.length > 0) {
        this.dronePosition = { ...this.trajectory[0].position }
      }
      // 离线跟踪仿真（功能04：跟踪误差）
      const { states, summary } = simulateTracking(this.trajectory)
      this.tracking = states
      this.trackingSummary = summary
      void env
    },

    /** 按当前仿真时间在轨迹上插值，返回位置/速度/朝向 */
    sampleAt(time: number): TrajectorySample | null {
      const traj = this.trajectory
      if (traj.length === 0) return null
      if (time <= traj[0].time) return traj[0]
      const last = traj[traj.length - 1]
      if (time >= last.time) return last

      // 二分查找
      let lo = 0
      let hi = traj.length - 1
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (traj[mid].time <= time) lo = mid
        else hi = mid
      }
      const a = traj[lo]
      const b = traj[lo + 1]
      const dt = b.time - a.time
      const t = dt > 1e-6 ? (time - a.time) / dt : 0
      return {
        time,
        s: a.s + (b.s - a.s) * t,
        speed: a.speed + (b.speed - a.speed) * t,
        position: {
          x: a.position.x + (b.position.x - a.position.x) * t,
          y: a.position.y + (b.position.y - a.position.y) * t,
          z: a.position.z + (b.position.z - a.position.z) * t
        },
        velocity: {
          x: a.velocity.x + (b.velocity.x - a.velocity.x) * t,
          y: a.velocity.y + (b.velocity.y - a.velocity.y) * t,
          z: a.velocity.z + (b.velocity.z - a.velocity.z) * t
        }
      }
    },

    clearPlan() {
      this.rawPath = []
      this.smoothPath = []
      this.trajectory = []
      this.costCurve = []
      this.candidates = []
      this.localCandidates = []
      this.replanWindow = []
      this.replanEvents = []
      this.tracking = []
      this.trackingSummary = null
      this.stats = null
      this.status = 'idle'
      this.message = '就绪'
      this.playing = false
      this.simTime = 0
      this.duration = 0
      this.dirty = true
    },

    exportScene(): SerializedScene {
      const scene = useSceneStore()
      const engine = useEngineStore()
      const fleet = useFleetStore()
      return scene.serialize({
        rawPath: this.rawPath,
        smoothPath: this.smoothPath,
        trajectory: this.trajectory.map((t) => t.position),
        stats: this.stats,
        fleet: engine.fleetActive ? fleet.spec : undefined,
        viewLayers: engine.layers
      })
    }
  }
})
