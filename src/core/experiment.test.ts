import { describe, expect, it } from 'vitest'
import { Environment } from '@/core/environment'
import {
  aggregateRuns,
  buildExperimentConfig,
  buildExperimentReport,
  reportToCsv,
  runBatchExperiment,
  runsToCsv
} from '@/core/experiment'
import { PlanCache, planCacheKey } from '@/core/plan-cache'
import type {
  BuildingObstacle,
  ExperimentRun,
  NoFlyZone,
  PlanParams,
  TerrainParams,
  ThreatZone
} from '@/types'
import { defaultPlanParams, defaultWeights } from '@/core/defaults'

const terrain: TerrainParams = {
  size: 600, segments: 48, seed: 42, heightScale: 80,
  noiseScale: 0.003, ridgeScale: 30, canyon: false
}
const noThreats: ThreatZone[] = []
const noNofly: NoFlyZone[] = []
const noObs: BuildingObstacle[] = []
const plan: PlanParams = {
  ...defaultPlanParams, cellSize: 20, heightCell: 20,
  maxNodes: 120000, clearance: 8, cruiseAlt: 100
}
const wps = [
  { id: 's', role: 'start' as const, position: { x: -240, y: 100, z: -200 }, speed: 30 },
  { id: 'e', role: 'end' as const, position: { x: 240, y: 100, z: 200 }, speed: 30 }
]

describe('迭代三：批量实验', () => {
  it('多算法 × 多种子运行并聚合统计', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    let progressCalls = 0
    const { runs, aggregates } = runBatchExperiment(
      env, wps, plan, defaultWeights, 'polyline',
      ['astar', 'rrt'], 3, 20260920,
      { onProgress: () => progressCalls++ }
    )
    expect(runs).toHaveLength(6)
    expect(progressCalls).toBe(6)
    expect(aggregates.astar).toBeDefined()
    expect(aggregates.rrt).toBeDefined()
    expect(aggregates.astar!.runs).toBe(3)
    expect(aggregates.astar!.successRate).toBe(100)
    expect(aggregates.astar!.distance.mean).toBeGreaterThan(0)
    expect(aggregates.astar!.distance.std).toBeGreaterThanOrEqual(0)
    // 不同种子不同 runIndex/seed
    const seeds = new Set(runs.map((r) => r.seed))
    expect(seeds.size).toBe(3)
  }, 30000)

  it('取消令牌提前终止', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    let cancelAfter = 2
    const { runs } = runBatchExperiment(
      env, wps, plan, defaultWeights, 'polyline',
      ['astar', 'rrt', 'pso'], 5, 1,
      { shouldCancel: () => --cancelAfter < 0 }
    )
    expect(runs.length).toBeLessThan(15)
  }, 30000)

  it('聚合统计均值/标准差正确', () => {
    const runs: ExperimentRun[] = [
      mkRun(100, 10),
      mkRun(200, 20),
      mkRun(300, 30)
    ]
    const agg = aggregateRuns(runs)!
    expect(agg.distance.mean).toBe(200)
    expect(agg.distance.std).toBe(100)
    expect(agg.distance.min).toBe(100)
    expect(agg.distance.max).toBe(300)
    expect(agg.successRate).toBe(100)
  })

  it('报告可导出 JSON/CSV（聚合 + 明细）', () => {
    const env = new Environment(terrain, noThreats, noNofly, noObs)
    const { runs, aggregates } = runBatchExperiment(
      env, wps, plan, defaultWeights, 'polyline', ['astar'], 2, 1
    )
    const config = buildExperimentConfig(
      terrain, noThreats, noNofly, noObs, [], wps as never,
      plan, defaultWeights, 'polyline', ['astar'], 2, 1, 't'
    )
    const report = buildExperimentReport(config, runs, aggregates)
    expect(report.version).toBe('3.0.0')
    expect(() => JSON.stringify(report)).not.toThrow()
    const aggCsv = reportToCsv(report)
    expect(aggCsv).toContain('algo')
    expect(aggCsv).toContain('astar')
    const runsCsv = runsToCsv(report)
    expect(runsCsv.split('\n')).toHaveLength(3) // 表头 + 2 行
  }, 20000)
})

function mkRun(distance: number, planTimeMs: number): ExperimentRun {
  return {
    runIndex: 0, seed: 1, algo: 'astar', success: true, message: '',
    distance, planTimeMs, expandedNodes: 1, totalCost: distance,
    threatExposure: 0, exposureTime: 0, satisfactionRate: 100,
    obstacleAvoidanceRate: 100, smoothness: 0, energyKJ: 10, maxCurvature: 0,
    objectives: {
      distance, threat: 0, altitude: 0, nofly: 0, smooth: 0, energy: 10, dynamics: 0
    }
  }
}

describe('迭代三：规划缓存', () => {
  it('LRU 容量淘汰与命中统计', () => {
    const cache = new PlanCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3) // b 最久未用被淘汰
    expect(cache.has('b')).toBe(false)
    expect(cache.size).toBe(2)
    expect(cache.stats.hits).toBe(1)
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.stats.misses).toBe(1)
    expect(cache.stats.hitRate).toBeCloseTo(0.5, 5)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('planCacheKey 对字段顺序不敏感', () => {
    const a = { x: 1, y: { a: 1, b: 2 } }
    const b = { y: { b: 2, a: 1 }, x: 1 }
    expect(planCacheKey(a)).toBe(planCacheKey(b))
    const c = { x: 1, y: { a: 1, b: 3 } }
    expect(planCacheKey(a)).not.toBe(planCacheKey(c))
  })
})
