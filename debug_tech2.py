#!/usr/bin/env python3
import urllib.request
import json

# Fetch stops/route data
req = urllib.request.Request(
    'https://passiogo.com/mapGetData.php?getStops=2',
    data=b'json={"s0":"94","sA":1}',
    headers={'Content-Type': 'application/x-www-form-urlencoded'}
)
data = json.loads(urllib.request.urlopen(req).read())

tech_id = '63220'  # Tech Shuttle (not NW)
print(f'Checking Tech Shuttle ID: {tech_id}')

# Check route points
route_points = data.get('routePoints', {})
if tech_id in route_points:
    pts = route_points[tech_id]
    print(f'Route points: {len(pts)} arrays, first has {len(pts[0]) if pts else 0} points')
else:
    print(f'No route points for {tech_id}')

# Check stops
stops = data.get('stops', {})
tech_stops = [s for s in stops.values() if str(s.get('routeId')) == tech_id]
print(f'Stops for {tech_id}: {len(tech_stops)}')
if tech_stops:
    for s in tech_stops:
        print(f'  - {s.get("name")}')

# Also check routes info
routes_info = data.get('routes', {})
if tech_id in routes_info:
    print(f'Route info: {routes_info[tech_id]}')
else:
    print(f'No route info for {tech_id}')
    print(f'Available route info IDs: {list(routes_info.keys())}')
