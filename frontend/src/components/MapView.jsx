import { useEffect, useRef, useMemo } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const CATEGORY_COLORS = {
  hospital:   '#f87171',
  restaurant: '#fb923c',
  pharmacy:   '#4ade80',
  cafe:       '#facc15',
  default:    '#94a3b8',
}

const CATEGORY_ICONS = {
  hospital: '🏥', restaurant: '🍽️', pharmacy: '💊', cafe: '☕',
}

function formatDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`
}

export default function MapView({ userLocation, dataset, results, categories, loading, selectedId, onSelectResult }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef([])
  const resultMarkersRef = useRef([])
  const resultMarkerByIdRef = useRef(new Map()) // poi.id -> { marker, buildIcon(selected) }
  const userMarkerRef = useRef(null)
  const circleRef = useRef(null)

  // ── Initialise Leaflet map ─────────────────────────────────────────────────
  useEffect(() => {
    if (mapInstanceRef.current) return

    const map = L.map(mapRef.current, {
      center: [userLocation.latitude, userLocation.longitude],
      zoom: 14,
      zoomControl: true,
      attributionControl: false,
    })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map)

    mapInstanceRef.current = map
    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [])

  // ── Update user location marker ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    if (userMarkerRef.current) userMarkerRef.current.remove()
    if (circleRef.current) circleRef.current.remove()

    const userIcon = L.divIcon({
      className: '',
      html: `
        <div style="
          width:20px;height:20px;
          background:rgba(0,198,255,0.9);
          border:3px solid white;
          border-radius:50%;
          box-shadow:0 0 0 6px rgba(0,198,255,0.2),0 0 20px rgba(0,198,255,0.5);
          position:relative;
        ">
          <div style="
            position:absolute;inset:-6px;
            border-radius:50%;
            border:2px solid rgba(0,198,255,0.4);
            animation:ping 2s cubic-bezier(0,0,0.2,1) infinite;
          "></div>
        </div>
        <style>@keyframes ping{75%,100%{transform:scale(2);opacity:0}}</style>
      `,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    })

    userMarkerRef.current = L.marker(
      [userLocation.latitude, userLocation.longitude],
      { icon: userIcon, zIndexOffset: 1000 }
    ).addTo(map)
      .bindPopup(`<b style="color:#00c6ff">Your Location</b><br><span style="font-family:monospace;font-size:11px">${userLocation.latitude.toFixed(5)}, ${userLocation.longitude.toFixed(5)}</span>`)

    map.setView([userLocation.latitude, userLocation.longitude], 14)
  }, [userLocation])

  // ── Update dataset markers ─────────────────────────────────────────────────
  // FIX (Bug 7, known-issue list): this previously depended on [dataset, results],
  // so every query re-run (results changing) destroyed and rebuilt up to 400
  // background markers even though the dataset itself hadn't changed. It now
  // depends on [dataset] only. Result POIs are drawn as separate, higher-
  // z-index markers in the effect below regardless, so a dim background dot
  // may sit under a result pin — a minor visual overlap, not a duplicate
  // marker, and far cheaper than rebuilding the whole layer on every search.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    markersRef.current.forEach(m => m.remove())
    markersRef.current = []

    dataset
      .slice(0, 400) // performance cap
      .forEach(poi => {
        const color = CATEGORY_COLORS[poi.category] || CATEGORY_COLORS.default
        const icon = L.divIcon({
          className: '',
          html: `<div style="
            width:8px;height:8px;
            background:${color};
            border-radius:50%;
            opacity:0.5;
            border:1px solid ${color};
          "></div>`,
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        })
        const m = L.marker([poi.latitude, poi.longitude], { icon })
          .addTo(map)
          .bindPopup(`
            <div style="font-family:monospace;font-size:12px">
              <b style="font-family:Inter;font-size:13px">${poi.name}</b><br>
              <span style="color:#94a3b8">${poi.category}</span>
            </div>
          `)
        markersRef.current.push(m)
      })
  }, [dataset])

  // ── Update result markers ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    resultMarkersRef.current.forEach(m => m.remove())
    resultMarkersRef.current = []
    resultMarkerByIdRef.current.clear()

    results.forEach((poi, idx) => {
      const color = CATEGORY_COLORS[poi.category] || CATEGORY_COLORS.default
      const icon = CATEGORY_ICONS[poi.category] || '📍'
      const baseSize = Math.max(32, 44 - idx * 2)

      // Factored out so the selection-sync effect below can rebuild just
      // this one marker's icon (selected = larger, brighter ring) without
      // touching any other marker or re-running this whole rebuild effect.
      const buildIcon = (isSelected) => {
        const size = isSelected ? baseSize + 10 : baseSize
        return L.divIcon({
          className: '',
          html: `
            <div style="
              width:${size}px;height:${size}px;
              background:${color}${isSelected ? '44' : '22'};
              border:${isSelected ? 3 : 2}px solid ${color};
              border-radius:50% 50% 50% 0;
              transform:rotate(-45deg);
              display:flex;align-items:center;justify-content:center;
              box-shadow:0 0 ${isSelected ? 22 : 12}px ${color}${isSelected ? 'aa' : '66'};
              position:relative;
            ">
              <div style="transform:rotate(45deg);font-size:${size * 0.4}px">${icon}</div>
              <div style="
                position:absolute;
                top:-8px;right:-8px;
                width:18px;height:18px;
                background:#0b1120;
                border:1px solid ${color};
                border-radius:50%;
                font-size:10px;
                color:${color};
                display:flex;align-items:center;justify-content:center;
                font-family:monospace;font-weight:bold;
                transform:rotate(45deg);
              ">${idx + 1}</div>
            </div>
          `,
          iconSize: [size, size],
          iconAnchor: [size / 4, size],
        })
      }

      const m = L.marker([poi.latitude, poi.longitude], { icon: buildIcon(false), zIndexOffset: 500 - idx })
        .addTo(map)
        .bindPopup(`
          <div style="font-family:Inter;min-width:180px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
              <span style="
                background:${color}22;border:1px solid ${color};
                color:${color};border-radius:50%;width:22px;height:22px;
                display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700
              ">${idx + 1}</span>
              <b style="font-size:13px">${poi.name}</b>
            </div>
            <div style="font-family:monospace;font-size:11px;color:#94a3b8">${poi.category}</div>
            ${poi.distMetres !== undefined ? `<div style="font-size:12px;margin-top:6px;color:#00c6ff">⊙ ${formatDist(poi.distMetres)} away</div>` : ''}
            ${poi.tags?.address ? `<div style="font-size:11px;margin-top:4px;color:#64748b">${poi.tags.address}</div>` : ''}
            ${poi.privacyMode === 'secure' ? `<div style="font-size:10px;margin-top:6px;color:#00e5c0">🔒 Result from secure circuit</div>` : ''}
          </div>
        `)

      // Marker → result card sync (Phase 6: map ↔ result interaction)
      m.on('click', () => onSelectResult?.(poi.id))

      resultMarkersRef.current.push(m)
      resultMarkerByIdRef.current.set(poi.id, { marker: m, buildIcon, latlng: [poi.latitude, poi.longitude] })

      // Draw line from user to result
      if (userLocation) {
        const line = L.polyline(
          [[userLocation.latitude, userLocation.longitude], [poi.latitude, poi.longitude]],
          { color, weight: 1, opacity: 0.3, dashArray: '4 6' }
        ).addTo(map)
        resultMarkersRef.current.push(line)
      }
    })

    // Fit bounds to show all results + user
    if (results.length > 0 && userLocation) {
      const bounds = L.latLngBounds([
        [userLocation.latitude, userLocation.longitude],
        ...results.map(r => [r.latitude, r.longitude]),
      ])
      map.fitBounds(bounds, { padding: [60, 60] })
    }
  }, [results, userLocation])

  // ── Result-card → map sync: highlight + pan/zoom to the selected marker ────
  // (Phase 6: map ↔ result interaction.) Tracks the previously-selected id
  // itself so it can revert that one marker's icon without touching any
  // other marker or re-running the full rebuild effect above.
  const prevSelectedRef = useRef(null)
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    const prevId = prevSelectedRef.current
    if (prevId && prevId !== selectedId) {
      const prevEntry = resultMarkerByIdRef.current.get(prevId)
      if (prevEntry) prevEntry.marker.setIcon(prevEntry.buildIcon(false))
    }

    if (selectedId) {
      const entry = resultMarkerByIdRef.current.get(selectedId)
      if (entry) {
        entry.marker.setIcon(entry.buildIcon(true))
        map.panTo(entry.latlng, { animate: true })
        entry.marker.openPopup()
      }
    }
    prevSelectedRef.current = selectedId
  }, [selectedId])

  return (
    <div className="relative w-full h-full scanlines">
      <div ref={mapRef} className="w-full h-full" />

      {/* Overlay: loading */}
      {loading && (
        <div className="absolute inset-0 bg-veil-bg/40 backdrop-blur-sm flex items-center justify-center z-10">
          <div className="veil-card px-6 py-4 flex items-center gap-3">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
              <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
              <div className="w-2 h-2 rounded-full bg-veil-accent load-dot" />
            </div>
            <span className="text-sm font-mono text-veil-text">Evaluating circuit…</span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 veil-card px-3 py-2 z-10 text-xs font-mono space-y-1">
        {Object.entries(CATEGORY_ICONS).map(([cat, icon]) => (
          <div key={cat} className="flex items-center gap-2">
            <span>{icon}</span>
            <span className="capitalize text-veil-muted">{cat}</span>
          </div>
        ))}
        <div className="border-t border-veil-border pt-1 mt-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-veil-accent border-2 border-white" />
            <span className="text-veil-muted">You</span>
          </div>
        </div>
      </div>
    </div>
  )
}
