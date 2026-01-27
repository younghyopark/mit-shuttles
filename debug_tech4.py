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

# Build a lookup by stop id (without ID prefix)
stops_by_id = {}
for key, stop in stops_data.items():
    stop_id = str(stop.get('id', ''))
    stops_by_id[stop_id] = stop

if tech_id in routes_info:
    route_info = routes_info[tech_id]
    print(f'Tech Shuttle route info:')
    print(f'  Name: {route_info[0]}')
    print(f'  Color: {route_info[1]}')
    
    # The stop references are from index 2 onwards: ['seq', 'stop_id', direction]
    print('\nLooking up stops by their IDs:')
    for i, ref in enumerate(route_info[2:]):
        if isinstance(ref, list) and len(ref) >= 2:
            seq, stop_id, direction = ref[0], str(ref[1]), ref[2] if len(ref) > 2 else 0
            # Try to find this stop
            if stop_id in stops_by_id:
                stop = stops_by_id[stop_id]
                print(f'  {seq}. {stop.get("name")} (id={stop_id}, lat={stop.get("latitude")}, lng={stop.get("longitude")})')
            else:
                print(f'  {seq}. Stop ID {stop_id} NOT FOUND')

print(f'\nTotal stops in stops_by_id: {len(stops_by_id)}')
print(f'Sample stop IDs: {list(stops_by_id.keys())[:10]}')
