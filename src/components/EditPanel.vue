<script setup lang="ts">
import { computed } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { THREAT_COLORS } from '@/three/factory'
import type { ThreatKind } from '@/types'
import NumberSlider from './NumberSlider.vue'

const scene = useSceneStore()

const selectedThreat = computed(() =>
  scene.threats.find((t) => t.id === scene.selectedId)
)
const selectedNoFly = computed(() =>
  scene.noflyZones.find((z) => z.id === scene.selectedId)
)
const selectedObstacle = computed(() =>
  scene.obstacles.find((b) => b.id === scene.selectedId)
)
const selectedWaypoint = computed(() =>
  scene.waypoints.find((w) => w.id === scene.selectedId)
)
const selectedDynamic = computed(() =>
  scene.dynamics.find((d) => d.id === scene.selectedId)
)

const threatKindOptions: { value: ThreatKind; label: string }[] = [
  { value: 'radar', label: '雷达' },
  { value: 'sam', label: '防空' },
  { value: 'jammer', label: '干扰' }
]

const wpLabel: Record<string, string> = {
  start: '起点',
  end: '终点',
  via: '途经点'
}
const maxRange = scene.terrain.size / 2 - 10

function addMovingObstacle() {
  const p = { x: 0, y: 0, z: 0 }
  scene.addDynamicAt(p)
}
function addSuddenThreat() {
  const p = { x: 0, y: 0, z: 0 }
  scene.addSuddenThreatAt(p)
}

/** 动态实体“作用半径”统一读写入口（威胁用 threatRadius、障碍用 radius） */
function setDynamicRadius(v: number) {
  const d = selectedDynamic.value
  if (!d) return
  if (d.kind === 'threat') d.threatRadius = v
  else d.radius = v
}
</script>

<template>
  <div>
    <!-- 实体列表 -->
    <div class="section">
      <div class="section-title">威胁区（{{ scene.threats.length }}）</div>
      <div
        v-for="t in scene.threats"
        :key="t.id"
        class="list-item"
        :class="{ selected: scene.selectedId === t.id }"
        @click="scene.select(t.id)"
      >
        <span
          class="swatch"
          :style="{ background: `#${THREAT_COLORS[t.kind].toString(16).padStart(6, '0')}` }"
        ></span>
        <span class="name">{{ t.name }} · L{{ t.level }}</span>
        <button class="icon-btn danger" @click.stop="scene.removeThreat(t.id)">×</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">禁飞区（{{ scene.noflyZones.length }}）</div>
      <div
        v-for="z in scene.noflyZones"
        :key="z.id"
        class="list-item"
        :class="{ selected: scene.selectedId === z.id }"
        @click="scene.select(z.id)"
      >
        <span class="swatch" style="background:#ff2d55"></span>
        <span class="name">{{ z.name }}{{ z.hardBlock ? '' : '（软）' }}</span>
        <button class="icon-btn danger" @click.stop="scene.removeNoFly(z.id)">×</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">建筑障碍（{{ scene.obstacles.length }}）</div>
      <div
        v-for="b in scene.obstacles"
        :key="b.id"
        class="list-item"
        :class="{ selected: scene.selectedId === b.id }"
        @click="scene.select(b.id)"
      >
        <span class="swatch" style="background:#9aa3ad"></span>
        <span class="name">{{ b.name }}</span>
        <button class="icon-btn danger" @click.stop="scene.removeObstacle(b.id)">×</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>动态实体（{{ scene.dynamics.length }}）</span>
        <span style="display:flex;gap:4px">
          <button class="icon-btn" style="padding:2px 6px" @click="addMovingObstacle">+移动</button>
          <button class="icon-btn" style="padding:2px 6px" @click="addSuddenThreat">+突发</button>
        </span>
      </div>
      <div
        v-for="d in scene.dynamics"
        :key="d.id"
        class="list-item"
        :class="{ selected: scene.selectedId === d.id }"
        @click="scene.select(d.id)"
      >
        <span class="swatch" :style="{ background: d.color }"></span>
        <span class="name">
          {{ d.name }}
          <small style="color:var(--text-2)">
            {{ d.kind === 'threat' ? '威胁' : '障碍' }} ·
            {{ d.motion === 'static' ? '静止' : d.motion === 'patrol' ? '巡逻' : '直线' }}
            <template v-if="d.enableAt > 0"> · t={{ d.enableAt }}s出现</template>
          </small>
        </span>
        <button class="icon-btn danger" @click.stop="scene.removeDynamic(d.id)">×</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">任务航点（{{ scene.waypoints.length }}）</div>
      <div
        v-for="(w, i) in scene.waypoints"
        :key="w.id"
        class="list-item"
        :class="{ selected: scene.selectedId === w.id }"
        @click="scene.select(w.id)"
      >
        <span
          class="swatch"
          :style="{
            background:
              w.role === 'start' ? '#2ecc71' : w.role === 'end' ? '#e74c3c' : '#f1c40f'
          }"
        ></span>
        <span class="name">
          {{ w.role === 'via' ? `途经点 ${i}` : wpLabel[w.role] }} · {{ w.position.y.toFixed(0) }}m
        </span>
        <button
          v-if="w.role === 'via'"
          class="icon-btn danger"
          @click.stop="scene.removeWaypoint(w.id)"
        >
          ×
        </button>
      </div>
    </div>

    <!-- 威胁区编辑 -->
    <div v-if="selectedThreat" class="section editor">
      <div class="section-title">编辑威胁区</div>
      <input
        type="text"
        v-model="selectedThreat.name"
        style="margin-bottom: 8px"
      />
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>类型</label>
        <select v-model="selectedThreat.kind">
          <option v-for="o in threatKindOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </div>
      <NumberSlider label="威胁等级" v-model="selectedThreat.level" :min="1" :max="5" />
      <NumberSlider label="作用半径" v-model="selectedThreat.radius" :min="20" :max="250" unit="m" />
      <NumberSlider label="最低高度" v-model="selectedThreat.heightMin" :min="0" :max="400" unit="m" />
      <NumberSlider label="最高高度" v-model="selectedThreat.heightMax" :min="10" :max="500" unit="m" />
      <NumberSlider
        label="透明度"
        v-model="selectedThreat.opacity"
        :min="0.05"
        :max="0.6"
        :step="0.01"
        :decimals="2"
      />
      <NumberSlider label="X 位置" v-model="selectedThreat.position.x" :min="-maxRange" :max="maxRange" unit="m" />
      <NumberSlider label="Z 位置" v-model="selectedThreat.position.z" :min="-maxRange" :max="maxRange" unit="m" />
    </div>

    <!-- 禁飞区编辑 -->
    <div v-if="selectedNoFly" class="section editor">
      <div class="section-title">编辑禁飞区</div>
      <input type="text" v-model="selectedNoFly.name" style="margin-bottom: 8px" />
      <NumberSlider label="作用半径" v-model="selectedNoFly.radius" :min="20" :max="250" unit="m" />
      <NumberSlider label="最低高度" v-model="selectedNoFly.heightMin" :min="0" :max="400" unit="m" />
      <NumberSlider label="最高高度" v-model="selectedNoFly.heightMax" :min="10" :max="500" unit="m" />
      <NumberSlider
        label="惩罚权重"
        v-model="selectedNoFly.penalty"
        :min="0"
        :max="50"
        :step="0.5"
        :decimals="1"
      />
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>硬避障</label>
        <label class="checkbox">
          <input type="checkbox" v-model="selectedNoFly.hardBlock" />
          启用后体素不可通行；关闭则仅施加软惩罚
        </label>
      </div>
      <NumberSlider label="X 位置" v-model="selectedNoFly.position.x" :min="-maxRange" :max="maxRange" unit="m" />
      <NumberSlider label="Z 位置" v-model="selectedNoFly.position.z" :min="-maxRange" :max="maxRange" unit="m" />
    </div>

    <!-- 建筑编辑 -->
    <div v-if="selectedObstacle" class="section editor">
      <div class="section-title">编辑建筑障碍</div>
      <input type="text" v-model="selectedObstacle.name" style="margin-bottom: 8px" />
      <NumberSlider label="宽度 X" v-model="selectedObstacle.size.x" :min="10" :max="120" unit="m" />
      <NumberSlider label="进深 Z" v-model="selectedObstacle.size.z" :min="10" :max="120" unit="m" />
      <NumberSlider label="高度" v-model="selectedObstacle.height" :min="10" :max="200" unit="m" />
      <NumberSlider label="X 位置" v-model="selectedObstacle.position.x" :min="-maxRange" :max="maxRange" unit="m" />
      <NumberSlider label="Z 位置" v-model="selectedObstacle.position.z" :min="-maxRange" :max="maxRange" unit="m" />
    </div>

    <!-- 动态实体编辑 -->
    <div v-if="selectedDynamic" class="section editor">
      <div class="section-title">编辑动态实体</div>
      <input type="text" v-model="selectedDynamic.name" style="margin-bottom: 8px" />
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>类型</label>
        <select v-model="selectedDynamic.kind">
          <option value="obstacle">移动障碍（硬碰撞球）</option>
          <option value="threat">动态/突发威胁</option>
        </select>
      </div>
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>运动模式</label>
        <select v-model="selectedDynamic.motion">
          <option value="static">静止（突发威胁）</option>
          <option value="linear">直线往返</option>
          <option value="patrol">巡逻折线</option>
        </select>
      </div>
      <NumberSlider label="运动速度" v-model="selectedDynamic.speed" :min="0" :max="80" unit="m/s" />
      <NumberSlider
        :label="selectedDynamic.kind === 'threat' ? '威胁半径' : '障碍半径'"
        :model-value="selectedDynamic.kind === 'threat' ? selectedDynamic.threatRadius : selectedDynamic.radius"
        @update:model-value="setDynamicRadius"
        :min="10"
        :max="200"
        unit="m"
      />
      <template v-if="selectedDynamic.kind === 'threat'">
        <NumberSlider label="威胁等级" v-model="selectedDynamic.level" :min="1" :max="5" />
        <NumberSlider label="最低高度" v-model="selectedDynamic.heightMin" :min="0" :max="400" unit="m" />
        <NumberSlider label="最高高度" v-model="selectedDynamic.heightMax" :min="10" :max="500" unit="m" />
      </template>
      <NumberSlider label="出现时刻" v-model="selectedDynamic.enableAt" :min="0" :max="60" :step="0.5" :decimals="1" unit="s" />
      <NumberSlider label="预测时域" v-model="selectedDynamic.predictHorizon" :min="2" :max="20" :step="0.5" :decimals="1" unit="s" />
      <NumberSlider label="X 位置" v-model="selectedDynamic.position.x" :min="-maxRange" :max="maxRange" unit="m" />
      <NumberSlider label="Z 位置" v-model="selectedDynamic.position.z" :min="-maxRange" :max="maxRange" unit="m" />
      <template v-if="selectedDynamic.motion === 'linear'">
        <NumberSlider label="目标 X" v-model="selectedDynamic.target.x" :min="-maxRange" :max="maxRange" unit="m" />
        <NumberSlider label="目标 Z" v-model="selectedDynamic.target.z" :min="-maxRange" :max="maxRange" unit="m" />
      </template>
      <div class="field-row" style="margin-top:4px">
        <button @click="selectedDynamic.active = !selectedDynamic.active">
          {{ selectedDynamic.active ? '立即停用' : '立即激活' }}
        </button>
      </div>
    </div>

    <!-- 航点编辑 -->
    <div v-if="selectedWaypoint" class="section editor">
      <div class="section-title">编辑{{ wpLabel[selectedWaypoint.role] }}</div>
      <NumberSlider label="高度 Y" v-model="selectedWaypoint.position.y" :min="0" :max="450" unit="m" />
      <NumberSlider label="飞行速度" v-model="selectedWaypoint.speed" :min="scene.planParams.speedMin" :max="scene.planParams.speedMax" unit="m/s" />
      <NumberSlider label="X 位置" v-model="selectedWaypoint.position.x" :min="-maxRange" :max="maxRange" unit="m" />
      <NumberSlider label="Z 位置" v-model="selectedWaypoint.position.z" :min="-maxRange" :max="maxRange" unit="m" />
    </div>

    <div v-if="!scene.selectedId" class="empty-tip">
      在 3D 视图中点选要素，或使用左侧工具在地形上点击添加。
    </div>
  </div>
</template>

<style scoped>
.editor {
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}
.checkbox {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  color: var(--text-1);
  font-size: 11px;
}
.empty-tip {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 10px;
}
</style>
