/**
 * MIT Shuttle Tracker - API Client
 * Communicates with Passio GO! API to fetch shuttle data
 * for multiple transit systems (MIT + Charles River TMA's EZRide).
 */

const BASE_URL = 'https://passiogo.com';

// Passio GO sends Access-Control-Allow-Origin: * directly on responses,
// so we can call it from the browser without a CORS proxy.

/**
 * All transit systems we pull data from. Keys ('mit', 'ezride') are used as
 * route-ID prefixes throughout the app to keep a flat, collision-free keyspace
 * even though each system numbers its routes independently.
 */
export const SYSTEMS = {
  mit:    { id: '94',   label: 'MIT',    chip: 'MIT' },
  ezride: { id: '5019', label: 'EZRide', chip: 'EZR' },
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

  const data = await apiRequest('mapGetData.php?getRoutes=2', {
    systemSelected0: system.id,
    amount: 1
  });

  const rawRoutes = data.all || [];
  return rawRoutes
    .filter(shouldShowRoute)
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

  const data = await apiRequest('mapGetData.php?getBuses=2', {
    s0: system.id,
    sA: 1
  });

  const vehicles = [];
  const buses = data.buses || {};

  for (const [deviceId, busList] of Object.entries(buses)) {
    if (Array.isArray(busList)) {
      for (const bus of busList) {
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

  try {
    const data = await apiRequest('mapGetData.php?getStops=2', {
      s0: system.id,
      sA: 1
    });

    // Extract route points (polylines), keyed by prefixed routeId
    const routePoints = {};
    if (data.routePoints) {
      for (const [rawRouteId, pointsArray] of Object.entries(data.routePoints)) {
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
  SYSTEMS,
  MIT_SYSTEM_ID,
};
