/**
 * WebGPU 最小类型声明（迭代三功能04）。
 * 仅声明本项目实际用到的 API 子集；浏览器已内置实现，
 * 这里只保证 TypeScript strict 下可编译。完整类型见 @webgpu/types。
 */

interface Navigator {
  readonly gpu?: GPU
}

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>
}

interface GPUDevice {
  createShaderModule(descriptor: { code: string }): GPUShaderModule
  createBuffer(descriptor: {
    size: number
    usage: number
  }): GPUBuffer
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup
  createComputePipeline(
    descriptor: GPUComputePipelineDescriptor
  ): GPUComputePipeline
  createCommandEncoder(): GPUCommandEncoder
  readonly queue: GPUQueue
}

interface GPUShaderModule {}
interface GPUBuffer {
  mapAsync(mode: number): Promise<void>
  getMappedRange(): ArrayBuffer
  unmap(): void
  destroy(): void
}
interface GPUTexture {}
interface GPUBindGroup {}
interface GPUBindGroupLayout {}

interface GPUBindGroupEntry {
  binding: number
  resource: { buffer: GPUBuffer }
}
interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout
  entries: GPUBindGroupEntry[]
}

interface GPUProgrammableStage {
  module: GPUShaderModule
  entryPoint: string
}
interface GPUComputePipelineDescriptor {
  layout: 'auto' | GPUBindGroupLayout
  compute: GPUProgrammableStage
}
interface GPUComputePipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void
  setBindGroup(index: number, bindGroup: GPUBindGroup): void
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  end(): void
}

interface GPUCommandEncoder {
  beginComputePass(): GPUComputePassEncoder
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size: number
  ): void
  finish(): GPUCommandBuffer
}

interface GPUCommandBuffer {}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBufferView
  ): void
}

interface GPURenderPipeline {}

declare const GPUBufferUsage: {
  UNIFORM: number
  STORAGE: number
  COPY_DST: number
  COPY_SRC: number
  MAP_READ: number
}
declare const GPUMapMode: {
  READ: number
}
