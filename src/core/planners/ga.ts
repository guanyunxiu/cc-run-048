import type { Vec3 } from '@/types'
import type { PathPlanner, PlannerContext, PlannerOutput } from '@/core/planners/types'
import { buildCorridor, decode, feasibleChainDP, fitness, hillClimbRepair, isFeasible } from '@/core/planners/corridor'

/**
 * 遗传算法（GA）三维航迹规划（功能01）。
 * 染色体 = 各切片候选点索引；锦标赛选择、单点交叉、均匀变异、精英保留。
 */
export class GAPlanner implements PathPlanner {
  private ctx: PlannerContext
  constructor(ctx: PlannerContext) {
    this.ctx = ctx
  }

  plan(start: Vec3, goal: Vec3): PlannerOutput {
    const { env, plan, weights, rng } = this.ctx
    const tu = plan.tuning
    const model = buildCorridor(start, goal, env, plan, rng)
    const N = model.N
    const M = model.optionsPerSlice[0].length

    type Chrom = number[]
    const pop: { c: Chrom; cost: number }[] = []
    const randomChrom = (): Chrom =>
      Array.from({ length: N }, () => rng.int(0, M - 1))
    const evalChrom = (c: Chrom) =>
      fitness(env, decode(start, goal, model, c), plan, weights)

    for (let i = 0; i < tu.gaPopulation; i++) {
      const c = randomChrom()
      pop.push({ c, cost: evalChrom(c) })
    }

    let expanded = pop.length
    const convergence: import('@/types').ConvergencePoint[] = []
    const elite = Math.max(2, Math.floor(tu.gaPopulation * 0.1))
    const tournament = (): Chrom => {
      const a = pop[rng.int(0, pop.length - 1)]
      const b = pop[rng.int(0, pop.length - 1)]
      return (a.cost <= b.cost ? a : b).c
    }

    for (let it = 0; it < tu.gaIterations; it++) {
      pop.sort((u, v) => u.cost - v.cost)
      convergence.push({
        iteration: it + 1,
        bestCost: pop[0].cost,
        avgCost: pop.reduce((s, p) => s + p.cost, 0) / pop.length
      })
      const { onProgress } = this.ctx
      onProgress?.(it + 1, tu.gaIterations, pop[0].cost)
      const next: { c: Chrom; cost: number }[] = pop
        .slice(0, elite)
        .map((e) => ({ c: [...e.c], cost: e.cost }))

      while (next.length < tu.gaPopulation) {
        const p1 = [...tournament()]
        const p2 = [...tournament()]
        let child = p1
        if (rng.next() < tu.gaCrossover) {
          const cut = rng.int(1, N - 1)
          child = [...p1.slice(0, cut), ...p2.slice(cut)]
        }
        for (let d = 0; d < N; d++) {
          if (rng.next() < tu.gaMutation) child[d] = rng.int(0, M - 1)
        }
        next.push({ c: child, cost: evalChrom(child) })
        expanded++
      }
      pop.length = 0
      pop.push(...next)
    }

    pop.sort((u, v) => u.cost - v.cost)
    const repaired = hillClimbRepair(
      env,
      model,
      start,
      goal,
      pop[0].c,
      plan,
      weights
    )
    const repairCost = fitness(env, decode(start, goal, model, repaired), plan, weights)
    let bestC = repairCost < pop[0].cost ? repaired : pop[0].c
    const dpChoices = feasibleChainDP(env, model, start, goal, plan, weights)
    if (dpChoices) {
      const dpCost = fitness(env, decode(start, goal, model, dpChoices), plan, weights)
      const curCost = fitness(env, decode(start, goal, model, bestC), plan, weights)
      if (dpCost <= curCost) bestC = dpChoices
    }
    const path = decode(start, goal, model, bestC)
    const feasible = isFeasible(env, path, plan)
    return {
      success: feasible,
      path,
      expandedNodes: expanded,
      convergence,
      message: feasible
        ? `遗传算法规划成功（${tu.gaIterations} 代 × ${tu.gaPopulation} 个体）`
        : '遗传算法最优解仍存在碰撞，请放宽走廊或调整权重'
    }
  }
}
