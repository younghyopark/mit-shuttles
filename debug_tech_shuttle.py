#!/usr/bin/env python3
import urllib.request
import json

# Fetch routes
req1 = urllib.request.Request(
    'https://passiogo.com/mapGetData.php?getRoutes=2', 
    data=b'json={"systemSelected0":"94","amount":1}',
    headers={'Content-Type': 'application/x-www-form-urlencoded'}
)
routes = json.loads(urllib.request.urlopen(req1).read()).get('all', [])

# Find Tech Shuttle
print('Looking for Tech Shuttle route:')
tech_shuttle = None
for r in routes:
    if 'tech' in r.get('name', '').lower():
        print(f"  Found: myid={r.get('myid')}, name={r.get('name')}")
        tech_shuttle = r

# Fetch stops/route data
req2 = urllib.request.Request(
    'https://passiogo.com/mapGetData.php?getStops=2',
    data=b'json={"s0":"94","sA":1}',
    headers={'Content-Type': 'application/x-www-form-urlencoded'}
)
data = json.loads(urllib.request.urlopen(req2).read())

if tech_shuttle:
    tech_id = str(tech_shuttle.get('myid'))
    print(f"\nTech Shuttle ID: {tech_id}")
    
    # Check if route points exist for this route
    route_points = data.get('routePoints', {})
    if tech_id in route_points:
        print(f"Route points found: {len(route_points[tech_id])} point arrays")
    else:
        print(f"No route points for ID {tech_id}")
        print(f"Available route point IDs: {list(route_points.keys())}")
    
    # Check stops for this route
    stops = data.get('stops', {})
    tech_stops = []
    for stop_key, stop in stops.items():
        if str(stop.get('routeId')) == tech_id:
            tech_stops.append(stop)
    
    print(f"\nStops with routeId={tech_id}: {len(tech_stops)}")
    if tech_stops:
        for s in tech_stops[:5]:
            print(f"  - {s.get('name')}")
    else:
        # Show what routeIds exist in stops
        print("\nAll unique routeIds in stops:")
        route_ids = set()
        for stop in stops.values():
            route_ids.add(stop.get('routeId'))
        for rid in sorted(route_ids):
            print(f"  {rid}")
        
        # Show sample stops
        print("\nSample stops (first 5):")
        for i, (k, s) in enumerate(stops.items()):
            if i >= 5: break
            print(f"  routeId={s.get('routeId')}, name={s.get('name')}")
