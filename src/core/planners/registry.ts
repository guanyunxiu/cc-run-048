import type { AlgoType, Vec3 } from '@/types'
import { GridPlanner } from '@/core/planner'
import { Random, setGlobalSeed } from '@/core/rng'
import type {
  PathPlanner,
  PlannerContext,
  PlannerOutput
} from '@/core/planners/types'
import { RRTPlanner } from '@/core/planners/rrt'
import { HybridAStarPlanner } from '@/core/planners/hybrid-astar'
import { ACOPlanner } from '@/core/planners/aco'
import { PSOPlanner } from '@/core/planners/pso'
import { GAPlanner } from '@/core/planners/ga'

/** A星/Dijkstra 适配器：复用迭代一的体素栅格搜索，统一 Planner 接口 */
class GridPlannerAdapter implements PathPlanner {
  constructor(private ctx: PlannerContext) {}
  plan(start: Vec3, goal: Vec3): PlannerOutput {
    const p = new GridPlanner(this.ctx.env, this.ctx.plan, this.ctx.weights)
    return p.plan(start, goal)
  }
}

export const ALGO_LABELS: Record<AlgoType, string> = {
  astar: 'A* 栅格搜索',
  dijkstra: 'Dijkstra',
  rrt: 'RRT 快速扩展随机树',
  rrtstar: 'RRT* 渐近最优',
  hybridastar: 'Hybrid A* 运动基元',
  aco: '蚁群算法 ACO',
  pso: '粒子群 PSO',
  ga: '遗传算法 GA'
}

export const ALGO_DESC: Record<AlgoType, string> = {
  astar: '体素 26 邻域 + 长步长，启发式全局最优，速度快',
  dijkstra: '无启发广度优先，保证栅格最优但扩展更多',
  rrt: '随机采样树，适合高维/开阔空间，结果有随机性',
  rrtstar: 'RRT + 邻域重连，采样预算越大路径越优',
  hybridastar: '航向离散 + 运动基元，天然满足转弯/爬升约束',
  aco: '信息素正反馈的群体智能，走廊式选路',
  pso: '粒子群速度-位置迭代，参数少、收敛快',
  ga: '选择/交叉/变异进化，适合多目标权衡'
}

/** 规划策略工厂：模块化、可插拔（功能01） */
export function createPlanner(
  algo: AlgoType,
  ctx: PlannerContext,
  seed?: number
): PathPlanner {
  if (seed !== undefined) setGlobalSeed(seed)
  const rng = ctx.rng ?? new Random(seed ?? 20260920)
  const fullCtx: PlannerContext = { ...ctx, rng }
  switch (algo) {
    case 'astar':
    case 'dijkstra':
      return new GridPlannerAdapter(fullCtx)
    case 'rrt':
      return new RRTPlanner(fullCtx, false)
    case 'rrtstar':
      return new RRTPlanner(fullCtx, true)
    case 'hybridastar':
      return new HybridAStarPlanner(fullCtx)
    case 'aco':
      return new ACOPlanner(fullCtx)
    case 'pso':
      return new PSOPlanner(fullCtx)
    case 'ga':
      return new GAPlanner(fullCtx)
    default:
      return new GridPlannerAdapter(fullCtx)
  }
}
