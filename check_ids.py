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
print('Routes (first 5):')
for r in routes[:5]:
    print(f'  myid={r.get("myid")}, name={r.get("name")}')

# Fetch stops/route data
req2 = urllib.request.Request(
    'https://passiogo.com/mapGetData.php?getStops=2',
    data=b'json={"s0":"94","sA":1}',
    headers={'Content-Type': 'application/x-www-form-urlencoded'}
)
data = json.loads(urllib.request.urlopen(req2).read())

print()
print('Route points keys:', list(data.get('routePoints', {}).keys())[:5])

# Check stops
print()
print('Stops (showing unique routeIds):')
route_ids_in_stops = set()
for stop in data.get('stops', {}).values():
    route_ids_in_stops.add(stop.get('routeId'))
print(f'  routeIds in stops: {sorted(route_ids_in_stops)[:10]}')
