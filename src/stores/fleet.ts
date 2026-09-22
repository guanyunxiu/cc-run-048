import { defineStore } from 'pinia'
import PlannerWorker from '@/workers/planner.worker.ts?worker'
import type {
  CostWeights,
  DroneSpec,
  FleetSpec,
  PlanParams,
  SmoothingType,
  ThreatZone,
  NoFlyZone,
  BuildingObstacle,
  TerrainParams
} from '@/types'
import type {
  WorkerRequest,
  WorkerResponse
} from '@/workers/planner.worker'
import { Environment } from '@/core/environment'
import { planFleet } from '@/core/fleet'
import { useSceneStore } from './scene'
import { useEngineStore } from './engine'
import { useSimStore } from './sim'
import { defaultFleet } from '@/core/fleet'

/**
 * 多无人机编队（功能03）：
 * - 维护机队规格（航点/颜色/传感器/通信半径/起飞延迟）
 * - 通过 Worker 批量规划，失败时主线程兜底
 * - 回放由 SceneRenderer 直接读取 engine.fleetRuntimes
 */
interface FleetState {
  spec: FleetSpec
  planning: boolean
  message: string
}

export const useFleetStore = defineStore('fleet', {
  state: (): FleetState => ({
    spec: defaultFleet(),
    planning: false,
    message: ''
  }),

  getters: {
    droneCount: (s) => s.spec.drones.length,
    colors: (s) => s.spec.drones.map((d) => d.color)
  },

  actions: {
    addDrone(drone?: Partial<DroneSpec>) {
      const n = this.spec.drones.length
      const id = `uav-${String.fromCharCode(65 + n)}`
      this.spec.drones.push({
        id,
        name: `无人机-${String.fromCharCode(65 + n)}`,
        color: ['#1abc9c', '#e84393', '#3aa0ff', '#ffb020'][n % 4],
        launchDelay: 0,
        sensorRange: 110,
        commRange: 250,
        waypoints: [],
        ...drone
      })
    },
    removeDrone(id: string) {
      this.spec.drones = this.spec.drones.filter((d) => d.id !== id)
    },
    updateDrone(id: string, patch: Partial<DroneSpec>) {
      const d = this.spec.drones.find((x) => x.id === id)
      if (d) Object.assign(d, patch)
    },
    resetFleet() {
      this.spec = defaultFleet()
    },

    buildEnv(): Environment {
      const scene = useSceneStore()
      return new Environment(
        scene.terrain,
        scene.threats,
        scene.noflyZones,
        scene.obstacles
      )
    },

    /** 主线程同步规划（测试/兜底） */
    planLocally(
      planParams?: PlanParams,
      weights?: CostWeights,
      smoothing?: SmoothingType
    ) {
      const scene = useSceneStore()
      const engine = useEngineStore()
      const env = this.buildEnv()
      const result = planFleet(
        env,
        this.spec.drones,
        planParams ?? scene.planParams,
        weights ?? scene.weights,
        smoothing ?? 'bspline'
      )
      engine.setFleetResult(result.runtimes, result.maxDuration)
      if (result.maxDuration > 0) {
        // 惰性引用以避免 store 循环依赖
        useSimStore().useFleetTimeline(result.maxDuration)
      }
      this.message =
        result.failures.length === 0
          ? `编队规划成功（${result.runtimes.length} 架）`
          : `${result.failures.length} 架规划失败：${result.failures
              .map((f) => f.message)
              .join('；')}`
      return result
    },

    /** Worker 编队规划 */
    plan(): Promise<void> {
      const scene = useSceneStore()
      const engine = useEngineStore()
      this.planning = true
      engine.fleetPlanning = true

      const payload = {
        terrain: JSON.parse(JSON.stringify(scene.terrain)) as TerrainParams,
        threats: JSON.parse(JSON.stringify(scene.threats)) as ThreatZone[],
        noflyZones: JSON.parse(JSON.stringify(scene.noflyZones)) as NoFlyZone[],
        obstacles: JSON.parse(JSON.stringify(scene.obstacles)) as BuildingObstacle[],
        planParams: JSON.parse(JSON.stringify(scene.planParams)) as PlanParams,
        weights: JSON.parse(JSON.stringify(scene.weights)) as CostWeights
      }

      return new Promise((resolve) => {
        const worker = new PlannerWorker()
        const req: WorkerRequest = {
          type: 'fleet',
          ...payload,
          fleet: JSON.parse(JSON.stringify(this.spec)) as FleetSpec,
          smoothing: 'bspline'
        }
        const timer = setTimeout(() => {
          worker.terminate()
          this.planning = false
          engine.fleetPlanning = false
          // 超时兜底主线程
          this.planLocally(payload.planParams, payload.weights)
          resolve()
        }, 30000)

        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const msg = ev.data
          if (msg.type === 'fleet-done') {
            clearTimeout(timer)
            const r = msg.result
            engine.setFleetResult(r.runtimes, r.maxDuration)
            if (r.maxDuration > 0) useSimStore().useFleetTimeline(r.maxDuration)
            this.message =
              r.failures.length === 0
                ? `编队规划成功（${r.runtimes.length} 架）`
                : `${r.failures.length} 架失败`
            worker.terminate()
            this.planning = false
            resolve()
          }
        }
        worker.onerror = () => {
          clearTimeout(timer)
          worker.terminate()
          this.planLocally(payload.planParams, payload.weights)
          this.planning = false
          resolve()
        }
        worker.postMessage(req)
      })
    }
  }
})
