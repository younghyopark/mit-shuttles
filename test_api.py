"""
MIT Shuttle Tracker - API Test Script
Tests the Passio GO! API endpoints to verify availability and response format.
MIT Agency ID: 94
"""

import urllib.request
import urllib.parse
import json
from datetime import datetime

BASE_URL = "https://passiogo.com"
MIT_SYSTEM_ID = "94"

def make_request(endpoint, data=None):
    """Make a POST request to the Passio GO API."""
    url = f"{BASE_URL}/{endpoint}"
    
    if data:
        encoded_data = urllib.parse.urlencode(data).encode('utf-8')
    else:
        encoded_data = None
    
    try:
        req = urllib.request.Request(
            url,
            data=encoded_data,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'MIT-Shuttle-Tracker-Test/1.0'
            }
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            return {
                'status': response.status,
                'data': json.loads(response.read().decode('utf-8'))
            }
    except urllib.error.HTTPError as e:
        return {'error': f"HTTP Error {e.code}: {e.reason}"}
    except urllib.error.URLError as e:
        return {'error': f"URL Error: {e.reason}"}
    except json.JSONDecodeError as e:
        return {'error': f"JSON Decode Error: {e}"}
    except Exception as e:
        return {'error': f"Error: {e}"}

def test_get_routes():
    """Test the routes endpoint."""
    print("\n" + "="*60)
    print("📍 Testing: GET ROUTES")
    print("="*60)
    
    result = make_request(
        "mapGetData.php?getRoutes=1",
        {"systemSelected0": MIT_SYSTEM_ID, "amount": "1"}
    )
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
        return None
    
    print(f"✅ Status: {result['status']}")
    data = result['data']
    
    # Parse routes
    if isinstance(data, dict) and 'all' in data:
        routes = data['all']
        print(f"📊 Found {len(routes)} route groups")
        for route_group in routes:
            if isinstance(route_group, list):
                for route in route_group:
                    if isinstance(route, dict):
                        print(f"   🚌 Route: {route.get('name', 'N/A')} (ID: {route.get('id', 'N/A')})")
                        print(f"      Color: {route.get('color', 'N/A')}")
    else:
        print(f"📊 Response structure: {type(data)}")
        print(json.dumps(data, indent=2)[:1000])
    
    return data

def test_get_stops():
    """Test the stops endpoint."""
    print("\n" + "="*60)
    print("🚏 Testing: GET STOPS")
    print("="*60)
    
    result = make_request(
        "mapGetData.php?getStops=1",
        {"systemSelected0": MIT_SYSTEM_ID, "amount": "1"}
    )
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
        return None
    
    print(f"✅ Status: {result['status']}")
    data = result['data']
    
    # Parse stops
    if isinstance(data, dict):
        stops = data.get('stops', data.get('all', []))
        if isinstance(stops, list) and len(stops) > 0:
            # Flatten if nested
            flat_stops = []
            for item in stops:
                if isinstance(item, list):
                    flat_stops.extend(item)
                else:
                    flat_stops.append(item)
            
            print(f"📊 Found {len(flat_stops)} stops")
            for stop in flat_stops[:5]:  # Show first 5
                if isinstance(stop, dict):
                    print(f"   📍 Stop: {stop.get('name', 'N/A')} (ID: {stop.get('id', 'N/A')})")
                    print(f"      Location: ({stop.get('latitude', 'N/A')}, {stop.get('longitude', 'N/A')})")
            if len(flat_stops) > 5:
                print(f"   ... and {len(flat_stops) - 5} more stops")
    else:
        print(f"📊 Response structure: {type(data)}")
        print(json.dumps(data, indent=2)[:1000])
    
    return data

def test_get_vehicles():
    """Test the real-time vehicle locations endpoint."""
    print("\n" + "="*60)
    print("🚌 Testing: GET VEHICLES (Real-time)")
    print("="*60)
    
    result = make_request(
        "mapGetData.php?getBuses=2",
        {"s0": MIT_SYSTEM_ID, "sA": "1"}
    )
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
        return None
    
    print(f"✅ Status: {result['status']}")
    data = result['data']
    
    # Parse vehicles
    if isinstance(data, dict):
        buses = data.get('buses', data.get('all', []))
        if isinstance(buses, list) and len(buses) > 0:
            flat_buses = []
            for item in buses:
                if isinstance(item, list):
                    flat_buses.extend(item)
                elif isinstance(item, dict):
                    flat_buses.append(item)
            
            print(f"📊 Found {len(flat_buses)} active vehicles")
            for bus in flat_buses[:5]:
                if isinstance(bus, dict):
                    print(f"   🚌 Bus ID: {bus.get('busId', bus.get('id', 'N/A'))}")
                    print(f"      Route: {bus.get('routeId', bus.get('route', 'N/A'))}")
                    print(f"      Location: ({bus.get('latitude', 'N/A')}, {bus.get('longitude', 'N/A')})")
                    print(f"      Speed: {bus.get('speed', 'N/A')} | Heading: {bus.get('calculatedCourse', bus.get('heading', 'N/A'))}")
                    print(f"      Passenger Load: {bus.get('paxLoad', 'N/A')}")
        else:
            print("📊 No active vehicles at this time (shuttles may not be running)")
            print(f"   Response keys: {list(data.keys()) if isinstance(data, dict) else 'N/A'}")
    else:
        print(f"📊 Response structure: {type(data)}")
    
    # Print raw response for debugging
    print("\n   Raw response (first 500 chars):")
    print(f"   {json.dumps(data, indent=2)[:500]}")
    
    return data

def test_get_alerts():
    """Test the service alerts endpoint."""
    print("\n" + "="*60)
    print("⚠️  Testing: GET ALERTS")
    print("="*60)
    
    result = make_request(
        "goServices.php?getAlertMessages=1",
        {"systemSelected0": MIT_SYSTEM_ID, "amount": "1"}
    )
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
        return None
    
    print(f"✅ Status: {result['status']}")
    data = result['data']
    
    if isinstance(data, dict):
        alerts = data.get('alerts', data.get('all', []))
        if isinstance(alerts, list) and len(alerts) > 0:
            print(f"📊 Found {len(alerts)} alerts")
            for alert in alerts[:3]:
                if isinstance(alert, dict):
                    print(f"   ⚠️  {alert.get('title', alert.get('name', 'N/A'))}")
        else:
            print("📊 No active alerts")
    
    print(f"\n   Raw response: {json.dumps(data, indent=2)[:500]}")
    
    return data

def test_get_eta():
    """Test ETA/predictions endpoint."""
    print("\n" + "="*60)
    print("⏱️  Testing: GET ETA/PREDICTIONS")
    print("="*60)
    
    # Try different ETA endpoints
    endpoints = [
        ("mapGetData.php?getStopPredictions=1", {"systemSelected0": MIT_SYSTEM_ID, "amount": "1"}),
        ("mapGetData.php?eta=1", {"systemSelected0": MIT_SYSTEM_ID}),
    ]
    
    for endpoint, params in endpoints:
        result = make_request(endpoint, params)
        if 'error' not in result:
            print(f"✅ Endpoint {endpoint} works!")
            print(f"   Response: {json.dumps(result['data'], indent=2)[:500]}")
            return result['data']
        else:
            print(f"❌ Endpoint {endpoint}: {result['error']}")
    
    return None

def main():
    print("="*60)
    print("🚌 MIT SHUTTLE TRACKER - API TEST")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🔗 Base URL: {BASE_URL}")
    print(f"🏫 MIT System ID: {MIT_SYSTEM_ID}")
    print("="*60)
    
    # Run all tests
    routes = test_get_routes()
    stops = test_get_stops()
    vehicles = test_get_vehicles()
    alerts = test_get_alerts()
    eta = test_get_eta()
    
    # Summary
    print("\n" + "="*60)
    print("📋 SUMMARY")
    print("="*60)
    print(f"   Routes:   {'✅ Available' if routes else '❌ Failed'}")
    print(f"   Stops:    {'✅ Available' if stops else '❌ Failed'}")
    print(f"   Vehicles: {'✅ Available' if vehicles else '❌ Failed'}")
    print(f"   Alerts:   {'✅ Available' if alerts else '❌ Failed'}")
    print(f"   ETA:      {'✅ Available' if eta else '❌ Not found'}")
    print("="*60)

if __name__ == "__main__":
    main()
