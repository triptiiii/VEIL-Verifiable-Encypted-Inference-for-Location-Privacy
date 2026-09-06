import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const CATEGORY_HEX = {
  hospital:   0xf87171,
  restaurant: 0xfb923c,
  pharmacy:   0x4ade80,
  cafe:       0xfacc15,
  default:    0x94a3b8,
}

/**
 * Projects lat/lng to local XZ plane (metres from user origin).
 * Uses equirectangular projection (fine for city-scale).
 */
function latLngToXZ(lat, lng, originLat, originLng) {
  const R = 6_371_000
  const x = (lng - originLng) * (Math.PI / 180) * R * Math.cos(originLat * Math.PI / 180)
  const z = -(lat - originLat) * (Math.PI / 180) * R
  return { x, z }
}

export default function ThreeScene({ userLocation, results, dataset }) {
  const mountRef = useRef(null)
  const sceneRef = useRef(null)
  const animFrameRef = useRef(null)

  useEffect(() => {
    const W = mountRef.current.clientWidth
    const H = mountRef.current.clientHeight

    // ── Renderer ─────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x05080f, 1)
    renderer.shadowMap.enabled = true
    mountRef.current.appendChild(renderer.domElement)

    // ── Scene ─────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x05080f, 0.0008)

    // ── Camera ────────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(55, W / H, 1, 20000)
    camera.position.set(0, 600, 900)
    camera.lookAt(0, 0, 0)

    // ── Lighting ─────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x112233, 1.5))
    const dirLight = new THREE.DirectionalLight(0x00c6ff, 1.2)
    dirLight.position.set(500, 1000, 500)
    scene.add(dirLight)

    // ── Ground grid ──────────────────────────────────────────────────────────
    const gridHelper = new THREE.GridHelper(4000, 40, 0x1a2840, 0x0d1a2e)
    scene.add(gridHelper)

    // ── User position ────────────────────────────────────────────────────────
    const userGeo = new THREE.CylinderGeometry(0, 12, 40, 6)
    const userMat = new THREE.MeshStandardMaterial({
      color: 0x00c6ff,
      emissive: 0x00c6ff,
      emissiveIntensity: 0.8,
      metalness: 0.5,
      roughness: 0.2,
    })
    const userMesh = new THREE.Mesh(userGeo, userMat)
    userMesh.position.y = 20
    scene.add(userMesh)

    // Pulse ring around user
    const ringGeo = new THREE.RingGeometry(18, 22, 32)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00c6ff, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 1
    scene.add(ring)

    // User label plane
    const canvas2d = document.createElement('canvas')
    canvas2d.width = 200; canvas2d.height = 60
    const ctx = canvas2d.getContext('2d')
    ctx.fillStyle = 'rgba(0,198,255,0.9)'
    ctx.font = 'bold 20px Inter'
    ctx.fillText('You', 10, 40)
    const labelTex = new THREE.CanvasTexture(canvas2d)
    const labelPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 24),
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false })
    )
    labelPlane.position.set(0, 60, 0)
    labelPlane.rotation.x = -0.3
    scene.add(labelPlane)

    // ── POI markers ──────────────────────────────────────────────────────────
    const poiObjects = []
    const connectors = []

    // Background (non-result) dataset POIs — small dots
    const originLat = userLocation.latitude
    const originLng = userLocation.longitude
    const bgPOIs = dataset.filter(p => !results.find(r => r.id === p.id)).slice(0, 200)

    bgPOIs.forEach(poi => {
      const { x, z } = latLngToXZ(poi.latitude, poi.longitude, originLat, originLng)
      const clampX = Math.max(-2000, Math.min(2000, x))
      const clampZ = Math.max(-2000, Math.min(2000, z))
      const color = CATEGORY_HEX[poi.category] || CATEGORY_HEX.default

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(4, 6, 6),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.1, transparent: true, opacity: 0.25 })
      )
      dot.position.set(clampX, 4, clampZ)
      scene.add(dot)
    })

    // Result POIs — prominent markers
    results.forEach((poi, idx) => {
      const { x, z } = latLngToXZ(poi.latitude, poi.longitude, originLat, originLng)
      const clampX = Math.max(-2000, Math.min(2000, x))
      const clampZ = Math.max(-2000, Math.min(2000, z))
      const color = CATEGORY_HEX[poi.category] || CATEGORY_HEX.default

      // Column pillar
      const dist = poi.distMetres || 100
      const pillarH = Math.max(30, 300 - idx * 40)

      const pillarGeo = new THREE.CylinderGeometry(3, 3, pillarH, 8)
      const pillarMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.4,
      })
      const pillar = new THREE.Mesh(pillarGeo, pillarMat)
      pillar.position.set(clampX, pillarH / 2, clampZ)
      scene.add(pillar)

      // Floating sphere on top
      const sphereR = Math.max(12, 30 - idx * 3)
      const sphereGeo = new THREE.SphereGeometry(sphereR, 16, 16)
      const sphereMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.6,
        metalness: 0.4,
        roughness: 0.3,
        transparent: true,
        opacity: 0.9,
      })
      const sphere = new THREE.Mesh(sphereGeo, sphereMat)
      sphere.position.set(clampX, pillarH + sphereR + 10, clampZ)
      scene.add(sphere)

      // Point light at sphere
      const light = new THREE.PointLight(color, 0.8, 300)
      light.position.copy(sphere.position)
      scene.add(light)

      // Rank label above sphere
      const labelCanvas = document.createElement('canvas')
      labelCanvas.width = 256; labelCanvas.height = 120
      const lctx = labelCanvas.getContext('2d')
      lctx.fillStyle = `rgba(5,8,15,0.85)`
      lctx.roundRect(4, 4, 248, 112, 12)
      lctx.fill()
      lctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`
      lctx.lineWidth = 2
      lctx.roundRect(4, 4, 248, 112, 12)
      lctx.stroke()
      lctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
      lctx.font = 'bold 28px Inter'
      lctx.fillText(`#${idx + 1} ${poi.name?.slice(0, 14)}`, 12, 40)
      lctx.fillStyle = 'rgba(200,216,239,0.7)'
      lctx.font = '18px Inter'
      lctx.fillText(poi.category, 12, 66)
      if (poi.distMetres) {
        lctx.fillStyle = '#00c6ff'
        lctx.font = '16px monospace'
        lctx.fillText(`${poi.distMetres >= 1000 ? (poi.distMetres/1000).toFixed(1)+'km' : poi.distMetres+'m'}`, 12, 90)
      }
      const labelTexture = new THREE.CanvasTexture(labelCanvas)
      const labelMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(128, 60),
        new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide })
      )
      labelMesh.position.set(clampX, pillarH + sphereR * 2 + 50, clampZ)
      scene.add(labelMesh)

      // Connector line from user (0,0) to POI
      const points = [new THREE.Vector3(0, 5, 0), new THREE.Vector3(clampX, 5, clampZ)]
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points)
      const lineMat = new THREE.LineBasicMaterial({ color, opacity: 0.2, transparent: true })
      const line = new THREE.Line(lineGeo, lineMat)
      scene.add(line)

      poiObjects.push({ sphere, labelMesh, baseY: pillarH + sphereR + 10, light, idx })
      connectors.push(line)
    })

    sceneRef.current = { scene, camera, renderer, poiObjects, ring }

    // ── Orbit controls (manual) ─────────────────────────────────────────────
    let isDragging = false
    let prevMouse = { x: 0, y: 0 }
    let theta = 0, phi = Math.PI / 4
    const R = 1100

    const toCartesian = (th, ph) => ({
      x: R * Math.sin(ph) * Math.sin(th),
      y: R * Math.cos(ph),
      z: R * Math.sin(ph) * Math.cos(th),
    })

    renderer.domElement.addEventListener('mousedown', e => { isDragging = true; prevMouse = { x: e.clientX, y: e.clientY } })
    renderer.domElement.addEventListener('mouseup', () => { isDragging = false })
    renderer.domElement.addEventListener('mousemove', e => {
      if (!isDragging) return
      const dx = e.clientX - prevMouse.x
      const dy = e.clientY - prevMouse.y
      theta -= dx * 0.005
      phi = Math.max(0.3, Math.min(Math.PI / 2.2, phi + dy * 0.005))
      prevMouse = { x: e.clientX, y: e.clientY }
      const pos = toCartesian(theta, phi)
      camera.position.set(pos.x, pos.y, pos.z)
      camera.lookAt(0, 50, 0)
    })
    renderer.domElement.addEventListener('wheel', e => {
      camera.position.multiplyScalar(1 + e.deltaY * 0.001)
    })

    // ── Animation loop ────────────────────────────────────────────────────────
    let frame = 0
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate)
      frame++

      // Auto-rotate slowly
      if (!isDragging) {
        theta += 0.003
        const pos = toCartesian(theta, phi)
        camera.position.set(pos.x, pos.y, pos.z)
        camera.lookAt(0, 50, 0)
      }

      // Float spheres
      poiObjects.forEach(({ sphere, labelMesh, baseY, idx }) => {
        const t = frame * 0.02 + idx * 1.2
        sphere.position.y = baseY + Math.sin(t) * 12
        if (labelMesh) labelMesh.position.y = sphere.position.y + 50
        labelMesh?.lookAt(camera.position)
      })

      // Pulse ring
      const scale = 1 + Math.sin(frame * 0.04) * 0.15
      ring.scale.set(scale, scale, scale)
      ring.material.opacity = 0.3 + Math.sin(frame * 0.04) * 0.2

      // Make labels always face camera
      poiObjects.forEach(({ labelMesh }) => {
        if (labelMesh) labelMesh.lookAt(camera.position)
      })
      if (labelPlane) labelPlane.lookAt(camera.position)

      renderer.render(scene, camera)
    }
    animate()

    // ── Resize ────────────────────────────────────────────────────────────────
    const onResize = () => {
      const w = mountRef.current?.clientWidth || W
      const h = mountRef.current?.clientHeight || H
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      window.removeEventListener('resize', onResize)

      // FIX (Bug 6, known-issue list): every effect re-run previously created
      // a brand-new renderer/scene/geometries/materials/canvas-textures but
      // only disposed the renderer itself — the rest leaked GPU + canvas
      // memory on every query. Walk the scene graph and dispose everything
      // explicitly before tearing down the renderer.
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
          materials.forEach((mat) => {
            if (mat.map) mat.map.dispose() // disposes CanvasTexture instances (labels)
            mat.dispose()
          })
        }
      })
      renderer.dispose()
      renderer.forceContextLoss?.()
      if (mountRef.current?.contains(renderer.domElement)) {
        mountRef.current.removeChild(renderer.domElement)
      }
    }
  }, [userLocation, results, dataset])

  return (
    <div ref={mountRef} className="w-full h-full relative bg-veil-bg">
      {results.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-veil-muted">
            <div className="text-4xl mb-3 opacity-30">◈</div>
            <div className="text-sm font-mono">Run a query to see 3D markers</div>
          </div>
        </div>
      )}
      {/* Overlay HUD */}
      <div className="absolute top-4 right-4 text-xs font-mono text-veil-muted space-y-1 pointer-events-none">
        <div>Drag to orbit · Scroll to zoom</div>
        <div className="text-veil-accent">{results.length} POI{results.length !== 1 ? 's' : ''} rendered</div>
      </div>
    </div>
  )
}
