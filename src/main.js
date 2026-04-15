/**
 * MIT Shuttle Tracker - Main Application
 */

import L from 'leaflet';
import {
  fetchAllRoutesAndData,
  fetchAllVehicles,
  SYSTEMS,
} from './api.js';

// MIT Campus center coordinates
const MIT_CENTER = [42.3601, -71.0942];
const DEFAULT_ZOOM = 15;

// Update interval in milliseconds
const UPDATE_INTERVAL = 5000;

// LocalStorage key for route display preferences
const STORAGE_KEY = 'mit-shuttle-route-display';

// LocalStorage key for the single pinned stop (singular in the new model)
const PINNED_STOP_KEY = 'mit-shuttle-pinned-stop';
// Legacy plural key for migration from the multi-pin model
const LEGACY_PINNED_STOPS_KEY = 'mit-shuttle-pinned-stops';

// LocalStorage key for display preferences (showNextStop, etc.)
const DISPLAY_PREFS_KEY = 'mit-shuttle-display-prefs';

// Default focused route for first-time visitors: Tech Shuttle.
const DEFAULT_FOCUSED_ROUTE_ID = 'mit:63220';

// Default pinned stop for first-time visitors: "Grad Junction West" on Tech Shuttle.
// Gives the user an immediately useful arrival panel on first load.
const DEFAULT_PINNED_STOP = { routeId: 'mit:63220', stopId: '180113' };

// Application state
const state = {
  map: null,
  routes: [],
  vehicles: [],
  markers: new Map(),
  routeDisplay: new Map(),    // Per-route toggle for showing route lines & stops
  routeLines: new Map(),      // Route polylines
  stopMarkers: new Map(),     // Stop markers grouped by route
  routeData: null,            // Route points and stops data
  pinnedStop: null,           // Single { routeId, stopId } or null
  displayPrefs: { showNextStop: true }, // User display preferences (persisted)
  lastBusFrac: new Map(),     // `${routeId}:${busId}` -> { frac, time } for smoothing
  updateTimer: null
};

/**
 * Initialize the map
 */
function initMap() {
  state.map = L.map('map', {
    center: MIT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true
  });

  // Add dark tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(state.map);
}

/**
 * Save route display preferences to localStorage
 */
function saveRouteDisplayPrefs() {
  const prefs = {};
  for (const [routeId, isShowing] of state.routeDisplay) {
    if (isShowing) {
      prefs[routeId] = true;
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn('Could not save route preferences:', e);
  }
}

/**
 * Load route display preferences from localStorage.
 * - First-time visitors (no saved state) get Tech Shuttle focused by default.
 * - Migrates legacy unprefixed keys (pre-EZRide) to the `mit:` prefix.
 */
function loadRouteDisplayPrefs() {
  const saved = localStorage.getItem(STORAGE_KEY);

  // First-time visitor: seed with Tech Shuttle focused so the user sees
  // a route drawn immediately instead of a blank map.
  if (saved === null) {
    return { [DEFAULT_FOCUSED_ROUTE_ID]: true };
  }

  try {
    const parsed = JSON.parse(saved);
    // One-shot migration: turn "63220" → "mit:63220".
    for (const key of Object.keys(parsed)) {
      if (!key.includes(':')) {
        parsed[`mit:${key}`] = parsed[key];
        delete parsed[key];
      }
    }
    return parsed;
  } catch (e) {
    console.warn('Could not load route preferences:', e);
    return {};
  }
}

/**
 * Return the 2-3 letter provider chip for a prefixed route ID.
 * 'mit:63220' -> 'MIT', 'ezride:67265' -> 'EZR'.
 */
function chipFor(prefixedRouteId) {
  const systemKey = String(prefixedRouteId).split(':')[0];
  return SYSTEMS[systemKey]?.chip || '';
}

/**
 * Load the single pinned stop from localStorage.
 * - Migrates any legacy plural-array format by taking the first entry.
 * - First-time visitors (no saved state) get the default pin.
 * - Returns null only if the user has explicitly cleared their pin.
 */
function loadPinnedStop() {
  // Migrate any legacy plural key written by the old multi-pin model.
  const legacy = localStorage.getItem(LEGACY_PINNED_STOPS_KEY);
  if (legacy !== null) {
    try {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length > 0 &&
          arr[0] && typeof arr[0].routeId === 'string' && typeof arr[0].stopId === 'string') {
        localStorage.setItem(PINNED_STOP_KEY, JSON.stringify(arr[0]));
      }
    } catch {
      // ignore parse failures
    }
    localStorage.removeItem(LEGACY_PINNED_STOPS_KEY);
  }

  const saved = localStorage.getItem(PINNED_STOP_KEY);

  // First-time visitor: seed with the default pin.
  if (saved === null) {
    return { ...DEFAULT_PINNED_STOP };
  }

  try {
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed.routeId === 'string' && typeof parsed.stopId === 'string') {
      return parsed;
    }
    // Explicit "null" saved means the user cleared their pin.
    return null;
  } catch (e) {
    console.warn('Could not load pinned stop:', e);
    return null;
  }
}

/**
 * Load display preferences (toggles controlling how the pinned panel renders).
 * Merges saved values over sensible defaults so new keys auto-populate.
 */
function loadDisplayPrefs() {
  const defaults = { showNextStop: true };
  try {
    const saved = localStorage.getItem(DISPLAY_PREFS_KEY);
    if (saved) return { ...defaults, ...JSON.parse(saved) };
  } catch (e) {
    console.warn('Could not load display prefs:', e);
  }
  return defaults;
}

function saveDisplayPrefs() {
  try {
    localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(state.displayPrefs));
  } catch (e) {
    console.warn('Could not save display prefs:', e);
  }
}

/**
 * Persist the current state.pinnedStop. Writes `null` (as a string) when
 * cleared so load can distinguish "user cleared" from "first-time visit".
 */
function savePinnedStop() {
  try {
    localStorage.setItem(PINNED_STOP_KEY, JSON.stringify(state.pinnedStop));
  } catch (e) {
    console.warn('Could not save pinned stop:', e);
  }
}

/**
 * Is this (routeId, stopId) the currently pinned stop?
 */
function isStopPinned(routeId, stopId) {
  return !!state.pinnedStop &&
    state.pinnedStop.routeId === routeId &&
    state.pinnedStop.stopId === stopId;
}

/**
 * Pin a (routeId, stopId). Replaces any existing pin.
 */
function pinStop(routeId, stopId) {
  state.pinnedStop = { routeId, stopId };
  savePinnedStop();
  renderPinnedPanel();
}

/**
 * Clear the pinned stop (whether it matches the given args or not — the
 * one-pin model has nothing else to unpin). Saves + re-renders.
 */
function unpinStop() {
  if (state.pinnedStop === null) return;
  state.pinnedStop = null;
  savePinnedStop();
  renderPinnedPanel();
}

/**
 * Create a custom bus marker icon with direction arrow.
 * When `tinted` is true, the marker is rendered dimmed/desaturated to
 * signal it belongs to a route the user isn't currently focused on.
 */
function createBusIcon(color = '#a31f34', heading = 0, tinted = false) {
  return L.divIcon({
    className: 'bus-marker-container',
    html: `
      <div class="bus-marker-wrapper${tinted ? ' tinted' : ''}">
        <div class="bus-direction-arrow" style="transform: rotate(${heading}deg); border-bottom-color: ${color}"></div>
        <div class="bus-marker" style="background: ${color}">
          🚌
        </div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20]
  });
}

/**
 * Create a stop marker icon
 */
function createStopIcon(color = '#ffffff') {
  return L.divIcon({
    className: 'stop-marker-container',
    html: `<div class="stop-marker" style="border-color: ${color}"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6]
  });
}

/**
 * Draw route lines on the map
 */
function drawRouteLines() {
  if (!state.routeData) return;
  
  const { routePoints, routeInfo } = state.routeData;
  
  for (const [routeId, points] of Object.entries(routePoints)) {
    if (points.length < 2) continue;
    
    const info = routeInfo[routeId] || {};
    const color = info.color || '#a31f34';
    const shouldShow = state.routeDisplay.get(routeId) === true;
    
    // Remove existing line if any
    if (state.routeLines.has(routeId)) {
      state.map.removeLayer(state.routeLines.get(routeId));
      state.routeLines.delete(routeId);
    }
    
    if (shouldShow) {
      const polyline = L.polyline(points, {
        color: color,
        weight: 4,
        opacity: 0.7,
        smoothFactor: 1
      }).addTo(state.map);
      
      polyline.bindPopup(`<b>${info.name || 'Route ' + routeId}</b>`);
      state.routeLines.set(routeId, polyline);
    }
  }
}

/**
 * Draw stop markers on the map
 */
function drawStopMarkers() {
  if (!state.routeData) return;
  
  const { stops, routeInfo } = state.routeData;
  
  // Clear all existing stop markers
  for (const [routeId, markers] of state.stopMarkers) {
    for (const marker of markers) {
      state.map.removeLayer(marker);
    }
  }
  state.stopMarkers.clear();
  
  for (const [routeId, routeStops] of Object.entries(stops)) {
    const shouldShow = state.routeDisplay.get(routeId) === true;
    if (!shouldShow) continue;
    
    const info = routeInfo[routeId] || {};
    const color = info.color || '#ffffff';
    const markers = [];
    
    for (let stopIndex = 0; stopIndex < routeStops.length; stopIndex++) {
      const stop = routeStops[stopIndex];
      if (!stop.latitude || !stop.longitude) continue;
      
      const marker = L.marker([stop.latitude, stop.longitude], {
        icon: createStopIcon(color)
      }).addTo(state.map);
      
      // Store stop info for dynamic popup
      marker.stopData = {
        ...stop,
        stopIndex,
        routeId,
        routeName: stop.routeName || info.name || 'Unknown',
        totalStops: routeStops.length
      };
      
      // Bind popup that updates on open
      marker.bindPopup(() => createStopPopupContent(marker.stopData));
      
      markers.push(marker);
    }
    
    state.stopMarkers.set(routeId, markers);
  }
}

/**
 * Euclidean distance between two {latitude, longitude} points.
 * Good enough for neighborhood-scale stop-spacing comparisons.
 */
// ---------------------------------------------------------------------------
// Bus-to-stop position tracking
//
// Passio's ETA/next-stop API is disabled for both MIT and EZRide (verified
// 2026-04-15: "error": "ETA is disabled"), so we have to derive the bus's
// position along the route from raw GPS. The old implementation tried to
// interpolate continuously using geometric projection, but that flip-flopped
// near segment midpoints and (worst case) teleported between far-apart stops
// on loops that revisit the same geometry.
//
// Simplified model per user spec: the bus is either *at a stop* (integer
// index) or *in transit between two consecutive stops* (halfway = i + 0.5).
// No continuous interpolation, so no backward-wobble ever.
// ---------------------------------------------------------------------------

// MIT is at ~42.36°N. We use a single cosine scale factor for all distance
// math so that one unit of longitude and one unit of latitude cover the same
// ground distance. Approximate and stable for everything in the Boston area.
const LAT_COS = Math.cos(42.36 * Math.PI / 180); // ~0.7395
const LAT_TO_M = 111320;

/**
 * Ground distance in meters between two lat/lon points. Uses the flat-earth
 * approximation with a fixed cos(lat) scale — accurate to within ~1% at
 * MIT/Cambridge latitudes, which is way more than we need for a 30-50m
 * at-stop threshold.
 */
function distMeters(a, b) {
  const dLat = (a.latitude - b.latitude) * LAT_TO_M;
  const dLon = (a.longitude - b.longitude) * LAT_TO_M * LAT_COS;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Point-to-segment distance in meters. A, B, P are lat/lon objects. The
 * segment is the straight line from A to B in local (cos-corrected) meter
 * coordinates — precise enough for route-segment picking at city scale.
 */
function distMetersToSegment(p, a, b) {
  const pax = (p.longitude - a.longitude) * LAT_TO_M * LAT_COS;
  const pay = (p.latitude  - a.latitude ) * LAT_TO_M;
  const bax = (b.longitude - a.longitude) * LAT_TO_M * LAT_COS;
  const bay = (b.latitude  - a.latitude ) * LAT_TO_M;
  const lenSq = bax * bax + bay * bay;
  if (lenSq === 0) {
    return Math.sqrt(pax * pax + pay * pay);
  }
  let t = (pax * bax + pay * bay) / lenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const dx = pax - t * bax;
  const dy = pay - t * bay;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute the bus's fractional position along the route's stop sequence.
 *
 * Returns an integer when the bus is within a stop's radius (at the stop),
 * or N + 0.5 when in transit between stop N and stop N+1 in sequence.
 * Temporal smoothing rejects small circular-backward deltas (GPS jitter)
 * but accepts large backward jumps (real data corrections).
 *
 * The segment (N, N+1) is chosen by picking the consecutive-sequence pair
 * whose straight-line segment is closest to the bus. This respects the
 * route's sequence from the start and is robust against routes with
 * revisited geometry (e.g. Tech Shuttle passes Tech Square twice — stops
 * 3 and 9 are geographically close but belong to different segments).
 *
 * Returns null if the bus has no coordinates or there are no stops.
 */
function computeBusFractionalIndex(bus, stops, routeId) {
  if (!stops || stops.length === 0) return null;
  if (typeof bus.latitude !== 'number' || typeof bus.longitude !== 'number') return null;

  const M = stops.length;
  if (M === 1) return 0;

  // Step 1: find the CONSECUTIVE-SEQUENCE segment (i, i+1) whose line the
  // bus is closest to. Not "closest stop then look at its neighbors" —
  // that geographic-closest-first search gets tripped up by revisited
  // geometry. This walks the route in sequence order from the start.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < M; i++) {
    const a = stops[i];
    const b = stops[(i + 1) % M];
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) continue;
    if (!Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) continue;
    const d = distMetersToSegment(bus, a, b);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;

  // Step 2: at-stop vs in-transit, using Passio's per-stop geofence radius.
  // If the bus is inside either endpoint's radius, snap to that integer
  // index. Otherwise it's halfway between the two stops on this segment.
  const aIdx = bestIdx;
  const bIdx = (bestIdx + 1) % M;
  const a = stops[aIdx];
  const b = stops[bIdx];
  const distA = distMeters(bus, a);
  const distB = distMeters(bus, b);
  const radA = Math.max(25, Number(a.radius) || 50);
  const radB = Math.max(25, Number(b.radius) || 50);

  let rawFrac;
  if (distA <= radA && distA <= distB) {
    rawFrac = aIdx;
  } else if (distB <= radB) {
    rawFrac = bIdx;
  } else {
    rawFrac = aIdx + 0.5;
    if (rawFrac >= M) rawFrac -= M;
  }

  // Step 3: temporal smoothing. Reject small circular-backward deltas
  // (GPS noise around the at-stop boundary), but accept large ones so
  // real data corrections pass through.
  const cacheKey = `${routeId}:${bus.id}`;
  const prev = state.lastBusFrac.get(cacheKey);
  const now = Date.now();
  let outFrac = rawFrac;
  if (prev && now - prev.time < 60000) {
    let delta = rawFrac - prev.frac;
    // Circular shortest-arc correction.
    if (delta >  M / 2) delta -= M;
    if (delta < -M / 2) delta += M;
    // Tiny backward wobble (≤ 1.0 stops): freeze at previous position.
    // Larger backward motion (> 1 stop) is accepted as a real correction.
    if (delta < 0 && delta > -1.0) {
      outFrac = prev.frac;
    }
  }
  state.lastBusFrac.set(cacheKey, { frac: outFrac, time: now });

  return outFrac;
}

/**
 * Compute bus arrivals for a given (routeId, stopId). Shared by the stop
 * popup and the pinned panel so they stay in sync.
 *
 * Returns: {
 *   stop, stopIndex, totalStops, routeName,
 *   arrivals: [{ bus, stopsAway, stopsAwayFrac }] sorted by stopsAwayFrac
 * }
 * or null if the route/stop is not in state.routeData.
 *
 * `stopsAway` is the integer count for text display; `stopsAwayFrac` is the
 * precise fractional distance (for smooth visual positioning on the track).
 */
function computeStopArrivals(routeId, stopId) {
  const routeStops = state.routeData?.stops[routeId] || [];
  if (routeStops.length === 0) return null;

  const stopIndex = routeStops.findIndex(s => String(s.id) === String(stopId));
  if (stopIndex === -1) return null;

  const stop = routeStops[stopIndex];
  const totalStops = routeStops.length;
  const routeInfo = state.routeData?.routeInfo[routeId] || {};
  const routeName = stop.routeName || routeInfo.name || 'Unknown';

  const routeBuses = state.vehicles.filter(v => String(v.routeId) === routeId);

  const arrivals = routeBuses.map(bus => {
    const busFracIdx = computeBusFractionalIndex(bus, routeStops, routeId);
    if (busFracIdx === null) return { bus, stopsAway: null, stopsAwayFrac: null };

    // Circular-route wraparound — reasonable for MIT loops, imperfect for
    // EZRide's linear runs but still produces a usable number.
    let stopsAwayFrac = stopIndex - busFracIdx;
    if (stopsAwayFrac < 0) stopsAwayFrac += totalStops;

    const stopsAway = Math.round(stopsAwayFrac);

    return { bus, stopsAway, stopsAwayFrac };
  }).sort((a, b) => (a.stopsAwayFrac ?? 999) - (b.stopsAwayFrac ?? 999));

  return { stop, stopIndex, totalStops, routeName, arrivals };
}

/**
 * Create popup content for a stop with bus distance info + pin button.
 */
function createStopPopupContent(stopData) {
  const { name, routeName, routeId, stopIndex, totalStops, id: stopId } = stopData;

  const info = computeStopArrivals(routeId, stopId);
  const effectiveArrivals = info?.arrivals || [];

  let busInfo = '';
  if (effectiveArrivals.length === 0) {
    busInfo = '<p class="no-buses">No active buses on this route</p>';
  } else {
    busInfo = '<div class="bus-distances">';
    for (const { bus, stopsAway } of effectiveArrivals) {
      const busLabel = bus.busNumber || bus.id;
      if (stopsAway === 0) {
        busInfo += `<p class="bus-here">🚌 Bus ${busLabel} is <strong>at this stop</strong></p>`;
      } else if (stopsAway === 1) {
        busInfo += `<p>🚌 Bus ${busLabel} is <strong>1 stop away</strong></p>`;
      } else if (stopsAway !== null) {
        busInfo += `<p>🚌 Bus ${busLabel} is <strong>${stopsAway} stops away</strong></p>`;
      } else {
        busInfo += `<p>🚌 Bus ${busLabel} - location unknown</p>`;
      }
    }
    busInfo += '</div>';
  }

  const pinnedHere = isStopPinned(routeId, stopId);
  const somethingElsePinned = !pinnedHere && state.pinnedStop !== null;
  let pinLabel;
  if (pinnedHere) {
    pinLabel = '📌 Unpin from top';
  } else if (somethingElsePinned) {
    pinLabel = '📌 Pin this stop instead';
  } else {
    pinLabel = '📌 Pin to top';
  }
  const pinBtn = `
    <button class="pin-btn${pinnedHere ? ' pinned' : ''}"
            data-pin-route="${routeId}"
            data-pin-stop="${stopId}">
      ${pinLabel}
    </button>
  `;

  return `
    <div class="popup-content stop-popup">
      <h3>🚏 ${name}</h3>
      <p class="route-label"><strong>Route:</strong> ${routeName}</p>
      <p class="stop-number">Stop ${stopIndex + 1} of ${totalStops}</p>
      <hr>
      ${busInfo}
      ${pinBtn}
    </div>
  `;
}

/**
 * Approach-line layout: how many stops show on each side of the pinned one.
 *
 *  ┌──────────────────────────────────────────────┐
 *  │  [6] [5] [4] [3] [2] [1] [PINNED] [next]     │
 *  │                             │                │
 *  │                             bar sits here    │
 *  └──────────────────────────────────────────────┘
 *
 * The "next" slot is toggleable via state.displayPrefs.showNextStop:
 *  - true:  pinned stop sits one slot left of the far right edge, with the
 *           stop AFTER pinned at the far right. Useful for seeing "just
 *           departed" buses and grounding the pinned stop in its sequence.
 *  - false: pinned stop sits at the far right (classic layout), 6 previous
 *           stops fill the track.
 */
const PINNED_TRACK_PREV_STOPS = 6;

/**
 * Compute the current layout based on display prefs. Called every render.
 */
function pinnedTrackLayout() {
  const next = state.displayPrefs?.showNextStop ? 1 : 0;
  const prev = PINNED_TRACK_PREV_STOPS;
  const span = prev + next;
  return {
    prev,
    next,
    span,
    slotRatio: span === 0 ? 0 : next / span,
  };
}

/**
 * Map a bus's "stops until pinned" distance onto a visible track position
 * in [0, PINNED_TRACK_SPAN], or null if it's outside the window.
 *
 * Two branches:
 *  - approaching pinned: stopsAwayFrac ∈ [0, PINNED_TRACK_PREV_STOPS + 0.5]
 *                        maps to [PINNED_TRACK_NEXT_STOPS, PINNED_TRACK_SPAN]
 *  - just departed pinned (bus moved past pinned toward the next stop):
 *                        stopsAwayFrac ∈ [totalStops - 1, totalStops]
 *                        maps to [0, 1]
 *
 * The 0.5 grace on the approaching tail keeps a bus that just crossed the
 * 6-stop boundary rendering at the far-left slot instead of abruptly
 * vanishing into overflow.
 */
function trackPosFromStopsAway(stopsAwayFrac, totalStops) {
  if (stopsAwayFrac === null || stopsAwayFrac === undefined) return null;
  if (!(totalStops > 0)) return null;

  const layout = pinnedTrackLayout();

  // Approaching pinned (integer or fractional, 0..PREV_STOPS).
  if (stopsAwayFrac >= 0 && stopsAwayFrac <= layout.prev + 0.5) {
    return Math.min(layout.next + stopsAwayFrac, layout.span);
  }

  // Just departed pinned and heading toward the next stop. Only meaningful
  // when layout.next > 0 — in classic mode this region collapses and buses
  // in it are treated as overflow.
  if (layout.next > 0) {
    const departureStart = totalStops - layout.next;
    if (stopsAwayFrac >= departureStart && stopsAwayFrac <= totalStops) {
      return stopsAwayFrac - departureStart;
    }
  }

  return null;
}

/**
 * Classify a bus's proximity to the pinned stop for UI styling.
 * Returns one of: 'arriving' (0-1 stops), 'near' (2-3), or '' (further).
 */
function classifyBusProximity(stopsAway) {
  if (stopsAway === null || stopsAway === undefined) return '';
  if (stopsAway <= 1) return 'arriving';
  if (stopsAway <= 3) return 'near';
  return '';
}

/**
 * Human-readable distance string for a bus arrival (integer stops from pinned,
 * approaching direction only). Used for overflow text and popups.
 */
function formatStopsAwayText(stopsAway) {
  if (stopsAway === null || stopsAway === undefined) return '??';
  if (stopsAway === 0) return 'here';
  if (stopsAway === 1) return '1 stop';
  return `${stopsAway} stops`;
}

/**
 * Label text for a bus on the approach-line track, derived from its visible
 * position. Handles both sides of the pinned stop: "here", "N stops" on the
 * approaching side, and "leaving" / "next stop" on the departing side.
 */
function labelForTrackPos(trackPos) {
  if (trackPos === null || trackPos === undefined) return '??';
  const layout = pinnedTrackLayout();

  // Departing region: 0 (at the next stop) up to the pinned slot (layout.next).
  // Collapses to zero width in classic mode (layout.next === 0).
  if (trackPos < layout.next) {
    if (trackPos <= 0.15) return 'next stop';
    return 'leaving';
  }
  // Approaching region: pinned at layout.next, previous stops beyond.
  const stopsFromPinned = Math.round(trackPos - layout.next);
  if (stopsFromPinned === 0) return 'here';
  if (stopsFromPinned === 1) return '1 stop';
  return `${stopsFromPinned} stops`;
}

/**
 * Render a single bus marker as an HTML string for the approach-line.
 * `labelPosition` is 'below' (even index) or 'above' (odd index) so adjacent
 * bus labels don't overlap. The visible label is just the distance text —
 * the bus ID lives in the tooltip for anyone who wants it.
 */
function renderTrackBusHTML(bus, labelText, trackPos, proximity, labelPosition) {
  const busLabel = bus.busNumber || bus.id;
  const { span } = pinnedTrackLayout();

  // Ratio across the track: 0 = far right, 1 = far left (6 prev stops).
  const rawRatio = span > 0 ? trackPos / span : 0;
  const ratio = Math.min(Math.max(rawRatio, 0), 1).toFixed(3);

  return `
    <div class="track-bus ${proximity} label-${labelPosition}"
         data-bus-id="${bus.id}"
         style="--offset-ratio: ${ratio}"
         title="Bus ${busLabel} — ${labelText}">
      <div class="track-bus-dot">🚌</div>
      <div class="track-bus-label">${labelText}</div>
    </div>
  `;
}

/**
 * Render the single pinned-stop panel at the top of the app. Hides entirely
 * when nothing is pinned. Visualizes buses approaching the pinned stop as
 * markers on a horizontal line whose right end is the destination.
 *
 * Buses within 6 stops of the pinned stop render on the line at a fractional
 * position derived from their actual geo coordinates. Buses further out are
 * listed as a text strip below the line.
 */
function renderPinnedPanel() {
  const panel = document.getElementById('pinned-panel');
  if (!panel) return;

  if (!state.pinnedStop) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');

  const { routeId, stopId } = state.pinnedStop;
  const info = computeStopArrivals(routeId, stopId);
  const routeInfo = state.routeData?.routeInfo[routeId] || {};
  const routeColor = routeInfo.color || '#a31f34';
  const chip = chipFor(routeId);

  const stopName = info?.stop.name || 'Stop unavailable';
  const subtitle = info
    ? `${info.routeName} · Stop ${info.stopIndex + 1} of ${info.totalStops}`
    : (routeInfo.name || 'Waiting for route data…');

  // Partition each arrival into visible (has a track position) vs overflow
  // (listed as text below the line). Track position already encodes both
  // the approaching side and the "just departed" side relative to pinned.
  const totalStops = info?.totalStops || 0;
  const visible = [];
  const overflow = [];
  for (const arr of info?.arrivals || []) {
    const trackPos = trackPosFromStopsAway(arr.stopsAwayFrac, totalStops);
    if (trackPos === null) {
      overflow.push(arr);
    } else {
      visible.push({ ...arr, trackPos });
    }
  }

  // Draw buses rightmost-first so label alternation (below/above) follows
  // physical left-to-right adjacency on the track.
  visible.sort((a, b) => a.trackPos - b.trackPos);

  // Stop dots for every integer slot along the track, skipping the slot
  // where the vertical bar (pinned stop) sits. The "next stop" dot (when
  // enabled) lives at position 0 (far right) so the pinned slot reads as
  // a point in a sequence rather than a dead-end.
  const layout = pinnedTrackLayout();
  let prevDotsHtml = '';
  for (let n = 0; n <= layout.span; n++) {
    if (n === layout.next) continue;
    const ratio = (n / layout.span).toFixed(3);
    prevDotsHtml += `<div class="track-prev-dot" style="--offset-ratio: ${ratio}"></div>`;
  }

  // Bus markers. Labels alternate below/above so adjacent labels don't
  // collide. The label text comes from trackPos (so the "just departed"
  // region gets "leaving" / "next stop" instead of misleading big numbers).
  let busesHtml = '';
  visible.forEach(({ bus, stopsAway, trackPos }, idx) => {
    const labelPosition = idx % 2 === 0 ? 'below' : 'above';
    const labelText = labelForTrackPos(trackPos);
    const proximity = classifyBusProximity(stopsAway);
    busesHtml += renderTrackBusHTML(bus, labelText, trackPos, proximity, labelPosition);
  });

  // Single aggregate marker for every bus beyond the 6-stop window,
  // pinned to the far-left of the track and labeled "6+ stops". One icon
  // no matter how many buses are out there — just a hint that more are
  // coming from further away.
  if (overflow.length > 0) {
    const overflowLabelPos = visible.length % 2 === 0 ? 'below' : 'above';
    const overflowTitle = overflow.length === 1
      ? '1 more bus beyond 6 stops'
      : `${overflow.length} more buses beyond 6 stops`;
    busesHtml += `
      <div class="track-bus track-bus-overflow label-${overflowLabelPos}"
           style="--offset-ratio: 1"
           title="${overflowTitle}">
        <div class="track-bus-dot">🚌</div>
        <div class="track-bus-label">6+ stops</div>
      </div>
    `;
  }

  // Empty-state message only when there are genuinely no buses anywhere
  // (nothing visible AND nothing beyond the window).
  let emptyHtml = '';
  if (visible.length === 0 && overflow.length === 0) {
    emptyHtml = `<div class="track-empty">No active buses on this route</div>`;
  }

  // Text list under the track detailing each bus beyond the 6-stop window.
  // The 6+ marker on the line is the summary; this row gives the actual
  // stops-away numbers so the user still knows how far out they are.
  let overflowHtml = '';
  if (overflow.length > 0) {
    const parts = overflow.map(({ stopsAway }) => {
      return `<span class="overflow-item">${formatStopsAwayText(stopsAway)}</span>`;
    });
    overflowHtml = `<div class="pinned-overflow"><span class="overflow-prefix">Also approaching:</span> ${parts.join(' · ')}</div>`;
  }

  // Destination pulses when a bus is 0 or 1 stops away.
  const anyArriving = visible.some(a => a.stopsAway === 0 || a.stopsAway === 1);
  const trackClass = `pinned-track${anyArriving ? ' arriving' : ''}`;

  panel.innerHTML = `
    <div class="pinned-header" style="--pin-color: ${routeColor}">
      <span class="provider-chip">${chip}</span>
      <div class="pinned-title-group">
        <div class="pinned-stop-name" title="${stopName}">${stopName}</div>
        <div class="pinned-subtitle">${subtitle}</div>
      </div>
      <button class="edit-pin-btn" aria-label="Change pinned stop">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    </div>
    <div class="${trackClass}" style="--pin-color: ${routeColor}; --pinned-slot-ratio: ${layout.slotRatio.toFixed(4)}">
      <div class="track-line"></div>
      ${prevDotsHtml}
      <div class="track-stop" title="${stopName}"></div>
      ${busesHtml}
      ${emptyHtml}
    </div>
    ${overflowHtml}
  `;
}

/**
 * Update route and stop visibility. Also re-renders vehicle markers
 * and the shuttle list so bus tinting tracks the focus state immediately
 * when the user toggles a route on or off.
 */
function updateRouteDisplay() {
  drawRouteLines();
  drawStopMarkers();
  // Re-apply tinting: buses on freshly-focused routes un-tint, and buses
  // on freshly-unfocused routes dim.
  if (state.vehicles.length > 0) {
    updateVehicleMarkers(state.vehicles);
    renderShuttleList(state.vehicles);
  }
}

/**
 * A vehicle is "focused" when its route is currently toggled on. Buses on
 * non-focused routes are rendered tinted so the user's current selection
 * stands out visually.
 */
function isVehicleFocused(vehicle) {
  return state.routeDisplay.get(String(vehicle.routeId)) === true;
}

/**
 * Update or create vehicle markers on the map
 */
function updateVehicleMarkers(vehicles) {
  const currentIds = new Set(vehicles.map(v => v.id));

  // Remove markers for vehicles no longer active
  for (const [id, marker] of state.markers) {
    if (!currentIds.has(id)) {
      state.map.removeLayer(marker);
      state.markers.delete(id);
    }
  }

  // Update or create markers
  for (const vehicle of vehicles) {
    // Use route info from vehicle data (API provides it directly)
    const routeColor = vehicle.routeColor || '#a31f34';
    const routeName = vehicle.routeName || 'Unknown Route';
    const tinted = !isVehicleFocused(vehicle);

    const popupContent = `
      <div class="popup-content">
        <h3>Bus #${vehicle.busNumber}</h3>
        <p><strong>Route:</strong> ${routeName}</p>
        <p><strong>Passengers:</strong> ${vehicle.passengers} / ${vehicle.capacity}</p>
        <p><strong>Last Update:</strong> ${vehicle.lastUpdate}</p>
      </div>
    `;

    if (state.markers.has(vehicle.id)) {
      // Update existing marker
      const marker = state.markers.get(vehicle.id);
      marker.setLatLng([vehicle.latitude, vehicle.longitude]);
      marker.setIcon(createBusIcon(routeColor, vehicle.heading, tinted));
      marker.getPopup().setContent(popupContent);
    } else {
      // Create new marker
      const marker = L.marker([vehicle.latitude, vehicle.longitude], {
        icon: createBusIcon(routeColor, vehicle.heading, tinted)
      }).addTo(state.map);

      marker.bindPopup(popupContent);
      state.markers.set(vehicle.id, marker);
    }
  }
}

/**
 * Render the shuttle list in the sidebar
 */
function renderShuttleList(vehicles) {
  const container = document.getElementById('shuttle-list');
  
  // Update shuttle count in handle
  updateShuttleCount(vehicles.length);
  
  if (vehicles.length === 0) {
    container.innerHTML = '<p class="loading">No active shuttles</p>';
    return;
  }
  
  container.innerHTML = vehicles.map(vehicle => {
    // Use route info directly from vehicle data
    const routeName = vehicle.routeName || 'Unknown Route';
    const routeColor = vehicle.routeColor || '#a31f34';
    const loadPercent = vehicle.capacity > 0 ? Math.round((vehicle.passengers / vehicle.capacity) * 100) : 0;
    const tintedClass = isVehicleFocused(vehicle) ? '' : ' tinted';

    return `
      <div class="shuttle-card${tintedClass}" style="--route-color: ${routeColor}" data-vehicle-id="${vehicle.id}">
        <div class="bus-number">Bus #${vehicle.busNumber}</div>
        <div class="route-name">${routeName}</div>
        <div class="details">
          <span class="passengers">👥 ${vehicle.passengers}/${vehicle.capacity} (${loadPercent}%)</span>
          <span class="update">🕐 ${vehicle.lastUpdate}</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers to center map on vehicle
  container.querySelectorAll('.shuttle-card').forEach(card => {
    card.addEventListener('click', () => {
      const vehicleId = card.dataset.vehicleId;
      const vehicle = vehicles.find(v => v.id === vehicleId);
      if (vehicle) {
        state.map.setView([vehicle.latitude, vehicle.longitude], 17);
        const marker = state.markers.get(vehicleId);
        if (marker) {
          marker.openPopup();
        }
      }
    });
  });
}

/**
 * Render route filters in the sidebar
 */
function renderRouteFilters() {
  const container = document.getElementById('route-filters');

  // Sidebar only lists routes that are currently running — inactive routes
  // clutter the list with options that can't show any live buses. The
  // pin picker is where users can still reach them to pre-pin a stop.
  const routesHtml = state.routes.filter(r => r.active !== false).map(route => {
    const routeIdStr = String(route.myid);
    const isShowing = state.routeDisplay.get(routeIdStr) === true;
    const chip = chipFor(routeIdStr);
    return `
      <div class="route-filter ${isShowing ? 'active' : ''}">
        <button class="route-toggle-btn" data-route-id="${routeIdStr}" title="Show/hide route path and stops">
          <span class="provider-chip">${chip}</span>
          <span class="route-color" style="background: ${route.color}"></span>
          <span class="route-name">${route.name}</span>
          <span class="route-toggle-icon">${isShowing ? '🗺️' : '○'}</span>
        </button>
      </div>
    `;
  }).join('');
  
  const helperText = `<p class="route-helper-text">Click a route to show its path and stops on the map</p>`;
  
  container.innerHTML = helperText + `<div class="routes-list">${routesHtml}</div>`;
  
  // Add route toggle handlers
  container.querySelectorAll('.route-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const routeId = btn.dataset.routeId;
      const currentState = state.routeDisplay.get(routeId) === true;
      state.routeDisplay.set(routeId, !currentState);
      
      // Save to localStorage
      saveRouteDisplayPrefs();
      
      // Update button appearance
      const filterDiv = btn.closest('.route-filter');
      filterDiv.classList.toggle('active', !currentState);
      btn.querySelector('.route-toggle-icon').textContent = !currentState ? '🗺️' : '○';
      
      // Update map display
      updateRouteDisplay();
    });
  });
}

/**
 * Update connection status indicator.
 *
 * The header area is tight on mobile, so we stack the status over two
 * lines: everything up to the first bullet separator goes on line 1, and
 * the rest (e.g. "11 shuttles") wraps onto line 2. This avoids ugly
 * mid-phrase word breaks like "Updated: 1:23 PM • 11 / shuttles".
 */
function updateStatus(connected, message) {
  const dot = document.getElementById('connection-status');
  const line1 = document.getElementById('last-update-line1');
  const line2 = document.getElementById('last-update-line2');

  dot.className = 'status-dot ' + (connected ? 'connected' : 'error');

  const bulletIdx = message.indexOf(' • ');
  if (bulletIdx >= 0) {
    line1.textContent = message.slice(0, bulletIdx);
    line2.textContent = message.slice(bulletIdx + 3);
  } else {
    line1.textContent = message;
    line2.textContent = '';
  }
}

/**
 * Fetch and update all data.
 * Pulls vehicles from every configured system in parallel; tolerates
 * one system failing without blanking the UI.
 */
async function updateData() {
  try {
    const { vehicles, errors } = await fetchAllVehicles();
    state.vehicles = vehicles;

    updateVehicleMarkers(state.vehicles);
    renderShuttleList(state.vehicles);
    renderPinnedPanel();

    const now = new Date().toLocaleTimeString();
    if (errors.length > 0) {
      const failed = errors.map(e => SYSTEMS[e.systemKey]?.label || e.systemKey).join(', ');
      console.warn('Partial update failures:', errors);
      updateStatus(true, `Updated: ${now} • ${state.vehicles.length} shuttles • ${failed} unavailable`);
    } else {
      updateStatus(true, `Updated: ${now} • ${state.vehicles.length} shuttles`);
    }
  } catch (error) {
    console.error('Update error:', error);
    updateStatus(false, 'Connection error - retrying...');
  }
}

/**
 * Initialize mobile bottom sheet behavior with drag support
 */
function initMobileSheet() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-handle');
  
  if (!sidebar || !handle) return;
  
  // Check if mobile
  const isMobile = () => window.innerWidth <= 768;
  
  // Start collapsed on mobile
  if (isMobile()) {
    sidebar.classList.add('collapsed');
  }
  
  // Drag state
  let isDragging = false;
  let startY = 0;
  let startTranslate = 0;
  let currentTranslate = 0;
  
  // Get the collapsed translate value
  const getCollapsedTranslate = () => {
    const sidebarHeight = sidebar.offsetHeight;
    const handleHeight = 70; // Handle visible height when collapsed
    return sidebarHeight - handleHeight;
  };
  
  // Touch start
  handle.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    
    isDragging = true;
    startY = e.touches[0].clientY;
    
    // Get current translate value
    const isCollapsed = sidebar.classList.contains('collapsed');
    startTranslate = isCollapsed ? getCollapsedTranslate() : 0;
    currentTranslate = startTranslate;
    
    // Disable transition during drag
    sidebar.style.transition = 'none';
    sidebar.classList.remove('collapsed');
  }, { passive: true });
  
  // Touch move
  handle.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    
    const deltaY = e.touches[0].clientY - startY;
    currentTranslate = Math.max(0, Math.min(getCollapsedTranslate(), startTranslate + deltaY));
    
    sidebar.style.transform = `translateY(${currentTranslate}px)`;
  }, { passive: true });
  
  // Touch end
  handle.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    
    // Re-enable transition
    sidebar.style.transition = '';
    sidebar.style.transform = '';
    
    // Snap to expanded or collapsed based on position
    const threshold = getCollapsedTranslate() * 0.4;
    if (currentTranslate > threshold) {
      sidebar.classList.add('collapsed');
    } else {
      sidebar.classList.remove('collapsed');
    }
  });
  
  // Also support click for accessibility
  handle.addEventListener('click', (e) => {
    // Only toggle on click if it wasn't a drag
    if (!isDragging && isMobile()) {
      sidebar.classList.toggle('collapsed');
    }
  });
  
  // Handle window resize
  window.addEventListener('resize', () => {
    if (!isMobile()) {
      sidebar.classList.remove('collapsed');
      sidebar.style.transform = '';
    }
  });
}

/**
 * Update shuttle count label
 */
function updateShuttleCount(count) {
  const label = document.getElementById('shuttle-count');
  if (label) {
    label.textContent = count === 1 ? '1 Active Shuttle' : `${count} Active Shuttles`;
  }
}

/**
 * Initialize refresh button
 */
function initRefreshButton() {
  const refreshBtn = document.getElementById('refresh-btn');
  if (!refreshBtn) return;
  
  refreshBtn.addEventListener('click', async () => {
    // Add spinning animation
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    
    try {
      await updateData();
    } finally {
      // Remove spinning after a minimum time for visual feedback
      setTimeout(() => {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
      }, 500);
    }
  });
}

// ---------------------------------------------------------------------------
// Pin picker modal: a two-step flow (select route → select stop) that
// replaces the bare unpin button. The user can also clear the current pin
// from inside the picker, so unpinning is still reachable.
// ---------------------------------------------------------------------------

const pickerState = {
  step: 'routes',              // 'routes' | 'stops'
  selectedRouteId: null,
  inactiveExpanded: false,     // "Not running now" collapsible section state
};

/**
 * Open the picker on the route-selection step, highlighting whichever
 * route is currently pinned (if any). If the current pin is on an
 * inactive route, the "Not running now" section auto-expands so the
 * user immediately sees it.
 */
function openPinPicker() {
  const picker = document.getElementById('pin-picker');
  if (!picker) return;
  pickerState.step = 'routes';
  pickerState.selectedRouteId = null;

  const pinnedRouteId = state.pinnedStop?.routeId;
  const pinnedRoute = pinnedRouteId
    ? state.routes.find(r => r.myid === pinnedRouteId)
    : null;
  pickerState.inactiveExpanded = pinnedRoute ? pinnedRoute.active === false : false;

  picker.classList.remove('hidden');
  renderPinPickerRoutes();
}

function closePinPicker() {
  const picker = document.getElementById('pin-picker');
  if (!picker) return;
  picker.classList.add('hidden');
}

/**
 * Build HTML for a single route row. `inactive` applies dimmed styling
 * and an "offline" badge so users understand the route isn't running now.
 */
function renderPinPickerRouteRow(route, pinnedRouteId, inactive) {
  const routeId   = route.myid;
  const chip      = chipFor(routeId);
  const color     = route.color || '#a31f34';
  const isCurrent = routeId === pinnedRouteId;
  const classes = [
    'pin-picker-row',
    isCurrent ? 'pin-picker-row-active' : '',
    inactive ? 'pin-picker-row-inactive' : '',
  ].filter(Boolean).join(' ');

  let badge = '';
  if (isCurrent) {
    badge = '<span class="pin-picker-current">current</span>';
  } else if (inactive) {
    badge = '<span class="pin-picker-badge-offline">offline</span>';
  }

  return `
    <button class="${classes}" data-pp-route="${routeId}">
      <span class="provider-chip">${chip}</span>
      <span class="pin-picker-color" style="background:${color}"></span>
      <span class="pin-picker-row-label">${route.name || routeId}</span>
      ${badge}
      <svg class="pin-picker-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18l6-6-6-6"/>
      </svg>
    </button>
  `;
}

/**
 * Render the route-selection step. Routes split into an always-visible
 * "active" list (currently running) and a collapsible "Not running now"
 * section for outdated routes — the user can still pre-pin a stop there
 * for when the route comes back online. Current pin (if any) is sorted
 * to the top of whichever section it belongs to.
 */
function renderPinPickerRoutes() {
  const body  = document.querySelector('#pin-picker .pin-picker-body');
  const back  = document.querySelector('#pin-picker .pin-picker-back');
  const title = document.querySelector('#pin-picker .pin-picker-title');
  if (!body) return;

  pickerState.step = 'routes';
  pickerState.selectedRouteId = null;

  back.classList.add('hidden');
  title.textContent = 'Select a route';

  const pinnedRouteId = state.pinnedStop?.routeId || null;

  const byNameCurrentFirst = (a, b) => {
    if (a.myid === pinnedRouteId && b.myid !== pinnedRouteId) return -1;
    if (b.myid === pinnedRouteId && a.myid !== pinnedRouteId) return 1;
    return (a.name || '').localeCompare(b.name || '');
  };

  const activeRoutes   = state.routes.filter(r => r.active !== false).slice().sort(byNameCurrentFirst);
  const inactiveRoutes = state.routes.filter(r => r.active === false).slice().sort(byNameCurrentFirst);

  let html = '';

  // Display-options toggle: show one stop past the pinned slot on the track.
  const showNext = !!state.displayPrefs?.showNextStop;
  html += `
    <div class="pin-picker-section-header">Display</div>
    <button class="pin-picker-row pin-picker-settings-row" data-pp-action="toggle-next-stop" aria-pressed="${showNext}">
      <span class="pin-picker-row-label">Show next stop on track</span>
      <span class="pin-picker-switch${showNext ? ' on' : ''}" aria-hidden="true">
        <span class="pin-picker-switch-thumb"></span>
      </span>
    </button>
    <div class="pin-picker-divider"></div>
  `;

  if (state.pinnedStop) {
    html += `
      <button class="pin-picker-row pin-picker-clear" data-pp-action="clear">
        <span class="pin-picker-row-label">Clear current pin</span>
        <span class="pin-picker-row-sub">Hides the approach panel</span>
      </button>
    `;
  }

  // Active routes — always visible.
  for (const route of activeRoutes) {
    html += renderPinPickerRouteRow(route, pinnedRouteId, false);
  }

  // Inactive routes — under a collapsible toggle.
  if (inactiveRoutes.length > 0) {
    const expanded = pickerState.inactiveExpanded;
    const chevronRot = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
    html += `
      <button class="pin-picker-toggle${expanded ? ' expanded' : ''}" data-pp-action="toggle-inactive">
        <svg class="pin-picker-toggle-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:${chevronRot}">
          <path d="M9 18l6-6-6-6"/>
        </svg>
        <span class="pin-picker-toggle-label">Not running now</span>
        <span class="pin-picker-toggle-count">${inactiveRoutes.length}</span>
      </button>
    `;
    if (expanded) {
      html += '<div class="pin-picker-inactive-list">';
      for (const route of inactiveRoutes) {
        html += renderPinPickerRouteRow(route, pinnedRouteId, true);
      }
      html += '</div>';
    }
  }

  if (activeRoutes.length === 0 && inactiveRoutes.length === 0) {
    html = '<div class="pin-picker-empty">Routes are still loading…</div>';
  }

  body.innerHTML = html;
  body.scrollTop = 0;
}

/**
 * Render the stop-selection step for a given route. Auto-scrolls the
 * currently-pinned stop into view so the user can see where they are.
 */
function renderPinPickerStops(routeId) {
  const body  = document.querySelector('#pin-picker .pin-picker-body');
  const back  = document.querySelector('#pin-picker .pin-picker-back');
  const title = document.querySelector('#pin-picker .pin-picker-title');
  if (!body) return;

  pickerState.step = 'stops';
  pickerState.selectedRouteId = routeId;

  back.classList.remove('hidden');
  const routeInfo = state.routeData?.routeInfo[routeId] || {};
  title.textContent = routeInfo.name || 'Select a stop';

  const stops = state.routeData?.stops[routeId] || [];
  const pinnedStopId = state.pinnedStop?.routeId === routeId
    ? state.pinnedStop.stopId
    : null;

  let html = '';
  stops.forEach((stop, idx) => {
    const isCurrent = String(stop.id) === String(pinnedStopId);
    html += `
      <button class="pin-picker-row${isCurrent ? ' pin-picker-row-active' : ''}" data-pp-stop="${stop.id}">
        <span class="pin-picker-stop-index">${idx + 1}</span>
        <span class="pin-picker-row-label">${stop.name || `Stop ${idx + 1}`}</span>
        ${isCurrent ? '<span class="pin-picker-current">pinned</span>' : ''}
      </button>
    `;
  });

  if (stops.length === 0) {
    html = '<div class="pin-picker-empty">No stops on this route</div>';
  }

  body.innerHTML = html;
  body.scrollTop = 0;

  // Scroll the currently-pinned stop into view, if any.
  const activeEl = body.querySelector('.pin-picker-row-active');
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
}

/**
 * Wire up the picker's event handlers (one-time, at init).
 */
function initPinPicker() {
  const picker = document.getElementById('pin-picker');
  if (!picker) return;

  picker.querySelector('.pin-picker-close').addEventListener('click', closePinPicker);
  picker.querySelector('.pin-picker-back').addEventListener('click', renderPinPickerRoutes);

  // Backdrop click to dismiss
  picker.addEventListener('click', (e) => {
    if (e.target === picker) closePinPicker();
  });

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.classList.contains('hidden')) {
      closePinPicker();
    }
  });

  // Delegated clicks inside the picker body.
  picker.querySelector('.pin-picker-body').addEventListener('click', (e) => {
    // Collapsible "Not running now" toggle.
    const toggle = e.target.closest('.pin-picker-toggle');
    if (toggle) {
      pickerState.inactiveExpanded = !pickerState.inactiveExpanded;
      renderPinPickerRoutes();
      return;
    }

    const row = e.target.closest('.pin-picker-row');
    if (!row) return;

    // Display-options: flip the "show next stop" switch, persist, and
    // re-render both the picker (to flip the visual toggle) and the
    // pinned panel (to pick up the new layout immediately).
    if (row.dataset.ppAction === 'toggle-next-stop') {
      if (!state.displayPrefs) state.displayPrefs = {};
      state.displayPrefs.showNextStop = !state.displayPrefs.showNextStop;
      saveDisplayPrefs();
      renderPinPickerRoutes();
      renderPinnedPanel();
      return;
    }

    if (row.dataset.ppAction === 'clear') {
      unpinStop();
      closePinPicker();
      return;
    }

    const routeId = row.dataset.ppRoute;
    if (routeId) {
      renderPinPickerStops(routeId);
      return;
    }

    const stopId = row.dataset.ppStop;
    if (stopId && pickerState.selectedRouteId) {
      pinStop(pickerState.selectedRouteId, stopId);
      closePinPicker();
    }
  });
}

/**
 * Wire a single delegated click handler for pin/edit buttons. Popup DOM
 * is rebuilt by Leaflet on each open, so binding per-button would leak.
 */
function initPinDelegation() {
  document.addEventListener('click', (e) => {
    // Edit button on the pinned-panel card opens the route/stop picker.
    const editBtn = e.target.closest('.pinned-panel .edit-pin-btn');
    if (editBtn) {
      openPinPicker();
      return;
    }

    const btn = e.target.closest('[data-pin-route][data-pin-stop]');
    if (!btn) return;

    const routeId = btn.dataset.pinRoute;
    const stopId = btn.dataset.pinStop;

    if (isStopPinned(routeId, stopId)) {
      unpinStop();
    } else {
      pinStop(routeId, stopId);
    }

    // Close any open Leaflet popup so the user immediately sees the
    // panel update without a stale "Pin" button floating around.
    if (state.map) state.map.closePopup();
  });
}

/**
 * Initialize the application
 */
async function init() {
  console.log('🚌 MIT Shuttle Tracker starting...');

  // Initialize map
  initMap();

  // Initialize mobile bottom sheet
  initMobileSheet();

  // Initialize refresh button
  initRefreshButton();

  // Wire delegated click handler for pin/unpin buttons
  initPinDelegation();

  // Wire the pin picker modal (route + stop selection)
  initPinPicker();

  // Load the persisted pinned stop (or default to Grad Junction West on first visit)
  state.pinnedStop = loadPinnedStop();
  state.displayPrefs = loadDisplayPrefs();
  
  try {
    // Fetch initial data from every configured system in parallel
    updateStatus(false, 'Loading routes...');
    const { routes, routeData, errors } = await fetchAllRoutesAndData();

    // If everything failed, treat it as a fatal init error
    if (routes.length === 0 && Object.keys(routeData.routeInfo).length === 0) {
      throw new Error('All transit systems failed to load');
    }

    state.routes = routes;
    state.routeData = routeData;

    if (errors.length > 0) {
      const failed = errors.map(e => SYSTEMS[e.systemKey]?.label || e.systemKey);
      const uniqueFailed = [...new Set(failed)].join(', ');
      console.warn(`Partial load: ${uniqueFailed} unavailable`, errors);
      updateStatus(false, `${uniqueFailed} unavailable - loading others...`);
    }

    // Load saved route display preferences (auto-migrates legacy unprefixed keys)
    const savedPrefs = loadRouteDisplayPrefs();

    // Initialize route display from saved prefs or default to hidden
    state.routes.forEach(route => {
      const routeId = String(route.myid);
      state.routeDisplay.set(routeId, savedPrefs[routeId] === true);
    });

    renderRouteFilters();

    // Draw route lines and stops
    updateRouteDisplay();

    // Initial vehicle update
    await updateData();

    // Start periodic updates
    state.updateTimer = setInterval(updateData, UPDATE_INTERVAL);

    console.log('✅ MIT Shuttle Tracker initialized');

  } catch (error) {
    console.error('Initialization error:', error);
    updateStatus(false, 'Failed to load - check console');
  }
}

// Start the app
init();
