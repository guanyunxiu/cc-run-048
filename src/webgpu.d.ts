/**
 * 最小 WebGPU 类型声明（迭代三功能04）。
 * 仅声明本项目 compute shader 加速路径使用到的接口，
 * 避免引入完整 @webgpu/types 依赖；运行时仍以能力检测为准。
 */

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>
}

interface GPUDevice {
  createShaderModule(desc: { code: string }): GPUShaderModule
  createComputePipelineAsync(desc: {
    layout: 'auto'
    compute: { module: GPUShaderModule; entryPoint: string }
  }): Promise<GPUComputePipeline>
  createBindGroup(desc: {
    layout: GPUBindGroupLayout
    entries: { binding: number; resource: { buffer: GPUBuffer } }[]
  }): GPUBindGroup
  createBuffer(desc: { size: number; usage: number }): GPUBuffer
  createCommandEncoder(): GPUCommandEncoder
  queue: GPUQueue
  destroy(): void
}

interface GPUShaderModule {}
interface GPUComputePipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout
}
interface GPUBindGroupLayout {}
interface GPUBindGroup {}
interface GPUBuffer {
  mapAsync(mode: number): Promise<void>
  getMappedRange(): ArrayBuffer
  unmap(): void
}
interface GPUQueue {
  submit(commands: GPUCommandBuffer[]): void
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView): void
}
interface GPUCommandBuffer {}
interface GPUComputePassEncoder {
  setPipeline(p: GPUComputePipeline): void
  setBindGroup(index: number, bg: GPUBindGroup): void
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  end(): void
}
interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder
  copyBufferToBuffer(
    src: GPUBuffer,
    srcOffset: number,
    dst: GPUBuffer,
    dstOffset: number,
    size: number
  ): void
  finish(): GPUCommandBuffer
}

declare const GPUBufferUsage: {
  UNIFORM: number
  STORAGE: number
  COPY_DST: number
  COPY_SRC: number
  MAP_READ: number
}
declare const GPUMapMode: { READ: number }

interface Navigator {
  readonly gpu?: GPU
}
