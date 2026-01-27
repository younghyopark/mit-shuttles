# MIT Shuttle Tracker

A real-time web app for tracking MIT Tech Shuttle locations.

![MIT Shuttle Tracker](https://img.shields.io/badge/MIT-Shuttle%20Tracker-a31f34)

## Features

- 🗺️ Real-time shuttle positions on an interactive map
- 🚌 Live updates every 5 seconds
- 👥 Passenger load information
- 🎨 Color-coded routes
- 📱 Mobile-responsive design
- 🌙 Dark theme

## Tech Stack

- **Frontend**: Vanilla JavaScript + Vite
- **Maps**: Leaflet.js
- **API**: Passio GO! (MIT System ID: 94)
- **Styling**: Custom CSS

## Getting Started

### Prerequisites

- Node.js 18+ installed
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The app will open at http://localhost:3000

### Build for Production

```bash
npm run build
npm run preview
```

## API Documentation

The app uses the Passio GO! API:

| Endpoint | Description |
|----------|-------------|
| `mapGetData.php?getRoutes=2` | Get all routes |
| `mapGetData.php?getBuses=2` | Real-time vehicle positions |
| `mapGetData.php?getStops=2` | Get stops |

### Request Format

```javascript
POST https://passiogo.com/mapGetData.php?getBuses=2
Content-Type: application/x-www-form-urlencoded

json={"s0": "94", "sA": 1}
```

### Vehicle Data

```json
{
  "latitude": "42.354925",
  "longitude": "-71.102201",
  "calculatedCourse": "249.5",
  "paxLoad": 5,
  "totalCap": 42,
  "bus": "1100",
  "routeBlockId": "171105",
  "createdTime": "11:00 AM"
}
```

## Project Structure

```
mit-shuttle-tracker/
├── index.html          # Main HTML file
├── package.json        # Dependencies
├── vite.config.js      # Vite configuration
├── src/
│   ├── main.js         # Application entry point
│   ├── api.js          # API client
│   └── styles.css      # Styles
└── test_api_*.py       # API test scripts
```

## MIT Shuttle Routes

- **Tech Shuttle** - Main campus loop
- **Tech Shuttle NW** - Northwest extension
- **Boston Daytime** - Cambridge ↔ Boston
- **SafeRide** - Evening service (multiple routes)
- **Grocery Shuttles** - Trader Joe's, Costco, etc.

## Notes

- Uses a CORS proxy for browser requests (corsproxy.io)
- For production, set up your own backend proxy
- Shuttle data updates every 5 seconds

## License

MIT License - See [LICENSE](LICENSE)
