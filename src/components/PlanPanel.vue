<script setup lang="ts">
import { computed } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { ALGO_LABELS, ALGO_DESC } from '@/core/planners/registry'
import type { AlgoType, SmoothingType } from '@/types'
import NumberSlider from './NumberSlider.vue'

const scene = useSceneStore()
const sim = useSimStore()
const p = scene.planParams
const w = scene.weights
const dyn = p.dynamics
const tune = p.tuning
const rt = scene.replanTriggers

const algos = Object.keys(ALGO_LABELS) as AlgoType[]
const smoothingOptions: { value: SmoothingType; label: string }[] = [
  { value: 'none', label: '不平滑（原始折线）' },
  { value: 'polyline', label: '折线松弛平滑' },
  { value: 'bspline', label: '三次 B 样条' },
  { value: 'bezier', label: '三次贝塞尔（Catmull-Rom）' },
  { value: 'polynomial', label: '三次多项式样条' },
  { value: 'dubins', label: 'Dubins 圆弧' },
  { value: 'clothoid', label: 'Clothoid 回旋曲线' }
]

const isRRT = computed(() => p.algo === 'rrt' || p.algo === 'rrtstar')
const isHybrid = computed(() => p.algo === 'hybridastar')
const isAco = computed(() => p.algo === 'aco')
const isPso = computed(() => p.algo === 'pso')
const isGa = computed(() => p.algo === 'ga')
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">规划算法（可插拔，共 8 种）</div>
      <div class="algo-grid">
        <button
          v-for="a in algos"
          :key="a"
          :class="{ active: p.algo === a }"
          @click="sim.setAlgo(a)"
          :title="ALGO_DESC[a]"
        >
          {{ ALGO_LABELS[a].split(' ')[0] }}
        </button>
      </div>
      <div class="algo-desc">{{ ALGO_DESC[p.algo] }}</div>
      <div class="field" style="grid-template-columns: 88px 1fr; margin-top: 8px">
        <label>平滑方式</label>
        <select
          :value="sim.smoothing"
          @change="sim.setSmoothing(($event.target as HTMLSelectElement).value as SmoothingType)"
        >
          <option v-for="o in smoothingOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </div>
    </div>

    <!-- RRT / RRT* 参数 -->
    <div v-if="isRRT" class="section">
      <div class="section-title">{{ p.algo === 'rrtstar' ? 'RRT*' : 'RRT' }} 参数（实时调节）</div>
      <NumberSlider label="扩展步长" v-model="tune.rrtStep" :min="15" :max="90" unit="m" />
      <NumberSlider label="目标偏置" v-model="tune.goalBias" :min="0" :max="0.4" :step="0.02" :decimals="2" />
      <NumberSlider label="采样上限" v-model="tune.maxSamples" :min="500" :max="12000" :step="100" />
      <template v-if="p.algo === 'rrtstar'">
        <NumberSlider label="重连半径" v-model="tune.rewireRadius" :min="30" :max="220" unit="m" />
      </template>
    </div>

    <!-- Hybrid A* 参数 -->
    <div v-if="isHybrid" class="section">
      <div class="section-title">Hybrid A* 运动基元</div>
      <NumberSlider label="转弯档位" v-model="tune.motionPrims" :min="1" :max="5" />
    </div>

    <!-- 蚁群参数 -->
    <div v-if="isAco" class="section">
      <div class="section-title">蚁群参数（实时调节）</div>
      <NumberSlider label="蚂蚁数量" v-model="tune.antCount" :min="8" :max="60" />
      <NumberSlider label="迭代代数" v-model="tune.acoIterations" :min="10" :max="100" />
      <NumberSlider label="α 信息素" v-model="tune.acoAlpha" :min="0" :max="4" :step="0.1" :decimals="1" />
      <NumberSlider label="β 启发" v-model="tune.acoBeta" :min="0" :max="8" :step="0.1" :decimals="1" />
      <NumberSlider label="挥发率" v-model="tune.acoEvap" :min="0.05" :max="0.9" :step="0.05" :decimals="2" />
      <NumberSlider label="信息素强度" v-model="tune.acoQ" :min="10" :max="200" :step="5" />
    </div>

    <!-- 粒子群参数 -->
    <div v-if="isPso" class="section">
      <div class="section-title">粒子群参数（实时调节）</div>
      <NumberSlider label="粒子数量" v-model="tune.psoParticles" :min="8" :max="80" />
      <NumberSlider label="迭代代数" v-model="tune.psoIterations" :min="10" :max="150" />
      <NumberSlider label="惯性权重" v-model="tune.psoInertia" :min="0.1" :max="1.2" :step="0.02" :decimals="2" />
      <NumberSlider label="自我因子 c1" v-model="tune.psoC1" :min="0" :max="3" :step="0.05" :decimals="2" />
      <NumberSlider label="社会因子 c2" v-model="tune.psoC2" :min="0" :max="3" :step="0.05" :decimals="2" />
      <NumberSlider label="走廊半宽" v-model="tune.psoCorridor" :min="60" :max="320" unit="m" />
    </div>

    <!-- 遗传参数 -->
    <div v-if="isGa" class="section">
      <div class="section-title">遗传算法参数（实时调节）</div>
      <NumberSlider label="种群规模" v-model="tune.gaPopulation" :min="10" :max="100" />
      <NumberSlider label="迭代代数" v-model="tune.gaIterations" :min="10" :max="150" />
      <NumberSlider label="交叉概率" v-model="tune.gaCrossover" :min="0" :max="1" :step="0.05" :decimals="2" />
      <NumberSlider label="变异概率" v-model="tune.gaMutation" :min="0" :max="0.6" :step="0.02" :decimals="2" />
    </div>

    <div class="section">
      <div class="section-title">栅格搜索参数（A*/Dijkstra/Hybrid）</div>
      <NumberSlider label="水平栅格" v-model="p.cellSize" :min="10" :max="60" :step="5" unit="m" />
      <NumberSlider label="高度栅格" v-model="p.heightCell" :min="10" :max="50" :step="5" unit="m" />
      <NumberSlider label="最大步长" v-model="p.maxStep" :min="1" :max="3" />
      <NumberSlider label="启发权重" v-model="p.heuristicWeight" :min="0.5" :max="3" :step="0.1" :decimals="1" />
      <NumberSlider label="扩展上限" v-model="p.maxNodes" :min="20000" :max="500000" :step="20000" />
      <NumberSlider label="平滑迭代" v-model="p.smoothIterations" :min="0" :max="30" />
    </div>

    <div class="section">
      <div class="section-title">动力学约束（功能03）</div>
      <label class="checkbox" style="margin-bottom: 6px">
        <input type="checkbox" v-model="dyn.enforceInSearch" />
        搜索中施加约束（否则仅事后检查）
      </label>
      <label class="checkbox" style="margin-bottom: 6px">
        <input type="checkbox" v-model="dyn.autoRepair" />
        违反约束时自动整形修正
      </label>
      <NumberSlider label="最大转弯角" v-model="dyn.maxTurnAngle" :min="15" :max="120" unit="°" />
      <NumberSlider label="最大爬升角" v-model="dyn.maxClimbAngle" :min="5" :max="75" unit="°" />
      <NumberSlider label="最小步长" v-model="dyn.minStep" :min="2" :max="40" unit="m" />
      <NumberSlider label="最小转弯半径" v-model="dyn.minTurnRadius" :min="10" :max="200" unit="m" />
      <NumberSlider label="最大加速度" v-model="dyn.maxAccel" :min="3" :max="30" :step="0.5" :decimals="1" unit="m/s²" />
      <NumberSlider label="姿态变化率" v-model="dyn.maxAttitudeRate" :min="10" :max="120" unit="°/s" />
    </div>

    <div class="section">
      <div class="section-title">在线重规划触发（功能02）</div>
      <label class="checkbox" style="margin-bottom: 6px">
        <input type="checkbox" v-model="sim.onlineReplan" />
        回放中启用在线局部重规划
      </label>
      <label class="checkbox"><input type="checkbox" v-model="rt.enabled" />总开关：触发检测</label>
      <label class="checkbox"><input type="checkbox" v-model="rt.onThreatApproach" />威胁/障碍进入预警</label>
      <label class="checkbox"><input type="checkbox" v-model="rt.onCollisionRisk" />前瞻碰撞风险</label>
      <label class="checkbox"><input type="checkbox" v-model="rt.onYawDeviation" />偏航过大</label>
      <label class="checkbox" style="margin-bottom: 6px"><input type="checkbox" v-model="rt.onRangeAnomaly" />剩余航程异常</label>
      <NumberSlider label="前瞻时间" v-model="rt.lookaheadTime" :min="2" :max="15" :step="0.5" :decimals="1" unit="s" />
      <NumberSlider label="偏航阈值" v-model="rt.yawThreshold" :min="10" :max="90" unit="°" />
      <NumberSlider label="航程偏差" v-model="rt.rangeThreshold" :min="0.1" :max="1" :step="0.05" :decimals="2" />
      <NumberSlider label="重规划窗口" v-model="rt.windowRadius" :min="100" :max="500" :step="20" unit="m" />
    </div>

    <div class="section">
      <div class="section-title">飞行与安全</div>
      <NumberSlider label="安全距离" v-model="p.clearance" :min="0" :max="40" unit="m" />
      <NumberSlider label="巡航高度" v-model="p.cruiseAlt" :min="40" :max="300" unit="m" />
      <NumberSlider label="最小速度" v-model="p.speedMin" :min="5" :max="40" unit="m/s" />
      <NumberSlider label="最大速度" v-model="p.speedMax" :min="20" :max="120" unit="m/s" />
    </div>

    <div class="section">
      <div class="section-title">代价权重（实时影响航迹，迭代三 7 维）</div>
      <NumberSlider label="航程代价" v-model="w.distance" :min="0" :max="10" :step="0.1" :decimals="1" />
      <NumberSlider label="威胁暴露" v-model="w.threat" :min="0" :max="100" :step="1" />
      <NumberSlider label="高度代价" v-model="w.altitude" :min="0" :max="40" :step="0.5" :decimals="1" />
      <NumberSlider label="禁飞惩罚" v-model="w.nofly" :min="0" :max="200" :step="2" />
      <NumberSlider label="平滑代价" v-model="w.smooth" :min="0" :max="2" :step="0.05" :decimals="2" />
      <NumberSlider label="能耗代价" v-model="w.energy" :min="0" :max="10" :step="0.1" :decimals="1" />
      <NumberSlider label="动力学惩罚" v-model="w.dynamics" :min="0" :max="20" :step="0.2" :decimals="1" />
      <div class="field-row" style="margin-top: 6px">
        <label class="checkbox">
          <input type="checkbox" v-model="sim.autoReplan" />
          参数/环境变更后自动重规划
        </label>
      </div>
      <div class="field-row">
        <label class="checkbox">
          <input type="checkbox" v-model="sim.showCandidates" />
          显示候选航迹
        </label>
        <label class="checkbox">
          <input type="checkbox" v-model="sim.showClearanceMap" />
          安全裕度着色
        </label>
      </div>
      <div class="field-row">
        <label class="checkbox">
          <input type="checkbox" v-model="sim.showTracking" />
          跟踪误差虚影
        </label>
      </div>
    </div>

    <div class="section">
      <div class="section-title">能耗模型（功能01）</div>
      <NumberSlider label="起飞重量" v-model="p.energy.mass" :min="4" :max="40" :step="0.5" :decimals="1" unit="kg" />
      <NumberSlider label="阻力系数" v-model="p.energy.dragCoeff" :min="0.005" :max="0.06" :step="0.001" :decimals="3" />
      <NumberSlider label="诱导阻力因子" v-model="p.energy.inducedFactor" :min="5" :max="80" :step="1" />
      <NumberSlider label="爬升效率" v-model="p.energy.climbEfficiency" :min="0.3" :max="0.95" :step="0.02" :decimals="2" />
    </div>

    <div class="section">
      <div class="section-title">地形参数</div>
      <NumberSlider label="地形尺寸" v-model="scene.terrain.size" :min="600" :max="1600" :step="200" unit="m" />
      <NumberSlider label="高程幅度" v-model="scene.terrain.heightScale" :min="40" :max="260" :step="10" unit="m" />
      <NumberSlider label="山脊强度" v-model="scene.terrain.ridgeScale" :min="0" :max="150" :step="5" unit="m" />
      <NumberSlider label="噪声密度" v-model="scene.terrain.noiseScale" :min="0.001" :max="0.005" :step="0.0001" :decimals="4" />
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>峡谷</label>
        <label class="checkbox">
          <input type="checkbox" v-model="scene.terrain.canyon" />
          生成蜿蜒峡谷
        </label>
      </div>
      <div class="field-row">
        <label>随机种子</label>
        <input type="number" v-model.number="scene.terrain.seed" />
        <button @click="scene.terrain.seed = Math.floor(Math.random() * 1e6)">🎲</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.checkbox {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--text-1);
  font-size: 12px;
  margin-bottom: 4px;
}
.algo-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.algo-grid button {
  padding: 7px 2px;
  font-size: 11px;
}
.algo-desc {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
  margin-top: 6px;
  min-height: 32px;
}
</style>
