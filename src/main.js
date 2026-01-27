/**
 * MIT Shuttle Tracker - Main Application
 */

import L from 'leaflet';
import { fetchRoutes, fetchVehicles, fetchRouteData } from './api.js';

// MIT Campus center coordinates
const MIT_CENTER = [42.3601, -71.0942];
const DEFAULT_ZOOM = 15;

// Update interval in milliseconds
const UPDATE_INTERVAL = 5000;

// LocalStorage key for route display preferences
const STORAGE_KEY = 'mit-shuttle-route-display';

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
 * Load route display preferences from localStorage
 */
function loadRouteDisplayPrefs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.warn('Could not load route preferences:', e);
  }
  return {};
}

/**
 * Create a custom bus marker icon with direction arrow
 */
function createBusIcon(color = '#a31f34', heading = 0) {
  return L.divIcon({
    className: 'bus-marker-container',
    html: `
      <div class="bus-marker-wrapper">
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
 * Create popup content for a stop with bus distance info
 */
function createStopPopupContent(stopData) {
  const { name, routeName, routeId, stopIndex, totalStops } = stopData;
  
  // Find buses on this route
  const routeBuses = state.vehicles.filter(v => String(v.routeId) === routeId);
  
  let busInfo = '';
  if (routeBuses.length === 0) {
    busInfo = '<p class="no-buses">No active buses on this route</p>';
  } else {
    // Get the stops for this route to calculate distance
    const routeStops = state.routeData?.stops[routeId] || [];
    
    const busDistances = routeBuses.map(bus => {
      // Find which stop the bus is closest to
      const busStopIndex = findClosestStopIndex(bus, routeStops);
      
      if (busStopIndex === -1) {
        return { bus, stopsAway: null };
      }
      
      // Calculate stops away (considering circular routes)
      let stopsAway = stopIndex - busStopIndex;
      if (stopsAway < 0) {
        stopsAway += totalStops; // Wrap around for circular routes
      }
      
      return { bus, stopsAway, busStopIndex };
    });
    
    // Sort by stops away
    busDistances.sort((a, b) => (a.stopsAway ?? 999) - (b.stopsAway ?? 999));
    
    busInfo = '<div class="bus-distances">';
    for (const { bus, stopsAway } of busDistances) {
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
  
  return `
    <div class="popup-content stop-popup">
      <h3>🚏 ${name}</h3>
      <p class="route-label"><strong>Route:</strong> ${routeName}</p>
      <p class="stop-number">Stop ${stopIndex + 1} of ${totalStops}</p>
      <hr>
      ${busInfo}
    </div>
  `;
}

/**
 * Find the closest stop index for a bus based on its position
 */
function findClosestStopIndex(bus, stops) {
  if (!stops || stops.length === 0) return -1;
  
  let closestIndex = -1;
  let closestDistance = Infinity;
  
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    if (!stop.latitude || !stop.longitude) continue;
    
    const distance = Math.sqrt(
      Math.pow(bus.latitude - stop.latitude, 2) +
      Math.pow(bus.longitude - stop.longitude, 2)
    );
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }
  
  return closestIndex;
}

/**
 * Update route and stop visibility
 */
function updateRouteDisplay() {
  drawRouteLines();
  drawStopMarkers();
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
      marker.setIcon(createBusIcon(routeColor, vehicle.heading));
      marker.getPopup().setContent(popupContent);
    } else {
      // Create new marker
      const marker = L.marker([vehicle.latitude, vehicle.longitude], {
        icon: createBusIcon(routeColor, vehicle.heading)
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
  
  if (vehicles.length === 0) {
    container.innerHTML = '<p class="loading">No active shuttles</p>';
    return;
  }
  
  container.innerHTML = vehicles.map(vehicle => {
    // Use route info directly from vehicle data
    const routeName = vehicle.routeName || 'Unknown Route';
    const routeColor = vehicle.routeColor || '#a31f34';
    const loadPercent = vehicle.capacity > 0 ? Math.round((vehicle.passengers / vehicle.capacity) * 100) : 0;
    
    return `
      <div class="shuttle-card" style="--route-color: ${routeColor}" data-vehicle-id="${vehicle.id}">
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
  
  // Filter out service routes
  const activeRoutes = state.routes.filter(r => 
    !r.name.includes('OOS') && !r.name.includes('Charter')
  );
  
  const routesHtml = activeRoutes.map(route => {
    const routeIdStr = String(route.myid);
    const isShowing = state.routeDisplay.get(routeIdStr) === true;
    return `
      <div class="route-filter ${isShowing ? 'active' : ''}">
        <button class="route-toggle-btn" data-route-id="${routeIdStr}" title="Show/hide route path and stops">
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
 * Update connection status indicator
 */
function updateStatus(connected, message) {
  const dot = document.getElementById('connection-status');
  const text = document.getElementById('last-update');
  
  dot.className = 'status-dot ' + (connected ? 'connected' : 'error');
  text.textContent = message;
}

/**
 * Fetch and update all data
 */
async function updateData() {
  try {
    // Fetch vehicles
    state.vehicles = await fetchVehicles();
    
    // Update UI - show all vehicles
    updateVehicleMarkers(state.vehicles);
    renderShuttleList(state.vehicles);
    
    const now = new Date().toLocaleTimeString();
    updateStatus(true, `Updated: ${now} • ${state.vehicles.length} shuttles`);
    
  } catch (error) {
    console.error('Update error:', error);
    updateStatus(false, 'Connection error - retrying...');
  }
}

/**
 * Initialize the application
 */
async function init() {
  console.log('🚌 MIT Shuttle Tracker starting...');
  
  // Initialize map
  initMap();
  
  try {
    // Fetch initial data
    updateStatus(false, 'Loading routes...');
    state.routes = await fetchRoutes();
    
    // Load saved route display preferences
    const savedPrefs = loadRouteDisplayPrefs();
    
    // Initialize route display from saved prefs or default to hidden
    state.routes.forEach(route => {
      const routeId = String(route.myid);
      state.routeDisplay.set(routeId, savedPrefs[routeId] === true);
    });
    
    // Fetch route paths and stops
    updateStatus(false, 'Loading route data...');
    state.routeData = await fetchRouteData();
    
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
