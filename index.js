const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());


const ORS_API_KEY = "5b3ce3597851110001cf624883bee069829b4c9d91a8c62da78aa574";



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


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});