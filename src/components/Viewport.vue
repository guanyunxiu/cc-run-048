<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SceneRenderer } from '@/three/SceneRenderer'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { useEngineStore } from '@/stores/engine'
import { useFleetStore } from '@/stores/fleet'

const scene = useSceneStore()
const sim = useSimStore()
const engine = useEngineStore()
const fleet = useFleetStore()
const containerRef = ref<HTMLDivElement | null>(null)
let renderer: SceneRenderer | null = null

onMounted(() => {
  renderer = new SceneRenderer(containerRef.value!, scene, sim)

  // 区域/建筑：ID 集合或任意属性变化 -> 全量同步（数量少，重建成本可忽略）
  watch(
    () => JSON.stringify([scene.threats, scene.noflyZones, scene.obstacles]),
    () => renderer?.syncZones()
  )

  // 动态实体集合变化时全量同步
  watch(
    () => scene.dynamics.map((d) => d.id).join(','),
    () => renderer?.syncDynamics()
  )

  // 航点：ID 集合变化时重建标记
  watch(
    () => scene.waypoints.map((w) => w.id).join(','),
    () => renderer?.syncWaypoints()
  )

  // 地形参数变化 -> 重建地形网格
  watch(
    () => scene.terrainVersion,
    () => renderer?.rebuildTerrain()
  )

  // 航点位置变化（拖拽/滑块）-> 只更新位置，避免重建文字精灵
  watch(
    () =>
      scene.waypoints
        .map((w) => [w.position.x, w.position.y, w.position.z].join(','))
        .join('|'),
    () => {
      for (const wp of scene.waypoints) {
        const marker = renderer?.findWaypointObject(wp.id)
        marker?.position.set(wp.position.x, wp.position.y, wp.position.z)
      }
    }
  )

  watch(sim.smoothPath, () => renderer?.syncPaths(), { deep: false })
  watch(sim.rawPath, () => renderer?.syncPaths(), { deep: false })
  watch(sim.candidates, () => renderer?.syncCandidates(), { deep: true })
  watch(sim.localCandidates, () => renderer?.syncCandidates(), { deep: true })
  watch(sim.replanWindow, () => renderer?.syncCandidates(), { deep: true })
  watch(() => sim.showCandidates, () => renderer?.syncCandidates())
  watch(
    () => sim.stats?.constraints?.violationIndices,
    () => renderer?.syncViolationPoints(),
    { deep: true }
  )
  watch(() => sim.showClearanceMap, () => renderer?.recolorPath())
  watch(
    () => sim.showThreatHeatmap,
    () => renderer?.applyHeatmap()
  )
  watch(
    () => sim.cameraMode,
    (m) => renderer?.setCameraMode(m)
  )

  // 迭代三：标量场图层切换
  watch(
    () => engine.layers.fieldLayer,
    (mode) => void renderer?.setFieldLayer(mode)
  )
  // 巡航高度变化时重建场图层（采样高度改变）
  watch(
    () => scene.planParams.cruiseAlt,
    () => {
      if (engine.layers.fieldLayer !== 'off') {
        void renderer?.setFieldLayer(engine.layers.fieldLayer)
      }
    }
  )

  // 迭代三：多无人机
  watch(
    () => engine.fleetRuntimes,
    () => renderer?.syncFleet(),
    { deep: false }
  )
  watch(
    () => [
      engine.layers.showSensorRange,
      engine.layers.showCommRange,
      engine.layers.showCommLinks
    ],
    () => renderer?.syncFleet()
  )
  watch(
    () => engine.fleetActive,
    (active) => {
      if (!active) renderer?.clearFleetView()
    }
  )

  // 迭代三：实例化建筑开关
  const onInstanced = (e: Event) =>
    renderer?.setInstancedBuildings((e as CustomEvent<boolean>).detail)
  window.addEventListener('uav:instanced-buildings', onInstanced)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') scene.setEditMode('select')
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement?.tagName !== 'INPUT') scene.removeSelected()
    }
    if (e.key === ' ') {
      e.preventDefault()
      sim.togglePlay()
    }
  }
  window.addEventListener('keydown', onKey)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('uav:instanced-buildings', onInstanced)
  })
})

onBeforeUnmount(() => {
  renderer?.dispose()
  renderer = null
})

const hintText = () => {
  switch (scene.editMode) {
    case 'add-threat':
      return '点击地形放置雷达威胁区（放置后在右侧面板修改类型与参数）'
    case 'add-nofly':
      return '点击地形放置禁飞区'
    case 'add-obstacle':
      return '点击地形放置建筑障碍'
    case 'add-dynamic':
      return '点击地形放置移动障碍物（右侧面板可改为突发威胁、设置速度/巡逻点/出现时刻）'
    case 'add-waypoint':
      return '点击地形添加途经航点（自动设置安全高度）'
    default:
      return '左键旋转 · 右键平移 · 滚轮缩放 · 拖拽要素编辑 · Delete 删除选中'
  }
}

const reasonText: Record<string, string> = {
  'threat-approach': '威胁接近',
  'collision-risk': '碰撞风险',
  'yaw-deviation': '偏航过大',
  'range-anomaly': '航程异常',
  manual: '手动突发'
}
</script>

<template>
  <div ref="containerRef" class="viewport">
    <div class="hint">{{ hintText() }}</div>
    <div class="status-chip">
      <span
        class="dot"
        :class="{
          green: sim.status === 'done' && sim.stats?.success,
          red: sim.status === 'failed',
          yellow: sim.status === 'planning',
          gray: sim.status === 'idle'
        }"
      ></span>
      <span>{{ sim.message }}</span>
      <span v-if="sim.dirty && sim.status !== 'planning'" style="color: var(--warn)">
        ●参数已变更
      </span>
      <span v-if="sim.replanEvents.length > 0" class="replan-badge">
        在线重规划 ×{{ sim.replanEvents.length }}
      </span>
    </div>

    <!-- 最近一次重规划触发原因（功能05） -->
    <div v-if="sim.lastReplanEvent" class="replan-toast">
      <div class="rt-title">
        {{ reasonText[sim.lastReplanEvent.reason] }} · t={{ sim.lastReplanEvent.time.toFixed(1) }}s
      </div>
      <div class="rt-detail">{{ sim.lastReplanEvent.detail }}</div>
      <div class="rt-cost">
        局部代价 {{ sim.lastReplanEvent.costBefore }} → {{ sim.lastReplanEvent.costAfter }}
        · 耗时 {{ sim.lastReplanEvent.planMs.toFixed(1) }}ms
      </div>
    </div>

    <div class="field-switch">
      <span class="fs-label">标量场：</span>
      <button
        v-for="m in ([
          ['off', '关'],
          ['threat', '威胁强度'],
          ['clearance', '安全裕度'],
          ['cost', '综合代价']
        ] as const)"
        :key="m[0]"
        :class="{ active: engine.layers.fieldLayer === m[0] }"
        @click="engine.setFieldLayer(m[0])"
      >
        {{ m[1] }}
      </button>
    </div>

    <div class="legend">
      <div><i style="background:#22a7ff"></i>雷达区</div>
      <div><i style="background:#ff3b30"></i>防空区</div>
      <div><i style="background:#b046ff"></i>干扰区</div>
      <div><i style="background:#ff2d55"></i>禁飞区</div>
      <div><i style="background:#ff8f1f"></i>移动障碍/突发威胁（虚线为预测轨迹）</div>
      <div><i style="background:#2ecc71"></i>起点 / <i style="background:#e74c3c"></i>终点 / <i style="background:#f1c40f"></i>途经</div>
      <div v-if="sim.showCandidates"><i style="background:#ffb020"></i>候选航迹 / 局部重规划窗口</div>
      <div v-if="sim.lastReplanEvent"><i style="background:#ff2d55"></i>重规划触发风险位置</div>
      <div v-if="sim.stats?.constraints"><i style="background:#ff3b30"></i>约束违反点</div>
    </div>
  </div>
</template>

<style scoped>
.replan-badge {
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 10px;
  padding: 0 7px;
  font-size: 11px;
}
.replan-toast {
  position: absolute;
  top: 48px;
  right: 12px;
  background: rgba(40, 22, 8, 0.88);
  border: 1px solid var(--warn);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-0);
  z-index: 6;
  max-width: 320px;
  line-height: 1.5;
  pointer-events: none;
}
.rt-title {
  color: var(--warn);
  font-weight: 700;
}
.rt-detail {
  color: var(--text-1);
  font-size: 11px;
}
.rt-cost {
  color: var(--accent-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.field-switch {
  position: absolute;
  left: 12px;
  top: 48px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(10, 20, 36, 0.82);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 8px;
}
.fs-label {
  font-size: 11px;
  color: var(--text-2);
}
.field-switch button {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 5px;
  background: transparent;
  color: var(--text-1);
}
.field-switch button.active {
  background: var(--accent);
  color: #06101f;
  font-weight: 700;
}
</style>
