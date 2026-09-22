// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

beforeEach(() => {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  setActivePinia(createPinia())
})

describe('场景配置导出 / 导入', () => {
  it('序列化包含全部要素，导入后 store 状态一致', async () => {
    const { useSceneStore } = await import('@/stores/scene')
    const scene = useSceneStore()

    const exported = scene.serialize({
      rawPath: null,
      smoothPath: null,
      trajectory: null,
      stats: null
    })
    expect(exported.version).toBeTruthy()
    expect(exported.terrain.size).toBe(scene.terrain.size)
    expect(exported.threats.length).toBe(scene.threats.length)
    expect(exported.noflyZones.length).toBe(scene.noflyZones.length)
    expect(exported.waypoints.length).toBe(scene.waypoints.length)
    expect(exported.planParams.algo).toBe('astar')
    // 可安全 JSON 序列化（无函数/循环引用）
    expect(() => JSON.stringify(exported)).not.toThrow()

    // 修改再导入，验证恢复
    scene.threats = []
    scene.terrain.size = 1600
    scene.loadScene(exported)
    expect(scene.threats.length).toBe(exported.threats.length)
    expect(scene.terrain.size).toBe(exported.terrain.size)
  })

  it('编辑操作：增删改威胁/禁飞/建筑/航点', async () => {
    const { useSceneStore } = await import('@/stores/scene')
    const scene = useSceneStore()
    const n0 = scene.threats.length
    const id = scene.addThreatAt({ x: 1, y: 0, z: 2 }, 'jammer')
    expect(scene.threats.length).toBe(n0 + 1)
    scene.updateThreat(id, { radius: 123, level: 5 })
    expect(scene.threats.find((t) => t.id === id)!.radius).toBe(123)
    scene.select(id)
    scene.removeSelected()
    expect(scene.threats.some((t) => t.id === id)).toBe(false)

    const nfId = scene.addNoFlyAt({ x: 0, y: 0, z: 0 })
    expect(scene.noflyZones.some((z) => z.id === nfId)).toBe(true)
    scene.removeNoFly(nfId)

    const viaCount0 = scene.waypoints.filter((w) => w.role === 'via').length
    scene.addWaypointAt({ x: 0, y: 100, z: 0 })
    expect(scene.waypoints.filter((w) => w.role === 'via').length).toBe(
      viaCount0 + 1
    )

    const obsId = scene.addObstacleAt({ x: 5, y: 0, z: 5 })
    scene.updateObstacle(obsId, { height: 88 })
    expect(scene.obstacles.find((o) => o.id === obsId)!.height).toBe(88)

    // 起点/终点不允许通过 removeWaypoint 删除
    const start = scene.waypoints.find((w) => w.role === 'start')!
    const before = scene.waypoints.length
    scene.removeWaypoint(start.id)
    expect(scene.waypoints.length).toBe(before)
  })
})
