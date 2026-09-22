<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import PlannerWorker from '@/workers/planner.worker.ts?worker'
import type {
  CostWeights,
  ObjectiveVector,
  ParetoPoint,
  SensitivityResult
} from '@/types'
import type {
  WorkerRequest,
  WorkerResponse
} from '@/workers/planner.worker'
import {
  OBJECTIVE_KEYS,
  OBJECTIVE_LABELS
} from '@/core/multi-objective'
import ParetoChart from './ParetoChart.vue'
import ConvergenceChart from './ConvergenceChart.vue'
import SensitivityChart from './SensitivityChart.vue'
import NumberSlider from './NumberSlider.vue'

const scene = useSceneStore()
const sim = useSimStore()
const w = scene.weights

const weightMeta: { key: keyof CostWeights; max: number; step: number }[] = [
  { key: 'distance', max: 10, step: 0.1 },
  { key: 'threat', max: 150, step: 1 },
  { key: 'altitude', max: 60, step: 0.5 },
  { key: 'nofly', max: 300, step: 2 },
  { key: 'smooth', max: 3, step: 0.05 },
  { key: 'energy', max: 200, step: 2 },
  { key: 'dynamics', max: 250, step: 2 }
]

const paretoPoints = ref<ParetoPoint[] | null>(null)
const scanning = ref(false)
const scanProgress = ref(0)
const paretoMode3d = ref(false)
const axisChoices = OBJECTIVE_KEYS
const xAxis = ref<keyof ObjectiveVector>('distance')
const yAxis = ref<keyof ObjectiveVector>('threat')
const zAxis = ref<keyof ObjectiveVector>('energy')

const sensitivityResult = ref<SensitivityResult | null>(null)
const sensAxis = ref<keyof CostWeights>('threat')
const sensMin = ref(0)
const sensMax = ref(120)
const sensSteps = ref(8)
const sensRunning = ref(false)

const objectives = computed(() => sim.stats?.objectives)
const convergence = computed(() => sim.stats?.convergence ?? [])

const frontCount = computed(
  () => paretoPoints.value?.filter((p) => !p.dominated).length ?? 0
)

function cloneScenePayload() {
  return {
    terrain: JSON.parse(JSON.stringify(scene.terrain)),
    threats: JSON.parse(JSON.stringify(scene.threats)),
    noflyZones: JSON.parse(JSON.stringify(scene.noflyZones)),
    obstacles: JSON.parse(JSON.stringify(scene.obstacles)),
    waypoints: JSON.parse(JSON.stringify(scene.waypoints)),
    planParams: JSON.parse(JSON.stringify(scene.planParams)),
    weights: JSON.parse(JSON.stringify(scene.weights))
  }
}

async function runParetoScan() {
  scanning.value = true
  scanProgress.value = 0
  paretoPoints.value = null
  await new Promise((r) => setTimeout(r, 30))
  const p = cloneScenePayload()
  const worker = new PlannerWorker()
  const req: WorkerRequest = {
    type: 'pareto',
    ...p,
    baselineWeights: p.weights,
    smoothing: sim.smoothing,
    algo: scene.planParams.algo
  }
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    if (ev.data.type === 'pareto-done') {
      paretoPoints.value = ev.data.points
      scanProgress.value = 1
      scanning.value = false
      worker.terminate()
    }
  }
  worker.onerror = () => {
    scanning.value = false
    worker.terminate()
  }
  worker.postMessage(req)
  // 进度近似（扫描 12 组）
  const timer = window.setInterval(() => {
    if (!scanning.value) window.clearInterval(timer)
    else scanProgress.value = Math.min(0.95, scanProgress.value + 0.08)
  }, 200)
}

async function runSensitivity() {
  sensRunning.value = true
  sensitivityResult.value = null
  await new Promise((r) => setTimeout(r, 30))
  const values: number[] = []
  for (let i = 0; i < sensSteps.value; i++) {
    const t = sensSteps.value === 1 ? 0.5 : i / (sensSteps.value - 1)
    values.push(sensMin.value + (sensMax.value - sensMin.value) * t)
  }
  const p = cloneScenePayload()
  const worker = new PlannerWorker()
  const req: WorkerRequest = {
    type: 'sensitivity',
    ...p,
    baseWeights: p.weights,
    smoothing: sim.smoothing,
    algo: scene.planParams.algo,
    axis: sensAxis.value,
    values
  }
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    if (ev.data.type === 'sensitivity-done') {
      sensitivityResult.value = ev.data.result
      sensRunning.value = false
      worker.terminate()
    }
  }
  worker.onerror = () => {
    sensRunning.value = false
    worker.terminate()
  }
  worker.postMessage(req)
}

/** 选择某个 Pareto 解：套用其权重并重规划 */
async function applyParetoWeights(p: ParetoPoint) {
  Object.assign(scene.weights, p.weights)
  await sim.plan()
}

const currentObjectiveBars = computed(() => {
  if (!objectives.value) return []
  return OBJECTIVE_KEYS.map((k) => ({
    key: k,
    label: OBJECTIVE_LABELS[k],
    value: objectives.value![k]
  }))
})
</script>

<template>
  <div>
    <!-- 七维代价权重 -->
    <div class="section">
      <div class="section-title">多目标代价权重（7 维）</div>
      <p class="tip">
        综合代价 = 航程 + 威胁暴露 + 高度 + 禁飞 + 平滑 + <b>能耗</b> +
        <b>动力学惩罚</b>。权重实时影响搜索目标。
      </p>
      <NumberSlider
        v-for="m in weightMeta"
        :key="m.key"
        :label="OBJECTIVE_LABELS[m.key]"
        v-model="w[m.key]"
        :min="0"
        :max="m.max"
        :step="m.step"
        :decimals="m.step < 1 ? 2 : 0"
      />
    </div>

    <!-- 当前解的七维目标 -->
    <div class="section" v-if="objectives">
      <div class="section-title">当前航迹目标向量</div>
      <div class="obj-list">
        <div v-for="o in currentObjectiveBars" :key="o.key" class="obj-row">
          <span class="obj-k">{{ o.label }}</span>
          <span class="obj-v">{{ o.value.toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- 收敛曲线 -->
    <div class="section">
      <div class="section-title">迭代收敛曲线</div>
      <ConvergenceChart :data="convergence" />
      <p class="tip">
        ACO / PSO / GA 等迭代式算法在规划时记录每代最优与平均代价；
        栅格类算法无迭代过程。
      </p>
    </div>

    <!-- Pareto 前沿 -->
    <div class="section">
      <div class="section-title">Pareto 前沿（多目标优化）</div>
      <p class="tip">
        对 12 组典型权重策略各执行一次规划，在七维目标空间做非支配排序。
        <b>绿色为 Pareto 最优解</b>，灰色为被支配解。
      </p>
      <div class="axis-row">
        <label>
          X
          <select v-model="xAxis">
            <option v-for="k in axisChoices" :key="k" :value="k">{{ OBJECTIVE_LABELS[k] }}</option>
          </select>
        </label>
        <label>
          Y
          <select v-model="yAxis">
            <option v-for="k in axisChoices" :key="k" :value="k">{{ OBJECTIVE_LABELS[k] }}</option>
          </select>
        </label>
        <label v-if="paretoMode3d">
          Z
          <select v-model="zAxis">
            <option v-for="k in axisChoices" :key="k" :value="k">{{ OBJECTIVE_LABELS[k] }}</option>
          </select>
        </label>
        <label class="chk3">
          <input type="checkbox" v-model="paretoMode3d" />
          3D 投影
        </label>
      </div>
      <button class="primary" style="width: 100%" :disabled="scanning" @click="runParetoScan">
        {{ scanning ? `Pareto 扫描中 ${(scanProgress * 100).toFixed(0)}%` : '📊 运行 Pareto 权重扫描' }}
      </button>
      <div v-if="scanning" class="progress">
        <div class="bar" :style="{ width: scanProgress * 100 + '%' }"></div>
      </div>
      <ParetoChart
        v-if="paretoPoints"
        :points="paretoPoints"
        :x-axis="xAxis"
        :y-axis="yAxis"
        :z-axis="zAxis"
        :mode3d="paretoMode3d"
      />
      <div v-if="paretoPoints" class="pareto-list">
        <div class="pl-title">前沿解（{{ frontCount }}）— 点击套用权重并重新规划</div>
        <div
          v-for="(p, i) in paretoPoints.filter((x) => !x.dominated).slice(0, 8)"
          :key="i"
          class="pl-row"
          @click="applyParetoWeights(p)"
        >
          <span class="pl-cost">Σ{{ p.scalarCost.toFixed(0) }}</span>
          <span class="pl-objs">
            航程{{ p.objectives.distance.toFixed(0) }} ·
            威胁{{ p.objectives.threat.toFixed(1) }} ·
            能耗{{ p.objectives.energy.toFixed(1) }} ·
            动力学{{ p.objectives.dynamics.toFixed(2) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 权重敏感性 -->
    <div class="section">
      <div class="section-title">权重敏感性分析</div>
      <div class="axis-row">
        <label>
          权重轴
          <select v-model="sensAxis">
            <option v-for="m in weightMeta" :key="m.key" :value="m.key">
              {{ OBJECTIVE_LABELS[m.key] }}
            </option>
          </select>
        </label>
      </div>
      <NumberSlider label="最小权重" v-model="sensMin" :min="0" :max="300" :step="1" />
      <NumberSlider label="最大权重" v-model="sensMax" :min="0" :max="300" :step="1" />
      <NumberSlider label="采样点数" v-model="sensSteps" :min="3" :max="16" :step="1" />
      <button class="primary" style="width: 100%; margin-top: 6px" :disabled="sensRunning" @click="runSensitivity">
        {{ sensRunning ? '敏感性计算中…' : '📈 运行敏感性分析' }}
      </button>
      <SensitivityChart :result="sensitivityResult" />
    </div>
  </div>
</template>

<style scoped>
.tip {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  margin: 4px 0 8px;
}
.axis-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.axis-row label {
  font-size: 11px;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 4px;
}
.axis-row select {
  padding: 3px;
}
.chk3 {
  display: flex;
  gap: 4px;
  align-items: center;
}
.progress {
  height: 4px;
  background: var(--bg-3);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 6px;
}
.progress .bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.obj-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
}
.obj-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 7px;
}
.obj-k {
  color: var(--text-2);
}
.obj-v {
  color: var(--text-0);
  font-variant-numeric: tabular-nums;
}
.pareto-list {
  margin-top: 8px;
}
.pl-title {
  font-size: 10px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.pl-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  margin-bottom: 3px;
  cursor: pointer;
  font-size: 10px;
}
.pl-row:hover {
  border-color: var(--ok);
  background: rgba(46, 204, 113, 0.08);
}
.pl-cost {
  color: var(--ok);
  font-weight: 700;
  white-space: nowrap;
}
.pl-objs {
  color: var(--text-1);
}
</style>
