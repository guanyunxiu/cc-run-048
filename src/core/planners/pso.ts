import type { Vec3 } from '@/types'
import type { PathPlanner, PlannerContext, PlannerOutput } from '@/core/planners/types'
import { buildCorridor, decode, feasibleChainDP, fitness, hillClimbRepair, isFeasible } from '@/core/planners/corridor'

/**
 * 粒子群算法（PSO）三维航迹规划（功能01）。
 * 粒子位置 = 各切片候选点的连续索引（取整解码），
 * 速度受惯性/自我/社会三因子驱动，迭代收敛到低代价走廊。
 */
export class PSOPlanner implements PathPlanner {
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
    const maxPos = M - 1
    const vMax = maxPos * 0.35

    interface Particle {
      x: number[]
      v: number[]
      pbest: number[]
      pbestCost: number
      cost: number
    }

    const particles: Particle[] = []
    for (let i = 0; i < tu.psoParticles; i++) {
      const x = Array.from({ length: N }, () => rng.range(0, maxPos))
      const v = Array.from({ length: N }, () => rng.range(-vMax, vMax))
      particles.push({
        x,
        v,
        pbest: [...x],
        pbestCost: Infinity,
        cost: Infinity
      })
    }
    let gbest: number[] = [...particles[0].x]
    let gbestCost = Infinity

    let expanded = 0
    const convergence: import('@/types').ConvergencePoint[] = []
    for (let it = 0; it < tu.psoIterations; it++) {
      let genCostSum = 0
      for (const p of particles) {
        const path = decode(start, goal, model, p.x)
        p.cost = fitness(env, path, plan, weights)
        genCostSum += p.cost
        expanded++
        if (p.cost < p.pbestCost) {
          p.pbestCost = p.cost
          p.pbest = [...p.x]
        }
        if (p.cost < gbestCost) {
          gbestCost = p.cost
          gbest = [...p.x]
        }
      }
      convergence.push({
        iteration: it + 1,
        bestCost: gbestCost === Infinity ? 0 : gbestCost,
        avgCost: genCostSum / particles.length
      })
      this.ctx.onProgress?.(it + 1, tu.psoIterations, gbestCost)
      for (const p of particles) {
        for (let d = 0; d < N; d++) {
          const r1 = rng.next()
          const r2 = rng.next()
          p.v[d] =
            tu.psoInertia * p.v[d] +
            tu.psoC1 * r1 * (p.pbest[d] - p.x[d]) +
            tu.psoC2 * r2 * (gbest[d] - p.x[d])
          p.v[d] = Math.max(-vMax, Math.min(vMax, p.v[d]))
          p.x[d] = Math.max(0, Math.min(maxPos, p.x[d] + p.v[d]))
        }
      }
    }

    const repaired = hillClimbRepair(
      env,
      model,
      start,
      goal,
      gbest.map((v) => Math.round(v)),
      plan,
      weights
    )
    const repairedCost = fitness(
      env,
      decode(start, goal, model, repaired),
      plan,
      weights
    )
    let finalChoices = gbest.map((v) => Math.round(v))
    if (repairedCost < gbestCost) finalChoices = repaired
    const dpChoices = feasibleChainDP(env, model, start, goal, plan, weights)
    if (dpChoices) {
      const dpCost = fitness(env, decode(start, goal, model, dpChoices), plan, weights)
      const curCost = fitness(env, decode(start, goal, model, finalChoices), plan, weights)
      if (dpCost <= curCost) finalChoices = dpChoices
    }
    const path = decode(start, goal, model, finalChoices)
    const feasible = isFeasible(env, path, plan)
    return {
      success: feasible,
      path,
      expandedNodes: expanded,
      convergence,
      message: feasible
        ? `粒子群规划成功（${tu.psoIterations} 代 × ${tu.psoParticles} 粒子）`
        : '粒子群最优解仍存在碰撞，请放宽走廊或调整权重'
    }
  }
}
