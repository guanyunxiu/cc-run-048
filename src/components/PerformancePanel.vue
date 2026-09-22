<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useEngineStore } from '@/stores/engine'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { detectWebGPU } from '@/core/webgpu-field'
import {
  BUILTIN_PRESETS,
  allPresets,
  applyPreset,
  saveCustomPreset,
  deleteCustomPreset,
  loadCustomPresets
} from '@/core/presets'
import {
  crossOriginIsolated,
  planResultCache
} from '@/core/planner-pool'
import type { ParamPreset } from '@/types'

const engine = useEngineStore()
const scene = useSceneStore()
const sim = useSimStore()

const detecting = ref(false)
const cacheSize = ref(planResultCache.size)
const customPresets = ref<ParamPreset[]>(loadCustomPresets())
const presetName = ref('')
const instanced = ref(false)

const coi = crossOriginIsolated()
const hardwareConcurrency =
  typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined

function toggleInstanced(v: boolean) {
  instanced.value = v
  // 通过自定义事件通知渲染器（Viewport 已持有 renderer 实例）
  window.dispatchEvent(new CustomEvent('uav:instanced-buildings', { detail: v }))
}

async function detectGpu() {
  detecting.value = true
  const support = await detectWebGPU()
  engine.setWebgpuStatus(support.available, support.reason ?? support.info?.description ?? '')
  if (support.available && support.info?.description) {
    engine.webgpuReason = support.info.description
  }
  detecting.value = false
}

function usePreset(p: ParamPreset) {
  const { algo } = applyPreset(p, scene.planParams, scene.weights)
  if (algo) sim.setAlgo(algo)
  sim.markDirty()
}

function savePreset() {
  if (!presetName.value.trim()) return
  const preset: ParamPreset = {
    id: 'custom-' + Date.now().toString(36),
    name: presetName.value.trim(),
    description: '用户自定义参数预设',
    planParams: JSON.parse(JSON.stringify(scene.planParams)),
    weights: JSON.parse(JSON.stringify(scene.weights))
  }
  customPresets.value = saveCustomPreset(preset)
  presetName.value = ''
}

function removePreset(id: string) {
  customPresets.value = deleteCustomPreset(id)
}

function refreshCacheSize() {
  cacheSize.value = planResultCache.size
}

function clearCache() {
  planResultCache.clear()
  refreshCacheSize()
}

onMounted(() => {
  void detectGpu()
  setInterval(refreshCacheSize, 1000)
})
</script>

<template>
  <div>
    <!-- 实时性能 -->
    <div class="section">
      <div class="section-title">实时性能监控（功能04）</div>
      <div class="perf-grid">
        <div class="perf" :class="{ good: engine.fps >= 50, warn: engine.fps < 30 }">
          <div class="k">帧率 FPS</div>
          <div class="v">{{ engine.fps }}</div>
        </div>
        <div class="perf">
          <div class="k">帧耗时</div>
          <div class="v">{{ engine.frameMs }} ms</div>
        </div>
        <div class="perf">
          <div class="k">最近规划</div>
          <div class="v">{{ engine.planMs }} ms</div>
        </div>
        <div class="perf">
          <div class="k">Draw Calls</div>
          <div class="v">{{ engine.drawCalls }}</div>
        </div>
        <div class="perf">
          <div class="k">三角面</div>
          <div class="v">{{ engine.triangles }}</div>
        </div>
        <div class="perf">
          <div class="k">JS 堆内存</div>
          <div class="v">{{ engine.usedMB || '—' }} MB</div>
        </div>
      </div>
      <label class="chk">
        <input type="checkbox" v-model="engine.showPerfHud" />
        在三维视口显示性能 HUD（FPS/帧耗时/内存）
      </label>
    </div>

    <!-- 渲染后端 / WebGPU -->
    <div class="section">
      <div class="section-title">渲染后端 · WebGPU 可选升级</div>
      <div class="backend-row">
        <span class="badge" :class="engine.backend">{{ engine.backend.toUpperCase() }}</span>
        <span class="gpu" :class="{ ok: engine.webgpuAvailable, no: !engine.webgpuAvailable }">
          WebGPU：{{ engine.webgpuAvailable ? '可用 ✓' : '不可用（回退 WebGL2）' }}
        </span>
      </div>
      <div v-if="engine.webgpuReason" class="muted">{{ engine.webgpuReason }}</div>
      <label class="chk" v-if="engine.webgpuAvailable">
        <input
          type="checkbox"
          :checked="engine.webgpuEnabled"
          @change="engine.setWebgpuEnabled(($event.target as HTMLInputElement).checked)"
        />
        启用 WebGPU 计算标量场（威胁热力图，失败自动回退 CPU）
      </label>
      <div class="muted">
        规划计算运行在独立 Web Worker，不阻塞渲染；当前后端：
        <b>{{ engine.backend }}</b>
      </div>
      <label class="chk">
        <input type="checkbox" v-model="engine.layers.frustumCulling" />
        视锥裁剪（仅渲染可见对象）
      </label>
      <label class="chk">
        <input type="checkbox" v-model="engine.layers.lodEnabled" />
        大场景分块 + LOD 降级
      </label>
      <label class="chk">
        <input
          type="checkbox"
          :checked="instanced"
          @change="toggleInstanced(($event.target as HTMLInputElement).checked)"
        />
        建筑实例化渲染（InstancedMesh，单次 draw call）
      </label>
    </div>

    <!-- Worker / 缓存 / 并行 -->
    <div class="section">
      <div class="section-title">Worker 池 · 缓存 · 并行</div>
      <div class="muted">
        硬件并发：
        <b>{{ hardwareConcurrency ?? '未知' }}</b> 逻辑核 ·
        跨域隔离（SharedArrayBuffer）：
        <b :class="coi ? 'ok-text' : 'warn-text'">{{ coi ? '已启用' : '未启用（postMessage 回退）' }}</b>
      </div>
      <div class="cache-row">
        <span>规划结果 LRU 缓存：{{ cacheSize }} 条</span>
        <button @click="clearCache">清空</button>
      </div>
      <div class="muted">
        命中缓存的重复规划（切换标签、相同参数对比）直接返回，零计算；
        多算法/多种子任务并行分槽执行。
      </div>
    </div>

    <!-- 参数预设 -->
    <div class="section">
      <div class="section-title">算法参数预设（热插拔）</div>
      <div class="preset-save">
        <input v-model="presetName" placeholder="当前参数另存为预设…" />
        <button @click="savePreset">保存</button>
      </div>
      <div v-for="p in BUILTIN_PRESETS" :key="p.id" class="preset-row">
        <div class="pr-main" @click="usePreset(p)">
          <div class="pr-name">{{ p.name }} <span class="built">内置</span></div>
          <div class="pr-desc">{{ p.description }}</div>
        </div>
      </div>
      <div v-for="p in customPresets" :key="p.id" class="preset-row">
        <div class="pr-main" @click="usePreset(p)">
          <div class="pr-name">{{ p.name }}</div>
          <div class="pr-desc">{{ p.description }}</div>
        </div>
        <button class="del" @click="removePreset(p.id)">✕</button>
      </div>
      <div v-if="customPresets.length === 0" class="muted">
        尚无自定义预设，内置 {{ BUILTIN_PRESETS.length }} 套任务画像（
        <span v-for="(p, i) in allPresets().filter((x) => x.builtin)" :key="p.id">
          {{ i > 0 ? '、' : '' }}{{ p.name }}
        </span>）。
      </div>
    </div>
  </div>
</template>

<style scoped>
.perf-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 8px;
}
.perf {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px 8px;
}
.perf .k {
  font-size: 10px;
  color: var(--text-2);
}
.perf .v {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-0);
  font-variant-numeric: tabular-nums;
}
.perf.good .v {
  color: var(--ok);
}
.perf.warn .v {
  color: var(--warn);
}
.chk {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 11px;
  color: var(--text-1);
  margin-bottom: 5px;
}
.backend-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  background: #2a4a7f;
  color: #cfe4ff;
}
.badge.webgl1 {
  background: #6b5a2a;
}
.badge.webgpu {
  background: #1f6b4a;
}
.gpu.ok {
  color: var(--ok);
}
.gpu.no {
  color: var(--warn);
}
.muted {
  font-size: 10px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 5px 0;
}
.ok-text {
  color: var(--ok);
}
.warn-text {
  color: var(--warn);
}
.cache-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin: 6px 0;
}
.preset-save {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.preset-save input {
  flex: 1;
  min-width: 0;
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px 8px;
  margin-bottom: 5px;
}
.pr-main {
  flex: 1;
  cursor: pointer;
}
.pr-main:hover .pr-name {
  color: var(--accent);
}
.pr-name {
  font-size: 12px;
  color: var(--text-0);
  font-weight: 600;
}
.built {
  font-size: 9px;
  background: var(--bg-3);
  color: var(--text-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 400;
}
.pr-desc {
  font-size: 10px;
  color: var(--text-2);
  margin-top: 2px;
}
.del {
  width: 24px;
  color: var(--danger);
}
</style>
