<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ObjectiveVector, SensitivityResult } from '@/types'
import { OBJECTIVE_KEYS, OBJECTIVE_LABELS } from '@/core/multi-objective'

/**
 * 权重敏感性分析（功能01）：
 * X 轴为被扫描权重取值，多条 Y 轴为各目标归一化值；
 * 另以柱状线显示成功率。
 */
const props = withDefaults(
  defineProps<{
    result: SensitivityResult | null
    height?: number
  }>(),
  { height: 200 }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const activeAxes = ref<Set<keyof ObjectiveVector>>(
  new Set(['distance', 'threat', 'energy'])
)
const colors: Record<keyof ObjectiveVector, string> = {
  distance: '#3aa0ff',
  threat: '#ff5263',
  altitude: '#ffb020',
  nofly: '#b046ff',
  smooth: '#1abc9c',
  energy: '#f39c12',
  dynamics: '#e84393'
}

function toggle(k: keyof ObjectiveVector) {
  if (activeAxes.value.has(k)) activeAxes.value.delete(k)
  else activeAxes.value.add(k)
  draw()
}

const enabled = computed(() =>
  OBJECTIVE_KEYS.filter((k) => activeAxes.value.has(k))
)

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

  const r = props.result
  if (!r || r.points.length < 2) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('选择权重轴与范围后运行敏感性分析', w / 2, h / 2)
    return
  }

  const pts = r.points
  const padL = 40
  const padR = 12
  const padT = 12
  const padB = 26
  const pw = w - padL - padR
  const ph = h - padT - padB

  const xMin = pts[0].weight
  const xMax = pts[pts.length - 1].weight
  const xSpan = Math.max(xMax - xMin, 1e-9)

  // 对每个启用目标独立归一化（min-max），便于同图比较趋势
  for (const k of enabled.value) {
    const vals = pts.map((p) => p.objectives[k])
    const mn = Math.min(...vals)
    const mx = Math.max(...vals)
    const span = Math.max(mx - mn, 1e-9)
    ctx.beginPath()
    pts.forEach((p, i) => {
      const x = padL + ((p.weight - xMin) / xSpan) * pw
      const y = padT + ph - ((p.objectives[k] - mn) / span) * ph
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = colors[k]
    ctx.lineWidth = 2
    ctx.stroke()
    // 端点
    pts.forEach((p) => {
      const x = padL + ((p.weight - xMin) / xSpan) * pw
      const y = padT + ph - ((p.objectives[k] - mn) / span) * ph
      ctx.fillStyle = colors[k]
      ctx.beginPath()
      ctx.arc(x, y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  // 失败点红叉
  pts.forEach((p) => {
    if (p.success) return
    const x = padL + ((p.weight - xMin) / xSpan) * pw
    ctx.strokeStyle = '#ff3b30'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x - 4, padT + 4)
    ctx.lineTo(x + 4, padT + 12)
    ctx.moveTo(x + 4, padT + 4)
    ctx.lineTo(x - 4, padT + 12)
    ctx.stroke()
  })

  ctx.fillStyle = '#9fb0d0'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`权重 ${OBJECTIVE_LABELS[r.axis]} (${xMin} ~ ${xMax})`, padL + pw / 2, h - 8)
  ctx.save()
  ctx.translate(11, padT + ph / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('归一化目标值（min-max）', 0, 0)
  ctx.restore()
}

onMounted(draw)
watch(() => [props.result, activeAxes], draw, { deep: true })
</script>

<template>
  <div>
    <div class="legend">
      <span
        v-for="k in OBJECTIVE_KEYS"
        :key="k"
        class="lg"
        :class="{ off: !activeAxes.has(k) }"
        :style="{ color: colors[k] }"
        @click="toggle(k)"
      >
        ● {{ OBJECTIVE_LABELS[k] }}
      </span>
    </div>
    <canvas
      ref="canvasRef"
      class="sens-canvas"
      :style="{ height: height + 'px' }"
    ></canvas>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.lg {
  font-size: 10px;
  cursor: pointer;
  user-select: none;
}
.lg.off {
  opacity: 0.35;
}
.sens-canvas {
  width: 100%;
  display: block;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #101a2e;
}
</style>
