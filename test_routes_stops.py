"""
Test fetching route geometry and stops
"""
import urllib.request
import urllib.parse
import json

BASE_URL = "https://passiogo.com"
MIT_SYSTEM_ID = "94"

def api_request(endpoint, params):
    url = f"{BASE_URL}/{endpoint}"
    data = urllib.parse.urlencode({"json": json.dumps(params)}).encode('utf-8')
    
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0',
        }
    )
    
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode('utf-8'))

# Get routes with full details
print("="*60)
print("ROUTE DETAILS")
print("="*60)

routes = api_request("mapGetData.php?getRoutes=2", {
    "systemSelected0": MIT_SYSTEM_ID,
    "amount": 1
})

# Check what fields routes have
if routes.get('all'):
    route = routes['all'][8]  # Tech Shuttle
    print(f"\nRoute: {route.get('name')}")
    print(f"ID: {route.get('myid')}")
    print(f"Keys: {list(route.keys())}")
    
    # Check for points/geometry
    if 'points' in route:
        print(f"\nPoints type: {type(route['points'])}")
        print(f"Points sample: {str(route['points'])[:200]}")

# Get stops
print("\n" + "="*60)
print("STOPS")
print("="*60)

# Try route-specific stops endpoint
stops = api_request("mapGetData.php?getStops=2", {
    "systemSelected0": MIT_SYSTEM_ID,
    "amount": 1
})

print(f"\nStops response keys: {list(stops.keys())}")

if 'all' in stops:
    print(f"Found {len(stops['all'])} stop groups")
    if stops['all']:
        print(f"Sample stop: {json.dumps(stops['all'][0], indent=2)[:500]}")

if 'routes' in stops:
    print(f"\nRoutes in stops: {list(stops['routes'].keys())[:5]}")

# Try getting route points specifically
print("\n" + "="*60)
print("ROUTE POINTS")
print("="*60)

points = api_request("mapGetData.php?getRoutePoints=1", {
    "systemSelected0": MIT_SYSTEM_ID,
    "amount": 1
})

print(f"Route points keys: {list(points.keys())}")
if points:
    print(f"Sample: {json.dumps(points, indent=2)[:500]}")
