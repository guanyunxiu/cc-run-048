/**
 * OffscreenCanvas 离屏栅格化（功能04）：
 * 把标量场栅格值绘制为热力图位图（ImageBitmap / ImageData），
 * 在 Worker 或后台线程生成纹理上传，避免占用主线程绘制。
 * 不支持 OffscreenCanvas 时回退到 document.createElement('canvas')。
 */
import { heatColor, clearanceColor, type FieldGrid } from './field-grid'

export interface HeatTileOptions {
  /** 色块边长（像素），用于 LOD：越大越粗糙越快 */
  cellPx?: number
  /** 配色模式 */
  palette?: 'heat' | 'clearance'
}

export interface HeatTile {
  canvas: HTMLCanvasElement | OffscreenCanvas | null
  width: number
  height: number
  /** ImageBitmap（若可用，可直接作为纹理源） */
  bitmap?: ImageBitmap
}

function colorFn(palette: 'heat' | 'clearance') {
  return palette === 'clearance' ? clearanceColor : heatColor
}

/** 是否支持 OffscreenCanvas（Worker / 主线程均可能） */
export function offscreenSupported(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.getContext === 'function'
  )
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (offscreenSupported()) return new OffscreenCanvas(w, h)
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return null
}

type Any2dCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function getCtx(
  canvas: HTMLCanvasElement | OffscreenCanvas
): Any2dCtx | null {
  return canvas.getContext('2d') as Any2dCtx | null
}

/**
 * 将标量场渲染为热力图位图。
 * 分辨率为场网格 resolution，cellPx 控制每个栅格的像素块大小（LOD）。
 */
export async function renderHeatTile(
  grid: FieldGrid,
  options: HeatTileOptions = {}
): Promise<HeatTile> {
  const cellPx = options.cellPx ?? 4
  const palette = options.palette ?? 'heat'
  const r = grid.resolution
  const sizePx = r * cellPx

  const canvas = makeCanvas(sizePx, sizePx)
  if (!canvas) return { canvas: null, width: sizePx, height: sizePx }
  canvas.width = sizePx
  canvas.height = sizePx
  const ctx = getCtx(canvas)
  if (!ctx) return { canvas, width: sizePx, height: sizePx }

  const img = ctx.createImageData(r, r)
  const span = Math.max(grid.max - grid.min, 1e-6)
  const c: [number, number, number] = [0, 0, 0]
  const fn = colorFn(palette)
  for (let i = 0; i < r * r; i++) {
    const t = (grid.values[i] - grid.min) / span
    fn(t, c)
    img.data[i * 4] = Math.round(c[0] * 255)
    img.data[i * 4 + 1] = Math.round(c[1] * 255)
    img.data[i * 4 + 2] = Math.round(c[2] * 255)
    img.data[i * 4 + 3] = 200
  }

  // 先画到 1:1 离屏画布，再放大（LOD 块）
  const small = makeCanvas(r, r)
  if (small) {
    small.width = r
    small.height = r
    const sctx = getCtx(small)
    if (sctx) {
      sctx.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'low'
      ctx.clearRect(0, 0, sizePx, sizePx)
      ctx.drawImage(small as unknown as HTMLCanvasElement, 0, 0, sizePx, sizePx)
    }
  }

  let bitmap: ImageBitmap | undefined
  if (typeof createImageBitmap === 'function' && 'transferToImageBitmap' in canvas) {
    try {
      bitmap = await (canvas as OffscreenCanvas).transferToImageBitmap()
    } catch {
      bitmap = undefined
    }
  }
  return { canvas, width: sizePx, height: sizePx, bitmap }
}

/**
 * 分块渲染（功能04：大场景分块）。
 * 将栅格按 chunk 切成多块位图，调用方可视锥裁剪后只上传可见块。
 */
export async function renderHeatChunks(
  grid: FieldGrid,
  options: HeatTileOptions = {}
): Promise<HeatTile[]> {
  const cellPx = options.cellPx ?? 4
  const tiles: HeatTile[] = []
  const r = grid.resolution
  const cs = grid.chunkSize
  const palette = options.palette ?? 'heat'
  const fn = colorFn(palette)
  const span = Math.max(grid.max - grid.min, 1e-6)

  for (let cz = 0; cz < grid.chunksZ; cz++) {
    for (let cx = 0; cx < grid.chunksX; cx++) {
      const x0 = cx * cs
      const z0 = cz * cs
      const x1 = Math.min(r, x0 + cs)
      const z1 = Math.min(r, z0 + cs)
      const w = x1 - x0
      const h = z1 - z0
      const canvas = makeCanvas(w * cellPx, h * cellPx)
      if (!canvas) {
        tiles.push({ canvas: null, width: w * cellPx, height: h * cellPx })
        continue
      }
      canvas.width = w * cellPx
      canvas.height = h * cellPx
      const ctx = getCtx(canvas)
      if (ctx) {
        const img = ctx.createImageData(w, h)
        const c: [number, number, number] = [0, 0, 0]
        for (let iz = 0; iz < h; iz++) {
          for (let ix = 0; ix < w; ix++) {
            const src = grid.values[(z0 + iz) * r + (x0 + ix)]
            fn((src - grid.min) / span, c)
            const di = (iz * w + ix) * 4
            img.data[di] = Math.round(c[0] * 255)
            img.data[di + 1] = Math.round(c[1] * 255)
            img.data[di + 2] = Math.round(c[2] * 255)
            img.data[di + 3] = 200
          }
        }
        const small = makeCanvas(w, h)
        if (small) {
          small.width = w
          small.height = h
          const sctx2 = getCtx(small)
          sctx2?.putImageData(img, 0, 0)
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'low'
          ctx.drawImage(
            small as unknown as HTMLCanvasElement,
            0,
            0,
            w * cellPx,
            h * cellPx
          )
        }
      }
      tiles.push({ canvas, width: w * cellPx, height: h * cellPx })
    }
  }
  void palette
  return tiles
}
