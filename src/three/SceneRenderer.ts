import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'stats.js'
import type { FieldLayerMode, Vec3 } from '@/types'
import { generateTerrain, type TerrainData } from '@/core/terrain'
import { Environment } from '@/core/environment'
import { DynamicEnvironment, entityPosition } from '@/core/dynamic-environment'
import {
  buildFieldGrid,
  clearanceColor,
  fieldCacheKey,
  heatColor,
  modeToKind,
  type FieldGrid
} from '@/core/field-grid'
import {
  fleetActiveAt,
  fleetCommLinks,
  fleetSeparation,
  sampleFleetDrone
} from '@/core/fleet'
import {
  tryComputeThreatFieldGPU
} from '@/core/webgpu-field'
import {
  createBuildingMesh,
  createCommLinks,
  createDrone,
  createDynamicMesh,
  createFieldOverlay,
  createFleetDrone,
  createHazardMarker,
  createInstancedBuildings,
  createNoFlyMesh,
  createPathLine,
  createPerfHud,
  createPointMarkers,
  createRangeRing,
  createRangeSphere,
  createSelectRing,
  createSimpleLine,
  createTerrainMesh,
  createThreatMesh,
  createWaypointMarker,
  createTextSprite,
  updateCommLinks,
  updatePredictLine,
  type DroneModel,
  type DynamicMesh,
  type FieldOverlayResult,
  type HazardMarker,
  type TerrainMeshResult
} from './factory'
import type { useSceneStore } from '@/stores/scene'
import type { useSimStore } from '@/stores/sim'
import { useEngineStore } from '@/stores/engine'
import type { DroneRuntime } from '@/types'

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
  private terrain: TerrainData | null = null
  private env: Environment | null = null

  private zoneGroup = new THREE.Group()
  private dynamicGroup = new THREE.Group()
  private waypointGroup = new THREE.Group()
  private pathGroup = new THREE.Group()
  private candidateGroup = new THREE.Group()
  private overlayGroup = new THREE.Group()
  private drone: DroneModel | null = null
  /** 跟踪误差虚影无人机（功能04） */
  private ghostDrone: THREE.Group | null = null
  private selectRing: THREE.Mesh
  private dynamicMeshes = new Map<string, DynamicMesh>()
  private violationPoints: THREE.Points | null = null
  private replanToast: THREE.Sprite | null = null
  /** 在线重规划触发风险位置标记（功能05） */
  private hazardMarker: HazardMarker | null = null

  private rawLine: THREE.Line | null = null
  private smoothLine: THREE.Line | null = null

  // 迭代三：标量场图层
  private fieldOverlay: FieldOverlayResult | null = null
  private fieldGrid: FieldGrid | null = null
  private fieldCache = new Map<string, FieldGrid>()
  private fieldBuildingGroup: THREE.Group = new THREE.Group()
  private instancedBuildings: THREE.InstancedMesh | null = null

  // 迭代三：多无人机
  private fleetGroup = new THREE.Group()
  private fleetDrones = new Map<
    string,
    { group: THREE.Group; rotors: THREE.Mesh[]; sensor: THREE.Object3D; comm: THREE.LineLoop }
  >()
  private commLinks: THREE.LineSegments

  // 迭代三：性能 HUD
  private perfHud: HTMLElement | null = null
  private readonly engine = useEngineStore()

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
      this.fieldBuildingGroup,
      this.fleetGroup
    )
    this.commLinks = createCommLinks()
    this.fleetGroup.add(this.commLinks)
    this.rebuildTerrain()
    this.syncZones()
    this.syncDynamics()
    this.syncWaypoints()
    this.syncPaths()
    this.ensureDrone()
    this.ensureGhostDrone()
    this.perfHud = createPerfHud(container)
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
      this.engine.setBackend('webgl1')
    } else {
      this.engine.setBackend('webgl2')
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

  /** 地形参数变化：重建网格与环境缓存 */
  rebuildTerrain() {
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
    // 建筑需要贴地重建
    this.syncZones()
  }

  /** 全量同步威胁/禁飞/建筑 */
  syncZones() {
    this.disposeGroup(this.zoneGroup)
    for (const t of this.sceneStore.threats) {
      this.zoneGroup.add(createThreatMesh(t))
    }
    for (const z of this.sceneStore.noflyZones) {
      this.zoneGroup.add(createNoFlyMesh(z))
    }
    if (this.terrain) {
      for (const b of this.sceneStore.obstacles) {
        this.zoneGroup.add(createBuildingMesh(b, this.terrain))
      }
    }
    this.applyHeatmap()
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
    this.applyHeatmap()
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

  // ---------- 迭代三：标量场图层 / LOD / 实例化 ----------

  /** 切换标量场叠加层（威胁强度 / 安全裕度 / 综合代价，功能03） */
  async setFieldLayer(mode: FieldLayerMode): Promise<void> {
    // 关闭
    if (mode === 'off') {
      if (this.fieldOverlay) {
        this.fieldBuildingGroup.remove(this.fieldOverlay.mesh)
        this.disposeObject(this.fieldOverlay.mesh)
        this.fieldOverlay = null
      }
      this.fieldGrid = null
      return
    }
    const env = this.getEnvironment()
    const plan = this.sceneStore.planParams
    const altitude = Math.max(plan.cruiseAlt, 40)
    // 大场景默认降分辨率（LOD），开启 LOD 且尺寸大时用 64
    const resolution =
      this.engine.layers.lodEnabled && env.terrain.params.size > 1100 ? 64 : 96
    const kind = modeToKind(mode)!
    const cacheKey = fieldCacheKey(
      this.sceneStore.terrain,
      kind,
      resolution,
      Math.round(altitude / 10)
    )

    let grid = this.fieldCache.get(cacheKey) ?? null
    if (!grid) {
      grid = buildFieldGrid(env, kind, {
        resolution,
        altitude,
        clearance: plan.clearance,
        cruiseAlt: plan.cruiseAlt
      })
      // WebGPU 可选加速：仅威胁场且开关打开时用 GPU 重算栅格值
      if (kind === 'threat' && this.engine.webgpuEnabled) {
        const gpuVals = await tryComputeThreatFieldGPU(
          this.sceneStore.threats.map((t) => ({
            x: t.position.x,
            z: t.position.z,
            radius: t.radius,
            heightMin: t.heightMin,
            heightMax: t.heightMax,
            level: t.level
          })),
          resolution,
          env.terrain.params.size / 2,
          altitude
        )
        if (gpuVals) {
          grid.values.set(gpuVals)
          grid.min = Math.min(...gpuVals)
          grid.max = Math.max(...gpuVals)
        }
      }
      this.fieldCache.set(cacheKey, grid)
      if (this.fieldCache.size > 12) {
        const firstKey = this.fieldCache.keys().next().value
        if (firstKey) this.fieldCache.delete(firstKey)
      }
    }
    this.fieldGrid = grid

    // 复用或重建叠加网格
    if (
      !this.fieldOverlay ||
      (this.fieldOverlay.mesh.geometry.getAttribute('position') as THREE.BufferAttribute)
        .count !==
        resolution * resolution
    ) {
      if (this.fieldOverlay) {
        this.fieldBuildingGroup.remove(this.fieldOverlay.mesh)
        this.disposeObject(this.fieldOverlay.mesh)
      }
      const colorFn = kind === 'clearance' ? clearanceColor : heatColor
      this.fieldOverlay = createFieldOverlay(
        env.terrain.params.size / 2,
        resolution,
        altitude,
        colorFn
      )
      this.fieldBuildingGroup.add(this.fieldOverlay.mesh)
    }
    this.fieldOverlay.update(grid.values, resolution, grid.min, grid.max)
  }

  /** 切换实例化建筑（功能04：InstancedMesh，单次 draw call） */
  setInstancedBuildings(enabled: boolean) {
    if (enabled) {
      // 移除常规建筑网格（保留威胁/禁飞）
      this.zoneGroup.children
        .filter((c) => c.userData.entityType === 'obstacle')
        .forEach((c) => {
          this.zoneGroup.remove(c)
          this.disposeObject(c)
        })
      if (!this.instancedBuildings && this.terrain) {
        this.instancedBuildings = createInstancedBuildings(
          this.sceneStore.obstacles,
          this.terrain
        )
        this.fieldBuildingGroup.add(this.instancedBuildings)
      }
    } else {
      if (this.instancedBuildings) {
        this.fieldBuildingGroup.remove(this.instancedBuildings)
        this.disposeObject(this.instancedBuildings)
        this.instancedBuildings = null
      }
      this.syncZones()
    }
  }

  // ---------- 迭代三：多无人机 ----------

  /** 同步编队无人机模型与范围环 */
  syncFleet() {
    const runtimes = this.engine.fleetRuntimes
    const alive = new Set(runtimes.map((r) => r.spec.id))
    // 删除多余
    for (const [id, obj] of this.fleetDrones) {
      if (!alive.has(id)) {
        this.fleetGroup.remove(obj.group)
        this.disposeObject(obj.group)
        this.fleetDrones.delete(id)
      }
    }
    for (const rt of runtimes) {
      if (rt.path.length < 2) continue
      let entry = this.fleetDrones.get(rt.spec.id)
      if (!entry) {
        const model = createFleetDrone(rt.spec.color)
        const sensor = createRangeSphere(rt.spec.sensorRange, new THREE.Color(rt.spec.color).getHex())
        const comm = createRangeRing(rt.spec.commRange, 0x4dd0e1, 0.4)
        sensor.visible = this.engine.layers.showSensorRange
        comm.visible = this.engine.layers.showCommRange
        model.group.add(sensor)
        model.group.add(comm)
        this.fleetGroup.add(model.group)
        entry = { group: model.group, rotors: model.rotors, sensor, comm }
        this.fleetDrones.set(rt.spec.id, entry)
      }
      entry.sensor.visible = this.engine.layers.showSensorRange
      entry.comm.visible = this.engine.layers.showCommRange
      // 航迹线
      this.syncFleetPath(rt)
    }
  }

  private fleetPathLines = new Map<string, THREE.Line>()

  private syncFleetPath(rt: DroneRuntime) {
    let line = this.fleetPathLines.get(rt.spec.id)
    if (line) {
      this.fleetGroup.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    if (rt.path.length >= 2) {
      line = createPathLine(rt.path, {
        color: new THREE.Color(rt.spec.color).getHex(),
        opacity: 0.85
      })
      this.fleetGroup.add(line)
      this.fleetPathLines.set(rt.spec.id, line)
    } else {
      this.fleetPathLines.delete(rt.spec.id)
    }
  }

  clearFleetView() {
    for (const [, obj] of this.fleetDrones) {
      this.fleetGroup.remove(obj.group)
      this.disposeObject(obj.group)
    }
    this.fleetDrones.clear()
    for (const [, line] of this.fleetPathLines) {
      this.fleetGroup.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    this.fleetPathLines.clear()
  }

  /** 每帧更新编队：位置、传感器/通信范围、链路与间隔 */
  private updateFleet(dt: number) {
    const runtimes = this.engine.fleetRuntimes
    if (runtimes.length === 0) return
    const t = this.simStore.simTime
    const pairs: [Vec3, Vec3][] = []
    const links = fleetCommLinks(runtimes, t)
    for (const [, , a, b] of links) pairs.push([a, b])
    if (this.engine.layers.showCommLinks) {
      this.commLinks.visible = true
      updateCommLinks(this.commLinks, pairs)
    } else {
      this.commLinks.visible = false
    }

    const seps = fleetSeparation(runtimes, t)
    let minSep = Infinity
    runtimes.forEach((rt, i) => {
      const entry = this.fleetDrones.get(rt.spec.id)
      if (!entry) return
      const active = fleetActiveAt(rt, t)
      entry.group.visible = active
      if (!active) return
      const s = sampleFleetDrone(rt, t)
      if (s) {
        entry.group.position.set(s.position.x, s.position.y, s.position.z)
        if (Math.hypot(s.velocity.x, s.velocity.z) > 0.5) {
          entry.group.rotation.y = Math.atan2(s.velocity.x, s.velocity.z)
        }
      }
      const spin = 1 + dt * 24
      for (const r of entry.rotors) r.rotation.y += spin
      if (isFinite(seps[i]) && seps[i] < minSep) minSep = seps[i]
    })
    this.engine.setFleetMinSeparation(minSep)
  }

  // ---------- 迭代三：性能 HUD ----------

  /**
   * 功能04：对场叠加层做距离 LOD + 视锥裁剪。
   * - 相机距离远时整体降低不透明度（视觉降级）并降帧更新；
   * - frustumCulling 开关关闭时强制渲染（three 自带球体包围盒裁剪之外的补充）。
   */
  private updateFieldLod() {
    if (!this.fieldOverlay || !this.fieldGrid) return
    const mesh = this.fieldOverlay.mesh
    const camPos = this.camera.position
    const center = mesh.position
    const dist = camPos.distanceTo(
      new THREE.Vector3(center.x, this.fieldGrid.altitude, center.z)
    )
    // 距离阈值按场景尺寸缩放
    const near = this.sceneStore.terrain.size * 0.9
    const far = this.sceneStore.terrain.size * 2.4
    const mat = mesh.material as THREE.MeshBasicMaterial
    if (this.engine.layers.lodEnabled && dist > near) {
      const k = Math.max(0.25, 1 - (dist - near) / Math.max(far - near, 1) * 0.6)
      mat.opacity = 0.55 * k
    } else {
      mat.opacity = 0.55
    }
    // 视锥裁剪总开关（false 时即使包围盒判定不可见也强制绘制）
    mesh.frustumCulled = this.engine.layers.frustumCulling
  }

  private updatePerfHud() {
    if (!this.perfHud) return
    this.perfHud.style.display = this.engine.showPerfHud ? 'block' : 'none'
    if (!this.engine.showPerfHud) return
    const e = this.engine
    const mem = e.usedMB ? `${e.usedMB} MB` : 'n/a'
    this.perfHud.innerHTML =
      `FPS <b style="color:${e.fps >= 50 ? '#9fe8b8' : e.fps < 30 ? '#ff8a65' : '#ffd166'}">${e.fps}</b><br>` +
      `帧 ${e.frameMs} ms<br>` +
      `规划 ${e.planMs} ms<br>` +
      `DC ${e.drawCalls} · tri ${e.triangles}<br>` +
      `内存 ${mem}<br>` +
      `<span style="color:#6fa8d8">${e.backend.toUpperCase()}${
        e.webgpuEnabled ? '+GPU' : ''
      }</span>`
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
    this.updateReplanToast()
    this.updateHazardMarker(elapsed)
    this.updateFleet(dt)
    this.updateFieldLod()

    // 回放期动态威胁出现：航迹威胁颜色实时刷新
    if (this.simStore.playing) this.recolorPath()

    // 选中高亮环
    this.updateSelectRing()

    if (this.simStore.cameraMode === 'follow') this.updateFollowCamera()
    this.controls.update()
    this.renderer.render(this.scene, this.camera)

    // 迭代三：上报真实渲染统计与性能 HUD
    this.engine.updatePerf({
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles
    })
    this.updatePerfHud()
    this.stats?.end()
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
    this.renderer.dispose()
    el.remove()
    this.perfHud?.remove()
    this.stats?.dom?.remove()
  }
}

function vec(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z)
}
