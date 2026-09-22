// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** 最小 WebGL2 mock：用 Proxy 覆盖 Three.js 调用的所有方法/常量 */
function installWebGLMock() {
  function makeCtx(version: 1 | 2) {
    const special: Record<string, unknown> = {
      getParameter(p: number) {
        if (p === 0x1f00)
          return version === 2 ? 'WebGL 2.0 (SwiftShader)' : 'WebGL 1.0'
        if (p === 0x1f01) return 'MockGL' // RENDERER
        if (p === 0x8869 || p === 0x8dfb || p === 0x8b4c || p === 0x8b49)
          return 32
        if (p === 0x851c || p === 0x84ff) return 16384
        return 0
      },
      getExtension(name: string) {
        if (name === 'WEBGL_lose_context')
          return { loseContext: () => {}, restoreContext: () => {} }
        if (
          name === 'ANGLE_instanced_arrays' ||
          name === 'OES_texture_float' ||
          name === 'OES_vertex_array_object' ||
          name === 'EXT_color_buffer_float' ||
          name === 'OES_texture_half_float'
        )
          return {}
        return null
      },
      getSupportedExtensions: () => ['WEBGL_lose_context'],
      getShaderPrecisionFormat: () => ({ rangeMin: 1, rangeMax: 1, precision: 1 }),
      getShaderParameter: () => true,
      getProgramParameter: (p: number) =>
        p === 0x8b86 || p === 0x8b82 ? true : 0, // LINK_STATUS/DELETE_STATUS
      getActiveUniformsiv: () => 0,
      getShaderInfoLog: () => '',
      getProgramInfoLog: () => '',
      createShader: () => ({}),
      createProgram: () => ({}),
      createBuffer: () => ({}),
      createTexture: () => ({}),
      createFramebuffer: () => ({}),
      createRenderbuffer: () => ({}),
      createVertexArray: () => ({}),
      getUniformLocation: () => ({}),
      getActiveUniform: () => null,
      getActiveAttrib: () => null,
      getAttribLocation: () => 0,
      checkFramebufferStatus: () => 0x8cd5,
      isContextLost: () => false
    }
    const GL_CONST: Record<string, number> = {
      VERSION: 0x1f00,
      RENDERER: 0x1f01,
      VENDOR: 0x1f00,
      SHADING_LANGUAGE_VERSION: 0x8b8c
    }
    const ctx = new Proxy(special, {
      get(target, prop) {
        if (prop in target) return target[prop as string]
        if (typeof prop === 'string' && prop in GL_CONST) return GL_CONST[prop]
        // GL 常量属性（大写下划线命名）返回数字，其余为无操作方法
        if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]+$/.test(prop)) return 0
        return () => {}
      },
      has() {
        return true
      }
    })
    return ctx as unknown as WebGL2RenderingContext
  }

  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type: any) {
    if (
      type === 'webgl2' ||
      type === 'webgl' ||
      type === 'experimental-webgl2'
    ) {
      return makeCtx(type === 'webgl' ? 1 : 2)
    }
    if (type === '2d') {
      // Canvas 2D mock（createTextSprite 使用）
      const target: Record<string, unknown> = {
        measureText: () => ({ width: 80, actualBoundingBoxAscent: 10 }),
        getContextAttributes: () => ({})
      }
      return new Proxy(target, {
        get(t, p) {
          if (p in t) return t[p as string]
            if (p === 'canvas') return this
            if (p === 'fillStyle' || p === 'font' || p === 'textBaseline')
              return ''
            if (/^[A-Z][A-Z0-9_]+$/.test(String(p))) return 0
            const noop = () => {}
            return noop
          },
          set() {
            return true
          }
        }
      ) as unknown as CanvasRenderingContext2D
    }
    // @ts-expect-error mock
    return orig.call(this, type)
  } as typeof HTMLCanvasElement.prototype.getContext
}

// jsdom 缺失 API
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as any).ResizeObserver = RO
;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 16) as unknown as number
;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id)

installWebGLMock()

import { SceneRenderer } from '@/three/SceneRenderer'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'

describe('SceneRenderer（jsdom + WebGL mock）', () => {
  let container: HTMLDivElement
  let renderer: SceneRenderer

  beforeEach(() => {
    setActivePinia(createPinia())
    container = document.createElement('div')
    container.style.width = '800px'
    container.style.height = '600px'
    document.body.appendChild(container)
  })

  afterEach(() => {
    renderer?.dispose()
    container.remove()
  })

  it('能挂载：地形/区域/航点/路径/无人机全部创建，且渲染循环可跑', async () => {
    const scene = useSceneStore()
    const sim = useSimStore()
    // jsdom 中布局尺寸为 0，手动 stub
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })

    expect(() => {
      renderer = new SceneRenderer(container, scene, sim)
    }).not.toThrow()

    // 执行一次本地规划（jsdom Worker 在 vitest 中可用，但直接用 store action）
    const result = sim.planLocally()
    expect(result.success).toBe(true)
    expect(sim.smoothPath.length).toBeGreaterThan(10)
    expect(sim.trajectory.length).toBeGreaterThan(10)
    expect(sim.duration).toBeGreaterThan(0)

    // 驱动 5 帧动画
    await new Promise((r) => setTimeout(r, 90))

    // 路径同步后不抛错，相机模式可切换
    expect(() => renderer.setCameraMode('top')).not.toThrow()
    expect(() => renderer.setCameraMode('follow')).not.toThrow()
    expect(() => renderer.applyHeatmap()).not.toThrow()
    sim.showThreatHeatmap = true
    expect(() => renderer.applyHeatmap()).not.toThrow()

    // 添加/同步实体
    scene.addThreatAt({ x: 10, y: 0, z: 10 }, 'sam')
    expect(() => renderer.syncZones()).not.toThrow()
    scene.addNoFlyAt({ x: 20, y: 0, z: 20 })
    scene.addObstacleAt({ x: 30, y: 0, z: 30 })
    expect(() => renderer.syncZones()).not.toThrow()
    expect(() => renderer.rebuildTerrain()).not.toThrow()

    // 播放推进
    sim.play()
    await new Promise((r) => setTimeout(r, 60))
    expect(sim.simTime).toBeGreaterThan(0)
  })

  it('重规划触发时在场景中显示风险位置标记', async () => {
    const scene = useSceneStore()
    const sim = useSimStore()
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    Object.defineProperty(container, 'clientHeight', { value: 600 })
    renderer = new SceneRenderer(container, scene, sim)
    void scene

    // 模拟一次重规划触发：写入风险位置与事件
    sim.hazardPoint = { x: 120, y: 100, z: 120 }
    sim.lastReplanEvent = {
      time: sim.simTime,
      reason: 'threat-approach',
      detail: '突发威胁 将进入威胁区',
      position: { x: 0, y: 100, z: 0 },
      costBefore: 100,
      costAfter: 20,
      planMs: 3
    }
    await new Promise((r) => setTimeout(r, 60))
    const marker = (renderer as any).hazardMarker
    expect(marker).not.toBeNull()
    expect(marker.group.visible).toBe(true)
    expect(marker.group.position.x).toBeCloseTo(120, 5)
    expect(marker.group.position.z).toBeCloseTo(120, 5)

    // 触发事件超过显示窗口后标记隐藏
    sim.lastReplanEvent = { ...sim.lastReplanEvent, time: sim.simTime - 10 }
    await new Promise((r) => setTimeout(r, 60))
    expect(marker.group.visible).toBe(false)

    // 清除风险位置后不再显示
    sim.hazardPoint = null
    sim.lastReplanEvent = null
    await new Promise((r) => setTimeout(r, 60))
    expect(marker.group.visible).toBe(false)
  })
})
