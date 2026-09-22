import type {
  AlgoPreset,
  BuildingObstacle,
  CostWeights,
  DynamicsParams,
  NoFlyZone,
  PerfSettings,
  PlanParams,
  ReplanTriggers,
  TerrainParams,
  ThreatZone,
  UavSensor,
  Waypoint
} from '@/types'

export const defaultTerrain: TerrainParams = {
  size: 1000,
  segments: 128,
  seed: 20260920,
  heightScale: 140,
  noiseScale: 0.0022,
  ridgeScale: 70,
  canyon: true
}

export const defaultDynamics: DynamicsParams = {
  enforceInSearch: true,
  maxTurnAngle: 60,
  maxClimbAngle: 35,
  minStep: 8,
  maxAccel: 12,
  minTurnRadius: 40,
  maxAttitudeRate: 45,
  autoRepair: true
}

export const defaultAlgoTuning: PlanParams['tuning'] = {
  rrtStep: 45,
  goalBias: 0.12,
  rewireRadius: 90,
  maxSamples: 4000,
  motionPrims: 3,
  antCount: 24,
  acoIterations: 40,
  acoAlpha: 1,
  acoBeta: 4,
  acoEvap: 0.35,
  acoQ: 80,
  psoParticles: 28,
  psoIterations: 60,
  psoInertia: 0.72,
  psoC1: 1.5,
  psoC2: 1.5,
  psoCorridor: 160,
  gaPopulation: 40,
  gaIterations: 50,
  gaCrossover: 0.8,
  gaMutation: 0.12
}

export const defaultEnergyParams: PlanParams['energy'] = {
  mass: 12,
  gravity: 9.81,
  dragCoeff: 0.022,
  inducedFactor: 28,
  climbEfficiency: 0.78
}

export const defaultPlanParams: PlanParams = {
  algo: 'astar',
  cellSize: 25,
  heightCell: 20,
  maxNodes: 200000,
  maxStep: 2,
  clearance: 12,
  cruiseAlt: 120,
  speedMin: 15,
  speedMax: 60,
  heuristicWeight: 1.0,
  smoothIterations: 8,
  dynamics: { ...defaultDynamics },
  tuning: { ...defaultAlgoTuning },
  energy: { ...defaultEnergyParams }
}

export const defaultWeights: CostWeights = {
  distance: 1,
  threat: 25,
  altitude: 8,
  nofly: 60,
  smooth: 0.15,
  energy: 1.5,
  dynamics: 3
}

/** 迭代三：默认单机传感器/通信参数 */
export const defaultSensor: UavSensor = {
  sensorRange: 120,
  detectionRange: 220,
  commRange: 400,
  showSensor: false,
  showDetection: false,
  showComm: false
}

/** 迭代三：工程性能默认配置 */
export const defaultPerfSettings: PerfSettings = {
  chunkedTerrain: true,
  frustumCulling: true,
  instancedBuildings: true,
  planCache: true,
  webgpuField: false,
  workerPool: true
}

export const defaultReplanTriggers: ReplanTriggers = {
  enabled: true,
  onThreatApproach: true,
  onCollisionRisk: true,
  onYawDeviation: false,
  onRangeAnomaly: false,
  lookaheadTime: 6,
  warnDistance: 120,
  yawThreshold: 35,
  rangeThreshold: 0.35,
  windowRadius: 260
}

let seq = 0
export const uid = (prefix = 'id'): string =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export function defaultThreats(): ThreatZone[] {
  return [
    {
      id: uid('thr'),
      kind: 'radar',
      name: '雷达-01',
      position: { x: 60, y: 0, z: 40 },
      radius: 110,
      heightMin: 0,
      heightMax: 160,
      level: 4,
      opacity: 0.22
    },
    {
      id: uid('thr'),
      kind: 'sam',
      name: '防空-01',
      position: { x: -140, y: 0, z: -90 },
      radius: 90,
      heightMin: 20,
      heightMax: 220,
      level: 5,
      opacity: 0.28
    },
    {
      id: uid('thr'),
      kind: 'jammer',
      name: '干扰-01',
      position: { x: 180, y: 0, z: -160 },
      radius: 80,
      heightMin: 0,
      heightMax: 120,
      level: 2,
      opacity: 0.2
    }
  ]
}

export function defaultNoFlyZones(): NoFlyZone[] {
  return [
    {
      id: uid('nfz'),
      name: '禁飞区-城区',
      position: { x: -40, y: 0, z: 150 },
      radius: 70,
      heightMin: 0,
      heightMax: 300,
      penalty: 10,
      hardBlock: true
    }
  ]
}

export function defaultObstacles(): BuildingObstacle[] {
  return [
    {
      id: uid('obs'),
      name: '建筑-A',
      position: { x: 240, y: 0, z: 120 },
      size: { x: 36, z: 36 },
      height: 55
    },
    {
      id: uid('obs'),
      name: '建筑-B',
      position: { x: 285, y: 0, z: 80 },
      size: { x: 24, z: 40 },
      height: 40
    }
  ]
}

/** 迭代二默认动态实体：一个高空横穿航线的移动障碍 + 一个中途出现的突发威胁 */
export function defaultDynamicEntities() {
  return [
    {
      id: uid('dyn'),
      name: '移动障碍-空中横穿',
      kind: 'obstacle' as const,
      motion: 'linear' as const,
      position: { x: -400, y: 120, z: -58 },
      target: { x: 0, y: 120, z: -58 },
      patrolPoints: [
        { x: -400, y: 120, z: -58 },
        { x: 0, y: 120, z: -58 }
      ],
      speed: 16,
      radius: 20,
      threatRadius: 60,
      heightMin: 0,
      heightMax: 160,
      level: 4,
      predictHorizon: 8,
      enableAt: 0,
      disableAt: Infinity,
      active: true,
      color: '#ff8f1f'
    },
    {
      id: uid('dyn'),
      name: '突发威胁-临时防空',
      kind: 'threat' as const,
      motion: 'static' as const,
      position: { x: 120, y: 0, z: 120 },
      target: { x: 120, y: 0, z: 120 },
      patrolPoints: [],
      speed: 0,
      radius: 20,
      threatRadius: 95,
      heightMin: 20,
      heightMax: 240,
      level: 5,
      predictHorizon: 8,
      enableAt: 9,
      disableAt: Infinity,
      active: true,
      color: '#ff2d55'
    }
  ]
}

export function defaultWaypoints(): Waypoint[] {
  return [
    {
      id: uid('wp'),
      role: 'start',
      position: { x: -420, y: 120, z: -320 },
      speed: 30
    },
    {
      id: uid('wp'),
      role: 'via',
      position: { x: -150, y: 130, z: 80 },
      speed: 30
    },
    {
      id: uid('wp'),
      role: 'end',
      position: { x: 420, y: 110, z: 300 },
      speed: 30
    }
  ]
}

/** 迭代三：算法参数预设（热插拔/参数预设，功能04） */
export const ALGO_PRESETS: AlgoPreset[] = [
  {
    id: 'rrt-fast',
    name: 'RRT 快速',
    description: '大步长、低采样上限，优先规划速度',
    algo: 'rrt',
    tuning: { rrtStep: 70, goalBias: 0.2, maxSamples: 2000 }
  },
  {
    id: 'rrtstar-quality',
    name: 'RRT* 高质量',
    description: '大重连半径与高采样预算，追求渐近最优',
    algo: 'rrtstar',
    tuning: { rrtStep: 40, goalBias: 0.1, rewireRadius: 150, maxSamples: 9000 }
  },
  {
    id: 'aco-exploit',
    name: 'ACO 强利用',
    description: '高 β 低挥发，快速收敛到低威胁走廊',
    algo: 'aco',
    tuning: { antCount: 30, acoIterations: 60, acoAlpha: 1, acoBeta: 6, acoEvap: 0.2 }
  },
  {
    id: 'pso-balanced',
    name: 'PSO 平衡',
    description: '标准惯性与学习因子，通用性强',
    algo: 'pso',
    tuning: { psoParticles: 32, psoIterations: 80, psoInertia: 0.72, psoC1: 1.5, psoC2: 1.5 }
  },
  {
    id: 'ga-diverse',
    name: 'GA 多样',
    description: '高变异低交叉，维持种群多样性，适合多目标',
    algo: 'ga',
    tuning: { gaPopulation: 60, gaIterations: 80, gaCrossover: 0.7, gaMutation: 0.25 }
  },
  {
    id: 'weights-stealth',
    name: '权重：隐身优先',
    description: '威胁/禁飞权重拉满，航程次要',
    algo: 'astar',
    tuning: {},
    weights: { distance: 0.6, threat: 90, altitude: 6, nofly: 160, smooth: 0.1, energy: 1, dynamics: 2 }
  },
  {
    id: 'weights-endurance',
    name: '权重：续航优先',
    description: '能耗与航程权重为主，平滑低空',
    algo: 'astar',
    tuning: {},
    weights: { distance: 1.4, threat: 12, altitude: 4, nofly: 40, smooth: 0.2, energy: 5, dynamics: 2 }
  },
  {
    id: 'weights-agile',
    name: '权重：机动优先',
    description: '动力学/平滑权重为主，轨迹更易跟踪',
    algo: 'hybridastar',
    tuning: { motionPrims: 5 },
    weights: { distance: 0.8, threat: 20, altitude: 4, nofly: 50, smooth: 0.6, energy: 1, dynamics: 12 }
  }
]
