const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const SpotMonitor = require('./src/SpotMonitor');
const Database = require('./src/Database');
const AlertService = require('./src/AlertService');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
const db = new Database();
const monitor = new SpotMonitor(db);
const alertService = new AlertService(db);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current spot prices across all clouds
app.get('/api/spot-prices', async (req, res) => {
  try {
    const { vmType, region } = req.query;
    const data = await monitor.getAllSpotPrices(vmType, region);
    res.json(data);
  } catch (error) {
    console.error('Error fetching spot prices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Azure eviction rates
app.get('/api/azure/eviction-rates', async (req, res) => {
  try {
    const { vmSizes, regions } = req.query;
    const data = await monitor.getAzureEvictionRates(
      vmSizes ? vmSizes.split(',') : [],
      regions ? regions.split(',') : []
    );
    res.json(data);
  } catch (error) {
    console.error('Error fetching eviction rates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get AWS Spot price history
app.get('/api/aws/spot-history', async (req, res) => {
  try {
    const { instanceTypes, region } = req.query;
    const data = await monitor.getAWSSpotHistory(
      instanceTypes ? instanceTypes.split(',') : [],
      region
    );
    res.json(data);
  } catch (error) {
    console.error('Error fetching AWS spot history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get GCP Preemptible pricing
app.get('/api/gcp/preemptible-prices', async (req, res) => {
  try {
    const { machineTypes, zone } = req.query;
    const data = await monitor.getGCPPreemptiblePrices(
      machineTypes ? machineTypes.split(',') : [],
      zone
    );
    res.json(data);
  } catch (error) {
    console.error('Error fetching GCP prices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get comparison across all clouds
app.get('/api/compare', async (req, res) => {
  try {
    const { cpu, memory, region } = req.query;
    const comparison = await monitor.compareAcrossClouds(cpu, memory, region);
    res.json(comparison);
  } catch (error) {
    console.error('Error comparing clouds:', error);
    res.status(500).json({ error: error.message });
  }
});

// Alert configuration
app.post('/api/alerts', async (req, res) => {
  try {
    const alert = await alertService.createAlert(req.body);
    res.json(alert);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await alertService.getAlerts();
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  try {
    await alertService.deleteAlert(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Historical data
app.get('/api/history', async (req, res) => {
  try {
    const { cloud, vmType, region, days = 7 } = req.query;
    const history = await db.getHistory(cloud, vmType, region, days);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule periodic price checks (every hour)
cron.schedule('0 * * * *', async () => {
  console.log('Running scheduled price check...');
  try {
    await monitor.collectAllPrices();
    await alertService.checkAlerts();
  } catch (error) {
    console.error('Scheduled check failed:', error);
  }
});

// Initialize database and start server
db.initialize().then(() => {
  app.listen(PORT, () => {
    console.log(\`Multi-Cloud Spot Monitor running on port \${PORT}\`);
    console.log(\`Visit http://localhost:\${PORT} to view the dashboard\`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
`;
