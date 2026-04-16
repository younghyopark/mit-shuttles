/**
 * MIT Shuttle Tracker - API Client
 * Communicates with Passio GO! API to fetch shuttle data
 * for multiple transit systems (MIT + Charles River TMA's EZRide).
 */

const BASE_URL = 'https://passiogo.com';
const MBTA_BASE = 'https://api-v3.mbta.com';

/**
 * All transit systems we pull data from. Keys are used as route-ID prefixes
 * throughout the app to keep a flat, collision-free keyspace.
 *
 * `type` determines which API backend to query:
 *   - 'passio' (default) — Passio GO
 *   - 'mbta'             — MBTA V3 REST API
 */
export const SYSTEMS = {
  mit:      { id: '94',   label: 'MIT',       chip: 'MIT',  type: 'passio' },
  ezride:   { id: '5019', label: 'EZRide',    chip: 'EZR',  type: 'passio' },
  longwood: { id: '6986', label: 'Longwood',   chip: 'LMA', type: 'passio', onlyRoutes: ['67526'] },
  mbta1:    { label: 'MBTA', chip: 'T', type: 'mbta', mbtaRouteId: '1', onlyRoutes: ['1'] },
};

// Back-compat export for any code still referencing MIT_SYSTEM_ID directly.
export const MIT_SYSTEM_ID = SYSTEMS.mit.id;

/**
 * Prefix a raw route ID (as the Passio API returns it) with our system key.
 * Example: prefixRouteId('mit', '63220') -> 'mit:63220'
 */
function prefixRouteId(systemKey, routeId) {
  return `${systemKey}:${String(routeId)}`;
}

/**
 * Make a POST request to the Passio GO API
 */
async function apiRequest(endpoint, params) {
  const url = `${BASE_URL}/${endpoint}`;

  const body = new URLSearchParams({
    json: JSON.stringify(params)
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString()
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`API Error (${endpoint}):`, error);
    throw error;
  }
}

/**
 * Decide whether a raw route from the API should be shown in the UI at all.
 * Only drops the never-user-facing operator routes (OOS / Charter). Routes
 * marked `outdated: "1"` (not currently running) are kept so the picker can
 * still surface them under a "Not running now" section.
 */
function shouldShowRoute(rawRoute) {
  if (!rawRoute || !rawRoute.name) return false;
  if (rawRoute.name.includes('OOS') || rawRoute.name.includes('Charter')) return false;
  return true;
}

/**
 * Fetch all routes for a single system, prefixed with the system key.
 * Each route carries an `active` boolean (true = currently running, false =
 * Passio marked it `outdated: "1"`). The UI decides how to display them.
 */
export async function fetchRoutes(systemKey) {
  const system = SYSTEMS[systemKey];
  if (!system) throw new Error(`Unknown system: ${systemKey}`);
  if (system.type === 'mbta') return fetchRoutes_MBTA(systemKey);

  const data = await apiRequest('mapGetData.php?getRoutes=2', {
    systemSelected0: system.id,
    amount: 1
  });

  const rawRoutes = data.all || [];
  return rawRoutes
    .filter(shouldShowRoute)
    .filter(route => {
      // If the system defines an onlyRoutes whitelist, restrict to those IDs.
      if (system.onlyRoutes) return system.onlyRoutes.includes(String(route.myid));
      return true;
    })
    .map(route => ({
      ...route,
      myid: prefixRouteId(systemKey, route.myid),
      _rawMyid: String(route.myid),
      systemKey,
      active: String(route.outdated) !== '1',
    }));
}

/**
 * Fetch real-time vehicle positions for a single system, with prefixed routeIds.
 */
export async function fetchVehicles(systemKey) {
  const system = SYSTEMS[systemKey];
  if (!system) throw new Error(`Unknown system: ${systemKey}`);
  if (system.type === 'mbta') return fetchVehicles_MBTA(systemKey);

  const data = await apiRequest('mapGetData.php?getBuses=2', {
    s0: system.id,
    sA: 1
  });

  const vehicles = [];
  const buses = data.buses || {};
  const allowed = system.onlyRoutes ? new Set(system.onlyRoutes) : null;

  for (const [deviceId, busList] of Object.entries(buses)) {
    if (Array.isArray(busList)) {
      for (const bus of busList) {
        if (allowed && !allowed.has(String(bus.routeId))) continue;
        vehicles.push({
          id: `${systemKey}:${deviceId}`,
          busNumber: bus.bus || bus.busName || bus.busId,
          routeId: prefixRouteId(systemKey, bus.routeId),
          routeName: bus.route,
          routeColor: bus.color,
          systemKey,
          latitude: parseFloat(bus.latitude),
          longitude: parseFloat(bus.longitude),
          heading: parseFloat(bus.calculatedCourse || 0),
          passengers: bus.paxLoad || 0,
          capacity: bus.totalCap || 0,
          lastUpdate: bus.createdTime,
          outOfService: bus.outOfService === 1
        });
      }
    }
  }

  return vehicles;
}

/**
 * Fetch route paths (polylines) and stops together for a single system.
 * All top-level keys in the returned routePoints / stops / routeInfo
 * are prefixed with the systemKey.
 */
export async function fetchRouteData(systemKey) {
  const system = SYSTEMS[systemKey];
  if (!system) throw new Error(`Unknown system: ${systemKey}`);
  if (system.type === 'mbta') return fetchRouteData_MBTA(systemKey);

  try {
    const data = await apiRequest('mapGetData.php?getStops=2', {
      s0: system.id,
      sA: 1
    });

    const allowed = system.onlyRoutes ? new Set(system.onlyRoutes) : null;

    // Extract route points (polylines), keyed by prefixed routeId
    const routePoints = {};
    if (data.routePoints) {
      for (const [rawRouteId, pointsArray] of Object.entries(data.routePoints)) {
        if (allowed && !allowed.has(String(rawRouteId))) continue;
        if (Array.isArray(pointsArray) && pointsArray.length > 0) {
          const points = pointsArray[0];
          if (Array.isArray(points)) {
            routePoints[prefixRouteId(systemKey, rawRouteId)] = points.map(p => [
              parseFloat(p.lat),
              parseFloat(p.lng)
            ]);
          }
        }
      }
    }

    // Build a lookup of stops by their numeric ID.
    // Each stop carries a prefixed routeId if it has one.
    const stopsById = {};
    if (data.stops) {
      for (const [stopKey, stop] of Object.entries(data.stops)) {
        if (stop && typeof stop === 'object') {
          const stopId = String(stop.id || stopKey.replace('ID', ''));
          stopsById[stopId] = {
            id: stopId,
            name: stop.name,
            latitude: parseFloat(stop.latitude),
            longitude: parseFloat(stop.longitude),
            // Passio's own "at-stop" geofence radius, in meters. Used by the
            // UI to decide when a bus is parked at the stop vs in-transit.
            radius: Number.isFinite(parseFloat(stop.radius)) ? parseFloat(stop.radius) : 50,
            routeId: stop.routeId ? prefixRouteId(systemKey, stop.routeId) : null,
            routeName: stop.routeName,
            systemKey,
          };
        }
      }
    }

    // Group stops by prefixed routeId
    const stops = {};
    for (const stop of Object.values(stopsById)) {
      if (stop.routeId) {
        if (!stops[stop.routeId]) {
          stops[stop.routeId] = [];
        }
        stops[stop.routeId].push(stop);
      }
    }

    // Extract route metadata (name, color) and stops from route references
    const routeInfo = {};
    if (data.routes) {
      for (const [rawRouteId, routeData] of Object.entries(data.routes)) {
        if (allowed && !allowed.has(String(rawRouteId))) continue;
        if (Array.isArray(routeData) && routeData.length >= 2) {
          const prefixedRouteId = prefixRouteId(systemKey, rawRouteId);
          routeInfo[prefixedRouteId] = {
            name: routeData[0],
            color: routeData[1],
            systemKey,
          };

          // If this route doesn't have stops from routeId grouping,
          // extract stops from the route's stop references (index 2+)
          if (!stops[prefixedRouteId] || stops[prefixedRouteId].length === 0) {
            const routeStops = [];
            const seenStopIds = new Set();

            for (let i = 2; i < routeData.length; i++) {
              const ref = routeData[i];
              if (Array.isArray(ref) && ref.length >= 2) {
                const stopId = String(ref[1]);
                if (!seenStopIds.has(stopId) && stopsById[stopId]) {
                  seenStopIds.add(stopId);
                  routeStops.push({
                    ...stopsById[stopId],
                    sequence: parseInt(ref[0], 10),
                    routeId: prefixedRouteId,
                    routeName: routeData[0],
                  });
                }
              }
            }

            if (routeStops.length > 0) {
              routeStops.sort((a, b) => a.sequence - b.sequence);
              stops[prefixedRouteId] = routeStops;
            }
          }
        }
      }
    }

    return { routePoints, stops, routeInfo };
  } catch (error) {
    console.warn(`Could not fetch route data for ${systemKey}:`, error);
    return { routePoints: {}, stops: {}, routeInfo: {} };
  }
}

// ---------------------------------------------------------------------------
// MBTA V3 API helpers
// ---------------------------------------------------------------------------

async function mbtaRequest(endpoint) {
  const res = await fetch(`${MBTA_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`MBTA HTTP ${res.status}`);
  return res.json();
}

/** Decode a Google-encoded polyline string into [[lat, lng], ...]. */
function decodeGooglePolyline(str) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

async function fetchRoutes_MBTA(systemKey) {
  const system = SYSTEMS[systemKey];
  const data = await mbtaRequest(`/routes/${system.mbtaRouteId}`);
  const r = data.data;
  return [{
    myid: prefixRouteId(systemKey, r.id),
    _rawMyid: String(r.id),
    systemKey,
    name: r.attributes.long_name || `Route ${r.attributes.short_name || r.id}`,
    color: r.attributes.color ? `#${r.attributes.color}` : '#FFC72C',
    active: true,
  }];
}

async function fetchVehicles_MBTA(systemKey) {
  const system = SYSTEMS[systemKey];
  const dir = system.mbtaDirection ?? 0;
  const data = await mbtaRequest(`/vehicles?filter[route]=${system.mbtaRouteId}&filter[direction_id]=${dir}`);
  return (data.data || []).map(v => ({
    id: `${systemKey}:${v.id}`,
    busNumber: v.id,
    routeId: prefixRouteId(systemKey, system.mbtaRouteId),
    routeName: `Route ${system.mbtaRouteId}`,
    routeColor: '#FFC72C',
    systemKey,
    latitude: parseFloat(v.attributes.latitude),
    longitude: parseFloat(v.attributes.longitude),
    heading: parseFloat(v.attributes.bearing || 0),
    passengers: 0,
    capacity: 0,
    lastUpdate: v.attributes.updated_at,
    outOfService: false,
  }));
}

async function fetchRouteData_MBTA(systemKey) {
  const system = SYSTEMS[systemKey];
  const rid = system.mbtaRouteId;
  const prefixed = prefixRouteId(systemKey, rid);

  // direction_id=0 gives northbound (Nubian → Harvard) — one direction only
  // so we get ~24 stops in service order instead of 46 from both directions.
  const dir = system.mbtaDirection ?? 0;
  const [stopsRes, shapesRes] = await Promise.all([
    mbtaRequest(`/stops?filter[route]=${rid}&filter[direction_id]=${dir}&fields[stop]=name,latitude,longitude`),
    mbtaRequest(`/shapes?filter[route]=${rid}`),
  ]);

  // Stops — group under the prefixed route ID (already in service order)
  const stops = {};
  const stopList = (stopsRes.data || []).map((s, idx) => ({
    id: String(s.id),
    name: s.attributes.name,
    latitude: parseFloat(s.attributes.latitude),
    longitude: parseFloat(s.attributes.longitude),
    radius: 30,
    routeId: prefixed,
    routeName: `Route ${rid}`,
    systemKey,
    sequence: idx,
  }));
  stops[prefixed] = stopList;

  // Route polyline — take the first (longest) shape
  const routePoints = {};
  const shapes = shapesRes.data || [];
  if (shapes.length > 0) {
    // Pick the shape with the most points (longest variant)
    let bestShape = shapes[0];
    let bestLen = 0;
    for (const sh of shapes) {
      const decoded = decodeGooglePolyline(sh.attributes.polyline || '');
      if (decoded.length > bestLen) {
        bestLen = decoded.length;
        bestShape = sh;
      }
    }
    routePoints[prefixed] = decodeGooglePolyline(bestShape.attributes.polyline || '');
  }

  const routeInfo = {
    [prefixed]: { name: `Route ${rid}`, color: '#FFC72C', systemKey },
  };

  return { routePoints, stops, routeInfo };
}

async function fetchStopETAs_MBTA(rawRouteId, stopIdRaw) {
  if (!rawRouteId || !stopIdRaw) return [];
  try {
    const data = await mbtaRequest(
      `/predictions?filter[route]=${rawRouteId}&filter[stop]=${stopIdRaw}&sort=arrival_time`
    );
    const nowMs = Date.now();
    return (data.data || [])
      .filter(p => p.attributes.arrival_time)
      .map(p => {
        const arrMs = new Date(p.attributes.arrival_time).getTime();
        const secs = Math.max(0, Math.round((arrMs - nowMs) / 1000));
        const veh = p.relationships?.vehicle?.data;
        return {
          busName: veh ? String(veh.id) : '?',
          deviceId: null,
          busId: null,
          secondsUntil: secs,
          arrivalEpochMs: arrMs,
          solid: true,
          updatedSecAgo: null,
          outOfService: false,
          speed: null,
          raw: p,
        };
      })
      .filter(e => e.secondsUntil < 7200); // drop predictions >2h out
  } catch (error) {
    console.warn(`MBTA ETA fetch failed for route=${rawRouteId} stop=${stopIdRaw}:`, error);
    return [];
  }
}

/**
 * MBTA route positions: use the vehicles endpoint to find which stop each
 * bus is currently at or heading to, then map the stop ID to our stop-list
 * index to produce `routeStopPosition`. This gives the pinned panel
 * authoritative "stops away" data without GPS polyline projection.
 */
async function fetchRoutePositions_MBTA(systemKey, rawRouteId) {
  const system = SYSTEMS[systemKey];
  if (!system) return [];
  const dir = system.mbtaDirection ?? 0;
  try {
    const data = await mbtaRequest(
      `/vehicles?filter[route]=${rawRouteId}&filter[direction_id]=${dir}&include=stop`
    );
    // Build a stop-id → index lookup from our cached route data.
    // We need the stop list for this route to resolve indices.
    // The caller (refreshPinnedRoutePositionsForSlot) will use the
    // routeStopPosition to compute fractional bus progress.
    const included = data.included || [];
    const out = [];
    for (const v of data.data || []) {
      const stopRel = v.relationships?.stop?.data;
      if (!stopRel) continue;
      const stopId = stopRel.id;
      // current_stop_sequence from GTFS — 0-indexed position in this trip
      const seq = v.attributes.current_stop_sequence;
      // Map GTFS sequence (which may start at a non-zero value and may have
      // gaps) to a 0-based ordinal.  The sequence values the MBTA returns
      // start at 0 for the first stop and increment by 10 (or similar).
      // We normalise by dividing/rounding to get an approximate index.
      // A more robust approach: look up the stop ID in the stop list we
      // already loaded (state.routeData.stops) — but that lives in main.js,
      // not here. So we pass the raw sequence and let the consumer cope.
      out.push({
        busName: String(v.id),
        routeStopPosition: seq != null ? seq : 0,
        routePointPosition: null,
        stopRoutePointPosition: null,
        tripId: v.relationships?.trip?.data?.id || null,
        routeBlockId: null,
        dwell: null,
        // Extra MBTA-specific: pass the actual stop ID so the consumer can
        // resolve a reliable index from the stop list.
        _mbtaStopId: stopId,
        raw: v,
      });
    }
    return out;
  } catch (error) {
    console.warn(`MBTA position fetch failed for route=${rawRouteId}:`, error);
    return [];
  }
}

/**
 * Fetch routes + route data from every configured system in parallel.
 * Uses Promise.allSettled so one system failing doesn't break the others.
 *
 * Returns:
 *   {
 *     routes: [...],                            // flat, prefixed, filtered
 *     routeData: { routePoints, stops, routeInfo },  // merged, prefixed
 *     errors: [{ systemKey, error }]            // non-fatal failures, if any
 *   }
 */
export async function fetchAllRoutesAndData() {
  const systemKeys = Object.keys(SYSTEMS);

  const results = await Promise.allSettled(
    systemKeys.flatMap(key => [
      fetchRoutes(key),
      fetchRouteData(key),
    ])
  );

  const allRoutes = [];
  const merged = { routePoints: {}, stops: {}, routeInfo: {} };
  const errors = [];

  for (let i = 0; i < systemKeys.length; i++) {
    const key = systemKeys[i];
    const routesResult = results[i * 2];
    const routeDataResult = results[i * 2 + 1];

    if (routesResult.status === 'fulfilled') {
      allRoutes.push(...routesResult.value);
    } else {
      errors.push({ systemKey: key, error: routesResult.reason });
    }

    if (routeDataResult.status === 'fulfilled') {
      Object.assign(merged.routePoints, routeDataResult.value.routePoints);
      Object.assign(merged.stops, routeDataResult.value.stops);
      Object.assign(merged.routeInfo, routeDataResult.value.routeInfo);
    } else {
      errors.push({ systemKey: key, error: routeDataResult.reason });
    }
  }

  return { routes: allRoutes, routeData: merged, errors };
}

/**
 * Fetch ETAs for a single (routeId, stopId) from Passio's undocumented
 * `eta=3` endpoint. This is a GET, not a POST, and takes a single stopId —
 * multi-stop queries ({@code stopIds=a,b} / {@code stopIds[]=a&stopIds[]=b}
 * / repeated params) all return only one stop, so callers that need ETAs
 * for multiple stops must parallelize the requests.
 *
 * routeId and stopId must be RAW Passio ids (no `mit:` / `ezride:` prefix).
 *
 * Passio serves TWO different response shapes from this endpoint depending
 * on whether their "solid ETA" path (historical DB lookup) is currently
 * healthy. We tolerate both:
 *
 *  - "solid" shape (what we usually see): {busName, secondsSpent, eta, etaR,
 *    solid:1, updatedSecAgo, driver, paxLoadS, scheduleTimes, ...} — no
 *    deviceId, no busId, no arrivalTimestamp.
 *  - "live" shape (fallback when solid DB lookup errors): a much richer
 *    payload including {deviceId, busId, routePointPosition,
 *    busProjectionLatlng, arrivalTimestamp, ...}.
 *
 * `busName` is the one field guaranteed in both shapes, and it matches
 * `vehicle.busNumber` in the rest of the app — that's how callers should
 * join ETAs back to bus records.
 *
 * "No buses" is encoded as a sentinel entry under stop key "0000" with
 * `eta === "no vehicles"` and `secondsSpent === 86400`; we filter those out
 * and return an empty array.
 *
 * Returns an array of:
 *   {
 *     busName:        string,          // user-facing bus number, e.g. "210"
 *     deviceId:       string | null,   // present only in "live" shape
 *     busId:          string | null,   // present only in "live" shape
 *     secondsUntil:   number,          // seconds until arrival (integer)
 *     arrivalEpochMs: number,          // client-clock arrival timestamp (ms)
 *     solid:          boolean,         // true if Passio's DB-backed prediction
 *     updatedSecAgo:  number | null,   // staleness of underlying bus position
 *     outOfService:   boolean,
 *     speed:          number | null,   // only in "live" shape
 *     raw:            object           // original entry for debugging
 *   }
 *
 * Never throws — errors are logged and an empty array is returned, so a
 * failing ETA call cannot break the main render loop.
 */
export async function fetchStopETAs(systemKey, routeIdRaw, stopIdRaw) {
  if (!routeIdRaw || !stopIdRaw) return [];
  const system = systemKey ? SYSTEMS[systemKey] : null;
  if (system?.type === 'mbta') return fetchStopETAs_MBTA(routeIdRaw, stopIdRaw);

  const params = new URLSearchParams({
    eta: '3',
    routeId: String(routeIdRaw),
    stopIds: String(stopIdRaw),
  });
  const url = `${BASE_URL}/mapGetData.php?${params.toString()}`;

  let data;
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    console.warn(`ETA fetch failed for route=${routeIdRaw} stop=${stopIdRaw}:`, error);
    return [];
  }

  const etaMap = data?.ETAs || {};
  // Anchor countdowns to the CLIENT clock rather than Passio's
  // `arrivalTimestamp` (which is server time and can drift). `secondsSpent`
  // is relative to "now" on the server, which matches "now" on the client
  // closely enough for second-level ETAs.
  const nowMs = Date.now();

  const out = [];
  for (const [stopKey, arr] of Object.entries(etaMap)) {
    if (!Array.isArray(arr)) continue;
    // "No vehicles" sentinel — stopKey "0000" with placeholder entries.
    if (stopKey === '0000') continue;
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      if (e.eta === 'no vehicles') continue;
      if (!e.busName) continue; // can't join back to a bus without a name
      // secondsSpent >= 86400 is Passio's "no prediction available" marker.
      const secs = Number(e.secondsSpent);
      if (!Number.isFinite(secs) || secs >= 86400) continue;
      const secsClamped = Math.max(0, Math.round(secs));
      const updatedAgoNum = Number(e.updatedSecAgo);
      out.push({
        busName:  String(e.busName),
        deviceId: e.deviceId != null ? String(e.deviceId) : null,
        busId:    e.busId    != null ? String(e.busId)    : null,
        secondsUntil:   secsClamped,
        arrivalEpochMs: nowMs + secsClamped * 1000,
        solid: e.solid === 1 || e.solid === '1' || e.solid === true,
        updatedSecAgo: Number.isFinite(updatedAgoNum) ? updatedAgoNum : null,
        outOfService:  !!e.OOS || e.outOfService === true,
        speed: Number.isFinite(Number(e.speed)) ? Number(e.speed) : null,
        raw: e,
      });
    }
  }

  // Sort by soonest first so the caller doesn't have to.
  out.sort((a, b) => a.secondsUntil - b.secondsUntil);
  return out;
}

/**
 * Fetch authoritative per-bus route positions for a single route.
 *
 * This hits the same `eta=3` endpoint as fetchStopETAs, but WITHOUT a
 * `stopIds` parameter. That query mode returns the rich "live" response
 * shape — a per-bus record for every bus on the route, including:
 *
 *   - `routeStopPosition`  — the integer service-sequence index of the
 *                            bus's current/next stop. This is the field
 *                            that makes the whole pinned-panel math work
 *                            without GPS projection on our end.
 *   - `routePointPosition` — the bus's current polyline vertex index
 *                            (-1 when dwelling at a stop). Used to
 *                            interpolate fractional progress between
 *                            stops for smooth UI positioning.
 *   - `stopRoutePointPosition`, `tripId`, `routeBlockId`, `dwell`, etc.
 *
 * Important semantic note about this response shape:
 *
 *   Every bus record is nested under a top-level stop key (Passio appears
 *   to aggregate the whole route under its "home" stop), and the
 *   `secondsSpent` / `eta` fields in this shape are the ETA to THAT
 *   outer-key stop — i.e. the route's terminus, not the bus's next stop.
 *   So don't use `secondsSpent` from here for per-stop ETAs — use
 *   `fetchStopETAs()` with an explicit `stopIds` for that.
 *
 * Returns an array of:
 *   {
 *     busName:                string,
 *     routeStopPosition:      number,          // 0-indexed into service sequence
 *     routePointPosition:     number | null,   // null when -1 / invalid
 *     stopRoutePointPosition: number | null,
 *     tripId:                 string | null,
 *     routeBlockId:           string | null,
 *     dwell:                  number | null,   // seconds spent at current stop
 *     raw:                    object,
 *   }
 *
 * Never throws — errors are logged and an empty array is returned so a
 * failing position fetch can't break the rest of the render loop.
 */
export async function fetchRoutePositions(systemKey, routeIdRaw) {
  if (!routeIdRaw) return [];
  const system = systemKey ? SYSTEMS[systemKey] : null;
  if (system?.type === 'mbta') return fetchRoutePositions_MBTA(systemKey, routeIdRaw);

  const params = new URLSearchParams({
    eta: '3',
    routeId: String(routeIdRaw),
  });
  const url = `${BASE_URL}/mapGetData.php?${params.toString()}`;

  let data;
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    console.warn(`Position fetch failed for route=${routeIdRaw}:`, error);
    return [];
  }

  const etaMap = data?.ETAs || {};
  const out = [];
  for (const [stopKey, arr] of Object.entries(etaMap)) {
    if (!Array.isArray(arr)) continue;
    // "No vehicles" sentinel: stopKey "0000" with placeholder entries.
    if (stopKey === '0000') continue;
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      if (!e.busName) continue;
      if (e.eta === 'no vehicles') continue;

      // routeStopPosition is the field we actually care about. If it's
      // missing or non-numeric, we can't use this record at all.
      const rsp = Number(e.routeStopPosition);
      if (!Number.isFinite(rsp)) continue;

      const rpp = Number(e.routePointPosition);
      // Passio uses -1 as "currently at a stop, no in-transit polyline
      // index." Normalize to null so callers can check one thing.
      const rppNormalized = Number.isFinite(rpp) && rpp >= 0 ? rpp : null;

      const srpp = Number(e.stopRoutePointPosition);
      const dwell = Number(e.dwell);

      out.push({
        busName: String(e.busName),
        routeStopPosition: rsp,
        routePointPosition: rppNormalized,
        stopRoutePointPosition: Number.isFinite(srpp) ? srpp : null,
        tripId:       e.tripId       != null ? String(e.tripId)       : null,
        routeBlockId: e.routeBlockId != null ? String(e.routeBlockId) : null,
        dwell: Number.isFinite(dwell) ? dwell : null,
        raw: e,
      });
    }
  }

  return out;
}

/**
 * Fetch real-time vehicles from every configured system in parallel.
 * Returns a flat vehicles array plus any per-system errors.
 */
export async function fetchAllVehicles() {
  const systemKeys = Object.keys(SYSTEMS);

  const results = await Promise.allSettled(
    systemKeys.map(key => fetchVehicles(key))
  );

  const vehicles = [];
  const errors = [];

  for (let i = 0; i < systemKeys.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      vehicles.push(...result.value);
    } else {
      errors.push({ systemKey: systemKeys[i], error: result.reason });
    }
  }

  return { vehicles, errors };
}

export const API = {
  fetchRoutes,
  fetchVehicles,
  fetchRouteData,
  fetchAllRoutesAndData,
  fetchAllVehicles,
  fetchStopETAs,
  fetchRoutePositions,
  SYSTEMS,
  MIT_SYSTEM_ID,
};
