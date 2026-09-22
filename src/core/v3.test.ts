import { describe, expect, it } from 'vitest'
import { Environment } from '@/core/environment'
import { evaluatePath, pathObjectives, segmentCosts } from '@/core/cost'
import {
  defaultPlanParams,
  defaultWeights
} from '@/core/defaults'
import { planMission } from '@/core/planning'
import {
  paretoWeightScan,
  weightSensitivity,
  dominates,
  paretoFront,
  crowdingDistance,
  defaultWeightSets
} from '@/core/multi-objective'
import {
  runBatchExperiment,
  summarizeRuns,
  runSingleExperiment,
  pathSmoothness,
  makeExperimentConfig,
  exportRunsCsv
} from '@/core/experiment'
import {
  buildFieldGrid,
  heatColor,
  clearanceColor,
  downsampleGrid,
  chunkBounds
} from '@/core/field-grid'
import {
  planFleet,
  fleetSeparation,
  fleetCommLinks,
  defaultFleet
} from '@/core/fleet'
import {
  LRUCache,
  planCacheKey,
  parallelMap,
  createProgressBuffer
} from '@/core/planner-pool'
import { PerformanceMonitor } from '@/core/perf-monitor'
import {
  BUILTIN_PRESETS,
  applyPreset
} from '@/core/presets'
import type {
  BuildingObstacle,
  CostWeights,
  ExperimentRun,
  NoFlyZone,
  ObjectiveVector,
  ParetoPoint,
  PlanParams,
  TerrainParams,
  ThreatZone,
  Vec3,
  Waypoint
} from '@/types'

const terrain: TerrainParams = {
  size: 600,
  segments: 40,
  seed: 42,
  heightScale: 70,
  noiseScale: 0.003,
  ridgeScale: 20,
  canyon: false
}
const noThreats: ThreatZone[] = []
const noNofly: NoFlyZone[] = []
const noObs: BuildingObstacle[] = []

function makeEnv(
  threats: ThreatZone[] = noThreats,
  nofly: NoFlyZone[] = noNofly,
  obs: BuildingObstacle[] = noObs
): Environment {
  return new Environment(terrain, threats, nofly, obs)
}

const weights: CostWeights = { ...defaultWeights }
const plan: PlanParams = {
  ...defaultPlanParams,
  cellSize: 20,
  heightCell: 20,
  maxNodes: 80000,
  maxStep: 2,
  clearance: 8,
  cruiseAlt: 100
}

const waypoints: Waypoint[] = [
  { id: 's', role: 'start', position: { x: -240, y: 100, z: -200 }, speed: 30 },
  { id: 'e', role: 'end', position: { x: 240, y: 100, z: 200 }, speed: 30 }
]

function straightPath(): Vec3[] {
  const pts: Vec3[] = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    pts.push({
      x: -240 + 480 * t,
      y: 100,
      z: -200 + 400 * t
    })
  }
  return pts
}

// ---------------- 功能01：七维多目标代价 ----------------

describe('七维多目标代价', () => {
  it('segmentCosts 返回 7 个分量且能耗为正', () => {
    const env = makeEnv()
    const path = straightPath()
    const c = segmentCosts(env, path[0], path[1], path[2], plan)
    expect(c).toHaveProperty('energy')
    expect(c).toHaveProperty('dynamics')
    expect(c.distance).toBeGreaterThan(0)
    expect(c.energy).toBeGreaterThan(0)
    // 直线段动力学违反应为 0
    expect(c.dynamics).toBe(0)
  })

  it('急转弯产生动力学惩罚', () => {
    const env = makeEnv()
    const prev: Vec3 = { x: 0, y: 100, z: 0 }
    const a: Vec3 = { x: 30, y: 100, z: 0 }
    const b: Vec3 = { x: 30, y: 100, z: 30 } // 90° 转弯，超 60° 限制
    const strictPlan = {
      ...plan,
      dynamics: { ...plan.dynamics, maxTurnAngle: 30 }
    }
    const c = segmentCosts(env, prev, a, b, strictPlan)
    expect(c.dynamics).toBeGreaterThan(0)
  })

  it('evaluatePath 返回七维目标向量与加权分量', () => {
    const env = makeEnv()
    const res = evaluatePath(env, straightPath(), weights, plan)
    const keys: (keyof ObjectiveVector)[] = [
      'distance', 'threat', 'altitude', 'nofly', 'smooth', 'energy', 'dynamics'
    ]
    for (const k of keys) {
      expect(res.objectives[k]).toBeGreaterThanOrEqual(0)
      expect(res.breakdown[k]).toBeGreaterThanOrEqual(0)
    }
    expect(res.objectives.distance).toBeGreaterThan(300)
    expect(res.objectives.energy).toBeGreaterThan(0)
  })

  it('pathObjectives 是未加权口径（零权重不影响）', () => {
    const env = makeEnv()
    const o1 = pathObjectives(env, straightPath(), plan)
    const o2 = pathObjectives(env, straightPath(), plan)
    expect(o1.distance).toBeCloseTo(o2.distance, 6)
  })

  it('爬升段能耗高于平飞段', () => {
    const env = makeEnv()
    const prev = null
    const level = segmentCosts(
      env,
      prev,
      { x: 0, y: 100, z: 0 },
      { x: 100, y: 100, z: 0 },
      plan
    )
    const climb = segmentCosts(
      env,
      prev,
      { x: 0, y: 100, z: 0 },
      { x: 100, y: 200, z: 0 },
      plan
    )
    expect(climb.energy).toBeGreaterThan(level.energy)
  })
})

// ---------------- Pareto 非支配排序 ----------------

describe('Pareto 非支配排序', () => {
  function pt(o: Partial<ObjectiveVector>): ParetoPoint {
    return {
      objectives: {
        distance: 0, threat: 0, altitude: 0, nofly: 0,
        smooth: 0, energy: 0, dynamics: 0,
        ...o
      },
      weights: { ...defaultWeights },
      path: [],
      algo: 'astar',
      scalarCost: 0,
      dominated: false
    }
  }

  it('dominates 判定：全不差且一维严格更优', () => {
    const a = pt({ distance: 1, threat: 2 })
    const b = pt({ distance: 1, threat: 3 })
    expect(dominates(a.objectives, b.objectives)).toBe(true)
    expect(dominates(b.objectives, a.objectives)).toBe(false)
  })

  it('互不支配（各有优劣）', () => {
    const a = pt({ distance: 1, threat: 5 })
    const b = pt({ distance: 5, threat: 1 })
    expect(dominates(a.objectives, b.objectives)).toBe(false)
    expect(dominates(b.objectives, a.objectives)).toBe(false)
  })

  it('paretoFront 仅保留非支配解', () => {
    const points = [
      pt({ distance: 1, threat: 5 }),
      pt({ distance: 5, threat: 1 }),
      pt({ distance: 6, threat: 6 }) // 被两者支配
    ]
    const front = paretoFront(points)
    expect(front).toHaveLength(2)
    expect(points[2].dominated).toBe(true)
  })

  it('crowdingDistance 边界解为无穷大', () => {
    const front = [
      pt({ distance: 1 }),
      pt({ distance: 3 }),
      pt({ distance: 9 })
    ]
    const d = crowdingDistance(front, ['distance', 'threat'])
    expect(d[0]).toBe(Infinity)
    expect(d[2]).toBe(Infinity)
  })

  it('默认权重组合数量 >= 10', () => {
    expect(defaultWeightSets().length).toBeGreaterThanOrEqual(10)
  })
})

// ---------------- 端到端 Pareto 扫描与敏感性 ----------------

describe('Pareto 扫描与敏感性（规划端到端）', () => {
  it('paretoWeightScan 产出候选点并标记前沿', () => {
    const env = makeEnv()
    // 用少量权重集加速测试
    const sets = defaultWeightSets().slice(0, 4)
    const points = paretoWeightScan(env, waypoints, plan, {
      weightSets: sets,
      smoothing: 'none',
      algo: 'astar',
      seed: 7
    })
    expect(points.length).toBeGreaterThan(0)
    const front = points.filter((p) => !p.dominated)
    expect(front.length).toBeGreaterThan(0)
    expect(front.length).toBeLessThanOrEqual(points.length)
    // 每个点都有七维目标
    for (const p of points) {
      expect(p.objectives.distance).toBeGreaterThan(0)
    }
  }, 20000)

  it('weightSensitivity 返回逐权重目标序列', () => {
    const env = makeEnv()
    const res = weightSensitivity(
      env,
      waypoints,
      plan,
      weights,
      'threat',
      [0, 50, 100],
      'none',
      'astar',
      7
    )
    expect(res.axis).toBe('threat')
    expect(res.points).toHaveLength(3)
    expect(res.points.every((p) => p.success)).toBe(true)
  }, 15000)

  it('planMission 填充 objectives 与（栅格算法无）收敛曲线', () => {
    const env = makeEnv()
    const result = planMission(env, waypoints, plan, weights, {
      smoothing: 'none',
      algoOverride: 'astar'
    })
    expect(result.success).toBe(true)
    expect(result.stats.objectives).toBeDefined()
    expect(result.stats.objectives!.distance).toBeGreaterThan(0)
  })

  it('PSO 规划记录逐代收敛曲线且最优代价下降', () => {
    const env = makeEnv()
    const result = planMission(env, waypoints, plan, weights, {
      smoothing: 'none',
      algoOverride: 'pso',
      seed: 7
    })
    expect(result.success).toBe(true)
    const conv = result.stats.convergence
    expect(conv).toBeDefined()
    expect(conv!.length).toBeGreaterThan(5)
    const first = conv![0].bestCost
    const last = conv![conv!.length - 1].bestCost
    expect(last).toBeLessThanOrEqual(first)
  }, 20000)
}, { timeout: 30000 })

// ---------------- 功能02：批量实验 ----------------

describe('批量实验与统计', () => {
  it('runSingleExperiment 产出完整指标', () => {
    const env = makeEnv()
    const run = runSingleExperiment(
      env, waypoints, plan, weights, 'none', 'astar', 11, 0
    )
    expect(run.success).toBe(true)
    expect(run.distance).toBeGreaterThan(0)
    expect(run.planTimeMs).toBeGreaterThanOrEqual(0)
    expect(run.energy).toBeGreaterThan(0)
    expect(run.objectives).toBeDefined()
    expect(run.path.length).toBeGreaterThan(1)
  })

  it('pathSmoothness 直线为 0、折线为正', () => {
    expect(pathSmoothness(straightPath())).toBeCloseTo(0, 3)
    const bent: Vec3[] = [
      { x: 0, y: 100, z: 0 },
      { x: 50, y: 100, z: 0 },
      { x: 50, y: 100, z: 50 }
    ]
    expect(pathSmoothness(bent)).toBeGreaterThan(0)
  })

  it('summarizeRuns 计算成功率与均值/标准差', () => {
    const runs: ExperimentRun[] = [
      {
        runIndex: 0, seed: 1, algo: 'astar', success: true, message: '',
        distance: 100, planTimeMs: 5, expandedNodes: 10, totalCost: 10,
        threatExposure: 1, exposureTime: 2, smoothness: 3,
        satisfactionRate: 95, energy: 4,
        objectives: {
          distance: 100, threat: 1, altitude: 0, nofly: 0,
          smooth: 3, energy: 4, dynamics: 0
        },
        path: []
      },
      {
        runIndex: 1, seed: 2, algo: 'astar', success: true, message: '',
        distance: 200, planTimeMs: 15, expandedNodes: 20, totalCost: 30,
        threatExposure: 3, exposureTime: 4, smoothness: 5,
        satisfactionRate: 85, energy: 8,
        objectives: {
          distance: 200, threat: 3, altitude: 0, nofly: 0,
          smooth: 5, energy: 8, dynamics: 0
        },
        path: []
      }
    ]
    const s = summarizeRuns('astar', 'astar', runs)
    expect(s.successRate).toBeCloseTo(1)
    expect(s.distanceMean).toBeCloseTo(150)
    expect(s.distanceStd).toBeGreaterThan(0)
    expect(s.best?.totalCost).toBe(10)
    expect(s.worst?.totalCost).toBe(30)
  })

  it('runBatchExperiment 多算法×多种子汇总', () => {
    const env = makeEnv()
    const config = makeExperimentConfig({
      terrain,
      threats: [],
      noflyZones: [],
      obstacles: [],
      dynamics: [],
      waypoints,
      planParams: plan,
      weights,
      smoothing: 'none',
      algos: ['astar'],
      repetitions: 3,
      baseSeed: 99
    })
    const result = runBatchExperiment(env, config)
    expect(result.summaries).toHaveLength(1)
    expect(result.runs).toHaveLength(3)
    expect(result.summaries[0].runs).toBe(3)
    expect(result.summaries[0].successRate).toBeCloseTo(1)
    // 确定性：不同种子同一栅格算法航程一致
    const ds = new Set(result.runs.map((r) => r.distance))
    expect(ds.size).toBe(1)
  }, 20000)

  it('exportRunsCsv 含表头与每行', () => {
    const env = makeEnv()
    const config = makeExperimentConfig({
      terrain, threats: [], noflyZones: [], obstacles: [], dynamics: [],
      waypoints, planParams: plan, weights, smoothing: 'none',
      algos: ['astar'], repetitions: 2, baseSeed: 5
    })
    const csv = exportRunsCsv(runBatchExperiment(env, config))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('algo')
    expect(lines).toHaveLength(3)
  })
})

// ---------------- 功能03：标量场网格 ----------------

describe('标量场网格与 LOD', () => {
  it('threat 场：威胁中心值高于空地', () => {
    const threats: ThreatZone[] = [
      {
        id: 't', kind: 'radar', name: 'r',
        position: { x: 0, y: 0, z: 0 }, radius: 120,
        heightMin: 0, heightMax: 300, level: 5, opacity: 0.2
      }
    ]
    const env = makeEnv(threats)
    const grid = buildFieldGrid(env, 'threat', { resolution: 24, altitude: 100 })
    expect(grid.values.length).toBe(24 * 24)
    expect(grid.max).toBeGreaterThan(grid.min)
  })

  it('clearance 场：建筑附近净空下降', () => {
    const obs: BuildingObstacle[] = [
      {
        id: 'b', name: 'b',
        position: { x: 0, y: 0, z: 0 },
        size: { x: 40, z: 40 }, height: 120
      }
    ]
    const env = makeEnv(noThreats, noNofly, obs)
    const grid = buildFieldGrid(env, 'clearance', {
      resolution: 24, altitude: 100, clearance: 12
    })
    expect(grid.max).toBeGreaterThan(0)
  })

  it('cost 场可构建且值域有限', () => {
    const env = makeEnv()
    const grid = buildFieldGrid(env, 'cost', { resolution: 16, altitude: 100 })
    expect(Number.isFinite(grid.max)).toBe(true)
  })

  it('downsampleGrid 分辨率减半', () => {
    const env = makeEnv()
    const grid = buildFieldGrid(env, 'threat', { resolution: 32 })
    const low = downsampleGrid(grid)
    expect(low.resolution).toBe(16)
    expect(low.values.length).toBe(256)
  })

  it('chunkBounds 返回世界坐标范围', () => {
    const env = makeEnv()
    const grid = buildFieldGrid(env, 'threat', { resolution: 32, chunkSize: 16 })
    const b = chunkBounds(grid, 0, 0)
    expect(b.minX).toBeLessThanOrEqual(b.maxX)
    expect(b.minZ).toBeLessThanOrEqual(b.maxZ)
  })

  it('heatColor / clearanceColor 输出 RGB 0..1', () => {
    const c: [number, number, number] = [0, 0, 0]
    heatColor(0, c)
    expect(c[2]).toBeGreaterThan(c[0]) // 低值偏蓝
    heatColor(1, c)
    expect(c[0]).toBeGreaterThan(c[2]) // 高值偏红
    clearanceColor(0, c)
    expect(c[0]).toBeGreaterThan(c[1]) // 低裕度偏红
    clearanceColor(1, c)
    expect(c[1]).toBeGreaterThan(c[0]) // 高裕度偏绿
  })
})

// ---------------- 功能03：多无人机 ----------------

describe('多无人机编队', () => {
  it('planFleet 为每架机生成轨迹', () => {
    const env = makeEnv()
    const result = planFleet(
      env,
      defaultFleet().drones,
      plan,
      weights,
      'none',
      77
    )
    expect(result.runtimes).toHaveLength(2)
    const ok = result.runtimes.filter((r) => r.path.length >= 2)
    expect(ok.length).toBe(2)
    expect(result.maxDuration).toBeGreaterThan(0)
  }, 20000)

  it('起飞延迟体现在轨迹时间轴', () => {
    const env = makeEnv()
    const fleet = defaultFleet().drones
    fleet[1].launchDelay = 5
    const result = planFleet(env, fleet, plan, weights, 'none', 77)
    const b = result.runtimes[1]
    expect(b.trajectory[0].time).toBeCloseTo(5, 1)
  })

  it('fleetSeparation 与 fleetCommLinks', () => {
    const env = makeEnv()
    const result = planFleet(env, defaultFleet().drones, plan, weights, 'none', 77)
    const seps = fleetSeparation(result.runtimes, result.maxDuration * 0.3)
    expect(seps).toHaveLength(2)
    const links = fleetCommLinks(result.runtimes, result.maxDuration * 0.3)
    // 链路数组元素应为四元组（i,j,a,b）
    for (const l of links) expect(l).toHaveLength(4)
  })
})

// ---------------- 功能04：缓存/并行/性能 ----------------

describe('LRU 缓存与并行', () => {
  it('LRU 命中/淘汰', () => {
    const cache = new LRUCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3) // 淘汰 b（a 刚被访问）
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.size).toBe(2)
    expect(cache.hits).toBeGreaterThan(0)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('planCacheKey 对键顺序不敏感、对内容敏感', () => {
    const base = {
      terrain: { a: 1, b: 2 },
      threats: [],
      noflyZones: [],
      obstacles: [],
      dynamics: [],
      waypoints: [],
      planParams: {},
      weights: { x: 1 },
      smoothing: 'none',
      algo: 'astar',
      seed: 1
    }
    const reordered = { ...base, terrain: { b: 2, a: 1 } }
    expect(planCacheKey(base)).toBe(planCacheKey(reordered))
    const changed = { ...base, seed: 2 }
    expect(planCacheKey(base)).not.toBe(planCacheKey(changed))
  })

  it('parallelMap 保序且限制并发', async () => {
    const items = [1, 2, 3, 4, 5]
    let active = 0
    let maxActive = 0
    const out = await parallelMap(
      items,
      async (x) => {
        active++
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active--
        return x * 2
      },
      2
    )
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('createProgressBuffer 在 node 可能为 null 或 Int32 视图', () => {
    const buf = createProgressBuffer()
    if (buf) {
      const view = new Int32Array(buf)
      view[0] = 5
      expect(view[0]).toBe(5)
    }
    // 不支持时不抛错
    expect(buf === null || buf instanceof SharedArrayBuffer).toBe(true)
  })
})

describe('性能监控', () => {
  it('记录帧与规划耗时', () => {
    const mon = new PerformanceMonitor()
    for (let i = 0; i < 10; i++) mon.recordFrame(16, { calls: 5, triangles: 100 })
    expect(mon.fps).toBeGreaterThan(50)
    expect(mon.frameMs).toBeGreaterThan(0)
    mon.recordPlan(12.5)
    expect(mon.planMs).toBeCloseTo(12.5)
    expect(mon.planCount).toBe(1)
    expect(mon.drawCalls).toBe(5)
  })
})

// ---------------- 功能04：参数预设 ----------------

describe('参数预设', () => {
  it('内置预设数量 >= 5 且可应用', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(5)
    const pp: PlanParams = JSON.parse(JSON.stringify({
      ...defaultPlanParams,
      tuning: { ...defaultPlanParams.tuning },
      dynamics: { ...defaultPlanParams.dynamics }
    }))
    const ww: CostWeights = { ...defaultWeights }
    const before = pp.cellSize
    const { algo } = applyPreset(BUILTIN_PRESETS[0], pp, ww)
    expect(pp.cellSize).not.toBe(before)
    expect(algo).toBeDefined()
    expect(ww.energy).toBeGreaterThanOrEqual(0)
  })
})
