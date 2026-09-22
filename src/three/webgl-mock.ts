/**
 * 共享 WebGL2 mock（jsdom 无真实 GPU）。
 * 从 scene-renderer.dom.test.ts 抽取，供 three/ 下多个测试复用。
 */
export function installWebGLMock() {
  function makeCtx(version: 1 | 2) {
    const special: Record<string, unknown> = {
      getParameter(p: number) {
        if (p === 0x1f00)
          return version === 2 ? 'WebGL 2.0 (SwiftShader)' : 'WebGL 1.0'
        if (p === 0x1f01) return 'MockGL'
        if (p === 0x8869 || p === 0x8dfb || p === 0x8b4c || p === 0x8b49) return 32
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
        p === 0x8b86 || p === 0x8b82 ? true : 0,
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
    const ctx = new Proxy(special, {
      get(target, prop) {
        if (prop in target) return target[prop as string]
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
  HTMLCanvasElement.prototype.getContext = function (type: unknown) {
    if (
      type === 'webgl2' ||
      type === 'webgl' ||
      type === 'experimental-webgl2'
    ) {
      return makeCtx(type === 'webgl' ? 1 : 2)
    }
    if (type === '2d') {
      const target: Record<string, unknown> = {
        measureText: () => ({ width: 80, actualBoundingBoxAscent: 10 }),
        getContextAttributes: () => ({})
      }
      return new Proxy(target, {
        get(t, p) {
          if (p in t) return t[p as string]
          if (p === 'canvas') return this
          if (p === 'fillStyle' || p === 'font' || p === 'textBaseline') return ''
          if (/^[A-Z][A-Z0-9_]+$/.test(String(p))) return 0
          return () => {}
        },
        set() {
          return true
        }
      }) as unknown as CanvasRenderingContext2D
    }
    // @ts-expect-error mock
    return orig.call(this, type)
  } as typeof HTMLCanvasElement.prototype.getContext
}
