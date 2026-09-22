import { defineStore } from 'pinia'
import type {
  AlgoType,
  FleetTrack,
  SmoothingType,
  UavSensor,
  Vec3
} from '@/types'
import { defaultSensor, uid } from '@/core/defaults'
import { PlannerWorkerPool } from '@/core/worker-pool'
import { useSceneStore } from './scene'

let pool: PlannerWorkerPool | null = null
function getPool(): PlannerWorkerPool {
  if (!pool) pool = new PlannerWorkerPool()
  return pool
}

const FLEET_COLORS = [
  '#1abc9c',
  '#3aa0ff',
  '#ffb020',
  '#b046ff',
  '#ff7a59',
  '#2ecc71',
  '#e84393',
  '#00cec9'
]

/**
 * 多无人机编队 store（迭代三功能03：多无人机同时仿真）。
 * 每架无人机独立航点集/算法/航迹，统一时钟回放；
 * 单机（waypoints）仍走 sim store，fleet 仅在用户启用编队时使用。
 */
interface FleetState {
  tracks: FleetTrack[]
  /** 编队模式开关 */
  enabled: boolean
  /** 规划中 */
  planning: boolean
  /** 规划进度 0~1 */
  progress: number
  /** 默认传感器参数（新无人机继承） */
  sensor: UavSensor
  /** 最近一次机间冲突告警（时刻 + 两机 id） */
  conflicts: { time: number; a: string; b: string; distance: number }[]
}

/** 默认编队：在主机两侧各生成一架伴随无人机（平行航迹） */
export function defaultFleetTracks(): FleetTrack[] {
  return [
    {
      id: uid('uav'),
      name: '长机',
      color: FLEET_COLORS[0],
      algo: 'astar',
      waypoints: [
        { id: uid('wp'), role: 'start', position: { x: -420, y: 120, z: -360 }, speed: 30 },
        { id: uid('wp'), role: 'via', position: { x: -150, y: 130, z: 40 }, speed: 30 },
        { id: uid('wp'), role: 'end', position: { x: 420, y: 110, z: 260 }, speed: 30 }
      ]
    },
    {
      id: uid('uav'),
      name: '僚机-左',
      color: FLEET_COLORS[1],
      algo: 'rrt',
      waypoints: [
        { id: uid('wp'), role: 'start', position: { x: -420, y: 120, z: -280 }, speed: 30 },
        { id: uid('wp'), role: 'via', position: { x: -150, y: 130, z: 120 }, speed: 30 },
        { id: uid('wp'), role: 'end', position: { x: 420, y: 110, z: 340 }, speed: 30 }
      ]
    },
    {
      id: uid('uav'),
      name: '僚机-右',
      color: FLEET_COLORS[2],
      algo: 'pso',
      waypoints: [
        { id: uid('wp'), role: 'start', position: { x: -460, y: 120, z: -320 }, speed: 30 },
        { id: uid('wp'), role: 'via', position: { x: -190, y: 130, z: 80 }, speed: 30 },
        { id: uid('wp'), role: 'end', position: { x: 380, y: 110, z: 300 }, speed: 30 }
      ]
    }
  ]
}

export const useFleetStore = defineStore('fleet', {
  state: (): FleetState => ({
    tracks: [],
    enabled: false,
    planning: false,
    progress: 0,
    sensor: { ...defaultSensor },
    conflicts: []
  }),

  getters: {
    activeTracks: (s) => s.tracks.filter((t) => (t.smoothPath?.length ?? 0) >= 2)
  },

  actions: {
    initDefault() {
      if (this.tracks.length === 0) this.tracks = defaultFleetTracks()
    },

    setEnabled(v: boolean) {
      this.enabled = v
      if (v) this.initDefault()
    },

    setSensor(patch: Partial<UavSensor>) {
      this.sensor = { ...this.sensor, ...patch }
    },

    addTrack() {
      this.initDefault()
      const idx = this.tracks.length
      const s = sceneStartEnd()
      this.tracks.push({
        id: uid('uav'),
        name: `无人机-${idx + 1}`,
        color: FLEET_COLORS[idx % FLEET_COLORS.length],
        algo: 'astar',
        waypoints: [
          { id: uid('wp'), role: 'start', position: { ...s.start, z: s.start.z + 40 * (idx + 1) }, speed: 30 },
          { id: uid('wp'), role: 'end', position: { ...s.end, z: s.end.z + 40 * (idx + 1) }, speed: 30 }
        ]
      })
    },

    removeTrack(id: string) {
      this.tracks = this.tracks.filter((t) => t.id !== id)
    },

    updateTrack(id: string, patch: Partial<FleetTrack>) {
      const t = this.tracks.find((x) => x.id === id)
      if (t) Object.assign(t, patch)
    },

    setAlgo(id: string, algo: AlgoType) {
      const t = this.tracks.find((x) => x.id === id)
      if (t) t.algo = algo
    },

    /** 清空所有规划结果（场景变更后） */
    clearResults() {
      for (const t of this.tracks) {
        t.rawPath = undefined
        t.smoothPath = undefined
        t.trajectory = undefined
        t.success = undefined
        t.distance = undefined
        t.planTimeMs = undefined
      }
      this.conflicts = []
    },

    /**
     * 并行规划全部无人机（Worker 池，功能04 并行搜索）。
     * 各机独立 PostMessage，池内并发执行。
     */
    async planAll(smoothing: SmoothingType = 'bspline'): Promise<void> {
      const scene = useSceneStore()
      this.initDefault()
      this.planning = true
      this.progress = 0
      this.conflicts = []
      const clone = <T>(v: T, infinityFix = false): T =>
        JSON.parse(
          JSON.stringify(v, (k, val) => (infinityFix && val === Infinity ? 1e9 : val))
        ) as T

      const total = this.tracks.length
      let done = 0
      await Promise.all(
        this.tracks.map(async (track) => {
          const req = {
            terrain: clone(scene.terrain),
            threats: clone(scene.threats),
            noflyZones: clone(scene.noflyZones),
            obstacles: clone(scene.obstacles),
            dynamics: clone(scene.dynamics, true),
            waypoints: clone(track.waypoints),
            planParams: clone({
              ...scene.planParams,
              algo: track.algo ?? scene.planParams.algo
            }),
            weights: clone(scene.weights),
            smoothing
          }
          try {
            const res = await getPool().plan(req)
            track.rawPath = res.result.rawPath
            track.smoothPath = res.result.smoothPath
            track.success = res.result.success
            track.distance = res.result.stats.distance
            track.planTimeMs = res.result.stats.planTimeMs
            // 轨迹仅存位置点（回放按弧长匀速时间化由渲染层完成）
            track.trajectory = res.result.smoothPath.map((p) => ({ ...p }))
          } catch (err) {
            track.success = false
            track.smoothPath = undefined
            console.error('[fleet] 规划失败', track.name, err)
          } finally {
            done++
            this.progress = done / total
          }
        })
      )
      this.planning = false
    },

  /**
   * 机间冲突检测（最近距离 < 安全间隔）。
   * 由渲染层在统一时间（按弧长比例，同步主回放时钟）采样各机位置后调用。
   */
  detectConflicts(
    frac: number,
    positions: { id: string; pos: Vec3 }[],
    separation: number
  ) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i].pos
        const b = positions[j].pos
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
        if (d < separation) {
          const pairKey = [positions[i].id, positions[j].id].sort().join('|')
          const last = this.conflicts[this.conflicts.length - 1]
          const samePair = last && [last.a, last.b].sort().join('|') === pairKey
          // 同一对机在 2s（按比例近似）内只记录一次
          if (!samePair || frac - last.time > 0.05) {
            this.conflicts.push({
              time: Math.round(frac * 100) / 100,
              a: positions[i].id,
              b: positions[j].id,
              distance: Math.round(d)
            })
          }
        }
      }
    }
  },

    /** 在各机轨迹上按弧长比例（0~1）采样位置，用于统一时钟回放 */
    sampleAtFraction(track: FleetTrack, frac: number): Vec3 | null {
      const path = track.smoothPath
      if (!path || path.length < 2) return null
      const total = pathLength(path)
      const target = total * Math.max(0, Math.min(1, frac))
      let acc = 0
      for (let i = 1; i < path.length; i++) {
        const d = Math.hypot(
          path[i].x - path[i - 1].x,
          path[i].y - path[i].y,
          path[i].z - path[i - 1].z
        )
        if (acc + d >= target) {
          const t = d > 1e-6 ? (target - acc) / d : 0
          return {
            x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
            y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
            z: path[i - 1].z + (path[i].z - path[i - 1].z) * t
          }
        }
        acc += d
      }
      return path[path.length - 1]
    },

    disposePool() {
      pool?.dispose()
      pool = null
    }
  }
})

function pathLength(path: Vec3[]): number {
  let l = 0
  for (let i = 1; i < path.length; i++) {
    l += Math.hypot(
      path[i].x - path[i - 1].x,
      path[i].y - path[i - 1].y,
      path[i].z - path[i - 1].z
    )
  }
  return l
}

function sceneStartEnd(): { start: Vec3; end: Vec3 } {
  const scene = useSceneStore()
  const s = scene.waypoints.find((w) => w.role === 'start')?.position ?? {
    x: -400, y: 120, z: -300
  }
  const e = scene.waypoints.find((w) => w.role === 'end')?.position ?? {
    x: 400, y: 110, z: 300
  }
  return { start: { ...s }, end: { ...e } }
}
