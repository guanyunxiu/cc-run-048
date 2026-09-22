import * as THREE from 'three'
import type {
  BuildingObstacle,
  DynamicEntity,
  NoFlyZone,
  ThreatKind,
  ThreatZone,
  Vec3
} from '@/types'
import type { TerrainData } from '@/core/terrain'
import { sampleHeight } from '@/core/terrain'

/** 威胁类型 -> 基础颜色（颜色映射） */
export const THREAT_COLORS: Record<ThreatKind, number> = {
  radar: 0x22a7ff, // 雷达：蓝
  sam: 0xff3b30, // 防空：红
  jammer: 0xb046ff // 干扰：紫
}

export const NOFLY_COLOR = 0xff2d55
export const WAYPOINT_COLORS = {
  start: 0x2ecc71,
  end: 0xe74c3c,
  via: 0xf1c40f
}

const tmpColor = new THREE.Color()

/** 地形高程配色：低 -> 高 渐变（滩涂/草/岩/雪） */
function terrainGradient(h: number, maxH: number, out: THREE.Color): THREE.Color {
  const t = Math.max(0, Math.min(1, h / maxH))
  if (t < 0.25) out.setRGB(0.83 + t * 0.3, 0.76 + t * 0.25, 0.52)
  else if (t < 0.55)
    out.setRGB(0.36 - (t - 0.25) * 0.4, 0.55 - (t - 0.25) * 0.15, 0.28)
  else if (t < 0.8)
    out.setRGB(0.34 + (t - 0.55) * 0.9, 0.31 + (t - 0.55) * 0.8, 0.28)
  else out.setRGB(0.9, 0.92, 0.95)
  return out
}

export interface TerrainMeshResult {
  mesh: THREE.Mesh
  /** 重新计算顶点色（高度配色 + 威胁/禁飞强度叠加） */
  applyOverlay: (
    threatField: (x: number, z: number) => number,
    noflyField: (x: number, z: number) => number,
    enabled: boolean
  ) => void
}

/** 由 DEM 高程网格构建地形网格（顶点着色） */
export function createTerrainMesh(terrain: TerrainData): TerrainMeshResult {
  const n = terrain.gridSize
  const { size } = terrain.params
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(n * n * 3)
  const colors = new Float32Array(n * n * 3)
  const indices: number[] = []

  let pi = 0
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / (n - 1)) * size - terrain.halfSize
      const z = (iz / (n - 1)) * size - terrain.halfSize
      const y = terrain.heights[iz * n + ix]
      positions[pi] = x
      positions[pi + 1] = y
      positions[pi + 2] = z
      pi += 3
    }
  }

  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.02,
    flatShading: false
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'

  const maxH = Math.max(...terrain.heights, 1)
  const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute
  const overlay = new THREE.Color()
  const noflyC = new THREE.Color(NOFLY_COLOR)

  const applyOverlay = (
    threatField: (x: number, z: number) => number,
    noflyField: (x: number, z: number) => number,
    enabled: boolean
  ) => {
    let k = 0
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = positions[k * 3]
        const z = positions[k * 3 + 2]
        const h = positions[k * 3 + 1]
        terrainGradient(h, maxH, tmpColor)
        if (enabled) {
          const ti = Math.min(1, threatField(x, z))
          if (ti > 0.02) {
            // 威胁热力：红/橙叠加
            overlay.setHSL(0.02 * (1 - ti), 0.95, 0.5)
            tmpColor.lerp(overlay, Math.min(0.75, ti * 0.8))
          }
          const ni = Math.min(1, noflyField(x, z))
          if (ni > 0.02) tmpColor.lerp(noflyC, Math.min(0.7, ni * 0.8))
        }
        colorAttr.setXYZ(k, tmpColor.r, tmpColor.g, tmpColor.b)
        k++
      }
    }
    colorAttr.needsUpdate = true
  }
  applyOverlay(() => 0, () => 0, false)

  return { mesh, applyOverlay }
}

/** 威胁区：半透明圆柱 + 地面范围圆环 + 顶部环（颜色随等级映射） */
export function createThreatMesh(t: ThreatZone): THREE.Group {
  const g = new THREE.Group()
  g.userData.entityId = t.id
  g.userData.entityType = 'threat'
  const base = new THREE.Color(THREAT_COLORS[t.kind])
  // 等级越高颜色越亮、越偏暖
  const color = base.clone()
  color.offsetHSL(0, 0, (t.level - 3) * 0.04)

  const h = Math.max(1, t.heightMax - t.heightMin)
  const cylGeo = new THREE.CylinderGeometry(t.radius, t.radius, h, 48, 1, true)
  const cylMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: t.opacity,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  const cyl = new THREE.Mesh(cylGeo, cylMat)
  cyl.position.set(t.position.x, (t.heightMin + t.heightMax) / 2, t.position.z)
  g.add(cyl)

  const lineMat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9
  })
  for (const yy of [t.heightMin + 0.5, t.heightMax]) {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(circlePoints(t.radius, yy)),
      lineMat
    )
    ring.position.set(t.position.x, 0, t.position.z)
    g.add(ring)
  }

  // 地面圆盘（极淡填充，便于俯视识别）
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(t.radius, 48),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.08,
      depthWrite: false
    })
  )
  disk.rotation.x = -Math.PI / 2
  disk.position.set(t.position.x, 0.5, t.position.z)
  g.add(disk)

  // 中心标记小杆
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, h, 8),
    new THREE.MeshBasicMaterial({ color })
  )
  pole.position.set(t.position.x, t.heightMin + h / 2, t.position.z)
  g.add(pole)

  return g
}

function circlePoints(radius: number, y: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius))
  }
  return pts
}

/** 禁飞区：红色半透明圆柱 + 线框 + 斜纹警戒柱 */
export function createNoFlyMesh(z: NoFlyZone): THREE.Group {
  const g = new THREE.Group()
  g.userData.entityId = z.id
  g.userData.entityType = 'nofly'
  const color = new THREE.Color(NOFLY_COLOR)
  const h = Math.max(1, z.heightMax - z.heightMin)

  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(z.radius, z.radius, h, 48, 1, true),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  )
  cyl.position.set(z.position.x, (z.heightMin + z.heightMax) / 2, z.position.z)
  g.add(cyl)

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(
      new THREE.CylinderGeometry(z.radius, z.radius, h, 24, 4, true)
    ),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
  )
  wire.position.copy(cyl.position)
  g.add(wire)

  // 地面/顶部范围环
  for (const yy of [0.5, z.heightMax]) {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(circlePoints(z.radius, yy)),
      new THREE.LineBasicMaterial({ color, linewidth: 2 })
    )
    ring.position.set(z.position.x, 0, z.position.z)
    g.add(ring)
  }
  return g
}

/** 建筑障碍：贴地立方体 */
export function createBuildingMesh(
  b: BuildingObstacle,
  terrain: TerrainData
): THREE.Mesh {
  const baseY = sampleHeight(terrain, b.position.x, b.position.z) - 0.3
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(b.size.x, b.height, b.size.z),
    new THREE.MeshStandardMaterial({
      color: 0x9aa3ad,
      roughness: 0.8,
      metalness: 0.15
    })
  )
  mesh.position.set(b.position.x, baseY + b.height / 2, b.position.z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.entityId = b.id
  mesh.userData.entityType = 'obstacle'
  return mesh
}

/** 航点标记（可拾取的小球 + 立柱 + 文字精灵） */
export function createWaypointMarker(
  id: string,
  role: 'start' | 'end' | 'via',
  label: string
): THREE.Group {
  const g = new THREE.Group()
  g.userData.entityId = id
  g.userData.entityType = 'waypoint'
  const color = WAYPOINT_COLORS[role]

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(7, 20, 16),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.4
    })
  )
  g.add(sphere)

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(10, 0.8, 8, 32),
    new THREE.MeshBasicMaterial({ color })
  )
  ring.rotation.x = Math.PI / 2
  g.add(ring)

  const sprite = createTextSprite(label, `#${new THREE.Color(color).getHexString()}`)
  sprite.position.set(0, 16, 0)
  g.add(sprite)
  return g
}

/** Canvas 文字精灵（始终面向相机） */
export function createTextSprite(text: string, color = '#ffffff'): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const fontSize = 44
  ctx.font = `bold ${fontSize}px sans-serif`
  const w = Math.ceil(ctx.measureText(text).width) + 24
  canvas.width = w
  canvas.height = fontSize + 20
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.fillStyle = 'rgba(15,20,30,0.65)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 12, canvas.height / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    transparent: true
  })
  const sprite = new THREE.Sprite(mat)
  const scale = 0.5
  sprite.scale.set(canvas.width * scale * 0.5, canvas.height * scale * 0.5, 1)
  return sprite
}

/**
 * 无人机简化模型：X 型四旋翼（机身 + 机臂 + 旋翼）。
 * rotors 暴露给动画循环旋转。
 */
export interface DroneModel {
  group: THREE.Group
  rotors: THREE.Mesh[]
}

export function createDrone(): DroneModel {
  const group = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2c3e50,
    roughness: 0.4,
    metalness: 0.4
  })
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x1abc9c,
    emissive: 0x1abc9c,
    emissiveIntensity: 0.3
  })

  const body = new THREE.Mesh(new THREE.BoxGeometry(5, 2, 6), bodyMat)
  group.add(body)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3, 4), accentMat)
  nose.rotation.x = -Math.PI / 2
  nose.position.z = 4
  group.add(nose)

  const armGeo = new THREE.BoxGeometry(1.1, 0.8, 1.1)
  const rotorGeo = new THREE.BoxGeometry(7, 0.15, 0.6)
  const rotors: THREE.Mesh[] = []
  const offsets: [number, number][] = [
    [3.4, 3.4],
    [-3.4, 3.4],
    [3.4, -3.4],
    [-3.4, -3.4]
  ]
  for (const [x, z] of offsets) {
    const arm = new THREE.Mesh(armGeo, bodyMat)
    arm.scale.set(Math.abs(x) / 1.5, 1, Math.abs(z) / 1.5)
    arm.position.set(x / 2, 0.3, z / 2)
    arm.rotation.y = Math.sign(x) === Math.sign(z) ? Math.PI / 4 : -Math.PI / 4
    group.add(arm)

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 1.2, 8),
      bodyMat
    )
    mast.position.set(x, 0.8, z)
    group.add(mast)

    const rotor = new THREE.Mesh(rotorGeo, accentMat)
    rotor.position.set(x, 1.6, z)
    group.add(rotor)
    rotors.push(rotor)
  }
  group.scale.setScalar(1.2)
  return { group, rotors }
}

/** 由点集创建线段，支持顶点颜色（代价/威胁颜色映射） */
export function createPathLine(
  points: Vec3[],
  options: {
    color?: number
    vertexColors?: Float32Array
    opacity?: number
    dashed?: boolean
  } = {}
): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(
    points.map((p) => new THREE.Vector3(p.x, p.y, p.z))
  )
  if (options.vertexColors) {
    geo.setAttribute('color', new THREE.BufferAttribute(options.vertexColors, 3))
  }
  const mat = new THREE.LineBasicMaterial({
    color: options.color ?? 0xffffff,
    transparent: true,
    opacity: options.opacity ?? 1,
    vertexColors: !!options.vertexColors
  })
  const line = new THREE.Line(geo, mat)
  line.frustumCulled = false
  return line
}

/** 选中高亮环 */
export function createSelectRing(radius = 14): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 2, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffe066,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: false
    })
  )
  ring.rotation.x = -Math.PI / 2
  ring.renderOrder = 99
  return ring
}

/**
 * 动态实体网格（功能05）：
 * - obstacle：橙色球/胶囊 + 地面范围环 + 速度方向箭头；
 * - threat：红色脉冲圆柱 + 顶部环。
 * 激活/未激活通过 group.visible 与材质透明度区分。
 */
export interface DynamicMesh {
  group: THREE.Group
  /** 范围环（地面，随激活态显隐/变色） */
  rangeRing: THREE.LineLoop
  /** 主体（障碍球 / 威胁圆柱） */
  body: THREE.Object3D
  /** 预测轨迹线（由 SceneRenderer 更新点） */
  predictLine: THREE.Line
  /** 速度箭头 */
  arrow: THREE.ArrowHelper
  pulseMaterial: THREE.MeshBasicMaterial | null
}

export function createDynamicMesh(d: DynamicEntity): DynamicMesh {
  const group = new THREE.Group()
  group.userData.entityId = d.id
  group.userData.entityType = 'dynamic'
  const color = new THREE.Color(d.color || '#ff8f1f')

  let body: THREE.Object3D
  let pulseMaterial: THREE.MeshBasicMaterial | null = null
  const r = d.kind === 'threat' ? d.threatRadius : d.radius

  if (d.kind === 'obstacle') {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(d.radius, 20, 16),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        roughness: 0.5,
        metalness: 0.3
      })
    )
    sphere.castShadow = true
    body = sphere
    group.add(sphere)
  } else {
    const h = Math.max(1, d.heightMax - d.heightMin)
    pulseMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: d.active ? 0.24 : 0.05,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, h, 40, 1, true),
      pulseMaterial
    )
    cyl.position.y = (d.heightMin + d.heightMax) / 2
    body = cyl
    group.add(cyl)
    // 地面圆盘
    const disk = new THREE.Mesh(
      new THREE.CircleGeometry(r, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.1,
        depthWrite: false
      })
    )
    disk.rotation.x = -Math.PI / 2
    disk.position.y = 0.6
    group.add(disk)
  }

  const rangeRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(circlePoints(r, 1)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  )
  group.add(rangeRing)

  const predictLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({
      color,
      dashSize: 8,
      gapSize: 6,
      transparent: true,
      opacity: 0.7
    })
  )
  predictLine.frustumCulled = false
  group.add(predictLine)

  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, 0),
    d.radius * 2.2,
    color.getHex(),
    d.radius * 0.7,
    d.radius * 0.45
  )
  group.add(arrow)

  group.visible = d.active
  return { group, rangeRing, body, predictLine, arrow, pulseMaterial }
}

/** 更新预测虚线几何（computeLineDistances 用于虚线） */
export function updatePredictLine(line: THREE.Line, points: Vec3[]): void {
  const geo = new THREE.BufferGeometry().setFromPoints(
    points.map((p) => new THREE.Vector3(p.x, 1.5, p.z))
  )
  line.geometry.dispose()
  line.geometry = geo
  line.computeLineDistances()
}

/** 简单折线（用于局部重规划候选航迹/窗口） */
export function createSimpleLine(
  points: THREE.Vector3[],
  color: number,
  opacity = 0.5,
  dashed = false
): THREE.Line {
  const mat = dashed
    ? new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity,
        dashSize: 6,
        gapSize: 5
      })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), mat)
  if (dashed) line.computeLineDistances()
  line.frustumCulled = false
  return line
}

/**
 * 在线重规划触发风险位置标记（功能05）：
 * 脉冲球 + 扩散环 + 落地虚线 + 文字标签，
 * 与触发原因提示同窗口显示，便于在场景中定位风险来源。
 */
export interface HazardMarker {
  group: THREE.Group
  sphere: THREE.Mesh
  ring: THREE.Mesh
}

export function createHazardMarker(): HazardMarker {
  const color = new THREE.Color(0xff2d55)
  const group = new THREE.Group()

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(6, 20, 16),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false
    })
  )
  sphere.renderOrder = 60
  group.add(sphere)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(9, 11, 48),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthTest: false
    })
  )
  ring.rotation.x = -Math.PI / 2
  ring.renderOrder = 60
  group.add(ring)

  // 落地参考虚线：俯视/斜视时便于判断风险点的水平位置与高度
  const beam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -1000, 0)
    ]),
    new THREE.LineDashedMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      dashSize: 6,
      gapSize: 5
    })
  )
  beam.computeLineDistances()
  beam.frustumCulled = false
  group.add(beam)

  const label = createTextSprite('⚠ 风险位置', '#ff5263')
  label.position.set(0, 20, 0)
  group.add(label)

  return { group, sphere, ring }
}

/** 小球点集（用于约束违反点高亮） */
export function createPointMarkers(
  positions: Vec3[],
  color = 0xff3b30,
  radius = 5
): THREE.Points {
  const geo = new THREE.BufferGeometry().setFromPoints(
    positions.map((p) => new THREE.Vector3(p.x, p.y, p.z))
  )
  const mat = new THREE.PointsMaterial({
    color,
    size: radius * 2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthTest: false
  })
  const pts = new THREE.Points(geo, mat)
  pts.frustumCulled = false
  pts.renderOrder = 50
  return pts
}

// ===================================================================
// 迭代三（v3.0）：标量场图层 / 实例化建筑 / 传感器通信范围 / 多机
// ===================================================================

export interface FieldOverlayResult {
  mesh: THREE.Mesh
  /** 用新栅格值更新顶点色 */
  update: (values: Float32Array, resolution: number, min: number, max: number) => void
}

/**
 * 标量场平面叠加层（功能03）：
 * 在给定高度生成一张水平网格，顶点色由外部栅格值映射。
 * 返回 update() 以便切换图层模式时复用几何（LOD 降分辨率也可重建）。
 */
export function createFieldOverlay(
  halfSize: number,
  resolution: number,
  altitude: number,
  colorAt: (t: number, out: [number, number, number]) => void
): FieldOverlayResult {
  const positions = new Float32Array(resolution * resolution * 3)
  const colors = new Float32Array(resolution * resolution * 3)
  const indices: number[] = []
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const x = (ix / (resolution - 1)) * 2 * halfSize - halfSize
      const z = (iz / (resolution - 1)) * 2 * halfSize - halfSize
      const k = (iz * resolution + ix) * 3
      positions[k] = x
      positions[k + 1] = altitude
      positions[k + 2] = z
    }
  }
  for (let iz = 0; iz < resolution - 1; iz++) {
    for (let ix = 0; ix < resolution - 1; ix++) {
      const a = iz * resolution + ix
      const b = a + 1
      const c = a + resolution
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(indices)
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 5
  mesh.frustumCulled = true

  const update = (
    values: Float32Array,
    res: number,
    min: number,
    max: number
  ) => {
    const attr = geo.getAttribute('color') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const span = Math.max(max - min, 1e-6)
    const c: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < res * res; i++) {
      const t = (values[i] - min) / span
      colorAt(t, c)
      arr[i * 3] = c[0]
      arr[i * 3 + 1] = c[1]
      arr[i * 3 + 2] = c[2]
    }
    attr.needsUpdate = true
  }
  return { mesh, update }
}

/**
 * 实例化建筑（功能04：InstancedMesh）。
 * 用一次 draw call 渲染全部建筑；每实例独立变换与尺寸。
 */
export function createInstancedBuildings(
  buildings: {
    position: Vec3
    size: { x: number; z: number }
    height: number
  }[],
  terrain: TerrainData
): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9aa3ad,
    roughness: 0.8,
    metalness: 0.15
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(buildings.length, 1))
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const p = new THREE.Vector3()
  buildings.forEach((b, i) => {
    const baseY = sampleHeight(terrain, b.position.x, b.position.z) - 0.3
    p.set(b.position.x, baseY + b.height / 2, b.position.z)
    s.set(b.size.x, b.height, b.size.z)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false // 整体粗粒度，建筑数量少
  return mesh
}

/** 范围圆环（传感器探测 / 通信），水平 */
export function createRangeRing(
  radius: number,
  color: number,
  opacity = 0.5
): THREE.LineLoop {
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(circlePoints(radius, 0)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  )
  return ring
}

/** 半透明范围球（传感器覆盖体） */
export function createRangeSphere(
  radius: number,
  color: number
): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 20, 14),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.06,
      depthWrite: false
    })
  )
}

/** 通信链路线段（多机），顶点动态更新 */
export function createCommLinks(): THREE.LineSegments {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(0), 3)
  )
  const line = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0x4dd0e1,
      transparent: true,
      opacity: 0.8
    })
  )
  line.frustumCulled = false
  return line
}

/** 更新通信链路几何 */
export function updateCommLinks(
  line: THREE.LineSegments,
  pairs: [Vec3, Vec3][]
): void {
  const arr = new Float32Array(pairs.length * 6)
  pairs.forEach(([a, b], i) => {
    arr[i * 6] = a.x
    arr[i * 6 + 1] = a.y
    arr[i * 6 + 2] = a.z
    arr[i * 6 + 3] = b.x
    arr[i * 6 + 4] = b.y
    arr[i * 6 + 5] = b.z
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  line.geometry.dispose()
  line.geometry = geo
}

/** 多机小型无人机（编队用，带颜色） */
export function createFleetDrone(colorHex: string): {
  group: THREE.Group
  rotors: THREE.Mesh[]
} {
  const model = createDrone()
  model.group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.material && o !== model.group) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      // 旋翼与机身保持，机头/机身染编队色
      if (mat.emissive) {
        mat.color = new THREE.Color(colorHex)
        mat.emissive = new THREE.Color(colorHex)
        mat.emissiveIntensity = 0.35
      }
    }
  })
  return model
}

/** 二维 DOM 性能 HUD（功能04），由渲染器填充文本 */
export function createPerfHud(container: HTMLElement): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText =
    'position:absolute;right:8px;top:8px;z-index:10;background:rgba(8,16,30,0.78);' +
    'border:1px solid #2a4060;border-radius:6px;padding:7px 10px;font:11px monospace;' +
    'color:#9fe8b8;pointer-events:none;line-height:1.6;min-width:118px;display:none;'
  container.appendChild(el)
  return el
}
