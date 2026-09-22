import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'stats.js'
import type { DynamicEntity, Vec3 } from '@/types'
import { generateTerrain, type TerrainData } from '@/core/terrain'
import { Environment } from '@/core/environment'
import { DynamicEnvironment, entityPosition } from '@/core/dynamic-environment'
import {
  createBuildingMesh,
  createBuildingsInstanced,
  createCommLines,
  createDrone,
  createDynamicMesh,
  createHazardMarker,
  createNoFlyMesh,
  createPathLine,
  createPointMarkers,
  createSelectRing,
  createSensorRanges,
  createSimpleLine,
  createTerrainMesh,
  createThreatMesh,
  createWaypointMarker,
  createTextSprite,
  updatePredictLine,
  type DroneModel,
  type DynamicMesh,
  type HazardMarker,
  type InstancedBuildings,
  type SensorRanges,
  type TerrainMeshResult
} from './factory'
import { createChunkedTerrain, type ChunkedTerrain } from './chunked-terrain'
import { PerfMonitor } from '@/core/perf-monitor'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'
import type { useSceneStore } from '@/stores/scene'
import type { useSimStore } from '@/stores/sim'

type SceneStore = ReturnType<typeof useSceneStore>
type SimStore = ReturnType<typeof useSimStore>

interface DragState {
  type: 'waypoint' | 'threat' | 'nofly' | 'obstacle' | 'dynamic'
  id: string
  pointerId: number
}

/** 三维仿真渲染器：封装 Three.js 场景、实体同步、拾取拖拽与动画循环 */
export class SceneRenderer {
  private container: HTMLElement
  private sceneStore: SceneStore
  private simStore: SimStore

  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private controls!: OrbitControls
  private stats!: Stats
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  private terrainView: TerrainMeshResult | null = null
  /** 迭代三：分块 LOD 地形（与 terrainView 二选一） */
  private chunkedTerrain: ChunkedTerrain | null = null
  private terrain: TerrainData | null = null
  private env: Environment | null = null

  private zoneGroup = new THREE.Group()
  private dynamicGroup = new THREE.Group()
  private waypointGroup = new THREE.Group()
  private pathGroup = new THREE.Group()
  private candidateGroup = new THREE.Group()
  private overlayGroup = new THREE.Group()
  /** 迭代三：多无人机编队分组 */
  private fleetGroup = new THREE.Group()
  /** 迭代三：传感器/通信范围分组 */
  private sensorGroup = new THREE.Group()
  private drone: DroneModel | null = null
  /** 跟踪误差虚影无人机（功能04） */
  private ghostDrone: THREE.Group | null = null
  private selectRing: THREE.Mesh
  private dynamicMeshes = new Map<string, DynamicMesh>()
  private violationPoints: THREE.Points | null = null
  private replanToast: THREE.Sprite | null = null
  /** 在线重规划触发风险位置标记（功能05） */
  private hazardMarker: HazardMarker | null = null
  /** 迭代三：实例化建筑 */
  private instancedBuildings: InstancedBuildings | null = null
  /** 迭代三：单机传感器范围 */
  private sensorRanges: SensorRanges | null = null
  /** 迭代三：编队各机模型 */
  private fleetDrones = new Map<string, DroneModel>()
  private fleetSensorRanges = new Map<string, SensorRanges>()
  private commLines: THREE.LineSegments | null = null
  /** 迭代三：性能监控 */
  private perf = new PerfMonitor()

  private rawLine: THREE.Line | null = null
  private smoothLine: THREE.Line | null = null

  private drag: DragState | null = null
  private dragPlane = new THREE.Plane()
  private dragOffset = new THREE.Vector3()
  private downPos = { x: 0, y: 0 }
  private moved = false

  private raf = 0
  private clock = new THREE.Clock()
  private resizeObserver: ResizeObserver
  private disposed = false

  constructor(
    container: HTMLElement,
    sceneStore: SceneStore,
    simStore: SimStore
  ) {
    this.container = container
    this.sceneStore = sceneStore
    this.simStore = simStore

    this.initRenderer()
    this.initScene()
    this.selectRing = createSelectRing()
    this.selectRing.visible = false
    this.scene.add(this.selectRing)

    this.scene.add(
      this.zoneGroup,
      this.dynamicGroup,
      this.waypointGroup,
      this.pathGroup,
      this.candidateGroup,
      this.overlayGroup,
      this.fleetGroup,
      this.sensorGroup
    )
    this.rebuildTerrain()
    this.syncZones()
    this.syncDynamics()
    this.syncWaypoints()
    this.syncPaths()
    this.ensureDrone()
    this.ensureGhostDrone()
    this.ensureSensorRanges()
    this.bindEvents()

    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(container)
    this.animate()
  }

  private initRenderer() {
    const canvas = document.createElement('canvas')
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    })
    if (!this.renderer.capabilities.isWebGL2) {
      // 框架在不支持 WebGL2 时回退 WebGL1（three 自动处理），给出提示
      console.warn('当前环境不支持 WebGL 2.0，已回退到 WebGL1 渲染')
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.container.appendChild(canvas)

    try {
      this.stats = new Stats()
      this.stats.showPanel(0)
      this.stats.dom.style.position = 'absolute'
      this.stats.dom.style.left = '8px'
      this.stats.dom.style.top = '8px'
      this.stats.dom.style.zIndex = '10'
      this.container.appendChild(this.stats.dom)
    } catch {
      this.stats = undefined as unknown as Stats
    }
  }

  private initScene() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0d1526)
    this.scene.fog = new THREE.Fog(0x0d1526, 1400, 3200)

    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.5, 8000)
    this.camera.position.set(620, 480, 720)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02
    this.controls.minDistance = 30
    this.controls.maxDistance = 2600
    this.controls.target.set(0, 60, 0)

    const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x33412a, 0.9)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6)
    sun.position.set(500, 800, 300)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const s = 700
    sun.shadow.camera.left = -s
    sun.shadow.camera.right = s
    sun.shadow.camera.top = s
    sun.shadow.camera.bottom = -s
    sun.shadow.camera.far = 2400
    this.scene.add(sun)

    const grid = new THREE.GridHelper(1000, 40, 0x3a5a80, 0x20304a)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35
    this.scene.add(grid)

    const axes = new THREE.AxesHelper(60)
    axes.position.set(-500, 2, -500)
    this.scene.add(axes)
  }

  // ---------- 环境同步 ----------

  private getEnvironment(): Environment {
    if (!this.env) {
      this.env = new DynamicEnvironment(
        this.sceneStore.terrain,
        this.sceneStore.threats,
        this.sceneStore.noflyZones,
        this.sceneStore.obstacles,
        this.sceneStore.dynamics
      )
    }
    return this.env
  }

  /** 动态环境（含移动障碍/突发威胁，时间参数化） */
  getDynamicEnv(): DynamicEnvironment {
    return this.getEnvironment() as DynamicEnvironment
  }

  /** 地形参数变化：重建网格与环境缓存（迭代三：可选分块 LOD 地形） */
  rebuildTerrain() {
    const view = this.safeView()
    const useChunked = view?.perf.chunkedTerrain ?? false
    if (useChunked) {
      if (this.terrainView) {
        this.scene.remove(this.terrainView.mesh)
        this.terrainView.mesh.geometry.dispose()
        ;(this.terrainView.mesh.material as THREE.Material).dispose()
        this.terrainView = null
      }
      if (this.chunkedTerrain) {
        this.scene.remove(this.chunkedTerrain.group)
        this.chunkedTerrain.dispose()
        this.chunkedTerrain = null
      }
      this.terrain = generateTerrain(this.sceneStore.terrain)
      this.env = null
      this.chunkedTerrain = createChunkedTerrain(this.terrain, { chunks: 4 })
      this.scene.add(this.chunkedTerrain.group)
      this.applyOverlayMode()
    } else {
      if (this.chunkedTerrain) {
        this.scene.remove(this.chunkedTerrain.group)
        this.chunkedTerrain.dispose()
        this.chunkedTerrain = null
      }
      if (this.terrainView) {
        this.scene.remove(this.terrainView.mesh)
        this.terrainView.mesh.geometry.dispose()
        ;(this.terrainView.mesh.material as THREE.Material).dispose()
      }
      this.terrain = generateTerrain(this.sceneStore.terrain)
      this.env = null
      this.terrainView = createTerrainMesh(this.terrain)
      this.scene.add(this.terrainView.mesh)
      this.applyHeatmap()
    }
    // 建筑需要贴地重建
    this.syncZones()
  }

  /** 迭代三：安全获取 view store（测试环境外不应抛错） */
  private safeView() {
    try {
      return useViewStore()
    } catch {
      return null
    }
  }

  private safeFleet() {
    try {
      return useFleetStore()
    } catch {
      return null
    }
  }

  /** 全量同步威胁/禁飞/建筑（迭代三：建筑可选 InstancedMesh） */
  syncZones() {
    this.disposeGroup(this.zoneGroup)
    if (this.instancedBuildings) {
      // 实例化建筑单独放在 zoneGroup（拾取时按 instanceId 反查）
      this.instancedBuildings.dispose()
      this.instancedBuildings = null
    }
    for (const t of this.sceneStore.threats) {
      this.zoneGroup.add(createThreatMesh(t))
    }
    for (const z of this.sceneStore.noflyZones) {
      this.zoneGroup.add(createNoFlyMesh(z))
    }
    if (this.terrain) {
      const view = this.safeView()
      if (view?.perf.instancedBuildings && this.sceneStore.obstacles.length > 0) {
        this.instancedBuildings = createBuildingsInstanced(
          this.sceneStore.obstacles,
          this.terrain
        )
        this.zoneGroup.add(this.instancedBuildings.mesh)
      } else {
        for (const b of this.sceneStore.obstacles) {
          this.zoneGroup.add(createBuildingMesh(b, this.terrain))
        }
      }
    }
    this.applyOverlayMode()
  }

  /** 全量同步动态实体（移动障碍/突发威胁） */
  syncDynamics() {
    this.disposeGroup(this.dynamicGroup)
    this.dynamicMeshes.clear()
    for (const d of this.sceneStore.dynamics) {
      const m = createDynamicMesh(d)
      this.dynamicMeshes.set(d.id, m)
      this.dynamicGroup.add(m.group)
    }
  }

  /** 单个动态实体参数编辑后重建 */
  refreshDynamic(id: string) {
    const existing = this.dynamicMeshes.get(id)
    if (existing) {
      this.dynamicGroup.remove(existing.group)
      this.disposeObject(existing.group)
      this.dynamicMeshes.delete(id)
    }
    const d = this.sceneStore.dynamics.find((x) => x.id === id)
    if (d) {
      const m = createDynamicMesh(d)
      this.dynamicMeshes.set(d.id, m)
      this.dynamicGroup.add(m.group)
    }
  }

  /** 每帧更新动态实体：位置、激活态、脉冲、预测轨迹、速度箭头 */
  private updateDynamics(elapsed: number) {
    const t = this.simStore.simTime
    for (const d of this.sceneStore.dynamics) {
      const m = this.dynamicMeshes.get(d.id)
      if (!m) continue
      const st = this.getDynamicEnv().stateAt(d, t)
      m.group.visible = st.active
      if (!st.active) continue
      const pos = st.position
      m.group.position.set(pos.x, pos.y, pos.z)
      // 预测位置与速度方向
      const p1 = entityPosition(d, t + 0.5)
      const dir = new THREE.Vector3(p1.x - pos.x, 0, p1.z - pos.z)
      if (dir.lengthSq() > 1e-6) {
        dir.normalize()
        m.arrow.setDirection(dir)
      }
      // 预测轨迹
      const horizon = d.predictHorizon
      const predicted: Vec3[] = []
      for (let i = 1; i <= 14; i++) {
        predicted.push(entityPosition(d, t + (horizon * i) / 14))
      }
      updatePredictLine(m.predictLine, predicted)

      // 威胁脉冲
      if (m.pulseMaterial) {
        const pulse = 0.16 + 0.1 * (0.5 + 0.5 * Math.sin(elapsed * 3))
        m.pulseMaterial.opacity = pulse
      }
    }
  }

  /** 单个实体参数更新后的轻量同步（重建对应网格） */
  refreshEntity(id: string) {
    const idx = this.zoneGroup.children.findIndex(
      (c) => c.userData.entityId === id
    )
    if (idx >= 0) {
      const old = this.zoneGroup.children[idx]
      this.zoneGroup.remove(old)
      this.disposeObject(old)
    }
    const threat = this.sceneStore.threats.find((t) => t.id === id)
    if (threat) this.zoneGroup.add(createThreatMesh(threat))
    const nofly = this.sceneStore.noflyZones.find((z) => z.id === id)
    if (nofly) this.zoneGroup.add(createNoFlyMesh(nofly))
    const obs = this.sceneStore.obstacles.find((b) => b.id === id)
    if (obs && this.terrain) this.zoneGroup.add(createBuildingMesh(obs, this.terrain))
    this.applyOverlayMode()
  }

  syncWaypoints() {
    this.disposeGroup(this.waypointGroup)
    const labels: Record<string, string> = { start: '起点', end: '终点', via: '途经点' }
    let viaN = 0
    for (const wp of this.sceneStore.waypoints) {
      const label =
        wp.role === 'via'
          ? `途经${++viaN}`
          : labels[wp.role]
      const m = createWaypointMarker(wp.id, wp.role, label)
      m.position.set(wp.position.x, wp.position.y, wp.position.z)
      this.waypointGroup.add(m)
    }
  }

  findWaypointObject(id: string): THREE.Object3D | undefined {
    return this.waypointGroup.children.find((c) => c.userData.entityId === id)
  }

  syncPaths() {
    if (this.rawLine) {
      this.pathGroup.remove(this.rawLine)
      this.rawLine.geometry.dispose()
      ;(this.rawLine.material as THREE.Material).dispose()
      this.rawLine = null
    }
    if (this.smoothLine) {
      this.pathGroup.remove(this.smoothLine)
      this.smoothLine.geometry.dispose()
      ;(this.smoothLine.material as THREE.Material).dispose()
      this.smoothLine = null
    }
    const sim = this.simStore
    if (sim.rawPath.length >= 2) {
      this.rawLine = createPathLine(sim.rawPath, {
        color: 0x8fa3bf,
        opacity: 0.4,
        dashed: false
      })
      this.pathGroup.add(this.rawLine)
    }
    if (sim.smoothPath.length >= 2) {
      const colors = this.pathVertexColors(sim.smoothPath)
      this.smoothLine = createPathLine(sim.smoothPath, {
        vertexColors: colors,
        opacity: 0.98
      })
      this.pathGroup.add(this.smoothLine)
    }
    this.syncCandidates()
    this.syncViolationPoints()
  }

  /** 候选航迹（RRT 采样树 / 局部重规划）与局部窗口（功能05） */
  syncCandidates() {
    this.disposeGroup(this.candidateGroup)
    const sim = this.simStore
    if (!sim.showCandidates) return

    // 全局候选（RRT 等）
    for (const c of sim.candidates.slice(0, 28)) {
      if (c.points.length < 2) continue
      const line = createSimpleLine(
        c.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        0x4d7cab,
        0.18,
        false
      )
      this.candidateGroup.add(line)
    }
    // 局部重规划候选（更亮）
    for (const c of sim.localCandidates.slice(0, 18)) {
      if (c.length < 2) continue
      const line = createSimpleLine(
        c.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        0xffb020,
        0.35,
        false
      )
      this.candidateGroup.add(line)
    }
    // 局部重规划窗口（黄色虚线连接 起点-接入点）
    if (sim.replanWindow.length === 2) {
      const [a, b] = sim.replanWindow
      // 窗口边界：两个小圆环用线段代替（水平十字）
      const box = createSimpleLine(
        [
          new THREE.Vector3(a.x, a.y, a.z),
          new THREE.Vector3(b.x, b.y, b.z)
        ],
        0xffe066,
        0.9,
        true
      )
      this.candidateGroup.add(box)
    }
  }

  /** 约束违反点红色高亮点（功能03） */
  syncViolationPoints() {
    if (this.violationPoints) {
      this.overlayGroup.remove(this.violationPoints)
      this.disposeObject(this.violationPoints)
      this.violationPoints = null
    }
    const sim = this.simStore
    const indices = sim.stats?.constraints?.violationIndices ?? []
    if (indices.length === 0 || sim.smoothPath.length === 0) return
    const pts = indices
      .map((i) => sim.smoothPath[i])
      .filter((p): p is Vec3 => !!p)
    if (pts.length > 0) {
      this.violationPoints = createPointMarkers(pts, 0xff3b30, 4)
      this.overlayGroup.add(this.violationPoints)
    }
  }

  /** 航迹顶点颜色：威胁绿→红，或安全裕度蓝→红映射（功能05） */
  private pathVertexColors(path: Vec3[]): Float32Array {
    const env = this.getDynamicEnv()
    const arr = new Float32Array(path.length * 3)
    const c = new THREE.Color()
    const clearance = this.sceneStore.planParams.clearance
    const t = this.simStore.simTime

    for (let i = 0; i < path.length; i++) {
      if (this.simStore.showClearanceMap) {
        // 安全裕度：到最近障碍/地面的净空 / clearance，绿(充足)->黄->红(不足)
        const p = path[i]
        const groundGap = p.y - env.groundHeight(p.x, p.z)
        let minGap = groundGap
        for (const b of this.sceneStore.obstacles) {
          const dx = Math.max(Math.abs(p.x - b.position.x) - b.size.x / 2, 0)
          const dz = Math.max(Math.abs(p.z - b.position.z) - b.size.z / 2, 0)
          const dy = Math.max(b.position.y + b.height - p.y, 0)
          const gap = Math.hypot(dx, dz, dy)
          if (gap < minGap) minGap = gap
        }
        const ratio = Math.max(0, Math.min(1, minGap / Math.max(clearance, 1)))
        // ratio=1 绿，0 红
        c.setHSL(0.33 * ratio, 0.9, 0.5)
      } else {
        const intensity = Math.min(1, env.totalThreatAt(path[i], t) * 0.9)
        c.setHSL(0.33 - intensity * 0.33, 0.9, 0.55)
      }
      arr[i * 3] = c.r
      arr[i * 3 + 1] = c.g
      arr[i * 3 + 2] = c.b
    }
    return arr
  }

  /** 重新着色航迹（回放期动态威胁出现时调用） */
  recolorPath() {
    if (!this.smoothLine || this.simStore.smoothPath.length < 2) return
    const geo = this.smoothLine.geometry
    const colors = this.pathVertexColors(this.simStore.smoothPath)
    const attr = geo.getAttribute('color') as THREE.BufferAttribute
    attr.array.set(colors)
    attr.needsUpdate = true
  }

  applyHeatmap() {
    if (!this.terrainView) return
    const env = this.getEnvironment()
    this.terrainView.applyOverlay(
      (x, z) => env.threatIntensity({ x, y: 1, z }),
      (x, z) => env.noflyPenalty({ x, y: 1, z }),
      this.simStore.showThreatHeatmap
    )
  }

  /**
   * 迭代三：多模式地形叠加层（威胁热力/安全裕度/代价热力/3D 威胁柱）。
   * 模式来自 view store；旧 showThreatHeatmap 开关仍映射到 threat 模式。
   */
  applyOverlayMode() {
    const view = this.safeView()
    const mode: import('@/types').OverlayMode =
      view?.overlayMode && view.overlayMode !== 'none'
        ? view.overlayMode
        : this.simStore.showThreatHeatmap
          ? 'threat'
          : 'none'
    const env = this.getEnvironment()
    const clearance = this.sceneStore.planParams.clearance
    const cruiseAlt = this.sceneStore.planParams.cruiseAlt
    const color = new THREE.Color()

    const colorAt = (x: number, z: number): THREE.Color | null => {
      if (mode === 'threat') {
        const ti = Math.min(1, env.threatIntensity({ x, y: cruiseAlt, z }))
        if (ti <= 0.02) return null
        color.setHSL(0.02 * (1 - ti), 0.95, 0.5)
        return color
      }
      if (mode === 'clearance') {
        const ground = env.groundHeight(x, z)
        let minGap = cruiseAlt - ground
        for (const b of this.sceneStore.obstacles) {
          const dx = Math.max(Math.abs(x - b.position.x) - b.size.x / 2, 0)
          const dz = Math.max(Math.abs(z - b.position.z) - b.size.z / 2, 0)
          const dy = Math.max(b.position.y + b.height - cruiseAlt, 0)
          const gap = Math.hypot(dx, dz, dy)
          if (gap < minGap) minGap = gap
        }
        const ratio = Math.max(0, Math.min(1, minGap / Math.max(clearance, 1)))
        color.setHSL(0.33 * ratio, 0.9, 0.5)
        return ratio >= 1 ? null : color
      }
      if (mode === 'cost') {
        const ti = Math.min(1, env.threatIntensity({ x, y: cruiseAlt, z }))
        const nf = Math.min(1, env.noflyPenalty({ x, y: cruiseAlt, z }) * 0.05)
        const v = Math.max(ti, nf)
        if (v <= 0.02) return null
        color.setHSL(0.05 * (1 - v), 0.9, 0.5)
        return color
      }
      return null
    }

    if (this.chunkedTerrain) {
      this.chunkedTerrain.applyOverlay(colorAt, mode !== 'none' && mode !== 'threat3d')
    } else if (this.terrainView) {
      // 非分块地形：回退到威胁热力（其余模式用颜色近似）
      this.terrainView.applyOverlay(
        (x, z) => env.threatIntensity({ x, y: cruiseAlt, z }),
        (x, z) => env.noflyPenalty({ x, y: cruiseAlt, z }),
        mode === 'threat' || mode === 'cost' || this.simStore.showThreatHeatmap
      )
    }
    this.syncThreatVolume(mode === 'threat3d', env, cruiseAlt)
  }

  /**
   * 迭代三：威胁强度三维体素云（threat3d 模式）。
   * 在巡航高度附近多层网格采样威胁场，以 Points 着色呈现立体威胁强度。
   */
  private threatVolume: THREE.Points | null = null
  private syncThreatVolume(
    enabled: boolean,
    env: Environment,
    cruiseAlt: number
  ) {
    if (this.threatVolume) {
      this.overlayGroup.remove(this.threatVolume)
      this.disposeObject(this.threatVolume)
      this.threatVolume = null
    }
    if (!enabled) return
    const size = this.sceneStore.terrain.size
    const half = size / 2
    const N = 36 // 水平格点数
    const levels = [-40, 0, 40, 80].map((d) => cruiseAlt + d)
    const positions: number[] = []
    const colors: number[] = []
    const c = new THREE.Color()
    for (const y of levels) {
      for (let iz = 0; iz < N; iz++) {
        for (let ix = 0; ix < N; ix++) {
          const x = (ix / (N - 1)) * size - half
          const z = (iz / (N - 1)) * size - half
          const v = env.threatIntensity({ x, y, z })
          if (v < 0.12) continue
          positions.push(x, y, z)
          c.setHSL(0.02 * (1 - Math.min(1, v)), 0.95, 0.55)
          colors.push(c.r, c.g, c.b)
        }
      }
    }
    if (positions.length === 0) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      size: 14,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true
    })
    this.threatVolume = new THREE.Points(geo, mat)
    this.threatVolume.frustumCulled = false
    this.overlayGroup.add(this.threatVolume)
  }

  private ensureDrone() {
    if (!this.drone) {
      this.drone = createDrone()
      this.scene.add(this.drone.group)
    }
    const sim = this.simStore
    if (sim.trajectory.length > 0) {
      const s = sim.sampleAt(sim.simTime)
      if (s) {
        this.drone.group.position.set(
          s.position.x,
          s.position.y,
          s.position.z
        )
      }
    } else {
      const start = this.sceneStore.startPoint
      if (start) this.drone.group.position.copy(vec(start.position))
    }
  }

  /** 跟踪误差虚影（功能04）：半透明红色无人机显示实际跟踪位置 */
  private ensureGhostDrone() {
    if (!this.ghostDrone) {
      const ghost = createDrone()
      ghost.group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.material) {
          const mat = mesh.material as THREE.MeshStandardMaterial
          mat.transparent = true
          mat.opacity = 0.4
          mat.color = new THREE.Color(0xff5263)
          mat.emissive = new THREE.Color(0x7a1f2b)
        }
      })
      ghost.group.visible = false
      this.scene.add(ghost.group)
      this.ghostDrone = ghost.group
    }
  }

  /** 迭代三：单机传感器/探测/通信范围（功能03） */
  private ensureSensorRanges() {
    if (!this.sensorRanges) {
      const s = this.sceneStore.sensor
      this.sensorRanges = createSensorRanges(s.sensorRange, s.detectionRange, s.commRange)
      this.sensorGroup.add(this.sensorRanges.group)
    }
  }

  /** 迭代三：同步传感器范围开关与半径 */
  syncSensorRanges() {
    this.ensureSensorRanges()
    const s = this.sceneStore.sensor
    if (!this.sensorRanges) return
    // 半径变化时重建（圆环几何固定）
    const rebuild =
      (this.sensorRanges.sensorMesh.geometry as THREE.SphereGeometry).parameters.radius !==
        s.sensorRange
    if (rebuild) {
      this.sensorGroup.remove(this.sensorRanges.group)
      this.sensorRanges = createSensorRanges(s.sensorRange, s.detectionRange, s.commRange)
      this.sensorGroup.add(this.sensorRanges.group)
    }
    this.sensorRanges.sensorMesh.visible = s.showSensor
    this.sensorRanges.detectionRing.visible = s.showDetection
    this.sensorRanges.commRing.visible = s.showComm
  }

  /** 迭代三：同步多无人机编队模型 */
  syncFleet() {
    const fleet = this.safeFleet()
    if (!fleet) return
    // 清理已删除的无人机
    for (const [id, model] of this.fleetDrones) {
      if (!fleet.tracks.some((t) => t.id === id)) {
        this.fleetGroup.remove(model.group)
        model.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (mesh.geometry) mesh.geometry.dispose()
        })
        this.fleetDrones.delete(id)
      }
    }
    for (const t of fleet.tracks) {
      let model = this.fleetDrones.get(t.id)
      if (!model) {
        model = createDrone()
        model.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (mesh.material) {
            ;(mesh.material as THREE.MeshStandardMaterial).color = new THREE.Color(t.color)
          }
        })
        this.fleetGroup.add(model.group)
        this.fleetDrones.set(t.id, model)
      }
      model.group.visible = fleet.enabled && (t.smoothPath?.length ?? 0) >= 2
    }
  }

  /** 迭代三：每帧更新编队无人机位置/传感器/通信链路 */
  private updateFleet() {
    const fleet = this.safeFleet()
    if (!fleet || !fleet.enabled) {
      this.fleetGroup.visible = false
      return
    }
    this.fleetGroup.visible = true
    this.syncFleet()
    const frac = this.simStore.progress
    const positions: { id: string; pos: THREE.Vector3 }[] = []
    for (const t of fleet.tracks) {
      const model = this.fleetDrones.get(t.id)
      const p = fleet.sampleAtFraction(t, frac)
      if (!model || !p) continue
      model.group.position.set(p.x, p.y, p.z)
      model.group.visible = true
      for (const r of model.rotors) r.rotation.y += 0.4
      positions.push({ id: t.id, pos: new THREE.Vector3(p.x, p.y, p.z) })
    }

    // 通信链路（距离 < commRange 绿色连线）
    const s = this.sceneStore.sensor
    if (s.showComm && positions.length >= 2) {
      const pairs: [Vec3, Vec3, boolean][] = []
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const d = positions[i].pos.distanceTo(positions[j].pos)
          pairs.push([
            positions[i].pos,
            positions[j].pos,
            d < s.commRange
          ])
        }
      }
      if (this.commLines) {
        this.fleetGroup.remove(this.commLines)
        this.commLines.geometry.dispose()
      }
      this.commLines = createCommLines(pairs)
      this.fleetGroup.add(this.commLines)
    } else if (this.commLines) {
      this.fleetGroup.remove(this.commLines)
      this.commLines.geometry.dispose()
      this.commLines = null
    }

    // 机间冲突检测（安全间隔 30m，按回放比例去重）
    if (positions.length >= 2 && this.simStore.playing) {
      fleet.detectConflicts(
        frac,
        positions.map((p) => ({ id: p.id, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z } })),
        30
      )
    }
  }

  // ---------- 拾取与拖拽 ----------

  private bindEvents() {
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('contextmenu', this.onContextMenu)
  }

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  private pickEntity(): THREE.Object3D | null {
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const roots = [
      ...this.zoneGroup.children,
      ...this.dynamicGroup.children,
      ...this.waypointGroup.children
    ]
    const hits = this.raycaster.intersectObjects(roots, true)
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object
      while (o) {
        // 迭代三：实例化建筑按 instanceId 反查 entityId
        if (o.userData.entityType === 'obstacle-instanced' && this.instancedBuildings) {
          const id = this.instancedBuildings.ids[hit.instanceId ?? 0]
          if (id) {
            return { userData: { entityId: id, entityType: 'obstacle' } } as unknown as THREE.Object3D
          }
        }
        if (o.userData.entityId) return o
        o = o.parent
      }
    }
    return null
  }

  private pickTerrain(): THREE.Vector3 | null {
    if (!this.terrainView) return null
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.terrainView.mesh, false)
    return hits.length > 0 ? hits[0].point.clone() : null
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    this.updatePointer(e)
    this.downPos = { x: e.clientX, y: e.clientY }
    this.moved = false

    const mode = this.sceneStore.editMode
    const ground = this.pickTerrain()

    if (mode === 'select') {
      const obj = this.pickEntity()
      if (obj) {
        const id = obj.userData.entityId as string
        const type = obj.userData.entityType as DragState['type']
        this.sceneStore.select(id)
        // 开始拖拽
        this.drag = { type, id, pointerId: e.pointerId }
        this.controls.enabled = false
        const worldPos = new THREE.Vector3()
        obj.getWorldPosition(worldPos)
        this.dragPlane.set(new THREE.Vector3(0, 1, 0), -worldPos.y)
        const hit = this.rayToPlane(e)
        if (hit) this.dragOffset.copy(worldPos).sub(hit)
        else this.dragOffset.set(0, 0, 0)
        this.renderer.domElement.style.cursor = 'grabbing'
      } else {
        this.sceneStore.select(null)
      }
      return
    }

    // 添加模式：点击地形放置要素
    if (!ground) return
    const p: Vec3 = { x: ground.x, y: ground.y, z: ground.z }
    if (mode === 'add-threat') {
      p.y = 0
      this.sceneStore.addThreatAt(p, 'radar')
    } else if (mode === 'add-nofly') {
      p.y = 0
      this.sceneStore.addNoFlyAt(p)
    } else if (mode === 'add-obstacle') {
      p.y = 0
      this.sceneStore.addObstacleAt(p)
      this.syncZones()
    } else if (mode === 'add-dynamic') {
      // 默认添加移动障碍；突发威胁由编辑面板/工具按钮添加
      p.y = 0
      this.sceneStore.addDynamicAt(p)
      this.syncDynamics()
    } else if (mode === 'add-waypoint') {
      const env = this.getEnvironment()
      p.y = Math.max(
        env.groundHeight(p.x, p.z) + this.sceneStore.planParams.clearance + 5,
        this.sceneStore.planParams.cruiseAlt
      )
      this.sceneStore.addWaypointAt(p)
      this.syncWaypoints()
    }
    this.simStore.markDirty()
  }

  private rayToPlane(e: PointerEvent): THREE.Vector3 | null {
    this.updatePointer(e)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const out = new THREE.Vector3()
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, out)
    return hit ? out : null
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      if (
        Math.abs(e.clientX - this.downPos.x) +
          Math.abs(e.clientY - this.downPos.y) >
        3
      ) {
        this.moved = true
      }
      const hit = this.rayToPlane(e)
      if (!hit) return
      hit.add(this.dragOffset)
      this.applyDragPosition(hit)
      return
    }

    // 悬停光标
    if (this.sceneStore.editMode === 'select') {
      this.updatePointer(e)
      const obj = this.pickEntity()
      this.renderer.domElement.style.cursor = obj ? 'grab' : 'default'
    } else {
      this.renderer.domElement.style.cursor = 'crosshair'
    }
  }

  private applyDragPosition(p: THREE.Vector3) {
    if (!this.drag) return
    const { id, type } = this.drag
    const half = this.sceneStore.terrain.size / 2 - 10
    p.x = THREE.MathUtils.clamp(p.x, -half, half)
    p.z = THREE.MathUtils.clamp(p.z, -half, half)
    const env = this.getEnvironment()

    if (type === 'waypoint') {
      const wp = this.sceneStore.waypoints.find((w) => w.id === id)
      if (!wp) return
      const minY = env.groundHeight(p.x, p.z) + this.sceneStore.planParams.clearance
      p.y = Math.max(wp.position.y, minY)
      wp.position = { x: p.x, y: p.y, z: p.z }
      // 位置更新由 Viewport 的 watcher 统一同步到标记
    } else if (type === 'threat') {
      const t = this.sceneStore.threats.find((x) => x.id === id)
      if (!t) return
      t.position = { x: p.x, y: 0, z: p.z }
      this.refreshEntity(id)
    } else if (type === 'nofly') {
      const z = this.sceneStore.noflyZones.find((x) => x.id === id)
      if (!z) return
      z.position = { x: p.x, y: 0, z: p.z }
      this.refreshEntity(id)
    } else if (type === 'obstacle') {
      const b = this.sceneStore.obstacles.find((x) => x.id === id)
      if (!b) return
      b.position = { x: p.x, y: 0, z: p.z }
      this.refreshEntity(id)
    } else if (type === 'dynamic') {
      const d = this.sceneStore.dynamics.find((x) => x.id === id)
      if (!d) return
      const ox = d.position.x
      const oz = d.position.z
      d.position = { x: p.x, y: 0, z: p.z }
      if (d.motion === 'linear') {
        d.target = { x: d.target.x + (p.x - ox), y: 0, z: d.target.z + (p.z - oz) }
      }
      this.refreshDynamic(id)
    }
    this.simStore.markDirty()
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.drag = null
      this.controls.enabled = this.simStore.cameraMode !== 'follow'
      this.renderer.domElement.style.cursor = 'default'
      // 拖拽结束后航迹失效，自动重算（若开启）
      if (this.moved && this.simStore.autoReplan) void this.simStore.plan()
    }
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  // ---------- 相机 ----------

  setCameraMode(mode: 'orbit' | 'top' | 'follow') {
    this.controls.enabled = mode !== 'follow'
    this.camera.up.set(0, 1, 0)
    if (mode === 'top') {
      // 保持 y-up：正上方略微偏移，避免与 up 轴完全平行时的万向奇异
      const top = this.sceneStore.terrain.size * 0.9
      this.camera.position.set(0.01, top, 0.01)
      this.controls.target.set(0, 0, 0)
    } else if (mode === 'orbit') {
      this.camera.position.set(620, 480, 720)
      this.controls.target.set(0, 60, 0)
    }
    this.controls.update()
  }

  /** 聚焦到选中实体 */
  focusSelected() {
    const id = this.sceneStore.selectedId
    if (!id) return
    const obj =
      this.zoneGroup.children.find((c) => c.userData.entityId === id) ??
      this.waypointGroup.children.find((c) => c.userData.entityId === id)
    if (!obj) return
    const p = new THREE.Vector3()
    obj.getWorldPosition(p)
    this.controls.target.copy(p)
    this.camera.position.set(p.x + 180, p.y + 160, p.z + 180)
    this.controls.update()
  }

  // ---------- 动画循环 ----------

  private animate = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.animate)
    this.stats?.begin()
    const dt = Math.min(this.clock.getDelta(), 0.05)
    const elapsed = this.clock.elapsedTime

    this.simStore.advance(dt)
    this.updateDrone(dt)
    this.updateDynamics(elapsed)
    this.updateGhost()
    this.updateSensorRanges()
    this.updateFleet()
    this.updateReplanToast()
    this.updateHazardMarker(elapsed)

    // 迭代三：分块地形 LOD 按相机距离切换
    if (this.chunkedTerrain) this.chunkedTerrain.update(this.camera.position)

    // 回放期动态威胁出现：航迹威胁颜色实时刷新
    if (this.simStore.playing) this.recolorPath()

    // 选中高亮环
    this.updateSelectRing()

    if (this.simStore.cameraMode === 'follow') this.updateFollowCamera()
    this.controls.update()
    this.renderer.render(this.scene, this.camera)

    // 迭代三：性能采样（renderer.info 含 drawCall/三角形）
    this.perf.sample(performance.now(), this.renderer.info)
    this.stats?.end()
  }

  /** 对外暴露性能监控（供 PerfPanel 读取） */
  getPerfMonitor(): PerfMonitor {
    return this.perf
  }

  /** 迭代三：每帧更新单机传感器范围位置与显隐 */
  private updateSensorRanges() {
    if (!this.sensorRanges) return
    const s = this.sceneStore.sensor
    this.sensorRanges.sensorMesh.visible = s.showSensor
    this.sensorRanges.detectionRing.visible = s.showDetection
    this.sensorRanges.commRing.visible = s.showComm
    if (s.showSensor || s.showDetection || s.showComm) {
      const pos = this.drone?.group.position
      if (pos) this.sensorRanges.update(pos)
    }
  }

  private updateDrone(dt: number) {
    if (!this.drone) return
    const sim = this.simStore
    const g = this.drone.group

    if (sim.trajectory.length > 0) {
      const s = sim.sampleAt(sim.simTime)
      if (s) {
        g.position.set(s.position.x, s.position.y, s.position.z)
        if (Math.hypot(s.velocity.x, s.velocity.z) > 0.5) {
          g.rotation.y = Math.atan2(s.velocity.x, s.velocity.z)
          g.rotation.x = THREE.MathUtils.clamp(
            -Math.atan2(
              s.velocity.y,
              Math.hypot(s.velocity.x, s.velocity.z)
            ) * 0.5,
            -0.4,
            0.4
          )
        }
        sim.setDroneTransform(s.position, g.rotation.y)
      }
    } else {
      const start = this.sceneStore.startPoint
      if (start) g.position.copy(vec(start.position))
    }

    // 旋翼转速随速度变化
    const spin = sim.playing ? 1 + dt * 28 : dt * 6
    for (const r of this.drone.rotors) r.rotation.y += spin
  }

  /** 跟踪虚影：按当前 simTime 取离线跟踪仿真状态 */
  private updateGhost() {
    if (!this.ghostDrone) return
    const sim = this.simStore
    this.ghostDrone.visible = sim.showTracking && sim.tracking.length > 0
    if (!this.ghostDrone.visible) return
    // 在 tracking 中按时间二分（states 与 traj 等长等时）
    const traj = sim.trajectory
    const t = sim.simTime
    let lo = 0
    let hi = traj.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (traj[mid].time <= t) lo = mid
      else hi = mid
    }
    const st = sim.tracking[lo]
    if (st) {
      this.ghostDrone.position.set(st.pos.x, st.pos.y, st.pos.z)
      this.ghostDrone.rotation.y = st.yaw
    }
  }

  /** 重规划触发原因飘字（功能05） */
  private updateReplanToast() {
    const sim = this.simStore
    const ev = sim.lastReplanEvent
    if (ev) {
      if (!this.replanToast) {
        this.replanToast = createTextSprite('', '#ffd166')
        this.replanToast.renderOrder = 200
        this.scene.add(this.replanToast)
      }
    }
    if (this.replanToast && ev) {
      const labels: Record<string, string> = {
        'threat-approach': '⚠ 威胁接近',
        'collision-risk': '⚠ 碰撞风险',
        'yaw-deviation': '⚠ 偏航过大',
        'range-anomaly': '⚠ 航程异常',
        manual: '⚠ 突发威胁'
      }
      // 触发后显示 4 秒（按仿真时间近似）
      if (sim.simTime - ev.time < 4) {
        const mat = this.replanToast.material as THREE.SpriteMaterial
        if ('map' in mat && mat.map) {
          this.drawToastTexture(mat, `${labels[ev.reason] ?? '⚠ 重规划'} · ${ev.detail}`)
        }
        const p = sim.dronePosition
        this.replanToast.position.set(p.x, p.y + 40, p.z)
        this.replanToast.visible = true
      } else {
        this.replanToast.visible = false
      }
    }
  }

  private drawToastTexture(mat: THREE.SpriteMaterial, text: string) {
    const old = mat.map
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const fontSize = 36
    ctx.font = `bold ${fontSize}px sans-serif`
    const w = Math.ceil(ctx.measureText(text).width) + 36
    canvas.width = w
    canvas.height = fontSize + 24
    ctx.font = `bold ${fontSize}px sans-serif`
    ctx.fillStyle = 'rgba(40,18,8,0.85)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#ffb020'
    ctx.lineWidth = 3
    ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3)
    ctx.fillStyle = '#ffd166'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 18, canvas.height / 2)
    const tex = new THREE.CanvasTexture(canvas)
    tex.minFilter = THREE.LinearFilter
    mat.map = tex
    mat.needsUpdate = true
    old?.dispose()
    const scale = 0.55
    this.replanToast!.scale.set(canvas.width * scale * 0.5, canvas.height * scale * 0.5, 1)
  }

  /** 重规划触发风险位置高亮（功能05）：与触发原因提示同窗口显示 */
  private updateHazardMarker(elapsed: number) {
    const sim = this.simStore
    const hp = sim.hazardPoint
    const ev = sim.lastReplanEvent
    // 触发后显示 6 秒（比原因飘字略长，便于定位）
    const show = !!hp && !!ev && sim.simTime - ev.time < 6
    if (!show) {
      if (this.hazardMarker) this.hazardMarker.group.visible = false
      return
    }
    if (!this.hazardMarker) {
      this.hazardMarker = createHazardMarker()
      this.scene.add(this.hazardMarker.group)
    }
    const m = this.hazardMarker
    m.group.visible = true
    m.group.position.set(hp!.x, hp!.y, hp!.z)
    // 脉冲：球体呼吸 + 环扩散淡出
    m.sphere.scale.setScalar(1 + 0.25 * Math.sin(elapsed * 6))
    const k = (elapsed * 1.2) % 1
    m.ring.scale.setScalar(1 + k * 1.6)
    ;(m.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k)
  }

  private updateSelectRing() {
    const id = this.sceneStore.selectedId
    if (!id) {
      this.selectRing.visible = false
      return
    }
    let p: THREE.Vector3 | null = null
    const wp = this.sceneStore.waypoints.find((w) => w.id === id)
    if (wp) {
      p = new THREE.Vector3(wp.position.x, wp.position.y, wp.position.z)
    } else {
      const obj = this.zoneGroup.children.find((c) => c.userData.entityId === id)
        ?? this.dynamicGroup.children.find((c) => c.userData.entityId === id)
      if (obj) {
        p = new THREE.Vector3()
        obj.getWorldPosition(p)
        const threat = this.sceneStore.threats.find((t) => t.id === id)
        const nofly = this.sceneStore.noflyZones.find((z) => z.id === id)
        const dyn = this.sceneStore.dynamics.find((d) => d.id === id)
        const r =
          threat?.radius ??
          nofly?.radius ??
          (dyn ? Math.max(dyn.radius, dyn.threatRadius) : 14)
        this.selectRing.scale.setScalar(r / 14)
      }
    }
    if (p) {
      this.selectRing.visible = true
      if (wp) this.selectRing.scale.setScalar(1)
      this.selectRing.position.copy(p)
      this.selectRing.position.y += 0.3
    }
  }

  private updateFollowCamera() {
    if (!this.drone) return
    const pos = this.drone.group.position
    const yaw = this.drone.group.rotation.y
    const dist = 70
    const height = 35
    const back = new THREE.Vector3(
      -Math.sin(yaw) * dist,
      height,
      -Math.cos(yaw) * dist
    )
    this.camera.position.lerp(pos.clone().add(back), 0.12)
    this.controls.target.lerp(pos, 0.15)
  }

  private onResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  private disposeGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children.pop()!
      this.disposeObject(child)
    }
  }

  private disposeObject(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = (mesh as THREE.Mesh).material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) (mat as THREE.Material).dispose()
    })
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('contextmenu', this.onContextMenu)
    this.controls.dispose()
    this.chunkedTerrain?.dispose()
    this.instancedBuildings?.dispose()
    this.renderer.dispose()
    el.remove()
    this.stats?.dom?.remove()
  }
}

function vec(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z)
}
