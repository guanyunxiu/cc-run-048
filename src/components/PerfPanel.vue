<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { useViewStore } from '@/stores/view'
import { detectCapabilities } from '@/core/capabilities'
import { computeFieldGrid } from '@/core/webgpu-field'
import { ALGO_PRESETS } from '@/core/defaults'
import type { OverlayMode } from '@/types'

const scene = useSceneStore()
const sim = useSimStore()
const view = useViewStore()

const caps = ref(detectCapabilities())
const tick = ref(0)
let timer = 0
onMounted(() => {
  timer = window.setInterval(() => tick.value++, 500)
})
onUnmounted(() => clearInterval(timer))

// 通过 Viewport 注入的 renderer 实例获取 PerfMonitor
const renderer = ref<{ getPerfMonitor?: () => { latest: { fps: number; frameMs: number; calls: number; tris: number; heap: number | null; planMs: number | null }; toCsv: () => string } } | null>(
  (window as any).__sceneRenderer ?? null
)
const perfNow = computed(() => {
  tick.value
  const r = (window as any).__sceneRenderer
  return r?.getPerfMonitor?.().latest ?? { fps: 0, frameMs: 0, calls: 0, tris: 0, heap: null, planMs: null }
})

const overlayModes: { value: OverlayMode; label: string }[] = [
  { value: 'none', label: '关闭' },
  { value: 'threat', label: '威胁热力图' },
  { value: 'clearance', label: '安全裕度图' },
  { value: 'cost', label: '代价热力图' },
  { value: 'threat3d', label: '威胁强度（圆柱）' }
]

async function tryWebgpuField() {
  const t0 = performance.now()
  const res = await computeFieldGrid(
    scene.terrain,
    {
      threats: scene.threats.map((t) => ({
        x: t.position.x, z: t.position.z, radius: t.radius,
        level: t.level, heightMin: t.heightMin, heightMax: t.heightMax
      })),
      nofly: scene.noflyZones.map((z) => ({
        x: z.position.x, z: z.position.z, radius: z.radius,
        penalty: z.penalty, heightMin: z.heightMin, heightMax: z.heightMax
      }))
    },
    'threat',
    scene.planParams.cruiseAlt
  )
  view.setFieldResult(res.backend, res.computeMs)
  view.setWebgpuActive(res.backend === 'webgpu')
  void t0
}

function applyPreset(id: string) {
  const p = ALGO_PRESETS.find((x) => x.id === id)
  if (!p) return
  sim.setAlgo(p.algo)
  Object.assign(scene.planParams.tuning, p.tuning)
  if (p.weights) Object.assign(scene.weights, p.weights)
  sim.message = `已应用预设：${p.name}`
}

function exportPerfCsv() {
  const r = (window as any).__sceneRenderer
  const csv = r?.getPerfMonitor?.().toCsv?.() ?? 'fps,frameMs,drawCalls,triangles,heapMB'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `perf-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const cacheStat = computed(() => {
  tick.value
  return { hits: sim.cacheHits, misses: sim.cacheMisses, size: sim.cache.size }
})
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">运行时性能监控（功能04）</div>
      <div class="perf-grid">
        <div class="perf-card"><div class="k">帧率 FPS</div><div class="v" :class="{ good: perfNow.fps >= 50, warn: perfNow.fps < 30 }">{{ perfNow.fps.toFixed(0) }}</div></div>
        <div class="perf-card"><div class="k">帧耗时</div><div class="v">{{ perfNow.frameMs.toFixed(1) }} ms</div></div>
        <div class="perf-card"><div class="k">Draw Calls</div><div class="v">{{ perfNow.calls }}</div></div>
        <div class="perf-card"><div class="k">三角形</div><div class="v">{{ (perfNow.tris / 1000).toFixed(0) }}k</div></div>
        <div class="perf-card"><div class="k">JS 堆</div><div class="v">{{ perfNow.heap !== null ? perfNow.heap + ' MB' : '—' }}</div></div>
        <div class="perf-card"><div class="k">规划耗时</div><div class="v">{{ perfNow.planMs !== null ? perfNow.planMs.toFixed(0) + ' ms' : '—' }}</div></div>
      </div>
      <button style="margin-top: 6px" @click="exportPerfCsv">导出性能日志 CSV</button>
    </div>

    <div class="section">
      <div class="section-title">工程优化开关（功能04）</div>
      <label class="checkbox"><input type="checkbox" v-model="view.perf.chunkedTerrain" />大场景分块 + LOD（切换后重建地形）</label>
      <label class="checkbox"><input type="checkbox" v-model="view.perf.instancedBuildings" />建筑实例化渲染 InstancedMesh</label>
      <label class="checkbox"><input type="checkbox" v-model="view.perf.frustumCulling" />视锥裁剪</label>
      <label class="checkbox"><input type="checkbox" v-model="view.perf.planCache" />规划结果缓存（LRU）</label>
      <label class="checkbox"><input type="checkbox" v-model="view.perf.workerPool" />Worker 池并行（编队/批量）</label>
      <div class="cache-stat" v-if="view.perf.planCache">
        缓存命中 {{ cacheStat.hits }} / 未命中 {{ cacheStat.misses }} · 当前 {{ cacheStat.size }} 条
      </div>
    </div>

    <div class="section">
      <div class="section-title">可视化叠加层（功能03）</div>
      <div class="overlay-grid">
        <button
          v-for="m in overlayModes"
          :key="m.value"
          :class="{ active: view.overlayMode === m.value }"
          @click="view.setOverlay(m.value)"
        >
          {{ m.label }}
        </button>
      </div>
      <p class="tip">地形叠加：威胁强度 / 巡航高度安全裕度 / 综合代价；切换后即时重着色。</p>
    </div>

    <div class="section">
      <div class="section-title">WebGPU 可选升级（功能04）</div>
      <div class="caps">
        <div>WebGPU：<b :class="caps.webgpu ? 'ok' : 'bad'">{{ caps.webgpu ? '可用' : '不可用' }}</b></div>
        <div>WebGL2：<b :class="caps.webgl2 ? 'ok' : 'bad'">{{ caps.webgl2 ? '可用' : '回退 WebGL1' }}</b></div>
        <div>Web Worker：<b :class="caps.webWorker ? 'ok' : 'bad'">{{ caps.webWorker ? '可用' : '不可用' }}</b></div>
        <div>SharedArrayBuffer：<b :class="caps.sharedArrayBuffer ? 'ok' : 'bad'">{{ caps.sharedArrayBuffer ? (caps.crossOriginIsolated ? '可用（跨域隔离）' : '可用（未隔离，回退拷贝）') : '不可用' }}</b></div>
        <div>OffscreenCanvas：<b :class="caps.offscreenCanvas ? 'ok' : 'bad'">{{ caps.offscreenCanvas ? '可用' : '回退 Canvas' }}</b></div>
        <div>CPU 核心：{{ caps.hardwareConcurrency }}</div>
      </div>
      <button :disabled="!caps.webgpu" @click="tryWebgpuField" style="margin-top: 6px">
        ⚡ 测试 WebGPU 场计算
      </button>
      <div v-if="view.fieldBackend" class="gpu-result">
        场计算后端：<b :class="view.fieldBackend === 'webgpu' ? 'ok' : 'warn'">
          {{ view.fieldBackend === 'webgpu' ? 'WebGPU compute' : 'CPU 回退' }}
        </b>
        · {{ view.fieldMs?.toFixed(1) }} ms
      </div>
    </div>

    <div class="section">
      <div class="section-title">算法模块热插拔 / 参数预设（功能04）</div>
      <p class="tip">
        算法经注册表（registry）热插拔；一键应用调参与权重预设，应用后可自动重规划对比。
      </p>
      <div v-for="p in ALGO_PRESETS" :key="p.id" class="preset-row" :title="p.description">
        <div class="preset-info">
          <b>{{ p.name }}</b>
          <span>{{ p.description }}</span>
        </div>
        <button @click="applyPreset(p.id)">应用</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perf-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
.perf-card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px 4px;
  text-align: center;
}
.perf-card .k { font-size: 10px; color: var(--text-2); }
.perf-card .v { font-size: 15px; font-weight: 700; color: var(--text-0); font-variant-numeric: tabular-nums; }
.good { color: var(--ok); }
.warn { color: var(--warn); }
.bad { color: var(--danger); }
.checkbox { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-1); margin-bottom: 5px; }
.cache-stat { font-size: 10px; color: var(--text-2); margin-top: 4px; }
.overlay-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.overlay-grid button { padding: 6px 4px; font-size: 11px; }
.overlay-grid button.active { background: var(--accent); color: #06101f; }
.tip { color: var(--text-2); font-size: 11px; line-height: 1.6; margin: 4px 0 0; }
.caps { font-size: 11px; color: var(--text-1); line-height: 1.8; }
.gpu-result { font-size: 11px; color: var(--text-1); margin-top: 5px; }
.preset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--line);
}
.preset-info { display: flex; flex-direction: column; }
.preset-info b { font-size: 11px; color: var(--text-0); }
.preset-info span { font-size: 10px; color: var(--text-2); }
</style>
