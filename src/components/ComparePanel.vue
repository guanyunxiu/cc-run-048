<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { Environment } from '@/core/environment'
import { compareAlgorithms, type AlgoCompareEntry } from '@/core/planning'
import { ALGO_LABELS } from '@/core/planners/registry'
import type { AlgoType } from '@/types'

const scene = useSceneStore()
const sim = useSimStore()

const selected = ref<Record<AlgoType, boolean>>({
  astar: true,
  dijkstra: true,
  rrt: true,
  rrtstar: true,
  hybridastar: true,
  aco: true,
  pso: true,
  ga: true
})
const running = ref(false)
const entries = ref<AlgoCompareEntry[] | null>(null)

const allAlgos = Object.keys(ALGO_LABELS) as AlgoType[]

async function runCompare() {
  running.value = true
  entries.value = null
  // 让出一帧显示加载态
  await new Promise((r) => setTimeout(r, 30))
  const env = new Environment(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles
  )
  const algos = allAlgos.filter((a) => selected.value[a])
  // 同步运行（节点环境，浏览器中各算法为轻量局部规划）
  entries.value = compareAlgorithms(
    env,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    algos,
    sim.smoothing
  )
  running.value = false
}

function best(field: keyof AlgoCompareEntry, lower = true): string | number {
  if (!entries.value) return ''
  const ok = entries.value.filter((e) => e.success)
  if (ok.length === 0) return ''
  const vals = ok.map((e) => e[field] as number)
  const bestV = lower ? Math.min(...vals) : Math.max(...vals)
  return bestV
}
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">多算法规划对比（功能01）</div>
      <p class="tip">
        勾选参与对比的算法，使用<b>同一环境、任务与代价权重</b>批量规划，
        对比航程 / 耗时 / 扩展节点 / 总代价 / 威胁暴露 / 约束满足率 / 曲率。
      </p>
      <div class="algo-pick">
        <label v-for="a in allAlgos" :key="a" class="pick">
          <input type="checkbox" v-model="selected[a]" />
          {{ ALGO_LABELS[a].split(' ')[0] }}
        </label>
      </div>
      <button class="primary" style="width: 100%; margin-top: 8px" :disabled="running" @click="runCompare">
        {{ running ? '对比计算中…' : '⚖ 运行算法对比' }}
      </button>
    </div>

    <div v-if="entries" class="section">
      <div class="section-title">对比结果（最优值高亮）</div>
      <table class="cmp-table">
        <thead>
          <tr>
            <th>算法</th>
            <th>状态</th>
            <th>航程</th>
            <th>耗时</th>
            <th>节点</th>
            <th>代价</th>
            <th>暴露</th>
            <th>约束</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.algo" :class="{ fail: !e.success }">
            <td class="algo-name">{{ ALGO_LABELS[e.algo].split(' ')[0] }}</td>
            <td :style="{ color: e.success ? 'var(--ok)' : 'var(--danger)' }">
              {{ e.success ? '✓' : '✗' }}
            </td>
            <td :class="{ best: best('distance') === e.distance }">{{ e.distance.toFixed(0) }}</td>
            <td :class="{ best: best('planTimeMs') === e.planTimeMs }">{{ e.planTimeMs.toFixed(1) }}</td>
            <td :class="{ best: best('expandedNodes') === e.expandedNodes }">{{ e.expandedNodes }}</td>
            <td :class="{ best: best('totalCost') === e.totalCost }">{{ e.totalCost.toFixed(0) }}</td>
            <td :class="{ best: best('threatExposure') === e.threatExposure }">{{ e.threatExposure.toFixed(1) }}</td>
            <td :class="{ best: best('satisfactionRate', false) === e.satisfactionRate }">
              {{ e.satisfactionRate.toFixed(0) }}%
            </td>
          </tr>
        </tbody>
      </table>
      <p class="tip">
        注：随机类算法（RRT/ACO/PSO/GA）使用固定随机种子，结果可复现；
        可在“规划参数”页实时调参后重新对比。
      </p>
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
.algo-pick {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
}
.pick {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-1);
}
.cmp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.cmp-table th,
.cmp-table td {
  border: 1px solid var(--line);
  padding: 5px 4px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.cmp-table th {
  color: var(--text-2);
  font-weight: 500;
}
.algo-name {
  text-align: left !important;
  color: var(--text-0);
  white-space: nowrap;
}
td.best {
  color: var(--ok);
  font-weight: 700;
  background: rgba(46, 204, 113, 0.08);
}
tr.fail {
  opacity: 0.55;
}
</style>
