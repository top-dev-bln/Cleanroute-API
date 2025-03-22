const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();



app.use(cors());
app.use(express.json());


const ORS_API_KEY = process.env.ORS_API_KEY;

  

app.post('/api/directions', async (req, res) => {
  try {
    const { start, end, profile } = req.body;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end points are required' });
    }

  
    const startCoord = [start[1], start[0]];
    const endCoord = [end[1], end[0]];

    console.log(`Fetching route from [${startCoord}] to [${endCoord}] using profile: ${profile || 'foot-walking'}`);
    
    const response = await axios.post(
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

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching directions:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch route',
      details: error.response?.data || error.message 
    });
  }
});

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
          size: 5, 
          'boundary.country': 'RO' 
        },
        headers: {
          'Authorization': `Bearer ${ORS_API_KEY}`,
          'Accept': 'application/json'
        }
      });
  
  
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

module.exports = app;

