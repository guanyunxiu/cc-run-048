import type {
  AlgoType,
  CostWeights,
  ParamPreset,
  PlanParams
} from '@/types'
import { defaultPlanParams, defaultWeights } from './defaults'

/**
 * 参数预设（功能04）：
 * 内置覆盖“快速侦察/隐蔽突防/省油远航/约束严格”等任务画像，
 * 用户自定义预设持久化到 localStorage。配合算法注册表实现热插拔。
 */

const STORAGE_KEY = 'uav-sim.param-presets.v1'

export const BUILTIN_PRESETS: ParamPreset[] = [
  {
    id: 'builtin-fast-recon',
    name: '快速侦察',
    description: '大步长、轻量平滑、航程优先，追求最短规划与飞行时间',
    algo: 'astar',
    builtin: true,
    planParams: {
      cellSize: 30,
      heightCell: 25,
      maxStep: 3,
      maxNodes: 120000,
      smoothIterations: 4
    },
    weights: { distance: 5, threat: 10, altitude: 4, nofly: 40, smooth: 0.05, energy: 10, dynamics: 20 }
  },
  {
    id: 'builtin-stealth',
    name: '隐蔽突防',
    description: '威胁/禁飞权重极高，绕飞优先，安全距离加大',
    algo: 'rrtstar',
    builtin: true,
    planParams: {
      clearance: 22,
      maxNodes: 300000,
      tuning: { ...defaultPlanParams.tuning, maxSamples: 7000, rewireRadius: 130 }
    },
    weights: { distance: 0.8, threat: 130, altitude: 6, nofly: 220, smooth: 0.2, energy: 20, dynamics: 50 }
  },
  {
    id: 'builtin-endurance',
    name: '省油远航',
    description: '能耗与高度稳定优先，巡航高度经济速度',
    algo: 'hybridastar',
    builtin: true,
    planParams: {
      cruiseAlt: 160,
      speedMin: 18,
      speedMax: 38
    },
    weights: { distance: 1.2, threat: 20, altitude: 30, nofly: 60, smooth: 0.3, energy: 180, dynamics: 40 }
  },
  {
    id: 'builtin-strict-dynamics',
    name: '严格动力学',
    description: '转弯/爬升约束严格，曲率限速平滑，满足率优先',
    algo: 'hybridastar',
    builtin: true,
    planParams: {
      dynamics: {
        ...defaultPlanParams.dynamics,
        maxTurnAngle: 35,
        maxClimbAngle: 20,
        minTurnRadius: 90,
        maxAccel: 8,
        enforceInSearch: true,
        autoRepair: true
      }
    },
    weights: { distance: 1, threat: 25, altitude: 8, nofly: 60, smooth: 1.5, energy: 30, dynamics: 220 }
  },
  {
    id: 'builtin-urban-low',
    name: '城区低空',
    description: '小栅格精细避障，低高度巡航，高净空要求',
    algo: 'astar',
    builtin: true,
    planParams: {
      cellSize: 15,
      heightCell: 12,
      clearance: 8,
      cruiseAlt: 70,
      maxStep: 1
    },
    weights: { distance: 2, threat: 40, altitude: 12, nofly: 120, smooth: 0.4, energy: 25, dynamics: 60 }
  }
]

/** 应用预设到 planParams/weights（不替换引用，逐字段合并以便响应式） */
export function applyPreset(
  preset: ParamPreset,
  planParams: PlanParams,
  weights: CostWeights
): { algo?: AlgoType } {
  const pp = preset.planParams
  if (pp.cellSize !== undefined) planParams.cellSize = pp.cellSize
  if (pp.heightCell !== undefined) planParams.heightCell = pp.heightCell
  if (pp.maxNodes !== undefined) planParams.maxNodes = pp.maxNodes
  if (pp.maxStep !== undefined) planParams.maxStep = pp.maxStep
  if (pp.clearance !== undefined) planParams.clearance = pp.clearance
  if (pp.cruiseAlt !== undefined) planParams.cruiseAlt = pp.cruiseAlt
  if (pp.speedMin !== undefined) planParams.speedMin = pp.speedMin
  if (pp.speedMax !== undefined) planParams.speedMax = pp.speedMax
  if (pp.heuristicWeight !== undefined)
    planParams.heuristicWeight = pp.heuristicWeight
  if (pp.smoothIterations !== undefined)
    planParams.smoothIterations = pp.smoothIterations
  if (pp.dynamics) Object.assign(planParams.dynamics, pp.dynamics)
  if (pp.tuning) Object.assign(planParams.tuning, pp.tuning)

  if (preset.weights) {
    Object.assign(weights, preset.weights)
    // 补齐可能缺失的新增权重维度
    Object.assign(weights, {
      energy: weights.energy ?? defaultWeights.energy,
      dynamics: weights.dynamics ?? defaultWeights.dynamics
    })
  }
  return { algo: preset.algo }
}

export function loadCustomPresets(): ParamPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as ParamPreset[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function saveCustomPreset(preset: ParamPreset): ParamPreset[] {
  const list = loadCustomPresets().filter((p) => p.id !== preset.id)
  list.unshift({ ...preset, builtin: false })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  return list
}

export function deleteCustomPreset(id: string): ParamPreset[] {
  const list = loadCustomPresets().filter((p) => p.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  return list
}

export function allPresets(): ParamPreset[] {
  return [...BUILTIN_PRESETS, ...loadCustomPresets()]
}
