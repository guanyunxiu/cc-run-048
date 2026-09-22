<script setup lang="ts">
import { computed } from 'vue'
import { useSimStore } from '@/stores/sim'
import CostChart from './CostChart.vue'
import ConvergenceChart from './ConvergenceChart.vue'

const sim = useSimStore()
const s = computed(() => sim.stats)
const cr = computed(() => sim.stats?.constraints)
const rawM = computed(() => sim.stats?.rawMetrics)
const smM = computed(() => sim.stats?.smoothMetrics)
const track = computed(() => sim.trackingSummary)

const costItems = computed(() => {
  const b = s.value?.costBreakdown
  const total =
    (b?.distance ?? 0) +
    (b?.threat ?? 0) +
    (b?.altitude ?? 0) +
    (b?.nofly ?? 0) +
    (b?.smooth ?? 0) +
    (b?.energy ?? 0) +
    (b?.dynamics ?? 0)
  return [
    { key: '航程', v: b?.distance ?? 0, color: '#3aa0ff', total },
    { key: '威胁', v: b?.threat ?? 0, color: '#ff5263', total },
    { key: '高度', v: b?.altitude ?? 0, color: '#ffb020', total },
    { key: '禁飞', v: b?.nofly ?? 0, color: '#b046ff', total },
    { key: '平滑', v: b?.smooth ?? 0, color: '#1abc9c', total },
    { key: '能耗', v: b?.energy ?? 0, color: '#f39c12', total },
    { key: '动力学', v: b?.dynamics ?? 0, color: '#e84393', total }
  ]
})

const convergenceData = computed(() => sim.stats?.convergence ?? [])

const reasonText: Record<string, string> = {
  'threat-approach': '威胁接近',
  'collision-risk': '碰撞风险',
  'yaw-deviation': '偏航过大',
  'range-anomaly': '航程异常',
  manual: '手动突发'
}

function pctClass(v: number) {
  return v <= -1 ? 'down' : v >= 1 ? 'up' : 'flat'
}
function fmtPct(v: number) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">仿真评估</div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="k">总航程 (m)</div>
          <div class="v">{{ s ? s.distance.toFixed(0) : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">规划耗时 (ms)</div>
          <div class="v">{{ s ? s.planTimeMs.toFixed(1) : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">威胁暴露量</div>
          <div class="v">{{ s ? s.threatExposure.toFixed(1) : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">暴露时间 (s)</div>
          <div class="v">{{ s ? s.exposureTime.toFixed(1) : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">扩展节点</div>
          <div class="v">{{ s ? s.expandedNodes : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">避障成功率</div>
          <div class="v" :style="{ color: (s?.obstacleAvoidanceRate ?? 100) >= 100 ? 'var(--ok)' : 'var(--danger)' }">
            {{ s ? s.obstacleAvoidanceRate + '%' : '—' }}
          </div>
        </div>
        <div class="stat-card">
          <div class="k">约束满足率</div>
          <div class="v" :style="{ color: (cr?.satisfactionRate ?? 100) >= 95 ? 'var(--ok)' : 'var(--warn)' }">
            {{ cr ? cr.satisfactionRate.toFixed(1) + '%' : '—' }}
          </div>
        </div>
        <div class="stat-card">
          <div class="k">在线重规划</div>
          <div class="v">{{ s?.replanCount ?? 0 }} 次</div>
        </div>
        <div class="stat-card">
          <div class="k">能耗目标 (kJ)</div>
          <div class="v">{{ s?.objectives ? s.objectives.energy.toFixed(1) : '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="k">动力学违反</div>
          <div class="v" :style="{ color: (s?.objectives?.dynamics ?? 0) === 0 ? 'var(--ok)' : 'var(--warn)' }">
            {{ s?.objectives ? s.objectives.dynamics.toFixed(2) : '—' }}
          </div>
        </div>
        <div class="stat-card" style="grid-column: 1 / -1">
          <div class="k">总加权代价（{{ s?.success ? '可行航迹' : '规划失败' }}）</div>
          <div class="v">{{ s ? s.totalCost.toFixed(1) : '—' }}</div>
        </div>
      </div>
    </div>

    <!-- 动力学约束（功能03） -->
    <div v-if="cr" class="section">
      <div class="section-title">动力学约束检查（{{ cr.samples }} 采样点）</div>
      <div class="viol-grid">
        <div class="viol" :class="{ bad: cr.turnViolations > 0 }">
          转弯角违反 <b>{{ cr.turnViolations }}</b>
        </div>
        <div class="viol" :class="{ bad: cr.climbViolations > 0 }">
          爬升角违反 <b>{{ cr.climbViolations }}</b>
        </div>
        <div class="viol" :class="{ bad: cr.stepViolations > 0 }">
          步长违反 <b>{{ cr.stepViolations }}</b>
        </div>
        <div class="viol" :class="{ bad: cr.radiusViolations > 0 }">
          转弯半径违反 <b>{{ cr.radiusViolations }}</b>
        </div>
        <div class="viol" :class="{ bad: cr.accelViolations > 0 }">
          加速度违反 <b>{{ cr.accelViolations }}</b>
        </div>
        <div class="viol" :class="{ bad: cr.attitudeRateViolations > 0 }">
          姿态率违反 <b>{{ cr.attitudeRateViolations }}</b>
        </div>
      </div>
      <div v-if="cr.violationIndices.length === 0" class="ok-tip">✓ 全部采样点满足动力学约束</div>
      <div v-else class="warn-tip">违反点已在三维视图中以红点高亮</div>
    </div>

    <!-- 平滑前后指标对比（功能04） -->
    <div v-if="rawM && smM" class="section">
      <div class="section-title">平滑前后指标对比（{{ s?.smoothing }}）</div>
      <table class="metrics-table">
        <thead>
          <tr><th>指标</th><th>原始</th><th>平滑后</th><th>变化</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>航程 (m)</td>
            <td>{{ rawM.length.toFixed(0) }}</td>
            <td>{{ smM.length.toFixed(0) }}</td>
            <td :class="pctClass(((smM.length - rawM.length) / Math.max(rawM.length,1)) * 100)">
              {{ fmtPct(((smM.length - rawM.length) / Math.max(rawM.length,1)) * 100) }}
            </td>
          </tr>
          <tr>
            <td>最大曲率 (1/m)</td>
            <td>{{ rawM.maxCurvature.toExponential(1) }}</td>
            <td>{{ smM.maxCurvature.toExponential(1) }}</td>
            <td :class="pctClass(rawM.maxCurvature > 1e-9 ? ((smM.maxCurvature - rawM.maxCurvature) / rawM.maxCurvature) * 100 : 0)">
              {{ rawM.maxCurvature > 1e-9 ? fmtPct(((smM.maxCurvature - rawM.maxCurvature) / rawM.maxCurvature) * 100) : '—' }}
            </td>
          </tr>
          <tr>
            <td>最大转角 (°)</td>
            <td>{{ rawM.maxTurnAngle.toFixed(1) }}</td>
            <td>{{ smM.maxTurnAngle.toFixed(1) }}</td>
            <td :class="pctClass(smM.maxTurnAngle - rawM.maxTurnAngle)">
              {{ (smM.maxTurnAngle - rawM.maxTurnAngle).toFixed(1) }}°
            </td>
          </tr>
          <tr>
            <td>最大爬升角 (°)</td>
            <td>{{ rawM.maxClimbAngle.toFixed(1) }}</td>
            <td>{{ smM.maxClimbAngle.toFixed(1) }}</td>
            <td :class="pctClass(smM.maxClimbAngle - rawM.maxClimbAngle)">
              {{ (smM.maxClimbAngle - rawM.maxClimbAngle).toFixed(1) }}°
            </td>
          </tr>
          <tr>
            <td>最大速度 (m/s)</td>
            <td>{{ rawM.maxSpeed.toFixed(1) }}</td>
            <td>{{ smM.maxSpeed.toFixed(1) }}</td>
            <td>—</td>
          </tr>
          <tr>
            <td>最大加速度 (m/s²)</td>
            <td>{{ rawM.maxAccel.toFixed(2) }}</td>
            <td>{{ smM.maxAccel.toFixed(2) }}</td>
            <td :class="pctClass(rawM.maxAccel > 1e-9 ? ((smM.maxAccel - rawM.maxAccel) / rawM.maxAccel) * 100 : 0)">
              {{ rawM.maxAccel > 1e-9 ? fmtPct(((smM.maxAccel - rawM.maxAccel) / rawM.maxAccel) * 100) : '—' }}
            </td>
          </tr>
          <tr>
            <td>最大抖动 (m/s³)</td>
            <td>{{ rawM.maxJerk.toFixed(2) }}</td>
            <td>{{ smM.maxJerk.toFixed(2) }}</td>
            <td :class="pctClass(rawM.maxJerk > 1e-9 ? ((smM.maxJerk - rawM.maxJerk) / rawM.maxJerk) * 100 : 0)">
              {{ rawM.maxJerk > 1e-9 ? fmtPct(((smM.maxJerk - rawM.maxJerk) / rawM.maxJerk) * 100) : '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 跟踪误差（功能04） -->
    <div v-if="track && track.samples > 0" class="section">
      <div class="section-title">轨迹跟踪误差</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="k">横向 RMS (m)</div><div class="v">{{ track.rmsLateral.toFixed(2) }}</div></div>
        <div class="stat-card"><div class="k">高度 RMS (m)</div><div class="v">{{ track.rmsAltitude.toFixed(2) }}</div></div>
        <div class="stat-card"><div class="k">航向 RMS (°)</div><div class="v">{{ track.rmsYaw.toFixed(2) }}</div></div>
        <div class="stat-card"><div class="k">速度 RMS (m/s)</div><div class="v">{{ track.rmsSpeed.toFixed(2) }}</div></div>
        <div class="stat-card" style="grid-column: 1 / -1">
          <div class="k">最大横向偏差 (m)</div><div class="v">{{ track.maxLateral.toFixed(2) }}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">代价分量</div>
      <div class="cost-bars">
        <div v-for="c in costItems" :key="c.key" class="bar-row">
          <span style="color: var(--text-1)">{{ c.key }}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              :style="{
                width: c.total > 0 ? Math.max(2, (c.v / c.total) * 100) + '%' : '0%',
                background: c.color
              }"
            ></div>
          </div>
          <span style="text-align: right; font-variant-numeric: tabular-nums">
            {{ c.v.toFixed(1) }}
          </span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">累积代价曲线</div>
      <CostChart :curve="sim.costCurve" />
    </div>

    <!-- 迭代收敛曲线（功能01） -->
    <div class="section">
      <div class="section-title">迭代收敛曲线（功能01）</div>
      <ConvergenceChart :data="convergenceData" />
    </div>

    <!-- 在线重规划记录（功能02） -->
    <div v-if="sim.replanEvents.length > 0" class="section">
      <div class="section-title">在线重规划记录（{{ sim.replanEvents.length }}）</div>
      <div class="replan-list">
        <div v-for="(e, i) in sim.replanEvents" :key="i" class="replan-row">
          <div class="rr-head">
            <span class="rr-tag">{{ reasonText[e.reason] }}</span>
            <span class="rr-time">t={{ e.time.toFixed(1) }}s</span>
          </div>
          <div class="rr-detail">{{ e.detail }}</div>
          <div class="rr-cost">
            代价 {{ e.costBefore }} → {{ e.costAfter }} · {{ e.planMs.toFixed(1) }}ms
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viol-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.viol {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--text-1);
}
.viol.bad {
  border-color: var(--danger);
  color: var(--danger);
}
.viol b {
  float: right;
  font-size: 13px;
}
.ok-tip {
  color: var(--ok);
  font-size: 11px;
  margin-top: 6px;
}
.warn-tip {
  color: var(--warn);
  font-size: 11px;
  margin-top: 6px;
}
.metrics-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.metrics-table th,
.metrics-table td {
  border: 1px solid var(--line);
  padding: 4px 6px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.metrics-table th:first-child,
.metrics-table td:first-child {
  text-align: left;
  color: var(--text-1);
}
.metrics-table thead th {
  color: var(--text-2);
  font-weight: 500;
}
.down { color: var(--ok); }
.up { color: var(--danger); }
.flat { color: var(--text-2); }
.replan-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.replan-row {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  border-radius: 5px;
  padding: 6px 8px;
}
.rr-head {
  display: flex;
  justify-content: space-between;
}
.rr-tag {
  color: var(--warn);
  font-weight: 700;
  font-size: 11px;
}
.rr-time {
  color: var(--text-2);
  font-size: 11px;
}
.rr-detail {
  font-size: 11px;
  color: var(--text-1);
  margin: 3px 0;
}
.rr-cost {
  font-size: 10px;
  color: var(--accent-2);
}
</style>
