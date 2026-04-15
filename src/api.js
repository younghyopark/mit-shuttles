/**
 * MIT Shuttle Tracker - API Client
 * Communicates with Passio GO! API to fetch shuttle data
 */

const BASE_URL = 'https://passiogo.com';
const MIT_SYSTEM_ID = '94';

// Passio GO sends Access-Control-Allow-Origin: * directly on responses,
// so we can call it from the browser without a CORS proxy.

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
 * Fetch all routes for MIT
 */
export async function fetchRoutes() {
  const data = await apiRequest('mapGetData.php?getRoutes=2', {
    systemSelected0: MIT_SYSTEM_ID,
    amount: 1
  });
  
  return data.all || [];
}

/**
 * Fetch real-time vehicle positions
 */
export async function fetchVehicles() {
  const data = await apiRequest('mapGetData.php?getBuses=2', {
    s0: MIT_SYSTEM_ID,
    sA: 1
  });
  
  // Flatten the buses object into an array
  const vehicles = [];
  const buses = data.buses || {};
  
  for (const [deviceId, busList] of Object.entries(buses)) {
    if (Array.isArray(busList)) {
      for (const bus of busList) {
        vehicles.push({
          id: deviceId,
          busNumber: bus.bus || bus.busName || bus.busId,
          routeId: bus.routeId,  // Use routeId, not routeBlockId
          routeName: bus.route,  // API provides route name directly!
          routeColor: bus.color, // API provides color directly!
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
 * Fetch route stops
 */
export async function fetchStops() {
  try {
    const data = await apiRequest('mapGetData.php?getStops=2', {
      s0: MIT_SYSTEM_ID,
      sA: 1
    });
    
    // Extract stops from the stops object
    const allStops = [];
    if (data.stops) {
      for (const [stopKey, stop] of Object.entries(data.stops)) {
        if (stop && typeof stop === 'object') {
          allStops.push({
            id: stop.id || stopKey,
            name: stop.name,
            latitude: parseFloat(stop.latitude),
            longitude: parseFloat(stop.longitude),
            routeId: stop.routeId,
            routeName: stop.routeName
          });
        }
      }
    }
    
    return allStops;
  } catch (error) {
    console.warn('Could not fetch stops:', error);
    return [];
  }
}

/**
 * Fetch route paths (polylines) and stops together
 */
export async function fetchRouteData() {
  try {
    const data = await apiRequest('mapGetData.php?getStops=2', {
      s0: MIT_SYSTEM_ID,
      sA: 1
    });
    
    // Extract route points (polylines)
    const routePoints = {};
    if (data.routePoints) {
      for (const [routeId, pointsArray] of Object.entries(data.routePoints)) {
        if (Array.isArray(pointsArray) && pointsArray.length > 0) {
          // Points are nested: [[{lat, lng}, {lat, lng}, ...]]
          const points = pointsArray[0];
          if (Array.isArray(points)) {
            routePoints[routeId] = points.map(p => [
              parseFloat(p.lat),
              parseFloat(p.lng)
            ]);
          }
        }
      }
    }
    
    // Build a lookup of stops by their numeric ID
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
            routeId: stop.routeId,
            routeName: stop.routeName
          };
        }
      }
    }
    
    // Extract stops - group by route using both routeId and route info references
    const stops = {};
    
    // First, group stops that have routeId set
    for (const stop of Object.values(stopsById)) {
      if (stop.routeId) {
        const routeId = String(stop.routeId);
        if (!stops[routeId]) {
          stops[routeId] = [];
        }
        stops[routeId].push(stop);
      }
    }
    
    // Extract route metadata (name, color) and stops from route references
    const routeInfo = {};
    if (data.routes) {
      for (const [routeId, routeData] of Object.entries(data.routes)) {
        if (Array.isArray(routeData) && routeData.length >= 2) {
          routeInfo[routeId] = {
            name: routeData[0],
            color: routeData[1]
          };
          
          // If this route doesn't have stops from routeId grouping,
          // extract stops from the route's stop references (index 2+)
          if (!stops[routeId] || stops[routeId].length === 0) {
            const routeStops = [];
            const seenStopIds = new Set();
            
            for (let i = 2; i < routeData.length; i++) {
              const ref = routeData[i];
              if (Array.isArray(ref) && ref.length >= 2) {
                const stopId = String(ref[1]);
                // Avoid duplicates (some routes have same stop for start/end)
                if (!seenStopIds.has(stopId) && stopsById[stopId]) {
                  seenStopIds.add(stopId);
                  routeStops.push({
                    ...stopsById[stopId],
                    sequence: parseInt(ref[0], 10),
                    routeId: routeId,
                    routeName: routeData[0]
                  });
                }
              }
            }
            
            if (routeStops.length > 0) {
              // Sort by sequence
              routeStops.sort((a, b) => a.sequence - b.sequence);
              stops[routeId] = routeStops;
            }
          }
        }
      }
    }
    
    return { routePoints, stops, routeInfo };
  } catch (error) {
    console.warn('Could not fetch route data:', error);
    return { routePoints: {}, stops: {}, routeInfo: {} };
  }
}

export const API = {
  fetchRoutes,
  fetchVehicles,
  fetchStops,
  fetchRouteData,
  MIT_SYSTEM_ID
};
