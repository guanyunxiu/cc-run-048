import type { Vec3 } from '@/types'
import type { TrajectorySample } from './smoothing'

/**
 * 轨迹跟踪仿真（功能04）：
 * 二阶被控模型（含时间常数 tau、阻尼），沿参考轨迹做速度向量跟踪，
 * 输出实际位置/姿态与横向、航向、速度、高度跟踪误差。
 * 用于“轨迹跟踪误差与姿态可视化”。
 */
export interface TrackingState {
  pos: Vec3
  vel: Vec3
  yaw: number
  /** 横向误差（水平偏离参考点，米） */
  lateralError: number
  /** 高度误差（米） */
  altitudeError: number
  /** 航向误差（度） */
  yawError: number
  /** 速度误差（m/s） */
  speedError: number
}

export interface TrackingConfig {
  /** 位置环时间常数（秒），越小跟得越紧 */
  tau: number
  /** 初始位置偏移（模拟投放偏差） */
  initialOffset: Vec3
}

export const DEFAULT_TRACKING: TrackingConfig = {
  tau: 0.6,
  initialOffset: { x: 0, y: 0, z: 0 }
}

export function initTracking(ref0: TrajectorySample, cfg: TrackingConfig): TrackingState {
  const pos = {
    x: ref0.position.x + cfg.initialOffset.x,
    y: ref0.position.y + cfg.initialOffset.y,
    z: ref0.position.z + cfg.initialOffset.z
  }
  return {
    pos,
    vel: { ...ref0.velocity },
    yaw: Math.atan2(ref0.velocity.x, ref0.velocity.z),
    lateralError: Math.hypot(cfg.initialOffset.x, cfg.initialOffset.z),
    altitudeError: cfg.initialOffset.y,
    yawError: 0,
    speedError: 0
  }
}

/** 推进一个仿真步长 */
export function stepTracking(
  state: TrackingState,
  ref: TrajectorySample,
  dt: number,
  cfg: TrackingConfig
): TrackingState {
  // 一阶速度指令跟踪 + 位置反馈（简化二阶）
  const k = 1 / Math.max(cfg.tau, 0.1)
  const ax = (ref.velocity.x - state.vel.x) * k
  const ay = (ref.velocity.y - state.vel.y) * k
  const az = (ref.velocity.z - state.vel.z) * k

  const vel: Vec3 = {
    x: state.vel.x + ax * dt,
    y: state.vel.y + ay * dt,
    z: state.vel.z + az * dt
  }
  const pos: Vec3 = {
    x: state.pos.x + vel.x * dt,
    y: state.pos.y + vel.y * dt,
    z: state.pos.z + vel.z * dt
  }

  const yaw =
    Math.hypot(vel.x, vel.z) > 0.5
      ? Math.atan2(vel.x, vel.z)
      : state.yaw
  const refYaw = Math.atan2(ref.velocity.x, ref.velocity.z)
  let yawErr = (yaw - refYaw) * (180 / Math.PI)
  while (yawErr > 180) yawErr -= 360
  while (yawErr < -180) yawErr += 360

  return {
    pos,
    vel,
    yaw,
    lateralError: Math.hypot(
      pos.x - ref.position.x,
      pos.z - ref.position.z
    ),
    altitudeError: pos.y - ref.position.y,
    yawError: yawErr,
    speedError: Math.hypot(vel.x, vel.y, vel.z) - ref.speed
  }
}

export interface TrackingSummary {
  rmsLateral: number
  rmsAltitude: number
  rmsYaw: number
  rmsSpeed: number
  maxLateral: number
  samples: number
}

/** 离线整段跟踪仿真，汇总 RMS / 峰值误差 */
export function simulateTracking(
  traj: TrajectorySample[],
  cfg: TrackingConfig = DEFAULT_TRACKING
): { states: TrackingState[]; summary: TrackingSummary } {
  if (traj.length < 2) {
    return {
      states: [],
      summary: { rmsLateral: 0, rmsAltitude: 0, rmsYaw: 0, rmsSpeed: 0, maxLateral: 0, samples: 0 }
    }
  }
  let state = initTracking(traj[0], cfg)
  const states: TrackingState[] = [state]
  let sumLat2 = 0
  let sumAlt2 = 0
  let sumYaw2 = 0
  let sumSpd2 = 0
  let maxLat = 0
  for (let i = 1; i < traj.length; i++) {
    const dt = Math.max(traj[i].time - traj[i - 1].time, 0.001)
    state = stepTracking(state, traj[i], dt, cfg)
    states.push(state)
    sumLat2 += state.lateralError ** 2
    sumAlt2 += state.altitudeError ** 2
    sumYaw2 += state.yawError ** 2
    sumSpd2 += state.speedError ** 2
    if (state.lateralError > maxLat) maxLat = state.lateralError
  }
  const n = states.length
  const rms = (s: number) => Math.round(Math.sqrt(s / n) * 100) / 100
  return {
    states,
    summary: {
      rmsLateral: rms(sumLat2),
      rmsAltitude: rms(sumAlt2),
      rmsYaw: rms(sumYaw2),
      rmsSpeed: rms(sumSpd2),
      maxLateral: Math.round(maxLat * 100) / 100,
      samples: n
    }
  }
}
