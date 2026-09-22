import { defineStore } from 'pinia'
import type {
  BuildingObstacle,
  CostWeights,
  DynamicEntity,
  EditMode,
  FleetTrack,
  NoFlyZone,
  PlanParams,
  ReplanTriggers,
  TerrainParams,
  ThreatZone,
  UavSensor,
  Vec3,
  Waypoint
} from '@/types'
import {
  defaultDynamicEntities,
  defaultEnergyParams,
  defaultNoFlyZones,
  defaultObstacles,
  defaultPlanParams,
  defaultReplanTriggers,
  defaultSensor,
  defaultTerrain,
  defaultThreats,
  defaultWaypoints,
  defaultWeights,
  uid
} from '@/core/defaults'
import type { SerializedScene } from '@/types'

interface SceneState {
  terrain: TerrainParams
  threats: ThreatZone[]
  noflyZones: NoFlyZone[]
  obstacles: BuildingObstacle[]
  waypoints: Waypoint[]
  /** 迭代二：移动障碍/突发威胁 */
  dynamics: DynamicEntity[]
  /** 迭代三：多无人机编队航迹 */
  fleet: FleetTrack[]
  planParams: PlanParams
  weights: CostWeights
  replanTriggers: ReplanTriggers
  /** 迭代三：单机传感器参数 */
  sensor: UavSensor
  editMode: EditMode
  selectedId: string | null
  /** 地形参数版本号，变化即通知渲染层重建网格 */
  terrainVersion: number
}

export const useSceneStore = defineStore('scene', {
  state: (): SceneState => ({
    terrain: { ...defaultTerrain },
    threats: defaultThreats(),
    noflyZones: defaultNoFlyZones(),
    obstacles: defaultObstacles(),
    waypoints: defaultWaypoints(),
    dynamics: defaultDynamicEntities(),
    fleet: [],
    planParams: {
      ...defaultPlanParams,
      dynamics: { ...defaultPlanParams.dynamics },
      tuning: { ...defaultPlanParams.tuning },
      energy: { ...defaultEnergyParams }
    },
    weights: { ...defaultWeights },
    replanTriggers: { ...defaultReplanTriggers },
    sensor: { ...defaultSensor },
    editMode: 'select',
    selectedId: null,
    terrainVersion: 0
  }),

  getters: {
    startPoint: (s) => s.waypoints.find((w) => w.role === 'start'),
    endPoint: (s) => s.waypoints.find((w) => w.role === 'end')
  },

  actions: {
    setEditMode(mode: EditMode) {
      this.editMode = mode
      if (mode !== 'select') this.selectedId = null
    },

    select(id: string | null) {
      this.selectedId = id
    },

    addThreatAt(p: Vec3, kind: ThreatZone['kind'] = 'radar'): string {
      const id = uid('thr')
      const names: Record<ThreatZone['kind'], string> = {
        radar: '雷达',
        sam: '防空',
        jammer: '干扰'
      }
      this.threats.push({
        id,
        kind,
        name: `${names[kind]}-${this.threats.length + 1}`,
        position: { ...p },
        radius: 90,
        heightMin: 0,
        heightMax: 160,
        level: 3,
        opacity: kind === 'sam' ? 0.28 : 0.22
      })
      this.selectedId = id
      return id
    },

    updateThreat(id: string, patch: Partial<ThreatZone>) {
      const t = this.threats.find((x) => x.id === id)
      if (t) Object.assign(t, patch)
    },

    removeThreat(id: string) {
      this.threats = this.threats.filter((t) => t.id !== id)
      if (this.selectedId === id) this.selectedId = null
    },

    addNoFlyAt(p: Vec3): string {
      const id = uid('nfz')
      this.noflyZones.push({
        id,
        name: `禁飞区-${this.noflyZones.length + 1}`,
        position: { ...p },
        radius: 60,
        heightMin: 0,
        heightMax: 200,
        penalty: 10,
        hardBlock: true
      })
      this.selectedId = id
      return id
    },

    updateNoFly(id: string, patch: Partial<NoFlyZone>) {
      const z = this.noflyZones.find((x) => x.id === id)
      if (z) Object.assign(z, patch)
    },

    removeNoFly(id: string) {
      this.noflyZones = this.noflyZones.filter((z) => z.id !== id)
      if (this.selectedId === id) this.selectedId = null
    },

    addObstacleAt(p: Vec3): string {
      const id = uid('obs')
      this.obstacles.push({
        id,
        name: `建筑-${this.obstacles.length + 1}`,
        position: { ...p, y: 0 },
        size: { x: 30, z: 30 },
        height: 45
      })
      this.selectedId = id
      return id
    },

    updateObstacle(id: string, patch: Partial<BuildingObstacle>) {
      const o = this.obstacles.find((x) => x.id === id)
      if (o) Object.assign(o, patch)
    },

    removeObstacle(id: string) {
      this.obstacles = this.obstacles.filter((o) => o.id !== id)
      if (this.selectedId === id) this.selectedId = null
    },

    /** 添加移动障碍（功能02） */
    addDynamicAt(p: Vec3): string {
      const id = uid('dyn')
      this.dynamics.push({
        id,
        name: `移动障碍-${this.dynamics.length + 1}`,
        kind: 'obstacle',
        motion: 'patrol',
        position: { ...p, y: 0 },
        target: { x: p.x + 120, y: 0, z: p.z },
        patrolPoints: [
          { ...p, y: 0 },
          { x: p.x + 150, y: 0, z: p.z + 60 }
        ],
        speed: 24,
        radius: 20,
        threatRadius: 60,
        heightMin: 0,
        heightMax: 160,
        level: 4,
        predictHorizon: 8,
        enableAt: 0,
        disableAt: Infinity,
        active: true,
        color: '#ff8f1f'
      })
      this.selectedId = id
      return id
    },

    /** 添加突发威胁（功能02）：默认 5 秒后出现 */
    addSuddenThreatAt(p: Vec3): string {
      const id = uid('dyn')
      this.dynamics.push({
        id,
        name: `突发威胁-${this.dynamics.length + 1}`,
        kind: 'threat',
        motion: 'static',
        position: { ...p, y: 0 },
        target: { ...p, y: 0 },
        patrolPoints: [],
        speed: 0,
        radius: 18,
        threatRadius: 90,
        heightMin: 20,
        heightMax: 220,
        level: 5,
        predictHorizon: 8,
        enableAt: 5,
        disableAt: Infinity,
        active: true,
        color: '#ff2d55'
      })
      this.selectedId = id
      return id
    },

    updateDynamic(id: string, patch: Partial<DynamicEntity>) {
      const d = this.dynamics.find((x) => x.id === id)
      if (d) Object.assign(d, patch)
    },

    removeDynamic(id: string) {
      this.dynamics = this.dynamics.filter((d) => d.id !== id)
      if (this.selectedId === id) this.selectedId = null
    },

    addWaypointAt(p: Vec3): string {
      const id = uid('wp')
      // 若还没有起点则先作为起点，否则作为途经点
      const hasStart = this.waypoints.some((w) => w.role === 'start')
      const hasEnd = this.waypoints.some((w) => w.role === 'end')
      const role: Waypoint['role'] = !hasStart
        ? 'start'
        : !hasEnd
          ? 'end'
          : 'via'
      this.waypoints.push({ id, role, position: { ...p }, speed: 30 })
      this.selectedId = id
      return id
    },

    updateWaypoint(id: string, patch: Partial<Waypoint>) {
      const w = this.waypoints.find((x) => x.id === id)
      if (w) Object.assign(w, patch)
    },

    removeWaypoint(id: string) {
      const w = this.waypoints.find((x) => x.id === id)
      if (w && w.role === 'via') {
        this.waypoints = this.waypoints.filter((x) => x.id !== id)
        if (this.selectedId === id) this.selectedId = null
      }
    },

    removeSelected() {
      const id = this.selectedId
      if (!id) return
      this.removeThreat(id)
      this.removeNoFly(id)
      this.removeObstacle(id)
      this.removeWaypoint(id)
      this.removeDynamic(id)
    },

    /** 场景序列化（供导出） */
    serialize(
      extra: Pick<SerializedScene, 'rawPath' | 'smoothPath' | 'trajectory' | 'stats'>
    ): SerializedScene {
      return {
        version: '3.0.0',
        exportedAt: new Date().toISOString(),
        terrain: JSON.parse(JSON.stringify(this.terrain)),
        threats: JSON.parse(JSON.stringify(this.threats)),
        noflyZones: JSON.parse(JSON.stringify(this.noflyZones)),
        obstacles: JSON.parse(JSON.stringify(this.obstacles)),
        waypoints: JSON.parse(JSON.stringify(this.waypoints)),
        dynamics: JSON.parse(JSON.stringify(this.dynamics), (k, v) =>
          v === Infinity ? 1e9 : v
        ),
        planParams: JSON.parse(JSON.stringify(this.planParams)),
        weights: JSON.parse(JSON.stringify(this.weights)),
        replanTriggers: JSON.parse(JSON.stringify(this.replanTriggers)),
        fleet: JSON.parse(JSON.stringify(this.fleet), (k, v) =>
          v === Infinity ? 1e9 : v
        ),
        sensor: JSON.parse(JSON.stringify(this.sensor)),
        ...extra
      }
    },

    loadScene(data: SerializedScene) {
      this.terrain = { ...defaultTerrain, ...data.terrain }
      this.threats = data.threats ?? []
      this.noflyZones = data.noflyZones ?? []
      this.obstacles = data.obstacles ?? []
      this.waypoints = data.waypoints ?? []
      this.dynamics = (data.dynamics ?? []).map((d) => ({
        ...d,
        enableAt: d.enableAt >= 1e9 ? Infinity : d.enableAt,
        disableAt: d.disableAt >= 1e9 ? Infinity : d.disableAt
      }))
      this.planParams = {
        ...defaultPlanParams,
        ...data.planParams,
        dynamics: { ...defaultPlanParams.dynamics, ...data.planParams?.dynamics },
        tuning: { ...defaultPlanParams.tuning, ...data.planParams?.tuning },
        energy: { ...defaultEnergyParams, ...data.planParams?.energy }
      }
      this.weights = { ...defaultWeights, ...data.weights }
      this.replanTriggers = {
        ...defaultReplanTriggers,
        ...data.replanTriggers
      }
      this.fleet = data.fleet ?? []
      this.sensor = { ...defaultSensor, ...data.sensor }
      this.selectedId = null
    },

    resetScene() {
      this.terrain = { ...defaultTerrain }
      this.threats = defaultThreats()
      this.noflyZones = defaultNoFlyZones()
      this.obstacles = defaultObstacles()
      this.waypoints = defaultWaypoints()
      this.dynamics = defaultDynamicEntities()
      this.fleet = []
      this.planParams = {
        ...defaultPlanParams,
        dynamics: { ...defaultPlanParams.dynamics },
        tuning: { ...defaultPlanParams.tuning },
        energy: { ...defaultEnergyParams }
      }
      this.weights = { ...defaultWeights }
      this.replanTriggers = { ...defaultReplanTriggers }
      this.sensor = { ...defaultSensor }
      this.selectedId = null
      this.editMode = 'select'
    }
  }
})
