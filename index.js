const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Remove kriging dependency as it's causing issues
// const kriging = require('kriging');

const app = express();
const PORT = process.env.PORT || 5001;

// Configurare CORS pentru a accepta conexiuni de oriunde
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control']
}));
app.use(express.json());

// API Keys
const ORS_API_KEY = "5b3ce3597851110001cf624883bee069829b4c9d91a8c62da78aa574";
const WAQI_TOKEN = "34a82bb60dac10d41ff4fbe8c28d16a7c6ccd168";
const WAQI_API_URL = "https://api.waqi.info/v2";
const OPENWEATHER_API_KEY = "a0d042195491a4909a4218a39babc1a0";

// Basic test route - verifică dacă serverul funcționează
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});

// Add a simple in-memory cache for routes
const routeCache = new Map();
const CACHE_EXPIRY = 30 * 60 * 1000; // 30 minutes in milliseconds

// Helper function to implement delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper function for API backoff retries
async function fetchWithRetry(apiCall, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  let lastError;

  while (retries < maxRetries) {
    try {
      // Add a small delay before each API call to avoid bursts
      if (retries > 0) {
        const delayTime = initialDelay * Math.pow(2, retries - 1);
        console.log(`Retry ${retries}/${maxRetries} for API call - waiting ${delayTime}ms`);
        await delay(delayTime);
      }

      return await apiCall();
    } catch (error) {
      lastError = error;
      
      // Only retry on rate limit errors (429) or specific server errors (500, 502, 503, 504)
      const status = error.response?.status;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      
      if (!isRetryable || retries >= maxRetries - 1) {
        throw error;
      }
      
      console.log(`API call failed with status ${status}. Retrying... (${retries + 1}/${maxRetries})`);
      retries++;
    }
  }
  
  throw lastError;
}

// Rută pentru a obține datele senzorilor de calitate a aerului
app.get('/api/air-sensors', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;
    
    console.log('Air sensors request received with params:', { minLat, minLng, maxLat, maxLng });
    
    // Verifică dacă avem parametrii necesari
    if (!minLat || !minLng || !maxLat || !maxLng) {
      return res.status(400).json({ error: 'All boundary parameters (minLat, minLng, maxLat, maxLng) are required' });
    }
    
    const latlng = `${minLat},${minLng},${maxLat},${maxLng}`;
    console.log(`Fetching air quality data for bounds: ${latlng}`);
    
    try {
      const response = await axios.get(`${WAQI_API_URL}/map/bounds/`, {
        params: {
          latlng,
          token: WAQI_TOKEN
        }
      });
      
      if (response.data.status !== "ok") {
        throw new Error(`WAQI API error: ${response.data.data}`);
      }
      
      console.log(`Fetched ${response.data.data.length} air quality sensors`);
      return res.json(response.data.data);
    } catch (apiError) {
      console.error('API error:', apiError.message);
      return res.status(502).json({ 
        error: 'Error communicating with WAQI API',
        details: apiError.message
      });
    }
  } catch (error) {
    console.error('Server error fetching air sensors:', error.message);
    return res.status(500).json({ 
      error: 'Failed to fetch air quality sensors',
      details: error.message 
    });
  }
});

// Modify route calculation endpoint to use caching and retries
app.post('/api/directions', async (req, res) => {
  try {
    const { start, end, profile } = req.body;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end points are required' });
    }

    // Generate a cache key based on the start, end, and profile
    const cacheKey = `${start[0]},${start[1]}_${end[0]},${end[1]}_${profile || 'foot-walking'}`;
    
    // Check if route is in cache
    if (routeCache.has(cacheKey)) {
      const cachedData = routeCache.get(cacheKey);
      if (cachedData.expiry > Date.now()) {
        console.log(`Using cached route for ${cacheKey}`);
        return res.json(cachedData.data);
      } else {
        // Cache expired, remove it
        routeCache.delete(cacheKey);
      }
    }

    // Convertim [lat, lng] la [lng, lat] pentru API-ul ORS
    const startCoord = [start[1], start[0]];
    const endCoord = [end[1], end[0]];

    console.log(`Fetching route from [${startCoord}] to [${endCoord}] using profile: ${profile || 'foot-walking'}`);
    
    // Use fetchWithRetry for API call with exponential backoff
    const response = await fetchWithRetry(
      async () => {
        return await axios.post(
          'https://api.openrouteservice.org/v2/directions/' + (profile || 'foot-walking') + '/geojson',
          {
            coordinates: [startCoord, endCoord],
            radiuses: [50, 50] 
          },
          {
            headers: {
              'Authorization': `Bearer ${ORS_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
      },
      3, // max retries
      2000 // initial delay (2 seconds)
    );

    // Cache successful response
    routeCache.set(cacheKey, {
      data: response.data,
      expiry: Date.now() + CACHE_EXPIRY
    });
    
    res.json(response.data);
  } catch (error) {
    // Improved error handling
    console.error('Error fetching directions:', error.response?.data || error.message);
    
    // Check for rate limit errors
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        details: 'The routing service is temporarily unavailable due to rate limiting. Please try again in a few minutes.'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch route',
      details: error.response?.data || error.message 
    });
  }
});

// Rută pentru geocoding (adresă -> coordonate)
app.get('/api/geocode', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    console.log(`Geocoding: "${query}"`);
    
    const response = await axios.get('https://api.openrouteservice.org/geocode/search', {
      params: {
        text: query,
        size: 5, // numărul de rezultate
        'boundary.country': 'RO' // opțional, pentru a limita rezultatele la România
      },
      headers: {
        'Authorization': `Bearer ${ORS_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    // Extrage doar informațiile necesare pentru a reduce dimensiunea răspunsului
    const simplifiedResults = response.data.features.map(feature => ({
      place_name: feature.properties.label,
      center: feature.geometry.coordinates,
      properties: feature.properties
    }));

    res.json(simplifiedResults);
  } catch (error) {
    console.error('Error geocoding:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Geocoding failed',
      details: error.response?.data || error.message 
    });
  }
});

// Rută pentru reverse geocoding (coordonate -> adresă)
app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const { lng, lat } = req.query;
    
    if (!lng || !lat) {
      return res.status(400).json({ error: 'Longitude and latitude are required' });
    }
    
    console.log(`Reverse geocoding: [${lng}, ${lat}]`);
    
    const response = await axios.get('https://api.openrouteservice.org/geocode/reverse', {
      params: {
        'point.lon': lng,
        'point.lat': lat,
        size: 1
      },
      headers: {
        'Authorization': `Bearer ${ORS_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    if (response.data.features && response.data.features.length > 0) {
      const feature = response.data.features[0];
      res.json({
        place_name: feature.properties.label,
        center: feature.geometry.coordinates,
        properties: feature.properties
      });
    } else {
      res.json({ place_name: "Unknown location" });
    }
  } catch (error) {
    console.error('Error reverse geocoding:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Reverse geocoding failed',
      details: error.response?.data || error.message 
    });
  }
});

// Add a geolocation fallback endpoint
app.get('/api/default-location', (req, res) => {
  console.log("Default location endpoint called");
  // Return fallback coordinates for Cluj-Napoca center
  res.json({
    lat: 46.770439,
    lng: 23.591423,
    place_name: "Cluj-Napoca, Romania"
  });
});

// Function to fetch Air Quality from AQICN API
async function fetchAirQualityFromOpenWeather(lat, lng) {
  try {
    // Use AQICN API
    const url = `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${WAQI_TOKEN}`;
    
    console.log(`Fetching air quality from AQICN for point (${lat.toFixed(6)}, ${lng.toFixed(6)})`);
    
    const response = await axios.get(url);

    if (response.data && response.data.status === "ok" && response.data.data) {
      const aqiData = response.data.data;
      
      // Extract raw PM10 value exactly as it appears in API
      let rawPm10 = aqiData.iaqi && aqiData.iaqi.pm10 ? aqiData.iaqi.pm10.v : null;
      
      // If PM10 is 0 or null, set it to -1
      if (rawPm10 === 0 || rawPm10 === null) {
        rawPm10 = -1;
      }
      
      // Log the raw PM10 value
      console.log(`
===== POINT (${lat.toFixed(6)}, ${lng.toFixed(6)}) =====
Raw PM10 value: ${rawPm10 !== -1 ? rawPm10 : '-1 (No data available)'} <-- EXACT API VALUE
====================================
      `);
      
      // Return an object with all the data, including the raw PM10 value
      const result = {
        aqi: aqiData.aqi || 0,
        rawPm10: rawPm10,
        pm10: rawPm10 !== -1 ? aqiData.iaqi.pm10.v : -1,
        pm25: aqiData.iaqi && aqiData.iaqi.pm25 ? aqiData.iaqi.pm25.v : -1,
        no2: aqiData.iaqi && aqiData.iaqi.no2 ? aqiData.iaqi.no2.v : -1,
        o3: aqiData.iaqi && aqiData.iaqi.o3 ? aqiData.iaqi.o3.v : -1,
        dominentpol: aqiData.dominentpol || ''
      };
      
      console.log("Raw PM10:", rawPm10);
      return result;
    }
    
    // If no valid data found, return -1 for data values
    console.log(`No valid data found for point (${lat.toFixed(6)}, ${lng.toFixed(6)}), using -1`);
    return { aqi: 0, rawPm10: -1, pm10: -1, pm25: -1, no2: -1, o3: -1, dominentpol: '' };
  } catch (error) {
    // If there was an error, log it and return -1 for data values
    console.error(`Error fetching AQI from AQICN for (${lat}, ${lng}):`, error.message);
    return { aqi: 0, rawPm10: -1, pm10: -1, pm25: -1, no2: -1, o3: -1, dominentpol: '' };
  }
}

// Calculate a more detailed AQI value based on PM2.5 concentration
function calculateDetailedAQI(components) {
  const pm25 = components.pm2_5;
  
  // EPA formula for PM2.5
  if (pm25 <= 12.0) return linearScale(pm25, 0, 12.0, 0, 50);
  if (pm25 <= 35.4) return linearScale(pm25, 12.1, 35.4, 51, 100);
  if (pm25 <= 55.4) return linearScale(pm25, 35.5, 55.4, 101, 150);
  if (pm25 <= 150.4) return linearScale(pm25, 55.5, 150.4, 151, 200);
  if (pm25 <= 250.4) return linearScale(pm25, 150.5, 250.4, 201, 300);
  if (pm25 <= 350.4) return linearScale(pm25, 250.5, 350.4, 301, 400);
  return linearScale(pm25, 350.5, 500.4, 401, 500);
}

// Linear scale function without rounding to preserve decimal precision
function linearScale(concentration, cLow, cHigh, iLow, iHigh) {
  return ((iHigh - iLow) / (cHigh - cLow)) * (concentration - cLow) + iLow;
}

// Update the kriging-matrix endpoint to use advanced IDW algorithm with real-time data
app.get('/api/kriging-matrix', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng, gridSize } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng || !gridSize) {
      return res.status(400).json({ 
        error: 'All boundary parameters (minLat, minLng, maxLat, maxLng) and gridSize are required' 
      });
    }

    console.log(`Generating AQI matrix for bounds: ${minLat},${minLng},${maxLat},${maxLng} with grid size: ${gridSize}`);

    // Convert to numbers
    const bounds = {
      minLat: parseFloat(minLat),
      minLng: parseFloat(minLng),
      maxLat: parseFloat(maxLat),
      maxLng: parseFloat(maxLng),
      gridSize: parseInt(gridSize)
    };

    // Expand bounds significantly to get more of Cluj-Napoca area (3x larger in each direction)
    const expandedBounds = {
      minLat: bounds.minLat - 0.3,
      minLng: bounds.minLng - 0.3,
      maxLat: bounds.maxLat + 0.3,
      maxLng: bounds.maxLng + 0.3
    };

    // Fetch real-time air quality data from WAQI API using the expanded bounds
    console.log(`Fetching real-time air quality data for LARGE expanded bounds: ${expandedBounds.minLat},${expandedBounds.minLng},${expandedBounds.maxLat},${expandedBounds.maxLng}`);
    const latlng = `${expandedBounds.minLat},${expandedBounds.minLng},${expandedBounds.maxLat},${expandedBounds.maxLng}`;
    
    const sensorResponse = await axios.get(`${WAQI_API_URL}/map/bounds/`, {
      params: {
        latlng,
        token: WAQI_TOKEN
      }
    });
    
    if (sensorResponse.data.status !== "ok") {
      throw new Error(`WAQI API error: ${sensorResponse.data.data}`);
    }
    
    const realTimeSensors = sensorResponse.data.data;
    console.log(`Fetched ${realTimeSensors.length} real-time air quality sensors from large expanded area`);
    
    if (realTimeSensors.length < 2) {
      return res.status(400).json({ 
        error: 'Not enough air quality sensors in the area for interpolation. Need at least 2 sensors.' 
      });
    }

    // Create grid using EXPANDED bounds with a much higher density to get ~1000 points
    const grid = createGrid(
      expandedBounds.minLat, 
      expandedBounds.minLng, 
      expandedBounds.maxLat, 
      expandedBounds.maxLng, 
      32 // Creates approximately 1,024 points (32x32 grid)
    );
    console.log(`Created high-density grid with ${grid.length} points for interpolation`);

    // Use advanced IDW interpolation with real-time data
    const matrix = grid.map(point => {
      // Use IDW with adaptive power based on distance
      const interpolatedValue = advancedInterpolateAQI(point, realTimeSensors);
      
      return {
        lat: point.lat,
        lng: point.lng,
        aqi: {
          value: interpolatedValue.value,
          pm10: interpolatedValue.value,  // Using AQI as proxy for PM10
          variance: interpolatedValue.reliability  // Use reliability as proxy for variance
        }
      };
    });

    // Return the matrix and original sensor data
    return res.json({
      matrix: matrix,
      sensors: realTimeSensors,
      viewBounds: bounds,
      expandedBounds: expandedBounds,
      method: 'extended_idw_realtime',
      timestamp: new Date().toISOString(),
      total_sensors: realTimeSensors.length
    });
    
  } catch (error) {
    console.error('Error generating AQI matrix:', error.message);
    res.status(500).json({ 
      error: 'Failed to generate AQI matrix', 
      details: error.message 
    });
  }
});

// Create a grid of points
function createGrid(minLat, minLng, maxLat, maxLng, gridSize) {
  const latStep = (maxLat - minLat) / gridSize;
  const lngStep = (maxLng - minLng) / gridSize;
  const grid = [];

  for (let i = 0; i <= gridSize; i++) {
    for (let j = 0; j <= gridSize; j++) {
      const lat = minLat + i * latStep;
      const lng = minLng + j * lngStep;
      grid.push({ lat, lng });
    }
  }

  return grid;
}

// Advanced IDW interpolation for AQI values
function advancedInterpolateAQI(point, stations) {
  // If no stations are available, return a default value
  if (!stations || stations.length === 0) {
    return { value: 50, reliability: 0 };
  }
  
  // If only one station is available, use its value
  if (stations.length === 1) {
    return { 
      value: stations[0].aqi,
      reliability: 0.9
    };
  }

  // Calculate distances to all stations
  const stationDistances = stations.map(station => {
    const distance = haversineDistance(
      point.lat, point.lng,
      station.lat, station.lon
    );
    return {
      station,
      distance: distance
    };
  });
  
  // Sort by distance
  stationDistances.sort((a, b) => a.distance - b.distance);
  
  // Use only the nearest 5 stations, or fewer if not available
  const nearestStations = stationDistances.slice(0, Math.min(5, stationDistances.length));
  
  // Calculate weights based on inverse distance with adaptive power
  let weightedSum = 0;
  let weightSum = 0;
  let minDistance = nearestStations[0].distance;
  let maxDistance = nearestStations[nearestStations.length - 1].distance;
  let distanceRange = maxDistance - minDistance || 1; // Avoid division by zero
  
  nearestStations.forEach(({ station, distance }) => {
    // Adjust power based on distance - points further away have less influence
    const normalizedDistance = (distance - minDistance) / distanceRange;
    const power = 2 + normalizedDistance * 2; // Power between 2 and 4
    
    // Small constant to avoid division by zero
    const epsilon = 0.001;
    
    // Weight calculation with smoothing for very close points
    const weight = 1 / Math.pow(Math.max(distance, epsilon), power);
    
    weightedSum += station.aqi * weight;
    weightSum += weight;
  });
  
  // Calculate the interpolated value
  const interpolatedValue = weightSum > 0 ? weightedSum / weightSum : 50;
  
  // Calculate reliability - higher when close to stations
  const reliability = Math.min(
    1.0, 
    Math.max(0.1, 1.0 - (minDistance / 10)) // 10km distance = 0 reliability
  );
  
  return { 
    value: Math.round(interpolatedValue),
    reliability: reliability
  };
}

// Haversine distance calculation for more accurate earth distances
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c; // Distance in km
  
  return distance;
}

// Add the helper function for getting route bounds before it's called
// Helper function to get the bounds of a route
function getBoundsFromCoordinates(coordinates) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  
  coordinates.forEach(coord => {
    // Coordinates are [lng, lat]
    const lng = coord[0];
    const lat = coord[1];
    
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  });
  
  return { minLat, minLng, maxLat, maxLng };
}

// Helper function to calculate average AQI along a route
function calculateRouteAqi(routePoints, sensors) {
  return calculateDetailedRouteAqi(routePoints, sensors).avgAqi;
}

// Function to sample points along a route more evenly
function sampleRoutePoints(routePoints, minSamples) {
  if (routePoints.length <= minSamples) {
    return routePoints; // Return all points if we don't have many
  }
  
  const result = [];
  // Always include start and end points
  result.push(routePoints[0]);
  
  // Calculate total route distance
  let totalDistance = 0;
  for (let i = 1; i < routePoints.length; i++) {
    totalDistance += haversineDistance(
      routePoints[i-1].lat, routePoints[i-1].lng,
      routePoints[i].lat, routePoints[i].lng
    );
  }
  
  // Calculate segment length to achieve even sampling
  const segmentLength = totalDistance / (minSamples - 1);
  
  let accumulatedDistance = 0;
  let lastAddedIndex = 0;
  
  // Add points approximately every segmentLength distance
  for (let i = 1; i < routePoints.length - 1; i++) {
    const segmentDistance = haversineDistance(
      routePoints[i-1].lat, routePoints[i-1].lng,
      routePoints[i].lat, routePoints[i].lng
    );
    
    accumulatedDistance += segmentDistance;
    
    if (accumulatedDistance >= segmentLength || 
        (i - lastAddedIndex) > routePoints.length / minSamples * 2) {
      result.push(routePoints[i]);
      lastAddedIndex = i;
      accumulatedDistance = 0;
    }
  }
  
  // Add the end point if it's not already included
  if (result[result.length - 1] !== routePoints[routePoints.length - 1]) {
    result.push(routePoints[routePoints.length - 1]);
  }
  
  return result;
}

// Completely rewrite the waypoint generation function to create much better alternative paths
// Fix the findPotentialWaypoints function to handle cases where realTimeSensors is undefined
function findPotentialWaypoints(coordinates, realTimeSensors) {
  const waypoints = [];
  
  // Make sure coordinates is defined
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0) {
    console.error('Invalid coordinates provided to findPotentialWaypoints');
    return [];
  }
  
  // Use a larger portion of the route (use 80% of the route instead of just the middle part)
  const start = Math.floor(coordinates.length * 0.1);
  const end = Math.floor(coordinates.length * 0.9);
  
  // Sample more points along the route (create more alternative paths)
  const step = Math.max(1, Math.floor((end - start) / 10)); // 10 points along route
  
  // Use much more varied distances for better exploration
  const offsetDistances = [0.003, 0.006, 0.01, 0.015]; // ~300m, 600m, 1km, 1.5km
  
  console.log(`Generating waypoints from ${start} to ${end} with step ${step}`);
  
  // If realTimeSensors is provided, create a heat map for smarter waypoint generation
  let aqiHeatMap = null;
  if (realTimeSensors && Array.isArray(realTimeSensors) && realTimeSensors.length > 0) {
    aqiHeatMap = createSimpleAqiHeatMap(realTimeSensors);
  }
  
  // Generate waypoints along the route at different distances
  for (let i = start; i < end; i += step) {
    const origPoint = coordinates[i];
    if (!origPoint) continue; // Skip undefined points
    
    // Try many more directions (16 directions instead of 8)
    const directions = [
      { lat: 1, lng: 0 },       // N
      { lat: 0.866, lng: 0.5 }, // NNE
      { lat: 0.707, lng: 0.707 }, // NE
      { lat: 0.5, lng: 0.866 }, // ENE
      { lat: 0, lng: 1 },       // E
      { lat: -0.5, lng: 0.866 }, // ESE
      { lat: -0.707, lng: 0.707 }, // SE
      { lat: -0.866, lng: 0.5 }, // SSE
      { lat: -1, lng: 0 },      // S
      { lat: -0.866, lng: -0.5 }, // SSW
      { lat: -0.707, lng: -0.707 }, // SW
      { lat: -0.5, lng: -0.866 }, // WSW
      { lat: 0, lng: -1 },      // W
      { lat: 0.5, lng: -0.866 }, // WNW
      { lat: 0.707, lng: -0.707 }, // NW
      { lat: 0.866, lng: -0.5 }  // NNW
    ];
    
    // Generate waypoints in all directions at different distances
    directions.forEach(dir => {
      offsetDistances.forEach(dist => {
        const waypoint = {
          lat: origPoint[1] + dir.lat * dist,
          lng: origPoint[0] + dir.lng * dist
        };
        
        // Check if this waypoint is in a high pollution area before adding it (if we have the data)
        if (aqiHeatMap) {
          const estimatedAqi = estimateAqiAtPoint(waypoint, aqiHeatMap);
          
          // Skip waypoints in very high pollution areas (prefer paths in cleaner areas)
          if (estimatedAqi < 100) { // Only add waypoints in areas with moderate or better air quality
            waypoint.estimatedAqi = estimatedAqi;
            waypoints.push(waypoint);
          }
        } else {
          // If we don't have air quality data, just add all waypoints
          waypoints.push(waypoint);
        }
      });
    });
  }
  
  console.log(`Generated ${waypoints.length} potential waypoints for alternative routes`);
  
  // Sort waypoints by estimated air quality (prioritize cleaner areas) if we have that data
  if (waypoints.length > 0 && waypoints[0].estimatedAqi !== undefined) {
    return waypoints.sort((a, b) => a.estimatedAqi - b.estimatedAqi);
  }
  
  return waypoints;
}

// Create a simple AQI heat map for quick lookups
function createSimpleAqiHeatMap(sensors) {
  // We'll create a simple grid-based heat map
  const heatMap = {
    minLat: Infinity,
    maxLat: -Infinity,
    minLng: Infinity,
    maxLng: -Infinity,
    sensors: sensors,
    resolution: 0.005, // About 500m cells
    grid: {}
  };
  
  // Find the bounds of our heat map
  sensors.forEach(sensor => {
    heatMap.minLat = Math.min(heatMap.minLat, sensor.lat);
    heatMap.maxLat = Math.max(heatMap.maxLat, sensor.lat);
    heatMap.minLng = Math.min(heatMap.minLng, sensor.lon);
    heatMap.maxLng = Math.max(heatMap.maxLng, sensor.lon);
  });
  
  // Expand bounds slightly
  heatMap.minLat -= 0.02;
  heatMap.minLng -= 0.02;
  heatMap.maxLat += 0.02;
  heatMap.maxLng += 0.02;
  
  // Pre-compute some AQI values for common cells
  for (let lat = heatMap.minLat; lat <= heatMap.maxLat; lat += heatMap.resolution) {
    for (let lng = heatMap.minLng; lng <= heatMap.maxLng; lng += heatMap.resolution) {
      const key = getGridKey(lat, lng, heatMap.resolution);
      
      // Calculate AQI for this cell using IDW interpolation
      const point = { lat, lng };
      const interpolated = advancedInterpolateAQI(point, sensors);
      
      heatMap.grid[key] = interpolated.value;
    }
  }
  
  return heatMap;
}

// Get grid cell key for a lat/lng point
function getGridKey(lat, lng, resolution) {
  const latCell = Math.floor(lat / resolution);
  const lngCell = Math.floor(lng / resolution);
  return `${latCell},${lngCell}`;
}

// Estimate AQI at any point using our precomputed heat map or direct calculation
function estimateAqiAtPoint(point, heatMap) {
  // Try to get a precomputed value
  const key = getGridKey(point.lat, point.lng, heatMap.resolution);
  
  if (heatMap.grid[key] !== undefined) {
    return heatMap.grid[key];
  }
  
  // If not available, calculate directly
  const interpolated = advancedInterpolateAQI(point, heatMap.sensors);
  
  // Cache for future use
  heatMap.grid[key] = interpolated.value;
  
  return interpolated.value;
}

// New endpoint for calculating healthier routes
app.post('/api/healthy-route', async (req, res) => {
  try {
    const { start, end, profile } = req.body;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end points are required' });
    }

    console.log(`Calculating healthy route from [${start}] to [${end}] using profile: ${profile || 'foot-walking'}`);
    
    // Generate a cache key for the standard route
    const standardRouteCacheKey = `${start[0]},${start[1]}_${end[0]},${end[1]}_${profile || 'foot-walking'}`;
    const healthyRouteCacheKey = `healthy_${standardRouteCacheKey}`;
    
    // Check cache first
    if (routeCache.has(healthyRouteCacheKey)) {
      const cachedData = routeCache.get(healthyRouteCacheKey);
      if (cachedData.expiry > Date.now()) {
        console.log(`Using cached healthy route for ${healthyRouteCacheKey}`);
        return res.json(cachedData.data);
      } else {
        routeCache.delete(healthyRouteCacheKey);
      }
    }
    
    // First, get the standard route from OpenRouteService
    const startCoord = [start[1], start[0]];
    const endCoord = [end[1], end[0]];
    
    // Check if we have the standard route in cache
    let standardRoute;
    if (routeCache.has(standardRouteCacheKey)) {
      const cachedData = routeCache.get(standardRouteCacheKey);
      if (cachedData.expiry > Date.now()) {
        console.log(`Using cached standard route for ${standardRouteCacheKey}`);
        standardRoute = cachedData.data;
      }
    }
    
    // If not in cache, fetch the standard route with retry logic
    if (!standardRoute) {
      // Get the standard route first
      const standardRouteResponse = await fetchWithRetry(
        async () => {
          return await axios.post(
            'https://api.openrouteservice.org/v2/directions/' + (profile || 'foot-walking') + '/geojson',
            {
              coordinates: [startCoord, endCoord],
              radiuses: [50, 50]
            },
            {
              headers: {
                'Authorization': `Bearer ${ORS_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
        },
        3, // max retries
        2000 // initial delay
      );
      
      standardRoute = standardRouteResponse.data;
      
      // Cache the standard route
      routeCache.set(standardRouteCacheKey, {
        data: standardRoute,
        expiry: Date.now() + CACHE_EXPIRY
      });
    }
    
    if (!standardRoute || !standardRoute.features || standardRoute.features.length === 0) {
      return res.status(404).json({ error: 'No standard route found' });
    }
    
    const standardRouteCoordinates = standardRoute.features[0].geometry.coordinates;
    const standardDistance = standardRoute.features[0].properties.summary.distance;
    
    console.log(`Standard route distance: ${standardDistance}m with ${standardRouteCoordinates.length} points`);
    
    // Generate air quality data for a wide area around the route
    const routeBounds = getBoundsFromCoordinates(standardRouteCoordinates);
    console.log('Route bounds:', routeBounds);
    
    // Expand the bounds to include potential detour areas
    const expandedBounds = {
      minLat: routeBounds.minLat - 0.02,
      minLng: routeBounds.minLng - 0.02,
      maxLat: routeBounds.maxLat + 0.02,
      maxLng: routeBounds.maxLng + 0.02
    };
    
    // Fetch air quality data for the expanded area
    const latlng = `${expandedBounds.minLat},${expandedBounds.minLng},${expandedBounds.maxLat},${expandedBounds.maxLng}`;
    const sensorResponse = await axios.get(`${WAQI_API_URL}/map/bounds/`, {
      params: { latlng, token: WAQI_TOKEN }
    });
    
    if (sensorResponse.data.status !== "ok") {
      throw new Error(`WAQI API error: ${sensorResponse.data.data}`);
    }
    
    const realTimeSensors = sensorResponse.data.data;
    console.log(`Fetched ${realTimeSensors.length} air quality sensors for the route area`);
    
    // Calculate air quality for points along the standard route
    const standardRoutePoints = standardRouteCoordinates.map(coord => ({
      lng: coord[0],
      lat: coord[1]
    }));
    
    // Get more detailed air quality data with proper logging
    console.log(`Calculating AQI for standard route with ${standardRoutePoints.length} points...`);
    const standardRouteAqi = calculateRouteAqi(standardRoutePoints, realTimeSensors);
    console.log(`Standard route average AQI: ${standardRouteAqi.toFixed(2)}`);
    
    // Ensure we have a valid AQI value
    if (isNaN(standardRouteAqi) || standardRouteAqi <= 0) {
      console.warn('Invalid AQI value for standard route, using default');
      standardRouteAqi = 50; // Use a default moderate value
    }
    
    // Now, request some alternative routes with detours
    // We'll use different waypoints between start and end
    
    // Find potential waypoints by analyzing the standard route
    const waypoints = findPotentialWaypoints(standardRouteCoordinates, realTimeSensors);
    console.log(`Generated ${waypoints.length} potential waypoints for alternative routes`);
    
    // Generate and evaluate multiple alternative routes
    const healthyRoutes = [];
    
    // Generate and evaluate at most 3 alternative routes to reduce API calls
    const waypointsToTry = findPotentialWaypoints(standardRouteCoordinates).slice(0, 12);
    
    // Ensure we only try alternative routes if the standard route has a measurable AQI
    if (standardRouteAqi > 0) {
      for (const waypoint of waypointsToTry) {
        try {
          // Add delay between API calls to avoid bursting
          await delay(500);
          
          // Create a route through this waypoint with retry logic
          const alternativeRouteResponse = await fetchWithRetry(
            async () => {
              return await axios.post(
                'https://api.openrouteservice.org/v2/directions/' + (profile || 'foot-walking') + '/geojson',
                {
                  coordinates: [startCoord, [waypoint.lng, waypoint.lat], endCoord],
                  radiuses: [-1, 50, -1] // Allow flexibility at the waypoint
                },
                {
                  headers: {
                    'Authorization': `Bearer ${ORS_API_KEY}`,
                    'Content-Type': 'application/json'
                  }
                }
              );
            },
            2, // fewer retries for alternates
            2000
          );
          
          if (alternativeRouteResponse.data && alternativeRouteResponse.data.features && alternativeRouteResponse.data.features.length > 0) {
            const altRoute = alternativeRouteResponse.data;
            const altRouteCoordinates = altRoute.features[0].geometry.coordinates;
            const altDistance = altRoute.features[0].properties.summary.distance;
            
            // Don't consider routes that are more than 50% longer
            if (altDistance > standardDistance * 1.5) {
              console.log(`Skipping alternative route: too long (${altDistance}m vs ${standardDistance}m)`);
              continue;
            }
            
            // Calculate air quality for this alternative route
            const altRoutePoints = altRouteCoordinates.map(coord => ({
              lng: coord[0],
              lat: coord[1]
            }));
            
            console.log(`Calculating AQI for alternative route with ${altRoutePoints.length} points...`);
            const altRouteAqi = calculateRouteAqi(altRoutePoints, realTimeSensors);
            console.log(`Alternative route average AQI: ${altRouteAqi.toFixed(2)}`);
            
            // Only consider routes with better air quality and make sure we don't have invalid values
            if (!isNaN(altRouteAqi) && altRouteAqi > 0 && altRouteAqi < standardRouteAqi) {
              const improvementPercent = ((standardRouteAqi - altRouteAqi) / standardRouteAqi) * 100;
              const lengthIncrease = ((altDistance - standardDistance) / standardDistance) * 100;
              
              console.log(`Found healthier route: distance +${lengthIncrease.toFixed(1)}%, AQI -${improvementPercent.toFixed(1)}%`);
              
              // Only include route if it has at least 5% better air quality
              if (improvementPercent >= 5) {
                healthyRoutes.push({
                  route: altRoute,
                  distance: altDistance,
                  avgAqi: altRouteAqi,
                  // Calculate a score that balances distance and air quality
                  // Lower is better - prioritize routes with bigger AQI improvements
                  score: (1 + (lengthIncrease / 100)) * (altRouteAqi / standardRouteAqi)
                });
              } else {
                console.log(`Discarding route with only ${improvementPercent.toFixed(1)}% AQI improvement`);
              }
            }
          }
        } catch (error) {
          console.warn('Error calculating alternative route:', error.message);
          // If we hit rate limits, stop trying more routes
          if (error.response?.status === 429) {
            console.log('Rate limit reached. Stopping alternative route calculation.');
            break;
          }
          // Continue with next waypoint
          continue;
        }
      }
    } else {
      console.warn('Cannot calculate alternative routes due to invalid standard route AQI');
    }
    
    // Return the best healthy route if we found any with significant improvements
    if (healthyRoutes.length > 0) {
      healthyRoutes.sort((a, b) => a.score - b.score);
      const bestRoute = healthyRoutes[0];
      
      // Validate metrics before sending
      if (isNaN(standardRouteAqi) || standardRouteAqi <= 0) standardRouteAqi = 50;
      if (isNaN(bestRoute.avgAqi) || bestRoute.avgAqi <= 0) bestRoute.avgAqi = standardRouteAqi * 0.8; // Estimate 20% better
      
      const result = {
        route: bestRoute.route,
        metrics: {
          standard: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          },
          healthy: {
            distance: bestRoute.distance,
            avgAqi: bestRoute.avgAqi
          }
        }
      };
      
      // Cache the healthy route result
      routeCache.set(healthyRouteCacheKey, {
        data: result,
        expiry: Date.now() + CACHE_EXPIRY
      });
      
      return res.json(result);
    } else {
      // If no healthier routes found, suggest the standard route
      console.log('No healthier routes found');
      return res.json({ 
        route: standardRoute,
        metrics: {
          standard: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          },
          healthy: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          }
        },
        message: 'No healthier alternative routes found'
      });
    }
  } catch (error) {
    console.error('Error calculating healthy route:', error.message);
    
    // Better error messages for rate limits
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        details: 'The routing service is temporarily unavailable due to rate limiting. Please try again in a few minutes.'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to calculate a healthy route',
      details: error.message 
    });
  }
});

// Enhanced route AQI calculation that also returns max AQI along route
function calculateDetailedRouteAqi(routePoints, sensors) {
  // Sample route points as before...
  const sampledPoints = sampleRoutePoints(routePoints, 20); // Increase to 20 points
  
  // Calculate AQI at each point
  const aqiValues = sampledPoints.map(point => {
    const interpolatedValue = advancedInterpolateAQI(point, sensors);
    return interpolatedValue.value;
  }).filter(value => value > 0);
  
  if (aqiValues.length === 0) {
    return { avgAqi: 50, maxAqi: 50, values: [50] }; // Default values
  }
  
  // Calculate average AQI
  const sum = aqiValues.reduce((acc, val) => acc + val, 0);
  const avgAqi = sum / aqiValues.length;
  
  // Also find the maximum AQI along the route (worst spot)
  const maxAqi = Math.max(...aqiValues);
  
  console.log(`Route AQI calculation: ${aqiValues.length} points, avg: ${avgAqi.toFixed(2)}, max: ${maxAqi}`);
  
  return { 
    avgAqi: avgAqi,
    maxAqi: maxAqi,
    values: aqiValues
  };
}

// Improve the waypoint generation function to create better alternative paths that don't backtrack
function findPotentialWaypoints(coordinates, realTimeSensors) {
  const waypoints = [];
  
  // Make sure coordinates is defined
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0) {
    console.error('Invalid coordinates provided to findPotentialWaypoints');
    return [];
  }
  
  // Use a larger portion of the route for better alternatives
  const start = Math.floor(coordinates.length * 0.15); // Move start a bit forward
  const end = Math.floor(coordinates.length * 0.85);   // Move end a bit back
  
  // Calculate the main direction of the route
  const routeStartPoint = coordinates[0];
  const routeEndPoint = coordinates[coordinates.length - 1];
  const mainDirection = {
    lat: routeEndPoint[1] - routeStartPoint[1],
    lng: routeEndPoint[0] - routeStartPoint[0]
  };
  
  // Normalize the direction vector
  const magnitude = Math.sqrt(mainDirection.lat * mainDirection.lat + mainDirection.lng * mainDirection.lng);
  if (magnitude > 0) {
    mainDirection.lat /= magnitude;
    mainDirection.lng /= magnitude;
  }
  
  console.log(`Main route direction: [${mainDirection.lat.toFixed(2)}, ${mainDirection.lng.toFixed(2)}]`);
  
  // Sample more points but in a smarter way to avoid backtracking
  // Use fewer points for longer routes to avoid API limits
  const routeLength = coordinates.length;
  const targetPoints = Math.min(10, Math.max(3, Math.floor(routeLength / 50)));
  const step = Math.max(1, Math.floor((end - start) / targetPoints));
  
  // Distance options with greater spread
  const offsetDistances = [0.003, 0.006, 0.01, 0.015]; // ~300m, 600m, 1km, 1.5km
  
  console.log(`Generating waypoints from ${start} to ${end}, step ${step}, target points ${targetPoints}`);
  
  // Create a heat map if we have sensor data
  let aqiHeatMap = null;
  if (realTimeSensors && Array.isArray(realTimeSensors) && realTimeSensors.length > 0) {
    aqiHeatMap = createSimpleAqiHeatMap(realTimeSensors);
  }
  
  // Get the route's bounding box
  const bounds = getBoundsFromCoordinates(coordinates);
  
  // Store points we've already processed to avoid clustering
  const processedAreas = new Set();
  const areaResolution = 0.001; // About 100m grid cells
  
  // Generate waypoints along the route at different distances
  for (let i = start; i < end; i += step) {
    const origPoint = coordinates[i];
    if (!origPoint) continue;
    
    // Calculate local route direction to avoid backtracking
    const localDirection = calculateLocalDirection(coordinates, i, 5);
    
    // Perpendicular directions are best for detours (90 degrees to route)
    const perpDirections = [
      { lat: localDirection.perpLat, lng: localDirection.perpLng },     // Right of route
      { lat: -localDirection.perpLat, lng: -localDirection.perpLng },   // Left of route
      { lat: localDirection.perpLat*0.7 + localDirection.forwardLat*0.7, 
        lng: localDirection.perpLng*0.7 + localDirection.forwardLng*0.7 }, // Forward-right
      { lat: -localDirection.perpLat*0.7 + localDirection.forwardLat*0.7, 
        lng: -localDirection.perpLng*0.7 + localDirection.forwardLng*0.7 }  // Forward-left
    ];
    
    // Generate waypoints in optimal directions
    perpDirections.forEach(dir => {
      offsetDistances.forEach(dist => {
        const waypoint = {
          lat: origPoint[1] + dir.lat * dist,
          lng: origPoint[0] + dir.lng * dist
        };
        
        // Skip if outside extended bounds to avoid extreme detours
        if (waypoint.lat < bounds.minLat - 0.01 || waypoint.lat > bounds.maxLat + 0.01 ||
            waypoint.lng < bounds.minLng - 0.01 || waypoint.lng > bounds.maxLng + 0.01) {
          return;
        }
        
        // Avoid crowding by checking if we've already processed a point in this area
        const areaKey = `${Math.floor(waypoint.lat / areaResolution)},${Math.floor(waypoint.lng / areaResolution)}`;
        if (processedAreas.has(areaKey)) {
          return;
        }
        processedAreas.add(areaKey);
        
        // Check air quality if we have data
        if (aqiHeatMap) {
          const estimatedAqi = estimateAqiAtPoint(waypoint, aqiHeatMap);
          // Skip poor air quality areas
          if (estimatedAqi < 100) {
            waypoint.estimatedAqi = estimatedAqi;
            waypoints.push(waypoint);
          }
        } else {
          waypoints.push(waypoint);
        }
      });
    });
  }
  
  console.log(`Generated ${waypoints.length} optimized waypoints for alternative routes`);
  
  // Sort waypoints by air quality if we have that data
  if (waypoints.length > 0 && waypoints[0].estimatedAqi !== undefined) {
    return waypoints.sort((a, b) => a.estimatedAqi - b.estimatedAqi);
  }
  
  return waypoints;
}

// Helper to calculate local route direction to help avoid backtracking
function calculateLocalDirection(coordinates, index, window) {
  // Use points before and after current position to determine direction
  const beforeIdx = Math.max(0, index - window);
  const afterIdx = Math.min(coordinates.length - 1, index + window);
  
  const before = coordinates[beforeIdx];
  const after = coordinates[afterIdx];
  
  // Calculate forward direction vector
  const forwardLat = after[1] - before[1];
  const forwardLng = after[0] - before[0];
  
  // Normalize
  const magnitude = Math.sqrt(forwardLat * forwardLat + forwardLng * forwardLng);
  const normalized = {
    forwardLat: magnitude > 0 ? forwardLat / magnitude : 0,
    forwardLng: magnitude > 0 ? forwardLng / magnitude : 0,
  };
  
  // Calculate perpendicular direction (rotate 90 degrees)
  normalized.perpLat = -normalized.forwardLng;
  normalized.perpLng = normalized.forwardLat;
  
  return normalized;
}

// Add a function to detect if a route has significant backtracking
function hasBacktracking(coordinates, threshold = 0.3) {
  if (coordinates.length < 10) return false;
  
  // Find major direction changes by checking angle between segments
  let backtrackCount = 0;
  
  for (let i = 2; i < coordinates.length - 2; i++) {
    const prev = coordinates[i-2];
    const curr = coordinates[i];
    const next = coordinates[i+2];
    
    // Calculate vectors
    const v1 = { lat: curr[1] - prev[1], lng: curr[0] - prev[0] };
    const v2 = { lat: next[1] - curr[1], lng: next[0] - curr[0] };
    
    // Calculate magnitudes
    const mag1 = Math.sqrt(v1.lat * v1.lat + v1.lng * v1.lng);
    const mag2 = Math.sqrt(v2.lat * v2.lat + v2.lng * v2.lng);
    
    // Calculate dot product to find angle
    if (mag1 > 0 && mag2 > 0) {
      const dot = (v1.lat * v2.lat + v1.lng * v2.lng) / (mag1 * mag2);
      
      // dot < -0.5 means angle > 120 degrees (significant direction change)
      if (dot < -0.5) {
        backtrackCount++;
      }
    }
  }
  
  // If more than threshold % of points show backtracking, reject the route
  return backtrackCount / coordinates.length > threshold;
}

// Fix the /api/healthy-route endpoint to properly integrate the backtracking checks
app.post('/api/healthy-route', async (req, res) => {
  try {
    const { start, end, profile } = req.body;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end points are required' });
    }

    console.log(`Calculating healthy route from [${start}] to [${end}] using profile: ${profile || 'foot-walking'}`);
    
    // Generate a cache key for the standard route
    const standardRouteCacheKey = `${start[0]},${start[1]}_${end[0]},${end[1]}_${profile || 'foot-walking'}`;
    const healthyRouteCacheKey = `healthy_${standardRouteCacheKey}`;
    
    // Check cache first
    if (routeCache.has(healthyRouteCacheKey)) {
      const cachedData = routeCache.get(healthyRouteCacheKey);
      if (cachedData.expiry > Date.now()) {
        console.log(`Using cached healthy route for ${healthyRouteCacheKey}`);
        return res.json(cachedData.data);
      } else {
        routeCache.delete(healthyRouteCacheKey);
      }
    }
    
    // First, get the standard route from OpenRouteService
    const startCoord = [start[1], start[0]];
    const endCoord = [end[1], end[0]];
    
    // Check if we have the standard route in cache
    let standardRoute;
    if (routeCache.has(standardRouteCacheKey)) {
      const cachedData = routeCache.get(standardRouteCacheKey);
      if (cachedData.expiry > Date.now()) {
        console.log(`Using cached standard route for ${standardRouteCacheKey}`);
        standardRoute = cachedData.data;
      }
    }
    
    // If not in cache, fetch the standard route with retry logic
    if (!standardRoute) {
      // Get the standard route first
      const standardRouteResponse = await fetchWithRetry(
        async () => {
          return await axios.post(
            'https://api.openrouteservice.org/v2/directions/' + (profile || 'foot-walking') + '/geojson',
            {
              coordinates: [startCoord, endCoord],
              radiuses: [50, 50]
            },
            {
              headers: {
                'Authorization': `Bearer ${ORS_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
        },
        3, // max retries
        2000 // initial delay
      );
      
      standardRoute = standardRouteResponse.data;
      
      // Cache the standard route
      routeCache.set(standardRouteCacheKey, {
        data: standardRoute,
        expiry: Date.now() + CACHE_EXPIRY
      });
    }
    
    if (!standardRoute || !standardRoute.features || standardRoute.features.length === 0) {
      return res.status(404).json({ error: 'No standard route found' });
    }
    
    const standardRouteCoordinates = standardRoute.features[0].geometry.coordinates;
    const standardDistance = standardRoute.features[0].properties.summary.distance;
    
    console.log(`Standard route distance: ${standardDistance}m with ${standardRouteCoordinates.length} points`);
    
    // Generate air quality data for a wide area around the route
    const routeBounds = getBoundsFromCoordinates(standardRouteCoordinates);
    console.log('Route bounds:', routeBounds);
    
    // Expand the bounds to include potential detour areas
    const expandedBounds = {
      minLat: routeBounds.minLat - 0.02,
      minLng: routeBounds.minLng - 0.02,
      maxLat: routeBounds.maxLat + 0.02,
      maxLng: routeBounds.maxLng + 0.02
    };
    
    // Fetch air quality data for the expanded area
    const latlng = `${expandedBounds.minLat},${expandedBounds.minLng},${expandedBounds.maxLat},${expandedBounds.maxLng}`;
    const sensorResponse = await axios.get(`${WAQI_API_URL}/map/bounds/`, {
      params: { latlng, token: WAQI_TOKEN }
    });
    
    if (sensorResponse.data.status !== "ok") {
      throw new Error(`WAQI API error: ${sensorResponse.data.data}`);
    }
    
    const realTimeSensors = sensorResponse.data.data;
    console.log(`Fetched ${realTimeSensors.length} air quality sensors for the route area`);
    
    // Calculate air quality for points along the standard route
    const standardRoutePoints = standardRouteCoordinates.map(coord => ({
      lng: coord[0],
      lat: coord[1]
    }));
    
    // Get more detailed air quality data with proper logging
    console.log(`Calculating AQI for standard route with ${standardRoutePoints.length} points...`);
    const standardRouteAqi = calculateRouteAqi(standardRoutePoints, realTimeSensors);
    console.log(`Standard route average AQI: ${standardRouteAqi.toFixed(2)}`);
    
    // Ensure we have a valid AQI value
    if (isNaN(standardRouteAqi) || standardRouteAqi <= 0) {
      console.warn('Invalid AQI value for standard route, using default');
      standardRouteAqi = 50; // Use a default moderate value
    }
    
    // Now, request some alternative routes with detours
    // We'll use different waypoints between start and end
    
    // Find potential waypoints by analyzing the standard route
    const waypoints = findPotentialWaypoints(standardRouteCoordinates, realTimeSensors);
    console.log(`Generated ${waypoints.length} direction-optimized waypoints for alternative routes`);
    
    // Generate and evaluate multiple alternative routes
    const healthyRoutes = [];
    
    // Choose the best waypoints to try (prioritize ones in cleaner areas)
    // We'll try more waypoints to have better chances of finding good routes
    const waypointsToTry = waypoints.slice(0, 16); // Try up to 16 waypoints
    
    // Ensure we only try alternative routes if the standard route has a measurable AQI
    if (standardRouteAqi > 0) {
      // Loop through waypoints to find healthier routes
      for (const waypoint of waypointsToTry) {
        try {
          // Add delay between API calls to avoid bursting
          await delay(500);
          
          // Create a route through this waypoint with retry logic
          const alternativeRouteResponse = await fetchWithRetry(
            async () => {
              return await axios.post(
                'https://api.openrouteservice.org/v2/directions/' + (profile || 'foot-walking') + '/geojson',
                {
                  coordinates: [startCoord, [waypoint.lng, waypoint.lat], endCoord],
                  radiuses: [-1, 50, -1] // Allow flexibility at the waypoint
                },
                {
                  headers: {
                    'Authorization': `Bearer ${ORS_API_KEY}`,
                    'Content-Type': 'application/json'
                  }
                }
              );
            },
            2, // fewer retries for alternates
            2000
          );
          
          if (alternativeRouteResponse.data && alternativeRouteResponse.data.features && alternativeRouteResponse.data.features.length > 0) {
            const altRoute = alternativeRouteResponse.data;
            const altRouteCoordinates = altRoute.features[0].geometry.coordinates;
            const altDistance = altRoute.features[0].properties.summary.distance;
            
            // Don't consider routes that are more than 40% longer
            if (altDistance > standardDistance * 1.4) {
              console.log(`Skipping alternative route: too long (${altDistance}m vs ${standardDistance}m)`);
              continue; // Skip to next waypoint in loop
            }
            
            // Check for backtracking and reject routes that double-back
            if (hasBacktracking(altRouteCoordinates)) {
              console.log(`Skipping alternative route: exhibits backtracking behavior`);
              continue; // Skip to next waypoint in loop
            }
            
            // Calculate air quality for this alternative route
            const altRoutePoints = altRouteCoordinates.map(coord => ({
              lng: coord[0],
              lat: coord[1]
            }));
            
            console.log(`Calculating AQI for alternative route with ${altRoutePoints.length} points...`);
            const altRouteAqi = calculateRouteAqi(altRoutePoints, realTimeSensors);
            console.log(`Alternative route average AQI: ${altRouteAqi.toFixed(2)}`);
            
            // Only consider routes with better air quality and make sure we don't have invalid values
            if (!isNaN(altRouteAqi) && altRouteAqi > 0 && altRouteAqi < standardRouteAqi) {
              const improvementPercent = ((standardRouteAqi - altRouteAqi) / standardRouteAqi) * 100;
              const lengthIncrease = ((altDistance - standardDistance) / standardDistance) * 100;
              
              console.log(`Found healthier route: distance +${lengthIncrease.toFixed(1)}%, AQI -${improvementPercent.toFixed(1)}%`);
              
              // Only include route if it has at least 5% better air quality
              if (improvementPercent >= 5) {
                // Improved score calculation that penalizes longer routes more heavily
                const lengthPenalty = Math.pow(1 + (lengthIncrease / 100), 1.5);
                const aqiImprovement = 1 + (improvementPercent / 100);
                const score = lengthPenalty / aqiImprovement;
                
                healthyRoutes.push({
                  route: altRoute,
                  distance: altDistance,
                  avgAqi: altRouteAqi,
                  score: score,
                  improvement: improvementPercent,
                  lengthIncrease: lengthIncrease
                });
                
                console.log(`Route accepted with score: ${score.toFixed(3)}`);
              } else {
                console.log(`Discarding route with only ${improvementPercent.toFixed(1)}% AQI improvement`);
              }
            }
          }
        } catch (error) {
          console.warn('Error calculating alternative route:', error.message);
          // If we hit rate limits, stop trying more routes
          if (error.response?.status === 429) {
            console.log('Rate limit reached. Stopping alternative route calculation.');
            break;
          }
          // Continue with next waypoint
          continue;
        }
      } // End of for loop
    } else {
      console.warn('Cannot calculate alternative routes due to invalid standard route AQI');
    }
    
    // Return the best healthy route if we found any with significant improvements
    if (healthyRoutes.length > 0) {
      healthyRoutes.sort((a, b) => a.score - b.score);
      const bestRoute = healthyRoutes[0];
      
      // Validate metrics before sending
      if (isNaN(standardRouteAqi) || standardRouteAqi <= 0) standardRouteAqi = 50;
      if (isNaN(bestRoute.avgAqi) || bestRoute.avgAqi <= 0) bestRoute.avgAqi = standardRouteAqi * 0.8; // Estimate 20% better
      
      const result = {
        route: bestRoute.route,
        metrics: {
          standard: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          },
          healthy: {
            distance: bestRoute.distance,
            avgAqi: bestRoute.avgAqi
          }
        }
      };
      
      // Cache the healthy route result
      routeCache.set(healthyRouteCacheKey, {
        data: result,
        expiry: Date.now() + CACHE_EXPIRY
      });
      
      return res.json(result);
    } else {
      // If no healthier routes found, suggest the standard route
      console.log('No healthier routes found');
      return res.json({ 
        route: standardRoute,
        metrics: {
          standard: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          },
          healthy: {
            distance: standardDistance,
            avgAqi: standardRouteAqi
          }
        },
        message: 'No healthier alternative routes found'
      });
    }
  } catch (error) {
    console.error('Error calculating healthy route:', error.message);
    
    // Better error messages for rate limits
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        details: 'The routing service is temporarily unavailable due to rate limiting. Please try again in a few minutes.'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to calculate a healthy route',
      details: error.message 
    });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} and accepting connections from all network interfaces`);
  console.log(`Available API endpoints:`);
  console.log(`- GET /api/test - Test if server is working`);
  console.log(`- GET /api/air-sensors - Get air quality sensors`);
  console.log(`- POST /api/directions - Get route directions`);
  console.log(`- GET /api/geocode - Search for addresses`);
  console.log(`- GET /api/reverse-geocode - Get address from coordinates`);
  console.log(`- GET /api/default-location - Get default location`);
});