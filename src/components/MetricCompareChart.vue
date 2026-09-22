<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AlgoType } from '@/types'

/**
 * 多算法指标对比图（功能03）：
 * - bar：分组柱状图（跨算法原始值，自动归一化显示）
 * - radar：雷达图（每个算法一条多边形，指标 min-max 归一化）
 */
export interface MetricSeries {
  label: string
  algo: AlgoType
  /** 与 metrics 对齐的原始值（越小越好统一口径） */
  values: number[]
}

const props = withDefaults(
  defineProps<{
    metrics: string[]
    series: MetricSeries[]
    type?: 'bar' | 'radar'
    height?: number
  }>(),
  { type: 'bar', height: 220 }
)

const palette = [
  '#3aa0ff',
  '#2ecc71',
  '#ff5263',
  '#ffb020',
  '#b046ff',
  '#1abc9c',
  '#e84393',
  '#f39c12'
]

const canvasRef = ref<HTMLCanvasElement | null>(null)

function color(i: number) {
  return palette[i % palette.length]
}

/** 全部指标按列归一化（越小越好 -> 1 表示最优） */
const normalized = computed(() => {
  return props.series.map((s, si) => ({
    ...s,
    color: color(si),
    norm: props.metrics.map((_, mi) => {
      const col = props.series.map((x) => x.values[mi] ?? 0)
      const mn = Math.min(...col)
      const mx = Math.max(...col)
      const v = s.values[mi] ?? 0
      if (mx - mn < 1e-9) return 1
      return 1 - (v - mn) / (mx - mn) // 1 = 最小(最优)
    })
  }))
})

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const dpr = Math.min(window.devicePixelRatio, 2)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#101a2e'
  ctx.fillRect(0, 0, w, h)

  if (props.series.length === 0) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('运行算法对比/批量实验后显示', w / 2, h / 2)
    return
  }

  if (props.type === 'radar') drawRadar(ctx, w, h)
  else drawBar(ctx, w, h)
}

function drawBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const padL = 32
  const padR = 8
  const padT = 12
  const padB = 44
  const pw = w - padL - padR
  const ph = h - padT - padB
  const groups = props.metrics.length
  const groupW = pw / groups
  const barW = Math.min(14, (groupW - 8) / Math.max(props.series.length, 1))

  ctx.strokeStyle = 'rgba(120,150,200,0.18)'
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ph / 4) * i
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(w - padR, y)
    ctx.stroke()
  }
  ctx.fillStyle = '#9fb0d0'
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    ctx.fillText(`${100 - i * 25}%`, padL - 4, padT + (ph / 4) * i + 3)
  }

  normalized.value.forEach((s) => {
    s.norm.forEach((v, mi) => {
      const x =
        padL +
        groupW * mi +
        groupW / 2 -
        (barW * props.series.length) / 2 +
        barW * props.series.findIndex((x) => x.algo === s.algo)
      const bh = v * ph
      ctx.fillStyle = s.color
      ctx.fillRect(x, padT + ph - bh, barW - 1, bh)
    })
  })

  // x 轴标签
  ctx.fillStyle = '#9fb0d0'
  ctx.textAlign = 'center'
  props.metrics.forEach((m, i) => {
    ctx.save()
    ctx.translate(padL + groupW * i + groupW / 2, h - padB + 10)
    ctx.rotate(-Math.PI / 5)
    ctx.fillText(m, 0, 0)
    ctx.restore()
  })

  drawLegend(ctx, w, h)
}

function drawRadar(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const cx = w / 2
  const cy = h / 2 - 6
  const radius = Math.min(w, h) / 2 - 46
  const axes = props.metrics.length
  if (axes < 3) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('雷达图至少需要 3 个指标', w / 2, h / 2)
    return
  }

  // 网格多边形
  for (let ring = 1; ring <= 4; ring++) {
    const rr = (radius * ring) / 4
    ctx.beginPath()
    for (let i = 0; i < axes; i++) {
      const a = (i / axes) * Math.PI * 2 - Math.PI / 2
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.strokeStyle = 'rgba(120,150,200,0.2)'
    ctx.stroke()
  }
  // 轴线 + 标签
  ctx.fillStyle = '#9fb0d0'
  ctx.font = '9px sans-serif'
  for (let i = 0; i < axes; i++) {
    const a = (i / axes) * Math.PI * 2 - Math.PI / 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
    ctx.strokeStyle = 'rgba(120,150,200,0.2)'
    ctx.stroke()
    const lx = cx + Math.cos(a) * (radius + 24)
    const ly = cy + Math.sin(a) * (radius + 12)
    ctx.textAlign = Math.abs(Math.cos(a)) < 0.3 ? 'center' : Math.cos(a) > 0 ? 'left' : 'right'
    ctx.fillText(props.metrics[i], lx, ly)
  }

  // 各算法多边形（归一化：越靠外越优）
  normalized.value.forEach((s) => {
    ctx.beginPath()
    s.norm.forEach((v, i) => {
      const a = (i / axes) * Math.PI * 2 - Math.PI / 2
      const rr = radius * Math.max(0, Math.min(1, v))
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = s.color + '33'
    ctx.fill()
    ctx.strokeStyle = s.color
    ctx.lineWidth = 1.6
    ctx.stroke()
  })

  drawLegend(ctx, w, h)
}

function drawLegend(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'left'
  let x = 8
  normalized.value.forEach((s) => {
    ctx.fillStyle = s.color
    ctx.fillRect(x, h - 12, 8, 8)
    ctx.fillStyle = '#c6d4ee'
    ctx.fillText(s.label, x + 11, h - 5)
    x += ctx.measureText(s.label).width + 26
  })
}

onMounted(draw)
watch(() => [props.series, props.type, props.metrics], draw, { deep: true })
</script>

<template>
  <canvas ref="canvasRef" class="metric-canvas" :style="{ height: height + 'px' }"></canvas>
</template>

<style scoped>
.metric-canvas {
  width: 100%;
  display: block;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #101a2e;
}
</style>
