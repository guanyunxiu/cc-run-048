/**
 * 运行环境能力检测（迭代三功能04）。
 * 全部检测均为惰性 + 缓存，不抛异常（无 DOM/无 GPU 环境返回 false）。
 */

export interface PlatformCapabilities {
  webWorker: boolean
  sharedArrayBuffer: boolean
  /** crossOriginIsolated：SAB 可在 Worker 间零拷贝共享的前提 */
  crossOriginIsolated: boolean
  offscreenCanvas: boolean
  webgpu: boolean
  webgl2: boolean
  /** performance.memory（Chromium） */
  memoryInfo: boolean
  hardwareConcurrency: number
}

let cached: PlatformCapabilities | null = null

function safeGpu(): GPU | undefined {
  try {
    return (navigator as Navigator & { gpu?: GPU }).gpu
  } catch {
    return undefined
  }
}

export function detectCapabilities(): PlatformCapabilities {
  if (cached) return cached
  const hasWindow = typeof window !== 'undefined'
  const hasNavigator = typeof navigator !== 'undefined'
  cached = {
    webWorker: typeof Worker !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated:
      hasWindow &&
      typeof (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
        'boolean'
        ? !!globalThis.crossOriginIsolated
        : false,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    webgpu: hasNavigator && !!safeGpu(),
    webgl2: (() => {
      if (!hasWindow || typeof document === 'undefined') return false
      // jsdom 等无 WebGL 实现的环境会同步抛 "not implemented"
      const getContext = (HTMLCanvasElement.prototype as unknown as {
        getContext?: (type: string) => unknown
      }).getContext
      if (typeof getContext !== 'function') return false
      try {
        const c = document.createElement('canvas')
        const fn = c.getContext.bind(c) as (type: string) => unknown
        return !!(fn('webgl2') || fn('experimental-webgl2'))
      } catch {
        return false
      }
    })(),    memoryInfo:
      hasNavigator &&
      !!(performance as Performance & { memory?: unknown }).memory,
    hardwareConcurrency:
      hasNavigator && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4
  }
  return cached
}

/** 仅供测试：重置能力缓存 */
export function resetCapabilitiesCache(): void {
  cached = null
}
