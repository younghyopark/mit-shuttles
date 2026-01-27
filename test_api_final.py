"""
MIT Shuttle Tracker - Final API Test
Shows complete API responses and data structure.
"""

import urllib.request
import urllib.parse
import json
from datetime import datetime

BASE_URL = "https://passiogo.com"
MIT_SYSTEM_ID = "94"

def api_request(endpoint, params):
    """Make API request with JSON params."""
    url = f"{BASE_URL}/{endpoint}"
    data = urllib.parse.urlencode({"json": json.dumps(params)}).encode('utf-8')
    
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
            'Origin': 'https://passiogo.com',
        }
    )
    
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode('utf-8'))

def main():
    print("="*70)
    print("🚌 MIT SHUTTLE TRACKER - API VERIFICATION")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*70)
    
    # 1. Get Routes
    print("\n📍 ROUTES")
    print("-"*70)
    routes_data = api_request(
        "mapGetData.php?getRoutes=2",
        {"systemSelected0": MIT_SYSTEM_ID, "amount": 1}
    )
    
    routes = routes_data.get('all', [])
    print(f"Found {len(routes)} routes:\n")
    
    for route in routes:
        print(f"  🚌 {route.get('name')}")
        print(f"     ID: {route.get('id')} | Color: {route.get('color')}")
        print(f"     Schedule enabled: {route.get('goShowSchedule')}")
        print()
    
    # 2. Get Stops
    print("\n🚏 STOPS")
    print("-"*70)
    stops_data = api_request(
        "mapGetData.php?getStops=2",
        {"systemSelected0": MIT_SYSTEM_ID, "amount": 1}
    )
    
    # Stops are nested by route
    all_stops = []
    if 'stops' in stops_data:
        for route_id, stop_list in stops_data['stops'].items():
            if isinstance(stop_list, list):
                all_stops.extend(stop_list)
    
    # Deduplicate by stop ID
    unique_stops = {}
    for stop in all_stops:
        if isinstance(stop, dict):
            unique_stops[stop.get('id')] = stop
    
    print(f"Found {len(unique_stops)} unique stops:\n")
    for i, (stop_id, stop) in enumerate(list(unique_stops.items())[:10]):
        print(f"  📍 {stop.get('name')}")
        print(f"     ID: {stop_id} | Lat: {stop.get('latitude')}, Lng: {stop.get('longitude')}")
    
    if len(unique_stops) > 10:
        print(f"\n  ... and {len(unique_stops) - 10} more stops")
    
    # 3. Get Active Vehicles
    print("\n\n🚌 ACTIVE VEHICLES (Real-time)")
    print("-"*70)
    vehicles_data = api_request(
        "mapGetData.php?getBuses=2",
        {"s0": MIT_SYSTEM_ID, "sA": 1}
    )
    
    buses = vehicles_data.get('buses', {})
    
    if buses:
        total_buses = sum(len(v) if isinstance(v, list) else 1 for v in buses.values())
        print(f"Found {total_buses} active vehicles:\n")
        
        for device_id, bus_list in buses.items():
            if isinstance(bus_list, list):
                for bus in bus_list:
                    print(f"  🚌 Bus #{bus.get('bus', 'N/A')} (Device: {device_id})")
                    print(f"     Route ID: {bus.get('routeBlockId', 'N/A')}")
                    print(f"     Location: ({bus.get('latitude')}, {bus.get('longitude')})")
                    print(f"     Heading: {bus.get('calculatedCourse', 'N/A')}°")
                    print(f"     Passenger Load: {bus.get('paxLoad', 0)} / {bus.get('totalCap', 'N/A')}")
                    print(f"     Last Update: {bus.get('createdTime', 'N/A')}")
                    print(f"     Out of Service: {bus.get('outOfService', 0)}")
                    print()
    else:
        print("  No active vehicles at this time.")
        print("  (Shuttles may not be running - check operating hours)")
    
    # 4. Get Route Details with Coordinates
    print("\n\n🗺️  ROUTE COORDINATES (for map polylines)")
    print("-"*70)
    
    # Get first active route's coordinates
    if routes:
        first_route = routes[0]
        route_id = first_route.get('id')
        print(f"Sample route: {first_route.get('name')} (ID: {route_id})")
        
        # Routes include coordinate points
        points = first_route.get('points', [])
        if points:
            print(f"  Has {len(points)} coordinate points for map drawing")
            if isinstance(points, list) and len(points) > 0:
                print(f"  First point: {points[0] if isinstance(points[0], dict) else points[:2]}")
    
    # Summary
    print("\n\n" + "="*70)
    print("✅ API SUMMARY")
    print("="*70)
    print(f"""
    Base URL:     {BASE_URL}
    MIT System:   ID {MIT_SYSTEM_ID}
    
    Endpoints:
    - Routes:     mapGetData.php?getRoutes=2    ✅ Working
    - Stops:      mapGetData.php?getStops=2     ✅ Working  
    - Vehicles:   mapGetData.php?getBuses=2     ✅ Working
    
    Request Format:
    - Method: POST
    - Body: json={{...params...}}
    - Headers: Content-Type: application/x-www-form-urlencoded
    
    Data Available:
    - {len(routes)} routes with colors and coordinates
    - {len(unique_stops)} stops with names and GPS coordinates
    - Real-time vehicle positions with heading and passenger load
    """)
    
    # Save sample data for reference
    sample_data = {
        "routes": routes[:2] if routes else [],
        "stops": list(unique_stops.values())[:5],
        "vehicles": vehicles_data.get('buses', {})
    }
    
    with open('api_sample_data.json', 'w') as f:
        json.dump(sample_data, f, indent=2)
    
    print("📄 Sample data saved to: api_sample_data.json")

if __name__ == "__main__":
    main()
