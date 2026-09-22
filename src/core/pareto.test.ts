import { describe, expect, it } from 'vitest'
import { Environment } from '@/core/environment'
import {
  dominates,
  nonDominatedSort,
  paretoFront,
  scanWeightedPareto,
  weightSensitivity
} from '@/core/pareto'
import { segmentEnergy, segmentDynamicsPenalty, evaluatePath, pathObjectives } from '@/core/cost'
import { planMission } from '@/core/planning'
import type {
  BuildingObstacle,
  CostWeights,
  NoFlyZone,
  ObjectiveVector,
  ParetoPoint,
  PlanParams,
  TerrainParams,
  ThreatZone,
  Vec3,
  Waypoint
} from '@/types'
import { defaultPlanParams, defaultWeights } from '@/core/defaults'

const terrain: TerrainParams = {
  size: 600,
  segments: 48,
  seed: 42,
  heightScale: 80,
  noiseScale: 0.003,
  ridgeScale: 30,
  canyon: false
}
const noThreats: ThreatZone[] = []
const noNofly: NoFlyZone[] = []
const noObs: BuildingObstacle[] = []
const plan: PlanParams = {
  ...defaultPlanParams,
  cellSize: 20,
  heightCell: 20,
  maxNodes: 120000,
  clearance: 8,
  cruiseAlt: 100
}
const weights: CostWeights = { ...defaultWeights }
const wps: Waypoint[] = [
  { id: 's', role: 'start', position: { x: -240, y: 100, z: -200 }, speed: 30 },
  { id: 'e', role: 'end', position: { x: 240, y: 100, z: 200 }, speed: 30 }
]

function obj(over: Partial<ObjectiveVector>): ObjectiveVector {
  return {
    distance: 0, threat: 0, altitude: 0, nofly: 0, smooth: 0, energy: 0, dynamics: 0,
    ...over
  }
}

describe('迭代三：能耗与动力学代价', () => {
  it('平飞能耗为正，爬升比平飞耗能更高', () => {
    const a: Vec3 = { x: 0, y: 100, z: 0 }
    const b: Vec3 = { x: 100, y: 100, z: 0 }
    const c: Vec3 = { x: 100, y: 160, z: 0 }
    const level = segmentEnergy(a, b, plan)
    const climb = segmentEnergy(a, c, plan)
    expect(level).toBeGreaterThan(0)
    expect(climb).toBeGreaterThan(level)
  })

  it('转角越限产生动力学惩罚，无越限为 0', () => {
    const a: Vec3 = { x: 0, y: 100, z: 0 }
    const b: Vec3 = { x: 0, y: 100, z: 40 }
    const gentle: Vec3 = { x: 10, y: 100, z: 78 }
    expect(segmentDynamicsPenalty(a, b, gentle, plan)).toBe(0)
    const sharp: Vec3 = { x: Math.sin((120 * Math.PI) / 180) * 40, y: 100, z: 40 }
    expect(segmentDynamicsPenalty(a, b, sharp, plan)).toBeGreaterThan(0)
  })

  it('evaluatePath 返回 7 维目标向量（含能耗/动力学）', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    const path: Vec3[] = [
      { x: -240, y: 100, z: -200 },
      { x: 0, y: 110, z: 0 },
      { x: 240, y: 100, z: 200 }
    ]
    const res = evaluatePath(env, path, weights, plan)
    expect(res.objectives.distance).toBeGreaterThan(0)
    expect(res.objectives.energy).toBeGreaterThan(0)
    expect(res.breakdown.energy).toBeGreaterThan(0)
    expect(Object.keys(res.objectives).sort()).toEqual(
      ['altitude', 'distance', 'dynamics', 'energy', 'nofly', 'smooth', 'threat'].sort()
    )
    const objs = pathObjectives(env, path, plan)
    expect(objs.energy).toBeCloseTo(res.objectives.energy, 5)
  })
})

describe('迭代三：Pareto 非支配排序', () => {
  function pt(o: ObjectiveVector, algo = 'astar' as const): ParetoPoint {
    return {
      objectives: o,
      weights: { ...weights },
      weightedCost: 0,
      algo,
      success: true
    }
  }

  it('支配关系判定正确（越小越优）', () => {
    expect(dominates(obj({ distance: 1, threat: 1 }), obj({ distance: 2, threat: 2 }))).toBe(true)
    expect(dominates(obj({ distance: 1, threat: 2 }), obj({ distance: 2, threat: 1 }))).toBe(false)
    expect(dominates(obj({ distance: 1, threat: 1 }), obj({ distance: 1, threat: 1 }))).toBe(false)
  })

  it('非支配排序给出层级与拥挤距离', () => {
    const points = [
      pt(obj({ distance: 1, threat: 3 })),
      pt(obj({ distance: 2, threat: 2 })),
      pt(obj({ distance: 3, threat: 1 })),
      pt(obj({ distance: 3, threat: 3 })) // 被前三者支配
    ]
    const sorted = nonDominatedSort(points)
    expect(sorted.filter((p) => p.rank === 0)).toHaveLength(3)
    expect(sorted[3].rank).toBeGreaterThan(0)
    // 端点拥挤距离为无穷
    const front = sorted.filter((p) => p.rank === 0)
    expect(front.some((p) => p.crowdingDistance === Infinity)).toBe(true)
  })

  it('paretoFront 仅返回第一前沿', () => {
    const points = [
      pt(obj({ distance: 1, threat: 3 })),
      pt(obj({ distance: 3, threat: 1 })),
      pt(obj({ distance: 3, threat: 3 }))
    ]
    expect(paretoFront(points)).toHaveLength(2)
  })
})

describe('迭代三：权重扫描 Pareto 与敏感性', () => {
  it('扫描多组权重得到非空前沿（含威胁场景，权重影响绕飞）', () => {
    const threats: ThreatZone[] = [
      {
        id: 't', kind: 'radar', name: 'r',
        position: { x: 20, y: 0, z: 10 },
        radius: 130, heightMin: 0, heightMax: 300,
        level: 5, opacity: 0.2
      }
    ]
    const env = new Environment(terrain, threats, noNofly, noObs)
    const { front, all } = scanWeightedPareto(
      env, wps, plan, weights, 'astar', 'polyline', { samples: 12, seed: 7 }
    )
    expect(all.length).toBeGreaterThan(1)
    expect(front.length).toBeGreaterThanOrEqual(1)
    for (const p of front) expect(p.rank).toBe(0)
    // 不同权重应产生不同航程/威胁目标值（扫描有多样性）
    const distances = new Set(all.map((p) => p.objectives.distance.toFixed(1)))
    expect(distances.size).toBeGreaterThan(1)
  }, 30000)

  it('权重敏感性：威胁权重升高时威胁暴露不增加', () => {
    const threats: ThreatZone[] = [
      {
        id: 't', kind: 'radar', name: 'r',
        position: { x: 20, y: 0, z: 10 },
        radius: 120, heightMin: 0, heightMax: 300,
        level: 5, opacity: 0.2
      }
    ]
    const env = new Environment(terrain, threats, noNofly, noObs)
    const sens = weightSensitivity(
      env, wps, plan, weights, 'astar', 'polyline', 'threat', 5, 0, 4, 7
    )
    expect(sens).toHaveLength(5)
    const first = sens[0].objectives.threat
    const last = sens[sens.length - 1].objectives.threat
    expect(last).toBeLessThanOrEqual(first + 1e-6)
    // 权重值应单调递增
    for (let i = 1; i < sens.length; i++) {
      expect(sens[i].weight).toBeGreaterThan(sens[i - 1].weight)
    }
  }, 30000)
})

describe('迭代三：规划结果含能耗/平滑度/收敛', () => {
  it('PSO 规划结果携带收敛曲线', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    const r = planMission(env, wps, plan, weights, {
      smoothing: 'polyline', algoOverride: 'pso', seed: 7
    })
    expect(r.success).toBe(true)
    expect(r.stats.energyKJ).toBeGreaterThan(0)
    expect(r.stats.smoothness).toBeGreaterThanOrEqual(0)
    expect(r.stats.convergence).toBeDefined()
    expect(r.stats.convergence!.length).toBeGreaterThan(1)
    // bestSoFar 单调不增
    for (let i = 1; i < r.stats.convergence!.length; i++) {
      expect(r.stats.convergence![i].bestSoFar).toBeLessThanOrEqual(
        r.stats.convergence![i - 1].bestSoFar + 1e-6
      )
    }
  }, 30000)

  it('A* 无收敛曲线（确定性图搜索）但目标向量完整', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    const r = planMission(env, wps, plan, weights, { smoothing: 'polyline', seed: 7 })
    expect(r.success).toBe(true)
    expect(r.stats.convergence).toBeUndefined()
    expect(r.stats.objectives).toBeDefined()
    expect(r.stats.objectives!.energy).toBeGreaterThan(0)
  })
})
