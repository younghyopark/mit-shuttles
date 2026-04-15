/**
 * MIT Shuttle Tracker - Main Application
 */

import L from 'leaflet';
import {
  fetchAllRoutesAndData,
  fetchAllVehicles,
  fetchStopETAs,
  fetchRoutePositions,
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
  // Precomputed per-route geometry used for route-aware bus progress. Without
  // this, a bus physically near a stop on an out-and-back segment reads as
  // "at that stop" even when it's still outbound — because the old fallback
  // matched straight-line segments between stops instead of the real polyline.
  // Populated once after routeData loads; never mutated at poll time.
  polyMeta: new Map(),        // routeId -> { poly, cumDist, totalLen }
  stopPolyIdx: new Map(),     // routeId -> [fractional polyline index, ...] in service order
  // Per-bus forward-continuity hint for projectBusOntoPolyline. Prevents the
  // projector from jumping between lollipop-segment candidates between polls.
  lastBusPolyIdx: new Map(),  // `${routeId}:${busId}` -> { polyIdx, time }
  // Authoritative per-bus stop positions from Passio's rich ETA shape.
  // Populated by refreshPinnedRoutePositions() before each render. When
  // present, this short-circuits all GPS projection logic in
  // computeBusFractionalIndex — we trust Passio's "bus is approaching
  // stop N" answer directly instead of guessing it from lat/lng. Keyed
  // by prefixed routeId at the outer level, bus fleet number inside.
  busRoutePositions: new Map(),  // routeId -> Map<busName, positionRecord>
  busRoutePositionsFetchedAtMs: 0,
  pinnedStop: null,           // Single { routeId, stopId } or null
  displayPrefs: { showNextStop: true }, // User display preferences (persisted)
  lastBusFrac: new Map(),     // `${routeId}:${busId}` -> { frac, time } for smoothing
  // ETAs for the currently pinned stop. Repopulated on every updateData cycle
  // when a stop is pinned, and cleared when the pin changes. Callers look up
  // ETAs by bus fleet number via `byBusName` because that's the only field
  // Passio's ETA endpoint guarantees across both of its response shapes.
  pinnedEtas: {
    routeId: null,            // prefixed, matches state.pinnedStop.routeId
    stopId:  null,
    fetchedAtMs: 0,
    byBusName: new Map(),     // bus fleet number -> ETA record
    list: [],                 // sorted-soonest-first array, for overflow rendering
  },
  updateTimer: null,
  etaTickTimer: null,         // 1s tick that advances ETA countdowns in place
  pinnedEtasInFlight: 0,      // monotonic token to discard stale ETA responses
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
  // Discard ETAs from the previous pin so the panel doesn't flash stale
  // minutes from the old stop. Bumping the in-flight token also orphans
  // any mid-flight fetch from the previous pin.
  state.pinnedEtasInFlight++;
  state.pinnedEtas.routeId = null;
  state.pinnedEtas.stopId  = null;
  state.pinnedEtas.byBusName.clear();
  state.pinnedEtas.list = [];
  state.pinnedEtas.fetchedAtMs = 0;
  // Also clear stale server-position data from the previous pin's route
  // so the panel doesn't briefly show the old route's bus positions
  // against the new route's stop list.
  state.busRoutePositions = new Map();
  state.busRoutePositionsFetchedAtMs = 0;
  // Kick off immediate fetches for the new pin so the user doesn't wait
  // up to 5s for the next poll. Both are fire-and-forget; neither throws.
  refreshPinnedEtas({ renderOnSuccess: true });
  refreshPinnedRoutePositions().then(renderPinnedPanel);
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
  // Clear ETA state and orphan any in-flight fetch.
  state.pinnedEtasInFlight++;
  state.pinnedEtas.routeId = null;
  state.pinnedEtas.stopId  = null;
  state.pinnedEtas.byBusName.clear();
  state.pinnedEtas.list = [];
  state.pinnedEtas.fetchedAtMs = 0;
  // And clear server-position data so downstream consumers (stop
  // popups for the old route) fall back to polyline projection.
  state.busRoutePositions = new Map();
  state.busRoutePositionsFetchedAtMs = 0;
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

// ---------------------------------------------------------------------------
// Route-aware bus progress: project buses onto the route POLYLINE, not onto
// straight lines between consecutive stops.
//
// Why this exists: Tech Shuttle (and others) have "lollipop" segments where
// the bus physically drives past a stop, continues to a turnaround, and
// comes back through the same street — only stopping on the return leg.
// A GPS-nearest-stop match reports the bus as "at" that stop on both the
// outbound and inbound pass, which made the approach-line panel flicker
// back-and-forth around Grad Junction West, W92, etc.
//
// The polyline already encodes the out-and-back geometry as two distinct
// sequences of vertices at the same GPS coordinates. If we project each
// bus onto the polyline with a forward-monotonic search (hint-based after
// the first poll; heading-based on bootstrap), the outbound pass gets
// mapped to a far smaller polyline index than the inbound pass, and the
// stops-away math Just Works.
// ---------------------------------------------------------------------------

/**
 * Precompute per-route geometry used by the polyline-based progress logic:
 *
 *   state.polyMeta.get(routeId)      = { poly, cumDist, totalLen }
 *   state.stopPolyIdx.get(routeId)   = [fracPolyIdx_0, ..., fracPolyIdx_{M-1}]
 *
 * `poly` is an array of [lat, lng] pairs (copy of routeData.routePoints).
 * `cumDist[i]` is the cumulative ground distance in meters from poly[0] to
 * poly[i] — used to convert polyline-vertex indices into a "fraction of
 * route traveled" value if we ever need one.
 *
 * The per-stop polyline indices are assigned GREEDILY in service order:
 * stop i must project to a polyline index strictly greater than stop i-1.
 * This is what resolves lollipop stops — given a choice between two GPS
 * matches, pick the one that comes later in the polyline than the previous
 * stop. For loop routes, the final stop wraps back to near the starting
 * polyline point; no special handling needed because `stopPolyIdxExt`
 * (used in polyIdxToStopFracIdx) synthesizes a wraparound sentinel.
 *
 * Stops whose GPS projection to the forward window exceeds 120m (the stop
 * is probably a data bug, or the polyline is broken) fall back to a global
 * closest-point projection, with a console warning. That's lossy for the
 * loop-back case but never crashes.
 */
function precomputeRouteGeometry(routeId) {
  const poly = state.routeData?.routePoints?.[routeId];
  const stops = state.routeData?.stops?.[routeId];
  if (!Array.isArray(poly) || poly.length < 2) return;
  if (!Array.isArray(stops) || stops.length === 0) return;

  // Cumulative distance along the polyline, so any caller that wants to
  // speak in meters (not vertex indices) can convert cheaply later.
  const cumDist = new Float64Array(poly.length);
  cumDist[0] = 0;
  for (let i = 1; i < poly.length; i++) {
    const [lat0, lng0] = poly[i - 1];
    const [lat1, lng1] = poly[i];
    const dLat = (lat1 - lat0) * LAT_TO_M;
    const dLng = (lng1 - lng0) * LAT_TO_M * LAT_COS;
    cumDist[i] = cumDist[i - 1] + Math.sqrt(dLat * dLat + dLng * dLng);
  }

  state.polyMeta.set(routeId, { poly, cumDist, totalLen: cumDist[poly.length - 1] });

  // Greedy monotonic assignment of stops to polyline indices. For each stop,
  // walk segments starting from `startAt` (one past the previous stop's
  // assignment) and record the closest-projection segment. The chosen
  // fractional index is (segIdx + t) where t ∈ [0, 1] is the projection
  // along that segment.
  const M = stops.length;
  const stopIdx = new Float64Array(M);
  let startAt = 0;
  for (let s = 0; s < M; s++) {
    const stop = stops[s];
    if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) {
      stopIdx[s] = s === 0 ? 0 : stopIdx[s - 1] + 0.5;
      continue;
    }

    // How far ahead may we look? The last stop has to sit before the end
    // of the polyline, so we cap at `poly.length - 1`. Every other stop
    // can scan to the end of the polyline unless the stop chase falls off,
    // which we handle with a global-fallback below.
    let bestSeg = -1;
    let bestT = 0;
    let bestDist = Infinity;
    for (let i = startAt; i < poly.length - 1; i++) {
      const a = poly[i];
      const b = poly[i + 1];
      const { t, dist } = projectPointOntoSegment(
        stop.latitude, stop.longitude, a[0], a[1], b[0], b[1]
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestSeg = i;
        bestT = t;
      }
    }

    // If the forward window didn't find a reasonable match (>120m off any
    // forward segment), the stop must lie on a segment we already passed
    // in the greedy walk — which only happens for data bugs. Fall back to
    // a global search so we at least have SOME index for this stop.
    if (bestDist > 120 || bestSeg === -1) {
      let gSeg = -1;
      let gT = 0;
      let gDist = Infinity;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const { t, dist } = projectPointOntoSegment(
          stop.latitude, stop.longitude, a[0], a[1], b[0], b[1]
        );
        if (dist < gDist) {
          gDist = dist;
          gSeg = i;
          gT = t;
        }
      }
      if (gSeg !== -1) {
        bestSeg = gSeg;
        bestT = gT;
        bestDist = gDist;
      }
      console.warn(
        `[route geometry] stop "${stop.name}" on ${routeId} fell back to ` +
        `global projection (dist=${Math.round(bestDist)}m). This is usually ` +
        `fine for a stop on the return leg of a loop.`
      );
    }

    const frac = bestSeg + bestT;
    stopIdx[s] = frac;
    // Advance the window slightly past the chosen segment so the NEXT stop
    // is forced further along the polyline. +1 is safe because a stop whose
    // real polyline vertex is within [bestSeg, bestSeg+1] has t<1, so the
    // next stop's bestSeg will be ≥ bestSeg+1 regardless.
    startAt = Math.min(poly.length - 2, bestSeg + 1);
  }

  state.stopPolyIdx.set(routeId, stopIdx);
}

/**
 * Project a point onto a line segment defined by two lat/lng pairs.
 * Returns `{ t, dist }` where t ∈ [0, 1] is the clamped fractional position
 * along the segment and dist is the Euclidean distance in meters from the
 * point to its projection.
 *
 * Uses the same flat-earth cosine correction as distMetersToSegment, kept
 * in a self-contained form here so precomputeRouteGeometry doesn't allocate
 * intermediate stop-objects to call distMetersToSegment.
 */
function projectPointOntoSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const pax = (pLng - aLng) * LAT_TO_M * LAT_COS;
  const pay = (pLat - aLat) * LAT_TO_M;
  const bax = (bLng - aLng) * LAT_TO_M * LAT_COS;
  const bay = (bLat - aLat) * LAT_TO_M;
  const lenSq = bax * bax + bay * bay;
  if (lenSq === 0) {
    return { t: 0, dist: Math.sqrt(pax * pax + pay * pay) };
  }
  let t = (pax * bax + pay * bay) / lenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const dx = pax - t * bax;
  const dy = pay - t * bay;
  return { t, dist: Math.sqrt(dx * dx + dy * dy) };
}

/**
 * Project a bus onto the route polyline, returning a fractional polyline
 * vertex index. Forward-continuity is enforced: on subsequent polls we
 * restrict the search to a window around the previous projection, so
 * lollipop segments (same GPS, different polyline index) don't flip.
 *
 * Bootstrap (no previous projection, or the previous one is older than
 * 60s) picks between globally-closest candidates using the bus heading:
 * the candidate whose local polyline direction best aligns with the
 * bus's `calculatedCourse` wins. This is cheap and self-correcting —
 * even a bad bootstrap gets replaced on the next poll by a forward-window
 * search anchored on the new position.
 *
 * Returns null if the bus has no GPS or the route has no polyMeta.
 */
function projectBusOntoPolyline(bus, routeId) {
  const meta = state.polyMeta.get(routeId);
  if (!meta) return null;
  if (typeof bus.latitude !== 'number' || typeof bus.longitude !== 'number') return null;
  const poly = meta.poly;
  const N = poly.length;
  if (N < 2) return null;

  const cacheKey = `${routeId}:${bus.id}`;
  const prev = state.lastBusPolyIdx.get(cacheKey);
  const now = Date.now();
  const havePrev = prev && (now - prev.time) < 60000;

  // Window search: scan a short forward window around the previous index
  // so a bus that's made small forward progress can't suddenly project
  // backward to a lollipop twin on the outbound leg.
  let bestIdx = -1;
  let bestT = 0;
  let bestDist = Infinity;

  if (havePrev) {
    const WINDOW_BACK = 5;   // tiny backward slack for GPS noise at stops
    const WINDOW_FWD  = 80;  // max forward advance per 5s poll (very loose)
    const center = Math.floor(prev.polyIdx);
    const startI = Math.max(0, center - WINDOW_BACK);
    const endI   = Math.min(N - 2, center + WINDOW_FWD);
    for (let i = startI; i <= endI; i++) {
      const a = poly[i];
      const b = poly[i + 1];
      const { t, dist } = projectPointOntoSegment(
        bus.latitude, bus.longitude, a[0], a[1], b[0], b[1]
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
        bestT = t;
      }
    }

    // If the window search turned up a genuinely distant projection, the
    // bus may have looped past the end of the window (wrap around to idx 0)
    // or taken a detour. Fall back to a global search in that case.
    if (bestDist > 200) {
      const g = projectBusGlobal(bus, meta, null);
      if (g) return g;
    }
  } else {
    // Bootstrap: use heading to pick between GPS-equivalent candidates.
    const g = projectBusGlobal(bus, meta, bus.heading);
    if (g == null) return null;
    bestIdx = Math.floor(g);
    bestT   = g - bestIdx;
    bestDist = 0; // not used after this point; we accept the pick
  }

  if (bestIdx < 0) return null;
  const frac = bestIdx + bestT;
  state.lastBusPolyIdx.set(cacheKey, { polyIdx: frac, time: now });
  return frac;
}

/**
 * Bootstrap / fallback global search. Walks every polyline segment and
 * returns the single fractional index that best matches the bus position.
 * When `heading` is a finite number (bus's `calculatedCourse`), ties
 * between lollipop twins are broken by picking the candidate whose local
 * segment direction best aligns with the bus's heading — a 2D dot product
 * between the unit vector of the segment and the unit vector of the bus's
 * travel direction.
 */
function projectBusGlobal(bus, meta, heading) {
  const poly = meta.poly;
  const N = poly.length;
  if (N < 2) return null;

  // First, collect every segment whose projection distance is within a
  // small margin of the global minimum. Those are the lollipop twins.
  let absoluteMinDist = Infinity;
  const perSeg = new Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const { t, dist } = projectPointOntoSegment(
      bus.latitude, bus.longitude, a[0], a[1], b[0], b[1]
    );
    perSeg[i] = { t, dist, i };
    if (dist < absoluteMinDist) absoluteMinDist = dist;
  }
  if (!Number.isFinite(absoluteMinDist)) return null;

  // "Candidate" = any segment within 25m of the absolute best. Lollipop
  // twins will be almost-equal, unrelated segments will be much worse.
  const candidateThresh = absoluteMinDist + 25;
  const candidates = perSeg.filter(s => s.dist <= candidateThresh);
  if (candidates.length === 0) return null;

  // Only one candidate? Return it directly; no heading tiebreak needed.
  if (candidates.length === 1 || !Number.isFinite(heading)) {
    const best = candidates.reduce((a, b) => (a.dist <= b.dist ? a : b));
    return best.i + best.t;
  }

  // Heading tiebreak. Bus heading is in degrees clockwise from north (0 = N,
  // 90 = E, 180 = S, 270 = W). Convert to a unit vector in the same "local
  // meters" frame we use for segment directions: (east, north).
  const hRad = heading * Math.PI / 180;
  const hEast = Math.sin(hRad);
  const hNorth = Math.cos(hRad);

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const a = poly[c.i];
    const b = poly[c.i + 1];
    const segEast  = (b[1] - a[1]) * LAT_COS;
    const segNorth = (b[0] - a[0]);
    const segLen = Math.sqrt(segEast * segEast + segNorth * segNorth);
    if (segLen === 0) continue;
    const align = (segEast / segLen) * hEast + (segNorth / segLen) * hNorth;
    // Penalize by GPS distance so a perfectly-aligned but 50m-off segment
    // doesn't beat a 2m-off misaligned one.
    const score = align - (c.dist / 50);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best.i + best.t;
}

/**
 * Convert a fractional polyline index to a fractional STOP index in the
 * route's service sequence. Handles loop wrap: the stop sequence is
 * cyclic, so a bus between the last stop and the first stop (polyline
 * tail → polyline head) reports a frac of (M - 1 + progress) modulo M.
 *
 * Returns null if the route has no precomputed stopPolyIdx.
 */
function polyIdxToStopFracIdx(polyIdx, routeId) {
  const idx = state.stopPolyIdx.get(routeId);
  const meta = state.polyMeta.get(routeId);
  if (!idx || !meta) return null;
  const M = idx.length;
  if (M === 0) return null;
  const polyLen = meta.poly.length - 1; // max segment index + 1

  // Build the extended array so the last-stop-to-first-stop wrap is just
  // another interpolation cell. stopPolyIdxExt[M] = stopPolyIdx[0] + polyLen
  // (the "next" visit of the first stop, after one full loop).
  const ext = new Array(M + 1);
  for (let i = 0; i < M; i++) ext[i] = idx[i];
  ext[M] = idx[0] + polyLen;

  // Normalize the polyline index into the extended range. If the bus is
  // before the first stop's polyline index, shift it forward by polyLen
  // so it lands in the wraparound cell [ext[M-1], ext[M]].
  let p = polyIdx;
  if (p < ext[0]) p += polyLen;

  // Linear scan is fine: M is <= 20ish for MIT routes. Binary search would
  // be two lines shorter and save nothing measurable.
  for (let k = 0; k < M; k++) {
    const lo = ext[k];
    const hi = ext[k + 1];
    if (p >= lo && p <= hi) {
      const span = hi - lo;
      const frac = span > 0 ? k + (p - lo) / span : k;
      return frac % M;
    }
  }
  // Shouldn't reach here if ext is monotonic, but guard anyway.
  return null;
}

/**
 * Convert one of Passio's authoritative bus position records (from the
 * rich ETA shape) into a fractional stop index for the pinned-panel
 * visualization.
 *
 * The record gives us:
 *   - `routeStopPosition`: integer index of the NEXT stop the bus is
 *                           approaching (or its current dwell stop).
 *   - `routePointPosition`: the bus's polyline vertex index, or null
 *                           when Passio reports -1 (meaning "at stop").
 *
 * When the bus is in transit we interpolate fractional progress using
 * the precomputed `stopPolyIdx`: the polyline distance between the
 * previous and next stops gives us a span, and the bus's offset from
 * the previous stop within that span gives us `t ∈ [0, 1]`. Result:
 *
 *     frac = (prevStopIdx + t) mod M
 *
 * When Passio has no valid polyline position (dwelling at a stop, or
 * geometry missing), we snap to the integer next-stop index so the
 * panel still shows a correct "at stop" state.
 *
 * Loop wrap is handled by shifting the next stop's polyline index by
 * polyLen when it's less than the previous stop's — same trick
 * polyIdxToStopFracIdx uses for the extended sentinel cell.
 */
function fracIdxFromServerPosition(pos, routeId, M) {
  const nextStop = pos.routeStopPosition;
  if (!Number.isFinite(nextStop) || nextStop < 0 || nextStop >= M) return null;

  // No in-transit polyline position — bus is either dwelling at a stop
  // or Passio doesn't have a fresh projection. Snap to the integer
  // next-stop index; the geofence logic in computeBusFractionalIndex
  // will then collapse this to exactly "at stop" in the UI.
  if (pos.routePointPosition == null) {
    return nextStop;
  }

  const stopPolyIdx = state.stopPolyIdx.get(routeId);
  const polyMeta = state.polyMeta.get(routeId);
  if (!stopPolyIdx || stopPolyIdx.length === 0 || !polyMeta) {
    return nextStop;
  }

  // Previous stop = one before the next stop (with loop wrap).
  const prevStop = (nextStop - 1 + M) % M;
  const prevPoly = stopPolyIdx[prevStop];
  let nextPoly   = stopPolyIdx[nextStop];
  const polyLen  = polyMeta.poly.length - 1;

  // Loop-boundary case: the bus is between the last service stop and
  // the first one (returning to origin for a new loop). In polyline
  // terms the "next" stop wraps to the beginning, so we synthesize a
  // nextPoly in extended coordinates.
  let busPoly = pos.routePointPosition;
  if (nextPoly < prevPoly) {
    nextPoly += polyLen;
    if (busPoly < prevPoly) busPoly += polyLen;
  }

  const span = nextPoly - prevPoly;
  if (span <= 0) return nextStop;

  // Clamp `t` to [0, 1] because Passio occasionally reports a
  // routePointPosition slightly outside the stop-to-stop polyline
  // span when the bus is near a corner or stop geofence.
  let t = (busPoly - prevPoly) / span;
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  return ((prevStop + t) % M + M) % M;
}

/**
 * Compute the bus's fractional position along the route's stop sequence.
 *
 * Primary path: use Passio's authoritative `routeStopPosition` from the
 * rich ETA shape (populated for the pinned route by
 * refreshPinnedRoutePositions). No GPS math on our end.
 *
 * Fallback paths: project the bus onto the route polyline, or walk
 * straight-line segments between consecutive stops. Used when server
 * position data isn't available (non-pinned route popups, first-load
 * race before refreshPinnedRoutePositions finishes, etc.).
 *
 * Returns an integer when the bus is within a stop's radius (at the stop),
 * or a fractional value when in transit. Falls back to the previous
 * straight-line-segment heuristic only when precomputed geometry is
 * missing for the route — preserves behavior for any route without
 * polyline data.
 *
 * Temporal smoothing rejects tiny circular-backward deltas (GPS jitter at
 * stop radii) but accepts larger backward motion as real corrections.
 *
 * Returns null if the bus has no coordinates or there are no stops.
 */
function computeBusFractionalIndex(bus, stops, routeId) {
  if (!stops || stops.length === 0) return null;
  if (typeof bus.latitude !== 'number' || typeof bus.longitude !== 'number') return null;

  const M = stops.length;
  if (M === 1) return 0;

  // Preferred path: use Passio's authoritative `routeStopPosition` and
  // `routePointPosition` from the rich ETA shape (populated for the
  // pinned route by refreshPinnedRoutePositions). Passio's server knows
  // exactly which stop each bus is servicing next — no GPS projection
  // needed. This is what fixes the lollipop-pass confusion cleanly.
  let rawFrac = null;
  const positionsForRoute = state.busRoutePositions.get(routeId);
  if (positionsForRoute && bus.busNumber != null) {
    const pos = positionsForRoute.get(String(bus.busNumber));
    if (pos && Number.isFinite(pos.routeStopPosition)) {
      rawFrac = fracIdxFromServerPosition(pos, routeId, M);
    }
  }

  // Fallback path: project onto the polyline using our precomputed
  // stopPolyIdx. Used when (a) the pinned panel hasn't populated server
  // positions yet on first load, (b) a stop popup is rendering for a
  // route we don't currently have position data for, or (c) Passio's
  // rich shape is unavailable for any reason.
  if (rawFrac == null && state.polyMeta.has(routeId) && state.stopPolyIdx.has(routeId)) {
    const polyIdx = projectBusOntoPolyline(bus, routeId);
    if (polyIdx != null) {
      rawFrac = polyIdxToStopFracIdx(polyIdx, routeId);
    }
  }

  // Legacy fallback: walk consecutive stop-to-stop straight-line segments.
  // Reached only when routeData.routePoints is missing for this route —
  // e.g. a new system we haven't configured polylines for. Preserves the
  // old behavior so we never degrade an otherwise-working route.
  if (rawFrac == null) {
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

    const aIdx = bestIdx;
    const bIdx = (bestIdx + 1) % M;
    const a = stops[aIdx];
    const b = stops[bIdx];
    const distA = distMeters(bus, a);
    const distB = distMeters(bus, b);
    const radA = Math.max(25, Number(a.radius) || 50);
    const radB = Math.max(25, Number(b.radius) || 50);

    if (distA <= radA && distA <= distB) {
      rawFrac = aIdx;
    } else if (distB <= radB) {
      rawFrac = bIdx;
    } else {
      rawFrac = aIdx + 0.5;
      if (rawFrac >= M) rawFrac -= M;
    }
  }

  // Snap to integer indices when the bus is inside Passio's per-stop
  // geofence radius. The polyline projection gives a continuous value;
  // this lets the at-stop UI state fire at the same threshold as before.
  {
    const nearest = Math.round(rawFrac) % M;
    const safeNearest = (nearest + M) % M;
    const s = stops[safeNearest];
    if (s && Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
      const rad = Math.max(25, Number(s.radius) || 50);
      if (distMeters(bus, s) <= rad) {
        rawFrac = safeNearest;
      }
    }
  }

  // Temporal smoothing: reject small circular-backward deltas (GPS noise
  // at stop boundaries) but accept larger ones as real corrections. Kept
  // even though projectBusOntoPolyline already enforces forward progress
  // in polyline space, because (a) the wraparound boundary can produce
  // apparent backward jumps when stops map unevenly, and (b) if we fell
  // through to the legacy fallback above we still need this guard.
  const cacheKey = `${routeId}:${bus.id}`;
  const prev = state.lastBusFrac.get(cacheKey);
  const now = Date.now();
  let outFrac = rawFrac;
  if (prev && now - prev.time < 60000) {
    let delta = rawFrac - prev.frac;
    if (delta >  M / 2) delta -= M;
    if (delta < -M / 2) delta += M;
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
/**
 * Strip the system prefix from a frontend route ID to get the raw Passio ID.
 *   'mit:63220'    -> '63220'
 *   'ezride:67265' -> '67265'
 *   '63220'        -> '63220'   (legacy/unprefixed)
 */
function rawRouteIdFromPrefixed(routeId) {
  if (routeId == null) return null;
  const s = String(routeId);
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * Format a live ETA countdown for display on a bus icon. The caller is
 * expected to have already computed `seconds` from the stored
 * `arrivalEpochMs` minus `Date.now()`, so the value ticks down smoothly
 * between server polls.
 *
 *   seconds <= 0   → "now"
 *   seconds < 60   → "45s"
 *   seconds < 3600 → "2m"  /  "2m 30s" (only under 10 min — avoids clutter
 *                                        on longer ETAs where single-second
 *                                        precision is nonsense)
 *   seconds >= 3600 → "1h+"
 */
function formatEtaLabel(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  if (s >= 3600) return '1h+';
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  if (mins < 10 && rem >= 5) return `${mins}m ${rem}s`;
  return `${mins}m`;
}

/**
 * Look up the current ETA for a given bus at the currently pinned stop,
 * measured against the client clock. Returns `null` when there is no ETA
 * record (unknown bus, stale fetch, or the endpoint returned "no vehicles").
 *
 * Returns:
 *   {
 *     arrivalEpochMs: number,  // fixed at fetch time; the tick loop reads
 *                               // this + Date.now() for a smooth countdown
 *     solid: boolean,
 *     stale: boolean,           // true when Passio's underlying position is
 *                               // >90s old — the ETA is still shown but the
 *                               // UI dims it so the user can discount it
 *   }
 */
function etaForBus(bus) {
  if (!bus || !bus.busNumber) return null;
  const e = state.pinnedEtas.byBusName.get(String(bus.busNumber));
  if (!e) return null;
  const stale = e.updatedSecAgo != null && e.updatedSecAgo > 90;
  return {
    arrivalEpochMs: e.arrivalEpochMs,
    solid: !!e.solid,
    stale,
  };
}

/**
 * Refresh Passio's authoritative per-bus stop positions for the currently
 * pinned route. This is what powers the route-aware bus progress in
 * computeBusFractionalIndex — Passio tells us "bus 833 is next approaching
 * stop index 1" and we just use that directly instead of projecting GPS
 * onto the polyline. Never throws.
 *
 * Only queries the pinned route, not every route. The pinned panel is the
 * only UI element that needs this data; stop popups for non-pinned routes
 * still fall back to the polyline projection, which handles lollipop cases
 * reasonably well and is free (no extra network round-trip).
 */
async function refreshPinnedRoutePositions() {
  const pinned = state.pinnedStop;
  if (!pinned) {
    // Clear stale data when nothing is pinned. Other consumers still get
    // the polyline-projection fallback for any route they care about.
    state.busRoutePositions = new Map();
    state.busRoutePositionsFetchedAtMs = 0;
    return;
  }
  const rawRouteId = rawRouteIdFromPrefixed(pinned.routeId);
  const list = await fetchRoutePositions(rawRouteId);

  // If the pin changed while this fetch was in flight, don't overwrite.
  if (!state.pinnedStop || state.pinnedStop.routeId !== pinned.routeId) return;

  const byBusName = new Map();
  for (const p of list) byBusName.set(p.busName, p);

  const next = new Map();
  next.set(pinned.routeId, byBusName);
  state.busRoutePositions = next;
  state.busRoutePositionsFetchedAtMs = Date.now();
}

/**
 * Kick off an ETA fetch for the currently pinned stop. Uses a monotonic
 * token so that if the user changes the pin mid-fetch, the stale response
 * is discarded instead of overwriting the newer one. Never throws.
 *
 * When `renderOnSuccess` is true, re-renders the pinned panel as soon as
 * the fetch lands so the user sees fresh minutes without waiting for the
 * next poll tick. Used for the immediate fetch on pin change.
 */
async function refreshPinnedEtas({ renderOnSuccess = false } = {}) {
  const pinned = state.pinnedStop;
  if (!pinned) {
    // Clear any stale data if nothing's pinned.
    state.pinnedEtas.routeId = null;
    state.pinnedEtas.stopId  = null;
    state.pinnedEtas.byBusName.clear();
    state.pinnedEtas.list = [];
    state.pinnedEtas.fetchedAtMs = 0;
    return;
  }
  const token = ++state.pinnedEtasInFlight;
  const rawRouteId = rawRouteIdFromPrefixed(pinned.routeId);
  const stopId = String(pinned.stopId);

  const etas = await fetchStopETAs(rawRouteId, stopId);

  // Discard if a newer fetch was started, or the user unpinned/repinned.
  if (token !== state.pinnedEtasInFlight) return;
  if (!state.pinnedStop) return;
  if (state.pinnedStop.routeId !== pinned.routeId) return;
  if (state.pinnedStop.stopId  !== pinned.stopId)  return;

  state.pinnedEtas.routeId = pinned.routeId;
  state.pinnedEtas.stopId  = stopId;
  state.pinnedEtas.fetchedAtMs = Date.now();
  state.pinnedEtas.list = etas;
  state.pinnedEtas.byBusName.clear();
  for (const e of etas) {
    state.pinnedEtas.byBusName.set(String(e.busName), e);
  }

  if (renderOnSuccess) renderPinnedPanel();
}

/**
 * Update the ETA countdown text on every `.track-bus-eta` element currently
 * in the DOM, without re-rendering the whole panel. Reads `data-arrival-ms`
 * and computes `(arrivalMs - Date.now()) / 1000` per tick. This is what lets
 * the displayed time tick down between 5-second API polls.
 */
function updateEtaLabelsInPlace() {
  const nowMs = Date.now();
  const nodes = document.querySelectorAll('.track-bus-eta[data-arrival-ms], .overflow-eta[data-arrival-ms]');
  for (const node of nodes) {
    const arr = Number(node.getAttribute('data-arrival-ms'));
    if (!Number.isFinite(arr)) continue;
    const seconds = (arr - nowMs) / 1000;
    const text = formatEtaLabel(seconds);
    if (node.textContent !== text) node.textContent = text;
  }
}

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
 * bus labels don't overlap. The visible label is the distance text plus a
 * second-line live-ETA countdown when one is available from Passio.
 *
 * The ETA element carries its own `data-arrival-ms` so the 1-second tick
 * loop can advance the countdown without re-rendering the whole panel.
 */
function renderTrackBusHTML(bus, labelText, trackPos, proximity, labelPosition) {
  const busLabel = bus.busNumber || bus.id;
  const { span } = pinnedTrackLayout();

  // Ratio across the track: 0 = far right, 1 = far left (6 prev stops).
  const rawRatio = span > 0 ? trackPos / span : 0;
  const ratio = Math.min(Math.max(rawRatio, 0), 1).toFixed(3);

  // ETA subline, if Passio has one for this bus. We render the element
  // whether or not we could compute text, because the tick loop updates
  // it by attribute — text will appear on the next tick even if the first
  // render is empty (shouldn't happen, but cheap to be safe).
  const eta = etaForBus(bus);
  let etaHtml = '';
  let titleExtra = '';
  if (eta) {
    const seconds = (eta.arrivalEpochMs - Date.now()) / 1000;
    const text = formatEtaLabel(seconds);
    const etaClass = `track-bus-eta${eta.stale ? ' stale' : ''}${eta.solid ? '' : ' soft'}`;
    etaHtml = `<div class="${etaClass}" data-arrival-ms="${eta.arrivalEpochMs}">${text}</div>`;
    titleExtra = ` — ETA ${text}`;
  }

  return `
    <div class="track-bus ${proximity} label-${labelPosition}"
         data-bus-id="${bus.id}"
         style="--offset-ratio: ${ratio}"
         title="Bus ${busLabel} — ${labelText}${titleExtra}">
      <div class="track-bus-dot">🚌</div>
      <div class="track-bus-label">${labelText}</div>
      ${etaHtml}
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
  // stops-away numbers so the user still knows how far out they are. When
  // Passio has a live ETA for the bus we tack it on in parentheses, with
  // its own data-arrival-ms so the tick loop keeps the minutes fresh.
  let overflowHtml = '';
  if (overflow.length > 0) {
    const parts = overflow.map(({ bus, stopsAway }) => {
      const stopsText = formatStopsAwayText(stopsAway);
      const eta = etaForBus(bus);
      if (!eta) return `<span class="overflow-item">${stopsText}</span>`;
      const seconds = (eta.arrivalEpochMs - Date.now()) / 1000;
      const text = formatEtaLabel(seconds);
      const cls = `overflow-eta${eta.stale ? ' stale' : ''}${eta.solid ? '' : ' soft'}`;
      return `<span class="overflow-item">${stopsText} <span class="${cls}" data-arrival-ms="${eta.arrivalEpochMs}">${text}</span></span>`;
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
 * Compute the lat/lng bounding box that covers every polyline and every
 * stop belonging to a route currently toggled on in the route display.
 * Returns a Leaflet `LatLngBounds`, or `null` if nothing is visible.
 *
 * We walk both polylines and stops because on a partially-loaded map
 * (e.g. a route whose polyline is missing for some reason) the stops
 * alone still let us produce a reasonable frame. And because polyline
 * vertices exist at many more points than stops do, they dominate the
 * bounds on any route we DO have geometry for — which is usually what
 * we want (the frame follows the road, not just the stops).
 */
function computeVisibleRouteBounds() {
  const bounds = L.latLngBounds([]);
  let extended = false;

  for (const [routeId, isShowing] of state.routeDisplay) {
    if (!isShowing) continue;

    const polyPts = state.routeData?.routePoints?.[routeId];
    if (Array.isArray(polyPts)) {
      for (const p of polyPts) {
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          bounds.extend(p);
          extended = true;
        }
      }
    }

    const stops = state.routeData?.stops?.[routeId];
    if (Array.isArray(stops)) {
      for (const s of stops) {
        if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
          bounds.extend([s.latitude, s.longitude]);
          extended = true;
        }
      }
    }
  }

  return extended ? bounds : null;
}

/**
 * Zoom + pan the map so every currently-visible route fits cleanly
 * inside the on-screen map area. "On-screen" here is narrower than
 * the map container itself because the pinned-stop panel overlays the
 * top of the map and, on mobile, the bottom sheet handle overlays the
 * bottom. We read both from the live DOM so the padding always matches
 * what the user actually sees, rather than hard-coding constants that
 * would drift when panel heights change.
 *
 * Called:
 *   - Once on init() after the first data load, so first-run visitors
 *     land on a sensible frame instead of the hard-coded MIT center.
 *   - On every user route toggle, so turning routes on/off reframes
 *     the map to match.
 *
 * No-ops if no routes are toggled on — we leave the current view alone
 * rather than jumping to some arbitrary default.
 */
function fitMapToVisibleRoutes({ animate = true } = {}) {
  if (!state.map) return;

  // Make sure Leaflet's idea of the container size is current. The
  // pinned panel can show/hide between renders, which changes the
  // map container's box without Leaflet knowing about it.
  state.map.invalidateSize({ animate: false, pan: false });

  const bounds = computeVisibleRouteBounds();
  if (!bounds || !bounds.isValid()) return;

  // Measure overlays so we can pad around them. offsetHeight returns 0
  // for hidden elements, so the hidden-state case handles itself.
  const pinnedPanel = document.getElementById('pinned-panel');
  const pinnedHeight = pinnedPanel && !pinnedPanel.classList.contains('hidden')
    ? pinnedPanel.offsetHeight
    : 0;

  // On mobile the sidebar is a bottom sheet that overlays the bottom
  // of the map. In its collapsed state only the handle is visible —
  // ~70px per initMobileSheet. On desktop the sidebar is a sibling
  // of the map, not an overlay, so no bottom reserve is needed.
  const isMobile = window.innerWidth <= 768;
  const sidebar = document.getElementById('sidebar');
  const sheetCollapsed = sidebar?.classList.contains('collapsed');
  const bottomReserve = isMobile
    ? (sheetCollapsed ? 80 : Math.min(sidebar?.offsetHeight ?? 0, 260))
    : 0;

  state.map.fitBounds(bounds, {
    // paddingTopLeft / paddingBottomRight let us pad the top more than
    // the bottom (to clear the pinned panel) without cropping the route
    // unnecessarily on either side.
    paddingTopLeft:    [24, pinnedHeight + 24],
    paddingBottomRight:[24, bottomReserve + 24],
    // Clamp how far Leaflet is willing to zoom IN. Without this, a
    // small route (just a couple close stops) would zoom to street
    // level and lose all context.
    maxZoom: 17,
    animate,
  });
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

      // Reframe the map so the newly-toggled route is visible. Animated
      // so the user can see the zoom transition as a direct result of
      // their click, not a mysterious jump.
      fitMapToVisibleRoutes({ animate: true });
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
    // Fetch bus GPS, pinned-stop ETAs, and authoritative per-bus route
    // positions all in parallel. The ETA and positions calls each wrap
    // their own errors (never reject), so a failure in either can't
    // block the GPS update that the map depends on.
    //
    // `refreshPinnedRoutePositions` is the key change that makes
    // lollipop routes work correctly: it asks Passio "which stop is
    // each bus approaching?" instead of making us guess from lat/lng.
    const [vehiclesResult] = await Promise.all([
      fetchAllVehicles(),
      refreshPinnedEtas(),
      refreshPinnedRoutePositions(),
    ]);
    const { vehicles, errors } = vehiclesResult;
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

    // Precompute polyline geometry for every route that has a polyline.
    // This is the engine behind route-aware bus progress (lollipop-safe
    // matching on out-and-back segments like Grad Junction West). It's a
    // one-time cost at startup — ~334 vertices × 12 stops for Tech
    // Shuttle is measured in microseconds, and nothing re-runs it at
    // poll time.
    for (const routeId of Object.keys(routeData.routePoints || {})) {
      try {
        precomputeRouteGeometry(routeId);
      } catch (e) {
        console.warn(`Could not precompute geometry for ${routeId}:`, e);
      }
    }

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

    // Now that the pinned panel has been rendered (by updateData ->
    // renderPinnedPanel), its DOM height is measurable — which means
    // fitMapToVisibleRoutes can pad around it correctly. Run it on
    // the next animation frame so any layout-affecting render from
    // updateData has already landed. No animation on first fit — the
    // user shouldn't see the map "swoosh" into place, it should just
    // open already framed.
    requestAnimationFrame(() => fitMapToVisibleRoutes({ animate: false }));

    // Start periodic updates
    state.updateTimer = setInterval(updateData, UPDATE_INTERVAL);

    // Separate 1-second tick that advances ETA countdowns in place on the
    // already-rendered DOM, so the displayed "3m 42s" decrements smoothly
    // instead of only updating once every 5-second API poll. Pauses
    // implicitly when nothing is pinned (the loop is a no-op because there
    // are no matching DOM nodes).
    state.etaTickTimer = setInterval(updateEtaLabelsInPlace, 1000);

    console.log('✅ MIT Shuttle Tracker initialized');

  } catch (error) {
    console.error('Initialization error:', error);
    updateStatus(false, 'Failed to load - check console');
  }
}

// TEMP: expose state on window for live debugging of polyline geometry.
// Safe to remove — nothing reads this outside the browser devtools.
if (typeof window !== 'undefined') window.__shuttleState = state;

// Start the app
init();
