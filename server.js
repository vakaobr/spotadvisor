// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const SpotMonitor = require('./src/SpotMonitor');
const Database = require('./src/Database');
const AlertService = require('./src/AlertService');
const logger = require('./src/logger');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Initialize DB instance
const db = new Database();

async function startServer() {
  // Initialize SpotMonitor and its clients
  const monitor = new SpotMonitor(db);
  await monitor.initializeClients();

  // Setup Express middlewares
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // central error handler
  app.use((err, req, res, next) => {
    logger.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  // Initialize database
  await db.initialize();

  // Define routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/spot-prices', async (req, res, next) => {
    try {
      const { vmType, region } = req.query;
      const data = await monitor.getAllSpotPrices(vmType, region);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/aws/pricing', async (req, res) => {
    try {
      const { instanceTypes, regionName } = req.query;
      const types = instanceTypes ? instanceTypes.split(',') : [];
      const region = regionName || 'US East (N. Virginia)';
      const data = await monitor.getAWSPricing(types, region);
      res.json(data);
    } catch (error) {
      logger.error('Error fetching AWS pricing:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/azure/eviction-rates', async (req, res) => {
    try {
      const { vmSizes, regions } = req.query;
      const data = await monitor.getAzureEvictionRates(
        vmSizes ? vmSizes.split(',') : [],
        regions ? regions.split(',') : []
      );
      res.json(data);
    } catch (error) {
      logger.error('Error fetching eviction rates:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/aws/spot-history', async (req, res) => {
    try {
      const { instanceTypes, region } = req.query;
      const data = await monitor.getAWSSpotHistory(
        instanceTypes ? instanceTypes.split(',') : [],
        region
      );
      res.json(data);
    } catch (error) {
      logger.error('Error fetching AWS spot history:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/gcp/preemptible-prices', async (req, res) => {
    try {
      const { machineTypes, zone } = req.query;
      const data = await monitor.getGCPPreemptiblePrices(
        machineTypes ? machineTypes.split(',') : [],
        zone
      );
      res.json(data);
    } catch (error) {
      logger.error('Error fetching GCP prices:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/compare', async (req, res) => {
    try {
      const cpuNum = Number(req.query.cpu) || 2;
      const memoryNum = Number(req.query.memory) || 8;
      const comparison = await monitor.compareAcrossClouds(cpuNum, memoryNum);
      res.json(comparison);
    } catch (error) {
      logger.error('Error comparing clouds:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Alert routes
    app.get('/api/alerts', async (req, res, next) => {
    try {
      const alerts = await new AlertService(db).getAlerts();
      res.json(alerts);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/alerts/:id', async (req, res, next) => {
    try {
      await new AlertService(db).deleteAlert(req.params.id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // history route
  app.get('/api/history', async (req, res, next) => {
    try {
      const { cloud, vmType, region, days = 7 } = req.query;
      const history = await db.getHistory(cloud, vmType, region, Number(days));
      res.json(history);
    } catch (error) {
      next(error);
    }
  });

  // Schedule periodic price checks
  const cronExpr = process.env.CRON_EXPR || '0 * * * *';
  cron.schedule(cronExpr, async () => {
    logger.info('Running scheduled price check...');
    try {
      await monitor.collectAllPrices();
      await new AlertService(db).checkAlerts();
    } catch (error) {
      logger.error('Scheduled check failed:', error);
    }
  }, {
    timezone: process.env.CRON_TZ || 'UTC'
  });

  const server = app.listen(PORT, () => {
    logger.info(`Multi-Cloud Spot Monitor running on port ${PORT}`);
  });

  // graceful shutdown
  const shutdown = () => {
    logger.info('Shutdown requested, closing server...');
    server.close(async () => {
      if (db.close) await db.close();
      logger.info('Shutdown complete.');
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Call the async main function and handle startup errors
(async () => {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();
