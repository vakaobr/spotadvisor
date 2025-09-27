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
