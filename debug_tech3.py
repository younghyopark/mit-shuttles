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

tech_id = '63220'
routes_info = data.get('routes', {})
stops_data = data.get('stops', {})

if tech_id in routes_info:
    route_info = routes_info[tech_id]
    print(f'Tech Shuttle route info:')
    print(f'  Name: {route_info[0]}')
    print(f'  Color: {route_info[1]}')
    print(f'  Stop references: {len(route_info) - 2} entries')
    
    # The stop references are from index 2 onwards: ['seq', 'stop_id', direction]
    print('\nLooking up stops by their IDs from route info:')
    for i, ref in enumerate(route_info[2:]):
        if isinstance(ref, list) and len(ref) >= 2:
            seq, stop_id, direction = ref[0], ref[1], ref[2] if len(ref) > 2 else 0
            # Try to find this stop in stops_data
            if stop_id in stops_data:
                stop = stops_data[stop_id]
                print(f'  {seq}. {stop.get("name")} (id={stop_id}, dir={direction})')
            else:
                print(f'  {seq}. Stop ID {stop_id} NOT FOUND in stops data')
        if i >= 10:  # Limit output
            print('  ...')
            break

print('\n--- Sample stops structure ---')
for i, (k, v) in enumerate(stops_data.items()):
    if i >= 3: break
    print(f'Key: {k}')
    print(f'  id: {v.get("id")}')
    print(f'  name: {v.get("name")}')
    print(f'  routeId: {v.get("routeId")}')
    print(f'  latitude: {v.get("latitude")}')
