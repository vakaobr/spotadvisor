// package.json
const packageJson = {
  "name": "multi-cloud-spot-monitor",
  "version": "1.0.0",
  "description": "Monitor Spot/Preemptible VM rates across AWS, Azure, and GCP",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.0.3",
    "axios": "^1.4.0",
    "@azure/identity": "^3.3.0",
    "@azure/arm-resourcegraph": "^4.2.1",
    "@aws-sdk/client-ec2": "^3.400.0",
    "@aws-sdk/client-pricing": "^3.400.0",
    "@google-cloud/compute": "^3.8.0",
    "node-cron": "^3.0.2",
    "sqlite3": "^5.1.6",
    "nodemailer": "^6.9.4",
    "winston": "^3.10.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}

// .env file template
const envTemplate = `
# Azure Credentials
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_SUBSCRIPTION_ID=your-subscription-id

# AWS Credentials
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1

# GCP Credentials
GCP_PROJECT_ID=your-project-id
GCP_KEY_FILE=./gcp-credentials.json

# Email Configuration (optional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ALERT_EMAIL=alerts@example.com

# Server Configuration
PORT=3000
NODE_ENV=production
`

// server.js - Main Express server
const serverCode = `
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

// src/SpotMonitor.js - Core monitoring logic
const spotMonitorCode = `
const { DefaultAzureCredential } = require('@azure/identity');
const { ResourceGraphClient } = require('@azure/arm-resourcegraph');
const { EC2Client, DescribeSpotPriceHistoryCommand } = require('@aws-sdk/client-ec2');
const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');
const { Compute } = require('@google-cloud/compute');
const logger = require('./logger');

class SpotMonitor {
  constructor(database) {
    this.db = database;
    this.initializeClients();
  }

  initializeClients() {
    // Azure
    if (process.env.AZURE_CLIENT_ID) {
      this.azureCredential = new DefaultAzureCredential();
      this.resourceGraphClient = new ResourceGraphClient(this.azureCredential);
    }

    // AWS
    if (process.env.AWS_ACCESS_KEY_ID) {
      this.ec2Client = new EC2Client({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
      this.pricingClient = new PricingClient({
        region: 'us-east-1', // Pricing API only works in us-east-1
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
    }

    // GCP
    if (process.env.GCP_PROJECT_ID) {
      this.gcpCompute = new Compute();
    }
  }

  // Azure: Get eviction rates and prices
  async getAzureEvictionRates(vmSizes = [], regions = []) {
    if (!this.resourceGraphClient) {
      throw new Error('Azure credentials not configured');
    }

    const vmSizesStr = vmSizes.map(s => \`'\${s}'\`).join(', ');
    const regionsStr = regions.map(r => \`'\${r}'\`).join(', ');

    // Query for eviction rates
    const evictionQuery = \`
      SpotResources
      | where type =~ 'microsoft.compute/skuspotevictionrate/location'
      \${vmSizes.length ? \`| where sku.name in~ (\${vmSizesStr})\` : ''}
      \${regions.length ? \`| where location in~ (\${regionsStr})\` : ''}
      | project skuName = tostring(sku.name), 
                location, 
                evictionRate = tostring(properties.evictionRate)
      | order by skuName asc, location asc
    \`;

    // Query for pricing
    const pricingQuery = \`
      SpotResources
      | where type =~ 'microsoft.compute/skuspotpricehistory/ostype/location'
      \${vmSizes.length ? \`| where sku.name in~ (\${vmSizesStr})\` : ''}
      | where properties.osType =~ 'linux'
      \${regions.length ? \`| where location in~ (\${regionsStr})\` : ''}
      | project skuName = tostring(sku.name), 
                location, 
                latestSpotPriceUSD = todouble(properties.spotPrices[0].priceUSD)
      | order by latestSpotPriceUSD asc
    \`;

    const [evictionResult, pricingResult] = await Promise.all([
      this.resourceGraphClient.resources({
        subscriptions: [process.env.AZURE_SUBSCRIPTION_ID],
        query: evictionQuery
      }),
      this.resourceGraphClient.resources({
        subscriptions: [process.env.AZURE_SUBSCRIPTION_ID],
        query: pricingQuery
      })
    ]);

    // Combine results
    const combined = {};
    
    if (evictionResult.data) {
      evictionResult.data.rows.forEach(row => {
        const key = \`\${row[0]}_\${row[1]}\`;
        combined[key] = {
          vmSize: row[0],
          region: row[1],
          evictionRate: row[2],
          cloud: 'Azure'
        };
      });
    }

    if (pricingResult.data) {
      pricingResult.data.rows.forEach(row => {
        const key = \`\${row[0]}_\${row[1]}\`;
        if (combined[key]) {
          combined[key].price = row[2];
        } else {
          combined[key] = {
            vmSize: row[0],
            region: row[1],
            price: row[2],
            cloud: 'Azure'
          };
        }
      });
    }

    const results = Object.values(combined);
    
    // Store in database
    for (const item of results) {
      await this.db.savePrice({
        cloud: 'Azure',
        vmType: item.vmSize,
        region: item.region,
        price: item.price,
        evictionRate: item.evictionRate
      });
    }

    return results;
  }

  // AWS: Get Spot price history
  async getAWSSpotHistory(instanceTypes = [], region = 'us-east-1') {
    if (!this.ec2Client) {
      throw new Error('AWS credentials not configured');
    }

    const params = {
      StartTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      EndTime: new Date(),
      ProductDescriptions: ['Linux/UNIX'],
      MaxResults: 100
    };

    if (instanceTypes.length > 0) {
      params.InstanceTypes = instanceTypes;
    }

    const command = new DescribeSpotPriceHistoryCommand(params);
    const response = await this.ec2Client.send(command);

    const results = response.SpotPriceHistory.map(item => ({
      cloud: 'AWS',
      instanceType: item.InstanceType,
      region: item.AvailabilityZone,
      price: parseFloat(item.SpotPrice),
      timestamp: item.Timestamp
    }));

    // Calculate interruption frequency (simplified - based on price volatility)
    const grouped = {};
    results.forEach(item => {
      const key = \`\${item.instanceType}_\${item.region}\`;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(item.price);
    });

    const processed = Object.keys(grouped).map(key => {
      const prices = grouped[key];
      const [instanceType, region] = key.split('_');
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance = prices.reduce((sum, price) => sum + Math.pow(price - avgPrice, 2), 0) / prices.length;
      const volatility = Math.sqrt(variance) / avgPrice;
      
      // Estimate interruption rate based on volatility (simplified)
      const estimatedInterruptionRate = Math.min(volatility * 100, 20);

      return {
        cloud: 'AWS',
        instanceType,
        region,
        currentPrice: prices[prices.length - 1],
        avgPrice,
        volatility,
        estimatedInterruptionRate: \`\${estimatedInterruptionRate.toFixed(1)}%\`
      };
    });

    // Store in database
    for (const item of processed) {
      await this.db.savePrice({
        cloud: 'AWS',
        vmType: item.instanceType,
        region: item.region,
        price: item.currentPrice,
        evictionRate: item.estimatedInterruptionRate
      });
    }

    return processed;
  }

  // GCP: Get Preemptible VM prices
  async getGCPPreemptiblePrices(machineTypes = [], zone = 'us-central1-a') {
    if (!this.gcpCompute) {
      throw new Error('GCP credentials not configured');
    }

    const project = process.env.GCP_PROJECT_ID;
    const results = [];

    try {
      // Get machine types for the zone
      const [machineTypeList] = await this.gcpCompute.machineTypes.list({
        project,
        zone
      });

      for (const machineType of machineTypeList) {
        if (machineTypes.length === 0 || machineTypes.includes(machineType.name)) {
          // GCP pricing calculation (simplified)
          // Preemptible instances are typically 60-91% cheaper than regular
          const regularPrice = this.calculateGCPPrice(machineType);
          const preemptiblePrice = regularPrice * 0.3; // ~70% discount
          
          results.push({
            cloud: 'GCP',
            machineType: machineType.name,
            zone,
            vcpus: machineType.guestCpus,
            memoryGb: Math.round(machineType.memoryMb / 1024),
            regularPrice,
            preemptiblePrice,
            savings: '70%',
            maxRuntime: '24 hours',
            preemptionRate: '5-15%' // GCP average
          });
        }
      }

      // Store in database
      for (const item of results) {
        await this.db.savePrice({
          cloud: 'GCP',
          vmType: item.machineType,
          region: zone,
          price: item.preemptiblePrice,
          evictionRate: item.preemptionRate
        });
      }
    } catch (error) {
      logger.error('GCP price fetch failed:', error);
      throw error;
    }

    return results;
  }

  // Calculate GCP price (simplified - would need actual pricing API)
  calculateGCPPrice(machineType) {
    // Base pricing estimates (per hour)
    const cpuPrice = 0.031611; // per vCPU
    const memoryPrice = 0.004237; // per GB
    
    const cpus = machineType.guestCpus || 1;
    const memoryGb = (machineType.memoryMb || 1024) / 1024;
    
    return (cpus * cpuPrice) + (memoryGb * memoryPrice);
  }

  // Compare similar VMs across all clouds
  async compareAcrossClouds(cpuCount = 2, memoryGb = 8, region = 'us-east') {
    const comparisons = [];

    // Azure
    if (this.resourceGraphClient) {
      const azureVmSize = this.mapToAzureSize(cpuCount, memoryGb);
      const azureData = await this.getAzureEvictionRates([azureVmSize], ['eastus']);
      if (azureData.length > 0) {
        comparisons.push({
          cloud: 'Azure',
          vmType: azureVmSize,
          ...azureData[0]
        });
      }
    }

    // AWS
    if (this.ec2Client) {
      const awsInstanceType = this.mapToAWSType(cpuCount, memoryGb);
      const awsData = await this.getAWSSpotHistory([awsInstanceType], 'us-east-1');
      if (awsData.length > 0) {
        comparisons.push({
          cloud: 'AWS',
          vmType: awsInstanceType,
          ...awsData[0]
        });
      }
    }

    // GCP
    if (this.gcpCompute) {
      const gcpMachineType = this.mapToGCPType(cpuCount, memoryGb);
      const gcpData = await this.getGCPPreemptiblePrices([gcpMachineType], 'us-central1-a');
      if (gcpData.length > 0) {
        comparisons.push({
          cloud: 'GCP',
          vmType: gcpMachineType,
          ...gcpData[0]
        });
      }
    }

    // Sort by price
    comparisons.sort((a, b) => {
      const priceA = a.price || a.currentPrice || a.preemptiblePrice || 0;
      const priceB = b.price || b.currentPrice || b.preemptiblePrice || 0;
      return priceA - priceB;
    });

    return comparisons;
  }

  // VM type mapping functions
  mapToAzureSize(cpus, memory) {
    if (cpus <= 2 && memory <= 8) return 'standard_d2s_v4';
    if (cpus <= 4 && memory <= 16) return 'standard_d4s_v4';
    if (cpus <= 8 && memory <= 32) return 'standard_d8s_v4';
    return 'standard_d16s_v4';
  }

  mapToAWSType(cpus, memory) {
    if (cpus <= 2 && memory <= 8) return 't3.large';
    if (cpus <= 4 && memory <= 16) return 't3.xlarge';
    if (cpus <= 8 && memory <= 32) return 't3.2xlarge';
    return 'm5.4xlarge';
  }

  mapToGCPType(cpus, memory) {
    if (cpus <= 2 && memory <= 8) return 'n1-standard-2';
    if (cpus <= 4 && memory <= 16) return 'n1-standard-4';
    if (cpus <= 8 && memory <= 32) return 'n1-standard-8';
    return 'n1-standard-16';
  }

  // Collect all prices (for scheduled runs)
  async collectAllPrices() {
    const results = {
      azure: null,
      aws: null,
      gcp: null
    };

    try {
      if (this.resourceGraphClient) {
        results.azure = await this.getAzureEvictionRates();
      }
    } catch (error) {
      logger.error('Azure collection failed:', error);
    }

    try {
      if (this.ec2Client) {
        results.aws = await this.getAWSSpotHistory();
      }
    } catch (error) {
      logger.error('AWS collection failed:', error);
    }

    try {
      if (this.gcpCompute) {
        results.gcp = await this.getGCPPreemptiblePrices();
      }
    } catch (error) {
      logger.error('GCP collection failed:', error);
    }

    return results;
  }
}

module.exports = SpotMonitor;
`;

// src/Database.js - SQLite database for storing historical data
const databaseCode = `
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('./logger');

class Database {
  constructor() {
    this.dbPath = path.join(__dirname, '..', 'data', 'spot-monitor.db');
  }

  initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          logger.error('Database connection failed:', err);
          reject(err);
        } else {
          logger.info('Connected to SQLite database');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  createTables() {
    const queries = [
      \`CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cloud TEXT NOT NULL,
        vm_type TEXT NOT NULL,
        region TEXT NOT NULL,
        price REAL,
        eviction_rate TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )\`,
      
      \`CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cloud TEXT NOT NULL,
        vm_type TEXT NOT NULL,
        region TEXT NOT NULL,
        threshold_price REAL,
        threshold_eviction REAL,
        notify_email TEXT,
        notify_webhook TEXT,
        enabled BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )\`,
      
      \`CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER,
        triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        price REAL,
        eviction_rate TEXT,
        FOREIGN KEY(alert_id) REFERENCES alerts(id)
      )\`,

      \`CREATE INDEX IF NOT EXISTS idx_prices_lookup 
       ON prices(cloud, vm_type, region, timestamp)\`,
       
      \`CREATE INDEX IF NOT EXISTS idx_alerts_enabled 
       ON alerts(enabled)\`
    ];

    return Promise.all(queries.map(query => this.run(query)));
  }

  run(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(query, params, function(err) {
        if (err) {
          logger.error('Database query failed:', err);
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(query, params, (err, row) => {
        if (err) {
          logger.error('Database query failed:', err);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) {
          logger.error('Database query failed:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async savePrice(data) {
    const query = \`
      INSERT INTO prices (cloud, vm_type, region, price, eviction_rate)
      VALUES (?, ?, ?, ?, ?)
    \`;
    return this.run(query, [
      data.cloud,
      data.vmType,
      data.region,
      data.price,
      data.evictionRate
    ]);
  }

  async getHistory(cloud, vmType, region, days = 7) {
    const query = \`
      SELECT * FROM prices
      WHERE cloud = ? 
        AND vm_type = ? 
        AND region = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY timestamp DESC
    \`;
    return this.all(query, [cloud, vmType, region, days]);
  }

  async getLatestPrices() {
    const query = \`
      SELECT p1.* FROM prices p1
      INNER JOIN (
        SELECT cloud, vm_type, region, MAX(timestamp) as max_time
        FROM prices
        GROUP BY cloud, vm_type, region
      ) p2 ON p1.cloud = p2.cloud 
         AND p1.vm_type = p2.vm_type 
         AND p1.region = p2.region 
         AND p1.timestamp = p2.max_time
    \`;
    return this.all(query);
  }
}

module.exports = Database;
`;

// src/AlertService.js - Handle alerting
const alertServiceCode = `
const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('./logger');

class AlertService {
  constructor(database) {
    this.db = database;
    this.setupEmailTransporter();
  }

  setupEmailTransporter() {
    if (process.env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
  }

  async createAlert(alertConfig) {
    const query = \`
      INSERT INTO alerts (cloud, vm_type, region, threshold_price, threshold_eviction, notify_email, notify_webhook)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    \`;
    
    const result = await this.db.run(query, [
      alertConfig.cloud,
      alertConfig.vmType,
      alertConfig.region,
      alertConfig.thresholdPrice,
      alertConfig.thresholdEviction,
      alertConfig.notifyEmail,
      alertConfig.notifyWebhook
    ]);
    
    return { id: result.id, ...alertConfig };
  }

  async getAlerts() {
    return this.db.all('SELECT * FROM alerts WHERE enabled = 1');
  }

  async deleteAlert(id) {
    return this.db.run('DELETE FROM alerts WHERE id = ?', [id]);
  }

  async checkAlerts() {
    const alerts = await this.getAlerts();
    const latestPrices = await this.db.getLatestPrices();
    
    for (const alert of alerts) {
      const priceData = latestPrices.find(p => 
        p.cloud === alert.cloud &&
        p.vm_type === alert.vm_type &&
        p.region === alert.region
      );
      
      if (!priceData) continue;
      
      let triggered = false;
      let reason = '';
      
      // Check price threshold
      if (alert.threshold_price && priceData.price > alert.threshold_price) {
        triggered = true;
        reason = \`Price \${priceData.price} exceeds threshold \${alert.threshold_price}\`;
      }
      
      // Check eviction threshold
      if (alert.threshold_eviction && priceData.eviction_rate) {
        const evictionValue = parseFloat(priceData.eviction_rate.replace('%', ''));
        if (evictionValue > alert.threshold_eviction) {
          triggered = true;
          reason += reason ? ' and ' : '';
          reason += \`Eviction rate \${priceData.eviction_rate} exceeds threshold \${alert.threshold_eviction}%\`;
        }
      }
      
      if (triggered) {
        await this.sendAlert(alert, priceData, reason);
        await this.recordAlertHistory(alert.id, priceData);
      }
    }
  }

  async sendAlert(alert, priceData, reason) {
    const message = {
      subject: \`Spot VM Alert: \${alert.cloud} \${alert.vm_type}\`,
      text: \`
        Alert Triggered!
        
        Cloud: \${alert.cloud}
        VM Type