/**
 * WebGPU 可选升级（功能04）：
 * - 能力检测（navigator.gpu）
 * - 用 compute shader 批量计算标量场（威胁强度），不可用时无缝回退 CPU
 * - 不影响 WebGL2 渲染主路径；仅作为数据并行加速的可选后端
 *
 * 无 GPU/无头环境下 detectWebGPU() 返回 available=false，
 * computeThreatField 直接走 CPU 路径，保证测试与旧设备可用。
 */

export interface WebGPUDeviceInfo {
  adapter: GPUAdapter
  device: GPUDevice
  /** 厂商/架构描述（可能为空字符串） */
  description: string
}

export interface WebGPUSupport {
  available: boolean
  reason?: string
  info?: WebGPUDeviceInfo
}

let cachedSupport: WebGPUSupport | null = null

/** 检测 WebGPU 支持并请求 device（结果缓存） */
export async function detectWebGPU(): Promise<WebGPUSupport> {
  if (cachedSupport) return cachedSupport
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    cachedSupport = { available: false, reason: '当前浏览器不支持 WebGPU' }
    return cachedSupport
  }
  try {
    const adapter = await (navigator as Navigator).gpu!.requestAdapter()
    if (!adapter) {
      cachedSupport = { available: false, reason: '未找到可用 GPU 适配器' }
      return cachedSupport
    }
    const device = await adapter.requestDevice()
    const info =
      'info' in adapter
        ? (adapter as unknown as { info?: { vendor?: string; architecture?: string } })
            .info
        : undefined
    cachedSupport = {
      available: true,
      info: {
        adapter,
        device,
        description: [info?.vendor, info?.architecture].filter(Boolean).join(' · ')
      }
    }
    return cachedSupport
  } catch (err) {
    cachedSupport = {
      available: false,
      reason: `WebGPU 初始化失败：${(err as Error).message}`
    }
    return cachedSupport
  }
}

/** 同步快速判断（不请求 device，用于 UI 徽标） */
export function webgpuLikelySupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

interface FlatThreat {
  x: number
  z: number
  radius: number
  heightMin: number
  heightMax: number
  level: number
}

/**
 * 威胁场 GPU 计算：
 * 每个 invocation 对应一个栅格点，叠加所有威胁圆柱场强。
 * 输出 Float32 一维数组（与 CPU buildFieldGrid 行优先一致）。
 */
export async function computeThreatFieldGPU(
  info: WebGPUDeviceInfo,
  threats: FlatThreat[],
  resolution: number,
  halfSize: number,
  altitude: number
): Promise<Float32Array | null> {
  const device = info.device
  const count = resolution * resolution

  // 威胁数据缓冲（无威胁时用 1 个占位）
  const threatData = new Float32Array(Math.max(threats.length, 1) * 6)
  threats.forEach((t, i) => {
    threatData[i * 6] = t.x
    threatData[i * 6 + 1] = t.z
    threatData[i * 6 + 2] = t.radius
    threatData[i * 6 + 3] = t.heightMin
    threatData[i * 6 + 4] = t.heightMax
    threatData[i * 6 + 5] = t.level
  })

  const shader = /* wgsl */ `
    struct Params {
      resolution: f32,
      halfSize: f32,
      altitude: f32,
      threatCount: f32,
    };
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var<storage, read> threats: array<f32>;
    @group(0) @binding(2) var<storage, read_write> out: array<f32>;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let r = u32(params.resolution);
      let idx = gid.y * r + gid.x;
      if (gid.x >= r || gid.y >= r) { return; }
      let h = params.halfSize;
      let px = -h + (f32(gid.x) / max(params.resolution - 1.0, 1.0)) * 2.0 * h;
      let pz = -h + (f32(gid.y) / max(params.resolution - 1.0, 1.0)) * 2.0 * h;
      var sum = 0.0;
      let n = u32(params.threatCount);
      for (var i = 0u; i < n; i = i + 1u) {
        let base = i * 6u;
        let r_ = threats[base + 2];
        if (params.altitude < threats[base + 3] || params.altitude > threats[base + 4]) {
          continue;
        }
        let dx = px - threats[base];
        let dz = pz - threats[base + 1];
        let d = sqrt(dx * dx + dz * dz);
        if (d >= r_) { continue; }
        let f = 1.0 - d / r_;
        sum = sum + (threats[base + 5] / 5.0) * f * f;
      }
      out[idx] = sum;
    }
  `

  const module = device.createShaderModule({ code: shader })
  const params = new Float32Array([resolution, halfSize, altitude, threats.length])

  const paramBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(paramBuffer, 0, params)

  const threatBuffer = device.createBuffer({
    size: Math.max(threatData.byteLength, 24),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(threatBuffer, 0, threatData)

  const outBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  })
  const readBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  })

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: { buffer: threatBuffer } },
      { binding: 2, resource: { buffer: outBuffer } }
    ]
  })

  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  const groups = Math.ceil(resolution / 8)
  pass.dispatchWorkgroups(groups, groups)
  pass.end()
  encoder.copyBufferToBuffer(outBuffer, 0, readBuffer, 0, count * 4)
  device.queue.submit([encoder.finish()])

  try {
    await readBuffer.mapAsync(GPUMapMode.READ)
    const copy = new Float32Array(readBuffer.getMappedRange()).slice()
    readBuffer.unmap()
    paramBuffer.destroy()
    threatBuffer.destroy()
    outBuffer.destroy()
    readBuffer.destroy()
    return copy as Float32Array
  } catch {
    return null
  }
}

/**
 * 统一入口：优先 WebGPU 计算威胁场，失败/不可用返回 null（由调用方走 CPU）。
 */
export async function tryComputeThreatFieldGPU(
  threats: FlatThreat[],
  resolution: number,
  halfSize: number,
  altitude: number
): Promise<Float32Array | null> {
  const support = await detectWebGPU()
  if (!support.available || !support.info) return null
  try {
    return await computeThreatFieldGPU(
      support.info,
      threats,
      resolution,
      halfSize,
      altitude
    )
  } catch {
    return null
  }
}

export type { FlatThreat }
