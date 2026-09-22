import type { TerrainParams } from '@/types'
import { generateTerrain, sampleHeight } from './terrain'
import { detectCapabilities } from './capabilities'

/**
 * WebGPU 可选加速（迭代三功能04）。
 * 不依赖 three 的 WebGPURenderer（避免 TSL 运行时开销），
 * 而是用 WGSL compute shader 计算地形网格上的标量场
 * （威胁强度/安全裕度/代价热力），不支持时透明回退 CPU。
 */

export type FieldKind = 'threat' | 'clearance' | 'cost'

export interface FieldSource {
  threats: {
    x: number
    z: number
    radius: number
    level: number
    heightMin: number
    heightMax: number
  }[]
  nofly: {
    x: number
    z: number
    radius: number
    penalty: number
    heightMin: number
    heightMax: number
  }[]
}

export interface FieldResult {
  /** gridSize × gridSize 归一化强度（0..1+） */
  data: Float32Array
  gridSize: number
  backend: 'webgpu' | 'cpu'
  computeMs: number
}

const WGSL = /* wgsl */ `
struct Uniforms {
  gridSize: f32,
  halfSize: f32,
  kind: f32,
  cruiseAlt: f32,
  threatCount: f32,
  noflyCount: f32
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> threats: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> noflys: array<vec4<f32>>;
@group(0) @binding(3) var<storage, write> out: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(u.gridSize);
  let ix = gid.x;
  let iz = gid.y;
  if (ix >= n || iz >= n) { return; }
  let fx = f32(ix) / max(u.gridSize - 1.0, 1.0);
  let fz = f32(iz) / max(u.gridSize - 1.0, 1.0);
  let x = fx * (u.halfSize * 2.0) - u.halfSize;
  let z = fz * (u.halfSize * 2.0) - u.halfSize;
  let idx = iz * n + ix;

  var sum = 0.0;
  let tCount = u32(u.threatCount);
  for (var i = 0u; i < tCount; i = i + 1u) {
    let t = threats[i];
    let dx = x - t.x;
    let dz = z - t.z;
    let d = sqrt(dx * dx + dz * dz);
    if (d < t.z) {
      let f = 1.0 - d / t.z;
      sum = sum + (t.w / 5.0) * f * f;
    }
  }
  let nCount = u32(u.noflyCount);
  for (var i = 0u; i < nCount; i = i + 1u) {
    let nz = noflys[i];
    let dx = x - nz.x;
    let dz = z - nz.z;
    let d = sqrt(dx * dx + dz * dz);
    if (d < nz.z) {
      let f = 1.0 - d / nz.z;
      sum = sum + nz.w * f * f * 0.05;
    }
  }
  out[idx] = sum;
}
`

/**
 * 计算地形网格标量场。优先 WebGPU compute，失败/不支持则 CPU 回退。
 * 采样高度 y=cruiseAlt（水平切面，与俯视热力图一致）。
 */
export async function computeFieldGrid(
  terrainParams: TerrainParams,
  source: FieldSource,
  kind: FieldKind,
  cruiseAlt: number
): Promise<FieldResult> {
  const caps = detectCapabilities()
  if (caps.webgpu) {
    try {
      return await computeOnGpu(terrainParams, source, kind, cruiseAlt)
    } catch (err) {
      // 设备丢失/着色器编译失败等：静默回退
      console.warn('[WebGPU] 场计算回退 CPU：', err)
    }
  }
  return computeOnCpu(terrainParams, source, kind, cruiseAlt)
}

async function computeOnGpu(
  terrainParams: TerrainParams,
  source: FieldSource,
  kind: FieldKind,
  cruiseAlt: number
): Promise<FieldResult> {
  const t0 = performance.now()
  const adapter = await (navigator as Navigator & { gpu: GPU }).gpu.requestAdapter()
  if (!adapter) throw new Error('no adapter')
  const device = await adapter.requestDevice()

  const terrain = generateTerrain(terrainParams)
  const n = terrain.gridSize
  const size = terrainParams.size

  const threatVecs = new Float32Array(source.threats.length * 4)
  source.threats.forEach((t, i) => {
    if (cruiseAlt < t.heightMin || cruiseAlt > t.heightMax) return
    threatVecs[i * 4] = t.x
    threatVecs[i * 4 + 1] = t.z
    threatVecs[i * 4 + 2] = t.radius
    threatVecs[i * 4 + 3] = t.level
  })
  const noflyVecs = new Float32Array(source.nofly.length * 4)
  source.nofly.forEach((z, i) => {
    if (cruiseAlt < z.heightMin || cruiseAlt > z.heightMax) return
    noflyVecs[i * 4] = z.x
    noflyVecs[i * 4 + 1] = z.z
    noflyVecs[i * 4 + 2] = z.radius
    noflyVecs[i * 4 + 3] = z.penalty
  })

  const uniforms = new Float32Array([
    n,
    size / 2,
    kind === 'threat' ? 0 : kind === 'clearance' ? 1 : 2,
    cruiseAlt,
    source.threats.length,
    source.nofly.length
  ])

  const uniformBuf = device.createBuffer({
    size: Math.max(32, uniforms.byteLength),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(uniformBuf, 0, uniforms)
  const threatBuf = device.createBuffer({
    size: Math.max(16, threatVecs.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(threatBuf, 0, threatVecs)
  const noflyBuf = device.createBuffer({
    size: Math.max(16, noflyVecs.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(noflyBuf, 0, noflyVecs)
  const outBuf = device.createBuffer({
    size: n * n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  })
  const readBuf = device.createBuffer({
    size: n * n * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  })

  const module = device.createShaderModule({ code: WGSL })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: threatBuf } },
      { binding: 2, resource: { buffer: noflyBuf } },
      { binding: 3, resource: { buffer: outBuf } }
    ]
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bind)
  pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8))
  pass.end()
  encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * n * 4)
  device.queue.submit([encoder.finish()])
  await readBuf.mapAsync(GPUMapMode.READ)
  const data = new Float32Array(readBuf.getMappedRange()).slice()
  readBuf.unmap()

  // clearance / cost 模式在 GPU 威胁场基础上做后处理（地形净空/加权）
  postProcess(data, terrain, terrainParams, source, kind, cruiseAlt)

  device.destroy()
  return {
    data,
    gridSize: n,
    backend: 'webgpu',
    computeMs: Math.round((performance.now() - t0) * 100) / 100
  }
}

function computeOnCpu(
  terrainParams: TerrainParams,
  source: FieldSource,
  kind: FieldKind,
  cruiseAlt: number
): FieldResult {
  const t0 = performance.now()
  const terrain = generateTerrain(terrainParams)
  const n = terrain.gridSize
  const data = new Float32Array(n * n)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / (n - 1)) * terrainParams.size - terrainParams.size / 2
      const z = (iz / (n - 1)) * terrainParams.size - terrainParams.size / 2
      let sum = 0
      for (const t of source.threats) {
        if (cruiseAlt < t.heightMin || cruiseAlt > t.heightMax) continue
        const d = Math.hypot(x - t.x, z - t.z)
        if (d >= t.radius) continue
        const f = 1 - d / t.radius
        sum += (t.level / 5) * f * f
      }
      for (const z0 of source.nofly) {
        if (cruiseAlt < z0.heightMin || cruiseAlt > z0.heightMax) continue
        const d = Math.hypot(x - z0.x, z - z0.z)
        if (d >= z0.radius) continue
        const f = 1 - d / z0.radius
        sum += z0.penalty * f * f * 0.05
      }
      data[iz * n + ix] = sum
    }
  }
  postProcess(data, terrain, terrainParams, source, kind, cruiseAlt)
  return {
    data,
    gridSize: n,
    backend: 'cpu',
    computeMs: Math.round((performance.now() - t0) * 100) / 100
  }
}

/** clearance/cost 模式：将威胁场与地形净空、权重组合为最终可视化标量 */
function postProcess(
  data: Float32Array,
  terrain: ReturnType<typeof generateTerrain>,
  params: TerrainParams,
  _source: FieldSource,
  kind: FieldKind,
  cruiseAlt: number
): void {
  if (kind === 'threat') return
  const n = terrain.gridSize
  for (let i = 0; i < data.length; i++) {
    const iz = Math.floor(i / n)
    const ix = i % n
    const x = (ix / (n - 1)) * params.size - params.size / 2
    const z = (iz / (n - 1)) * params.size - params.size / 2
    const ground = sampleHeight(terrain, x, z)
    const gap = Math.max(0, cruiseAlt - ground)
    if (kind === 'clearance') {
      // 净空越小值越大（危险），归一化到 0..1
      data[i] = Math.max(data[i], Math.max(0, 1 - gap / 120))
    } else {
      // cost：威胁 + 高度偏差 + 地形净空
      const altPenalty = Math.abs(cruiseAlt - 120) / 120
      data[i] = data[i] * 2 + altPenalty * 0.2 + Math.max(0, 1 - gap / 100)
    }
  }
}
