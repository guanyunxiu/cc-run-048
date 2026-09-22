// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('迭代三：多无人机编队 store', () => {
  it('默认生成 3 架无人机，可增删改', async () => {
    const { useFleetStore } = await import('@/stores/fleet')
    const fleet = useFleetStore()
    expect(fleet.tracks).toHaveLength(0)
    fleet.initDefault()
    expect(fleet.tracks).toHaveLength(3)
    expect(fleet.tracks.map((t) => t.algo)).toContain('astar')

    fleet.addTrack()
    expect(fleet.tracks).toHaveLength(4)
    const id = fleet.tracks[0].id
    fleet.updateTrack(id, { name: '长机-改' })
    expect(fleet.tracks[0].name).toBe('长机-改')
    fleet.setAlgo(id, 'ga')
    expect(fleet.tracks[0].algo).toBe('ga')
    fleet.removeTrack(id)
    expect(fleet.tracks).toHaveLength(3)
  })

  it('弧长比例采样返回合理位置', async () => {
    const { useFleetStore } = await import('@/stores/fleet')
    const fleet = useFleetStore()
    fleet.initDefault()
    const track = fleet.tracks[0]
    track.smoothPath = [
      { x: 0, y: 100, z: 0 },
      { x: 100, y: 100, z: 0 },
      { x: 200, y: 100, z: 0 }
    ]
    expect(fleet.sampleAtFraction(track, 0)).toEqual({ x: 0, y: 100, z: 0 })
    expect(fleet.sampleAtFraction(track, 1)).toEqual({ x: 200, y: 100, z: 0 })
    const mid = fleet.sampleAtFraction(track, 0.5)!
    expect(mid.x).toBeCloseTo(100, 5)
  })

  it('机间冲突检测记录近距离事件并按回放进度去重', async () => {
    const { useFleetStore } = await import('@/stores/fleet')
    const fleet = useFleetStore()
    fleet.initDefault()
    const [a, b] = fleet.tracks
    const near = (x: number) => [
      { id: a.id, pos: { x: 0, y: 100, z: 0 } },
      { id: b.id, pos: { x, y: 100, z: 0 } }
    ]
    fleet.detectConflicts(0, near(10), 30)
    expect(fleet.conflicts).toHaveLength(1)
    // 回放进度推进 < 5%：同一对不重复记录
    fleet.detectConflicts(0.02, near(12), 30)
    expect(fleet.conflicts).toHaveLength(1)
    // 推进 > 5% 后再次记录
    fleet.detectConflicts(0.1, near(8), 30)
    expect(fleet.conflicts).toHaveLength(2)
  })

  it('距离超过安全间隔不产生冲突', async () => {
    const { useFleetStore } = await import('@/stores/fleet')
    const fleet = useFleetStore()
    fleet.initDefault()
    const [a, b] = fleet.tracks
    fleet.detectConflicts(
      0,
      [
        { id: a.id, pos: { x: 0, y: 100, z: 0 } },
        { id: b.id, pos: { x: 100, y: 100, z: 0 } }
      ],
      30
    )
    expect(fleet.conflicts).toHaveLength(0)
  })
})

describe('迭代三：view store 能力与状态', () => {
  it('叠加层/传感器/性能开关可读写', async () => {
    const { useViewStore } = await import('@/stores/view')
    const view = useViewStore()
    expect(view.overlayMode).toBe('none')
    view.setOverlay('clearance')
    expect(view.overlayMode).toBe('clearance')
    view.setSensor({ showComm: true, commRange: 500 })
    expect(view.sensor.showComm).toBe(true)
    expect(view.sensor.commRange).toBe(500)
    view.setPerf({ chunkedTerrain: false })
    expect(view.perf.chunkedTerrain).toBe(false)
    const caps = view.detect()
    expect(typeof caps.webgpu).toBe('boolean')
    view.setFieldResult('webgpu', 3.2)
    expect(view.fieldBackend).toBe('webgpu')
    view.setCacheStats(0.5, 3)
    expect(view.cacheHitRate).toBe(0.5)
  })
})
