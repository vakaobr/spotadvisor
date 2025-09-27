const { DefaultAzureCredential } = require('@azure/identity');
const { ResourceGraphClient } = require('@azure/arm-resourcegraph');
const { EC2Client, DescribeSpotPriceHistoryCommand } = require('@aws-sdk/client-ec2');
const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');
const logger = require('./logger');
let Compute; // Declare Compute outside the class

async function loadCompute() {
  try {
    const computeModule = await import('@google-cloud/compute'); // Dynamic import
    Compute = computeModule.Compute; // Assign to the outer Compute
    console.log('Successfully loaded Compute module dynamically.'); // Add console log
  } catch (err) {
    console.error('Failed to load Compute module dynamically:', err);
    Compute = null; // Ensure Compute is null if loading fails
  }
}

class SpotMonitor {
  constructor(database) {
    this.db = database;
    this.cache = {
      awsPricing: { ts: 0, data: null },
      awsSpot: { ts: 0, data: null },
      ttlMs: Number(process.env.CACHE_TTL_MS || 300 * 1000) // default 300s
    };
    this.gcpCompute = null; // Initialize to null
    this.initializeClients();
  }

  async initializeClients() {
    // Azure
    if (process.env.AZURE_CLIENT_ID) {
      try {
        this.azureCredential = new DefaultAzureCredential();
        this.resourceGraphClient = new ResourceGraphClient(this.azureCredential);
      } catch (err) {
        logger.error('Failed to initialize Azure client', err);
        this.resourceGraphClient = null;
      }
    }

    // AWS - EC2 for spot history
    if (process.env.AWS_ACCESS_KEY_ID) {
      this.ec2Client = new EC2Client({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });

      // Pricing API client must operate in us-east-1 (service endpoint)
      try {
        this.pricingClient = new PricingClient({
          region: process.env.AWS_PRICING_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_KEY
          }
        });
      } catch (err) {
        logger.error('Failed to initialize AWS Pricing client', err);
        this.pricingClient = null;
      }
    }

    //GCP
    if (process.env.GCP_PROJECT_ID) {
        try {
            // Dynamically import the compute module
            const computeModule = await import('@google-cloud/compute');
            const { Compute } = computeModule;

            if (Compute) {
                try {
                    this.gcpCompute = new Compute({ projectId: process.env.GCP_PROJECT_ID });
                    logger.info('GCP Compute client initialized.');
                } catch (err) {
                    logger.error('Failed to initialize GCP Compute client', err);
                    this.gcpCompute = null;
                }
            } else {
                logger.warn('Compute module not loaded, skipping GCP client initialization.');
                this.gcpCompute = null;
            }
        } catch (err) {
            logger.error('Failed to load Compute module:', err);
            this.gcpCompute = null;
        }
    } else {
        logger.warn('GCP_PROJECT_ID is not set. Skipping GCP client initialization.');
        this.gcpCompute = null;
    }
  }

  // return latest saved prices optionally filtered
  async getAllSpotPrices(vmType, region) {
    const rows = await this.db.getLatestPrices();
    return rows.filter(r => {
      if (vmType && r.vm_type !== vmType) return false;
      if (region && r.region !== region) return false;
      return true;
    });
  }

  // AWS Pricing: get on-demand prices for instance types (uses Pricing API)
  // Note: Pricing API returns JSON strings inside PriceList array; parsing is required.
  async getAWSPricing(instanceTypes = [], regionName = 'US East (N. Virginia)') {
    if (!this.pricingClient) {
      logger.warn('AWS Pricing client not configured, skipping pricing fetch');
      return [];
    }

    const now = Date.now();
    if (this.cache.awsPricing.ts + this.cache.ttlMs > now && this.cache.awsPricing.data) {
      // If instanceTypes is empty, return cached; if not, filter cached results
      if (!instanceTypes || instanceTypes.length === 0) return this.cache.awsPricing.data;
      return this.cache.awsPricing.data.filter(r => instanceTypes.includes(r.instanceType));
    }

    const results = [];
    try {
      // For each instance type, call GetProducts with filters
      for (const instanceType of instanceTypes) {
        const filters = [
          { Type: 'TERM_MATCH', Field: 'serviceCode', Value: 'AmazonEC2' },
          { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
          { Type: 'TERM_MATCH', Field: 'location', Value: regionName },
          { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
          { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
          { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
          { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' }
        ];

        const cmd = new GetProductsCommand({
          ServiceCode: 'AmazonEC2',
          Filters: filters,
          FormatVersion: 'aws_v1',
          MaxResults: 100
        });

        const resp = await this.pricingClient.send(cmd);
        const priceItems = resp.PriceList || [];
        // parse priceItems (strings). We look for onDemand price dimensions
        for (const pRaw of priceItems) {
          try {
            const p = typeof pRaw === 'string' ? JSON.parse(pRaw) : pRaw;
            const product = p.product || p;
            const sku = product.sku || product.Sku || null;
            const terms = p.terms || {};
            const onDemand = terms.OnDemand || {};
            for (const odKey of Object.keys(onDemand)) {
              const od = onDemand[odKey];
              const priceDimensions = od.priceDimensions || {};
              for (const pdKey of Object.keys(priceDimensions)) {
                const pd = priceDimensions[pdKey];
                const pricePerUnit = pd.pricePerUnit && (pd.pricePerUnit.USD || pd.pricePerUnit.USD === 0) ? Number(pd.pricePerUnit.USD) : null;
                if (pricePerUnit != null) {
                  results.push({
                    cloud: 'AWS',
                    source: 'pricing_on_demand',
                    instanceType,
                    region: regionName,
                    sku,
                    price: pricePerUnit,
                    unit: pd.unit,
                    description: pd.description
                  });
                }
              }
            }
          } catch (err) {
            logger.warn('Failed to parse pricing item', err);
          }
        }
      }

      // cache
      this.cache.awsPricing = { ts: Date.now(), data: results };
      return results;
    } catch (err) {
      logger.error('AWS Pricing fetch failed', err);
      return [];
    }
  }

  // AWS: Get Spot price history (use EC2 DescribeSpotPriceHistory)
  async getAWSSpotHistory(instanceTypes = [], region = 'us-east-1') {
    if (!this.ec2Client) {
      logger.warn('AWS EC2 client not configured, skipping AWS fetch');
      return [];
    }

    const now = Date.now();
    if (this.cache.awsSpot.ts + this.cache.ttlMs > now && this.cache.awsSpot.data) {
      // if cached data exists and instanceTypes are subset, return cached; otherwise ignore cache
      if (!instanceTypes || instanceTypes.every(it => this.cache.awsSpot.data.instanceTypesSeen?.includes(it))) {
        return this.cache.awsSpot.data.results || [];
      }
    }

    const params = {
      StartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
      EndTime: new Date(),
      ProductDescriptions: ['Linux/UNIX'],
      MaxResults: 100
    };
    if (instanceTypes.length > 0) {
      params.InstanceTypes = instanceTypes;
    }

    try {
      const command = new DescribeSpotPriceHistoryCommand(params);
      const response = await this.ec2Client.send(command);

      const history = response.SpotPriceHistory || [];
      const results = history.map(item => {
        const az = item.AvailabilityZone || '';
        const regionName = az ? az.slice(0, -1) : item.RegionName || region;
        return {
          cloud: 'AWS',
          source: 'spot_history',
          instanceType: item.InstanceType,
          region: regionName,
          price: parseFloat(item.SpotPrice),
          timestamp: item.Timestamp
        };
      });

      // Group by instance+region and compute volatility/eviction estimate
      const grouped = {};
      results.forEach(item => {
        const key = `${item.instanceType}_${item.region}`;
        if (!grouped[key]) grouped[key] = [];
        if (typeof item.price === 'number' && !isNaN(item.price)) grouped[key].push(item.price);
      });

      const processed = Object.keys(grouped).map(key => {
        const prices = grouped[key];
        const [instanceType, regionVal] = key.split('_');
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((s, p) => s + Math.pow(p - avgPrice, 2), 0) / prices.length;
        const volatility = Math.sqrt(variance) / (avgPrice || 1);
        const estimatedInterruptionRate = Math.min(volatility * 100, 20);

        return {
          cloud: 'AWS',
          vm_type: instanceType,
          region: regionVal,
          price: prices[prices.length - 1],
          avg_price: avgPrice,
          volatility,
          eviction_rate: `${estimatedInterruptionRate.toFixed(1)}%`
        };
      });

      // save to DB
      await Promise.all(processed.map(item =>
        this.db.savePrice({
          cloud: 'AWS',
          vm_type: item.vm_type,
          region: item.region,
          price: item.price,
          eviction_rate: item.eviction_rate
        })
      ));

      // cache entire results and record seen instance types
      this.cache.awsSpot = {
        ts: Date.now(),
        data: { results: processed, instanceTypesSeen: instanceTypes }
      };

      return processed;
    } catch (err) {
      logger.error('AWS spot history fetch failed', err);
      return [];
    }
  }

  // GCP: Get Preemptible VM prices (simplified)
  async getGCPPreemptiblePrices(machineTypes = [], zone = 'us-central1-a') {
    if (!this.gcpCompute) {
      logger.warn('GCP client not configured, skipping GCP fetch');
      return [];
    }

    const project = process.env.GCP_PROJECT_ID;
    const results = [];

    try {
      const resp = await this.gcpCompute.machineTypes.list({ project, zone });
      const machineTypeList = (resp && resp[0] && resp[0].items) ? resp[0].items : resp.items || resp || [];

      for (const machineType of machineTypeList) {
        if (!machineType) continue;
        if (machineTypes.length === 0 || machineTypes.includes(machineType.name)) {
          const regularPrice = this.calculateGCPPrice(machineType);
          const preemptiblePrice = regularPrice * 0.3;

          results.push({
            cloud: 'GCP',
            vm_type: machineType.name,
            region: zone,
            vcpus: machineType.guestCpus,
            memory_gb: Math.round(machineType.memoryMb / 1024),
            regular_price: regularPrice,
            price: preemptiblePrice,
            savings: '70%',
            eviction_rate: '5-15%'
          });
        }
      }

      await Promise.all(results.map(item =>
        this.db.savePrice({
          cloud: 'GCP',
          vm_type: item.vm_type,
          region: zone,
          price: item.price,
          eviction_rate: item.eviction_rate
        })
      ));

      return results;
    } catch (err) {
      logger.error('GCP preemptible fetch failed', err);
      return [];
    }
  }

  calculateGCPPrice(machineType) {
    const cpuPrice = 0.031611;
    const memoryPrice = 0.004237;
    const cpus = machineType.guestCpus || 1;
    const memoryGb = (machineType.memoryMb || 1024) / 1024;
    return cpus * cpuPrice + memoryGb * memoryPrice;
  }

  // Compare across clouds (simple)
  async compareAcrossClouds(cpuCount = 2, memoryGb = 8) {
    const comparisons = [];

    if (this.resourceGraphClient) {
      const azureVmSize = this.mapToAzureSize(cpuCount, memoryGb);
      const data = await this.getAzureEvictionRates([azureVmSize], ['eastus']);
      if (data.length > 0) comparisons.push({ cloud: 'Azure', vm_type: azureVmSize, ...data[0] });
    }

    if (this.ec2Client) {
      const awsType = this.mapToAWSType(cpuCount, memoryGb);
      const data = await this.getAWSSpotHistory([awsType], 'us-east-1');
      if (data.length > 0) comparisons.push({ cloud: 'AWS', vm_type: awsType, ...data[0] });
      // also try to fetch on-demand via Pricing API for comparison
      const pricing = await this.getAWSPricing([awsType], 'US East (N. Virginia)');
      if (pricing.length > 0) {
        const p = pricing.find(x => x.instanceType === awsType);
        if (p) comparisons.push({ cloud: 'AWS-onDemand', vm_type: awsType, price: p.price });
      }
    }

    if (this.gcpCompute) {
      const gcpType = this.mapToGCPType(cpuCount, memoryGb);
      const data = await this.getGCPPreemptiblePrices([gcpType], 'us-central1-a');
      if (data.length > 0) comparisons.push({ cloud: 'GCP', vm_type: gcpType, ...data[0] });
    }

    comparisons.sort((a, b) => (a.price || 0) - (b.price || 0));
    return comparisons;
  }

  // Placeholder Azure method reused from earlier implementation
  async getAzureEvictionRates(vmSizes = [], regions = []) {
    if (!this.resourceGraphClient) {
      logger.warn('Azure client not configured, skipping Azure fetch');
      return [];
    }

    const vmSizesStr = vmSizes.map(s => `'${s}'`).join(', ');
    const regionsStr = regions.map(r => `'${r}'`).join(', ');

    const evictionQuery = `
      SpotResources
      | where type =~ 'microsoft.compute/skuspotevictionrate/location'
      ${vmSizes.length ? `| where sku.name in~ (${vmSizesStr})` : ''}
      ${regions.length ? `| where location in~ (${regionsStr})` : ''}
      | project skuName = tostring(sku.name),
                location,
                evictionRate = tostring(properties.evictionRate)
    `;

    const pricingQuery = `
      SpotResources
      | where type =~ 'microsoft.compute/skuspotpricehistory/ostype/location'
      ${vmSizes.length ? `| where sku.name in~ (${vmSizesStr})` : ''}
      | where properties.osType =~ 'linux'
      ${regions.length ? `| where location in~ (${regionsStr})` : ''}
      | project skuName = tostring(sku.name),
                location,
                latestSpotPriceUSD = todouble(properties.spotPrices[0].priceUSD)
    `;

    try {
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

      const combined = {};

      if (evictionResult.data?.rows) {
        evictionResult.data.rows.forEach(row => {
          const key = `${row[0]}_${row[1]}`;
          combined[key] = {
            vm_type: row[0],
            region: row[1],
            eviction_rate: row[2],
            cloud: 'Azure'
          };
        });
      }

      if (pricingResult.data?.rows) {
        pricingResult.data.rows.forEach(row => {
          const key = `${row[0]}_${row[1]}`;
          if (combined[key]) {
            combined[key].price = row[2];
          } else {
            combined[key] = {
              vm_type: row[0],
              region: row[1],
              price: row[2],
              cloud: 'Azure'
            };
          }
        });
      }

      const results = Object.values(combined);

      await Promise.all(results.map(item =>
        this.db.savePrice({
          cloud: 'Azure',
          vm_type: item.vm_type,
          region: item.region,
          price: item.price,
          eviction_rate: item.eviction_rate
        })
      ));

      return results;
    } catch (err) {
      logger.error('Azure price/eviction query failed', err);
      return [];
    }
  }

  // Simple mappings
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

  // Scheduled collection
  async collectAllPrices() {
    const results = { azure: null, aws_spot: null, aws_pricing: null, gcp: null };

    if (this.resourceGraphClient) {
      try {
        results.azure = await this.getAzureEvictionRates();
      } catch (err) {
        logger.error('Azure collection failed', err);
      }
    } else {
      logger.debug('Azure not configured, skipping');
    }

    if (this.ec2Client) {
      try {
        results.aws_spot = await this.getAWSSpotHistory();
      } catch (err) {
        logger.error('AWS spot collection failed', err);
      }
      try {
        results.aws_pricing = await this.getAWSPricing([]); // empty -> will return cached/all
      } catch (err) {
        logger.error('AWS pricing collection failed', err);
      }
    } else {
      logger.debug('AWS not configured, skipping');
    }

    if (this.gcpCompute) {
      try {
        results.gcp = await this.getGCPPreemptiblePrices();
      } catch (err) {
        logger.error('GCP collection failed', err);
      }
    } else {
      logger.debug('GCP not configured, skipping');
    }

    return results;
  }
}

module.exports = SpotMonitor;
