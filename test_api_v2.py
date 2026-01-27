"""
MIT Shuttle Tracker - API Test Script v2
Tests the Passio GO! API endpoints with improved parsing.
MIT Agency ID: 94
"""

import urllib.request
import urllib.parse
import json
import re
from datetime import datetime

BASE_URL = "https://passiogo.com"
MIT_SYSTEM_ID = "94"

def fix_json(text):
    """Fix common JSON issues from the API (unquoted keys, trailing commas)."""
    # Remove trailing commas before } or ]
    text = re.sub(r',\s*([}\]])', r'\1', text)
    # Add quotes around unquoted keys
    text = re.sub(r'([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:', r'\1"\2":', text)
    return text

def make_request(endpoint, data=None, method='POST'):
    """Make a request to the Passio GO API."""
    url = f"{BASE_URL}/{endpoint}"
    
    print(f"   URL: {url}")
    
    if data:
        encoded_data = urllib.parse.urlencode(data).encode('utf-8')
        print(f"   Data: {data}")
    else:
        encoded_data = None
    
    try:
        req = urllib.request.Request(
            url,
            data=encoded_data,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json, text/javascript, */*',
                'Origin': 'https://passiogo.com',
                'Referer': 'https://passiogo.com/',
            },
            method=method
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            raw_text = response.read().decode('utf-8')
            print(f"   Raw response (first 300 chars): {raw_text[:300]}")
            
            # Try to parse as JSON, with fixes if needed
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                # Try fixing the JSON
                fixed = fix_json(raw_text)
                try:
                    parsed = json.loads(fixed)
                except json.JSONDecodeError:
                    return {'raw': raw_text, 'status': response.status}
            
            return {
                'status': response.status,
                'data': parsed
            }
    except urllib.error.HTTPError as e:
        return {'error': f"HTTP Error {e.code}: {e.reason}"}
    except urllib.error.URLError as e:
        return {'error': f"URL Error: {e.reason}"}
    except Exception as e:
        return {'error': f"Error: {e}"}

def test_systems():
    """Test getting all systems to verify MIT's ID."""
    print("\n" + "="*60)
    print("🏫 Testing: GET ALL SYSTEMS")
    print("="*60)
    
    result = make_request("mapGetData.php?getSystems=1", {})
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
        return None
    
    if 'data' in result:
        data = result['data']
        print(f"\n✅ Status: {result['status']}")
        
        # Search for MIT in systems
        if isinstance(data, dict):
            for key, value in data.items():
                if isinstance(value, list):
                    for system in value:
                        if isinstance(system, dict):
                            name = str(system.get('name', '')).lower()
                            if 'mit' in name or 'massachusetts institute' in name:
                                print(f"\n   🎯 Found MIT: {system}")
        return data
    
    return result.get('raw')

def test_routes_v2():
    """Test routes with different parameter formats."""
    print("\n" + "="*60)
    print("📍 Testing: GET ROUTES (v2)")
    print("="*60)
    
    # Try different parameter formats
    params_list = [
        {"json": json.dumps({"systemSelected0": MIT_SYSTEM_ID, "amount": 1})},
        {"systemSelected0": MIT_SYSTEM_ID, "amount": "1"},
        {"s0": MIT_SYSTEM_ID, "sA": "1"},
    ]
    
    for params in params_list:
        print(f"\n   Trying params: {params}")
        result = make_request("mapGetData.php?getRoutes=2", params)
        
        if 'data' in result and result['data']:
            print(f"\n✅ Success with params: {params}")
            return result['data']
    
    return None

def test_vehicles_v2():
    """Test vehicles with different parameter formats."""
    print("\n" + "="*60)
    print("🚌 Testing: GET VEHICLES (v2)")
    print("="*60)
    
    # Try the format from PassioGo Python wrapper
    params = {
        "json": json.dumps({"s0": MIT_SYSTEM_ID, "sA": 1})
    }
    
    result = make_request("mapGetData.php?getBuses=2", params)
    
    if 'error' in result:
        print(f"❌ Error: {result['error']}")
    
    if 'data' in result:
        return result['data']
    
    return result.get('raw')

def test_direct_page():
    """Test fetching the actual PassioGo page for MIT."""
    print("\n" + "="*60)
    print("🌐 Testing: DIRECT PAGE ACCESS")
    print("="*60)
    
    url = "https://passiogo.com/goServices.php?getSystemsMin=1"
    
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            }
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode('utf-8')
            print(f"   Response: {raw[:500]}")
            
            # Parse and search for MIT
            try:
                data = json.loads(raw)
                if isinstance(data, dict) and 'all' in data:
                    for system in data['all']:
                        if isinstance(system, dict):
                            name = str(system.get('name', '')).lower()
                            if 'mit' in name:
                                print(f"\n   🎯 MIT System: {json.dumps(system, indent=2)}")
                                return system
            except:
                pass
            
            return raw
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

def test_goservices():
    """Test goServices endpoints."""
    print("\n" + "="*60)
    print("🔧 Testing: GO SERVICES ENDPOINTS")
    print("="*60)
    
    endpoints = [
        ("goServices.php?getAreas=1", {}),
        ("goServices.php?getRoutes=1", {"systemId": MIT_SYSTEM_ID}),
        ("goServices.php?getBuses=1", {"systemId": MIT_SYSTEM_ID}),
    ]
    
    results = {}
    for endpoint, params in endpoints:
        print(f"\n   Testing: {endpoint}")
        result = make_request(endpoint, params)
        
        if 'data' in result:
            results[endpoint] = result['data']
            print(f"   ✅ Got data")
    
    return results

def main():
    print("="*60)
    print("🚌 MIT SHUTTLE TRACKER - API TEST v2")
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)
    
    # Test different approaches
    systems_min = test_direct_page()
    systems = test_systems()
    routes = test_routes_v2()
    vehicles = test_vehicles_v2()
    services = test_goservices()
    
    print("\n" + "="*60)
    print("📋 SUMMARY")
    print("="*60)

if __name__ == "__main__":
    main()
