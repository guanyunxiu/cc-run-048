import type { Vec3 } from '@/types'
import type { PathPlanner, PlannerContext, PlannerOutput } from '@/core/planners/types'
import { buildCorridor, decode, feasibleChainDP, fitness, hillClimbRepair, isFeasible } from '@/core/planners/corridor'

/**
 * 蚁群算法（ACO）三维航迹规划（功能01）。
 * “城市”模型：每一切片是一个站点，候选点是可选项；
 * 蚂蚁按 信息素^alpha × 启发^beta 概率逐切片选点，
 * 每代结束后信息素挥发并按路径质量沉积。
 */
export class ACOPlanner implements PathPlanner {
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

    // 启发信息：候选点离障碍越远、威胁越低越好
    const eta: number[][] = []
    for (let i = 0; i < N; i++) {
      eta[i] = model.optionsPerSlice[i].map((p) => {
        const threat = env.threatIntensity(p) + env.noflyPenalty(p) * 0.05
        return 1 / (1 + threat * 4)
      })
    }
    const tau: number[][] = Array.from({ length: N }, () =>
      new Array<number>(M).fill(1)
    )

    const ants = tu.antCount
    const iters = tu.acoIterations
    const alpha = tu.acoAlpha
    const beta = tu.acoBeta
    const rho = tu.acoEvap
    const Q = tu.acoQ

    let best: { choices: number[]; cost: number } | null = null
    let expanded = 0
    const convergence: PlannerOutput['convergence'] = []

    for (let it = 0; it < iters; it++) {
      const deposits: { choices: number[]; amount: number[] }[] = []
      let genBest = Infinity
      let genSum = 0
      for (let a = 0; a < ants; a++) {
        const choices = new Array<number>(N)
        for (let i = 0; i < N; i++) {
          const w = new Array<number>(M)
          let sum = 0
          for (let j = 0; j < M; j++) {
            w[j] = Math.pow(tau[i][j], alpha) * Math.pow(eta[i][j], beta)
            sum += w[j]
          }
          choices[i] = sum > 0 ? rng.weightedIndex(w) : rng.int(0, M - 1)
        }
        const path = decode(start, goal, model, choices)
        const cost = fitness(env, path, plan, weights)
        expanded++
        if (cost < genBest) genBest = cost
        genSum += cost
        if (!best || cost < best.cost) best = { choices: [...choices], cost }
        deposits.push({
          choices,
          amount: new Array(N).fill(Q / Math.max(cost, 1))
        })
      }

      if (it === 0 || it === iters - 1 || it % Math.max(1, Math.floor(iters / 40)) === 0) {
        convergence.push({
          iteration: it,
          bestCost: genBest,
          meanCost: genSum / ants,
          bestSoFar: best ? best.cost : genBest
        })
      }

      // 挥发
      for (let i = 0; i < N; i++)
        for (let j = 0; j < M; j++) tau[i][j] *= 1 - rho

      // 沉积
      for (const d of deposits) {
        for (let i = 0; i < N; i++) {
          tau[i][d.choices[i]] += d.amount[i]
        }
      }
    }

    if (!best) {
      return { success: false, path: [], expandedNodes: 0, message: '蚁群算法异常' }
    }
    const repaired = hillClimbRepair(
      env,
      model,
      start,
      goal,
      best.choices,
      plan,
      weights
    )
    const repairCost = fitness(env, decode(start, goal, model, repaired), plan, weights)
    if (repairCost < best.cost) best = { choices: repaired, cost: repairCost }
    // 分层 DP：若走廊存在可行链，给出精确最优的可行解
    const dpChoices = feasibleChainDP(env, model, start, goal, plan, weights)
    let finalChoices = best.choices
    if (dpChoices) {
      const dpCost = fitness(env, decode(start, goal, model, dpChoices), plan, weights)
      if (dpCost <= best.cost) finalChoices = dpChoices
    }
    const path = decode(start, goal, model, finalChoices)
    const feasible = isFeasible(env, path, plan)
    return {
      success: feasible,
      path,
      expandedNodes: expanded,
      convergence,
      message: feasible
        ? `蚁群规划成功（${iters} 代 × ${ants} 蚁）`
        : '蚁群最优解仍存在碰撞，请放宽走廊或调整权重'
    }
  }
}
