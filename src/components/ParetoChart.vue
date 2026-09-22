<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import type { ObjectiveKey, ParetoPoint } from '@/types'

/**
 * Pareto 前沿图（迭代三功能01/03）：2D 散点或 3D 投影（Canvas 等轴测）。
 * 点击散点发出 select 事件（可在 3D 视图叠加对应航迹）。
 */
const props = defineProps<{
  points: ParetoPoint[]
  /** 前沿（rank=0）高亮 */
  front?: ParetoPoint[]
  xKey?: ObjectiveKey
  yKey?: ObjectiveKey
  zKey?: ObjectiveKey | null
  mode3d?: boolean
  height?: number
}>()

const emit = defineEmits<{ (e: 'select', p: ParetoPoint): void }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const W = 560
const H = computed(() => props.height ?? 280)
const selected = ref<ParetoPoint | null>(null)
const hitAreas = ref<{ x: number; y: number; p: ParetoPoint }[]>([])

const AXIS_LABEL: Record<ObjectiveKey, string> = {
  distance: '航程 m',
  threat: '威胁暴露',
  altitude: '高度偏差',
  nofly: '禁飞惩罚',
  smooth: '平滑代价',
  energy: '能耗 kJ',
  dynamics: '动力学惩罚'
}

const xKey = computed(() => props.xKey ?? 'distance')
const yKey = computed(() => props.yKey ?? 'threat')
const zKey = computed(() => props.zKey ?? 'energy')

const algoColor: Record<string, string> = {
  astar: '#3aa0ff',
  dijkstra: '#5dade2',
  rrt: '#ffb020',
  rrtstar: '#f39c12',
  hybridastar: '#2ecc71',
  aco: '#e74c3c',
  pso: '#b046ff',
  ga: '#1abc9c'
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H.value)
  hitAreas.value = []
  const pts = props.points
  if (pts.length === 0) return

  const frontSet = new Set((props.front ?? pts.filter((p) => p.rank === 0)))
  const padL = 52
  const padR = 16
  const padT = 16
  const padB = 34
  const plotW = W - padL - padR
  const plotH = H.value - padT - padB

  const xVals = pts.map((p) => p.objectives[xKey.value])
  const yVals = pts.map((p) => p.objectives[yKey.value])
  const zVals = pts.map((p) => p.objectives[zKey.value!] ?? 0)
  const xMin = Math.min(...xVals)
  const xMax = Math.max(...xVals)
  const yMin = Math.min(...yVals)
  const yMax = Math.max(...yVals)
  const zMin = Math.min(...zVals)
  const zMax = Math.max(...zVals)
  const sx = (v: number) => padL + ((v - xMin) / Math.max(xMax - xMin, 1e-9)) * plotW
  const sy = (v: number) => padT + (1 - (v - yMin) / Math.max(yMax - yMin, 1e-9)) * plotH

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.fillStyle = '#8fa3bf'
  ctx.font = '10px sans-serif'
  for (let i = 0; i <= 5; i++) {
    const gx = padL + (i / 5) * plotW
    const gy = padT + (i / 5) * plotH
    ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + plotH); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke()
  }

  // 3D 等轴测投影：x 向右，y 向上，z 向左下偏移
  const project = (p: ParetoPoint): [number, number] => {
    const x = sx(p.objectives[xKey.value])
    const y = sy(p.objectives[yKey.value])
    if (!props.mode3d) return [x, y]
    const zt = (p.objectives[zKey.value!] - zMin) / Math.max(zMax - zMin, 1e-9)
    return [x - zt * 26, y + zt * 20]
  }

  // 非前沿点先画（灰），前沿点后画（彩色）
  for (const p of pts) {
    if (frontSet.has(p)) continue
    const [x, y] = project(p)
    ctx.fillStyle = 'rgba(143,163,191,0.5)'
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  for (const p of pts) {
    if (!frontSet.has(p)) continue
    const [x, y] = project(p)
    const isSel = selected.value === p
    ctx.fillStyle = algoColor[p.algo] ?? '#ffffff'
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(0,0,0,0.4)'
    ctx.lineWidth = isSel ? 2 : 1
    ctx.beginPath()
    ctx.arc(x, y, isSel ? 7 : 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    hitAreas.value.push({ x, y, p })
  }

  // 轴标签
  ctx.fillStyle = '#c8d4e6'
  ctx.font = '11px sans-serif'
  ctx.fillText(AXIS_LABEL[xKey.value] + ' →', W - padR - 90, H.value - 8)
  ctx.save()
  ctx.translate(14, padT + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('← ' + AXIS_LABEL[yKey.value], -60, 0)
  ctx.restore()
  if (props.mode3d) {
    ctx.fillStyle = '#b046ff'
    ctx.fillText('⊙ ' + AXIS_LABEL[zKey.value!] + '（轴测深度）', padL + 8, padT + 12)
  }
}

function onClick(ev: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const mx = ((ev.clientX - rect.left) / rect.width) * W
  const my = ((ev.clientY - rect.top) / rect.height) * H.value
  let best: { x: number; y: number; p: ParetoPoint } | null = null
  let bestD = 14
  for (const h of hitAreas.value) {
    const d = Math.hypot(h.x - mx, h.y - my)
    if (d < bestD) {
      bestD = d
      best = h
    }
  }
  if (best) {
    selected.value = best.p
    emit('select', best.p)
    draw()
  }
}

onMounted(draw)
watch(() => [props.points, props.mode3d, props.xKey, props.yKey, props.zKey], draw, { deep: true })
</script>

<template>
  <div class="pareto">
    <canvas
      v-if="points.length > 0"
      ref="canvasRef"
      :width="W"
      :height="H"
      class="canvas"
      @click="onClick"
    ></canvas>
    <div v-else class="empty">尚无 Pareto 数据，点击“扫描 Pareto 前沿”生成折中解集。</div>
    <div v-if="points.length > 0" class="algo-legend">
      <span v-for="(color, algo) in algoColor" :key="algo">
        <i :style="{ background: color }"></i>{{ algo }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: auto;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: crosshair;
}
.empty {
  padding: 30px 10px;
  color: var(--text-2);
  font-size: 11px;
  text-align: center;
  background: var(--bg-2);
  border: 1px dashed var(--line);
  border-radius: 6px;
}
.algo-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  color: var(--text-2);
  margin-top: 4px;
}
.algo-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;
}
</style>
