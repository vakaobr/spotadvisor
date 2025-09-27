# Multi-Cloud Spot VM Monitor

Monitor and compare Spot/Preemptible VM prices and eviction rates across AWS, Azure, and GCP.

## Features

- Real-time monitoring of Spot VM prices across AWS, Azure, and GCP
- AWS: Spot history (EC2) + on-demand pricing (Pricing API)
- Azure eviction rate monitoring (Resource Graph)
- Historical data tracking with SQLite
- Email and webhook alerts for price/eviction thresholds
- REST API for programmatic access
- CLI smoke tests and developer tooling (ESLint, Prettier)

## Quick start

Prerequisites
- Node.js 20+
- npm
- Optional: PM2 or systemd for production
- Cloud credentials for providers you want to use:
  - Azure: Service Principal with Resource Graph access
  - AWS: IAM user with EC2 and Pricing API access
  - GCP: Service account with Compute Engine access

## Running on LightSail (AWS)

### 0. Quick Setup on Lightsail

```bash
# SSH into your Lightsail instance
ssh -i your-key.pem ubuntu@your-lightsail-ip

# Download and run setup script
curl -O https://raw.githubusercontent.com/YOUR_REPO/lightsail-setup.sh
chmod +x lightsail-setup.sh
./lightsail-setup.sh
```

(From here, follow the steps of Running locally section below)

## Running Locally

### 1. Clone the repo and install dependencies:
```bash
git clone <your-repo>
cd multi-cloud-spot-monitor
npm install
```

### 2. Configure environment variables (.env). Minimal example:
```bash
PORT=3000
NODE_ENV=development

# AWS
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_PRICING_REGION=us-east-1

# GCP
GCP_PROJECT_ID=...
# set GOOGLE_APPLICATION_CREDENTIALS to point to your service account key JSON

# Azure
AZURE_CLIENT_ID=...
AZURE_TENANT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_SUBSCRIPTION_ID=...

# Optional alerting
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
DEFAULT_ALERT_EMAIL=you@example.com

# Cache TTL in milliseconds (default 300000)
CACHE_TTL_MS=300000

### 3. Start the server:
- Development:
```bash
npm run dev
```
- Production:
```bash
npm start
``` 
### 4. Access the Dashboard
Open your browser and navigate to: `http://YOUR_LIGHTSAIL_IP`

---

## API Endpoints & Example curl Commands

- `GET /api/health` — health check
  ```bash
  curl -sS http://localhost:3000/api/health
  ```

- GET /api/spot-prices — latest prices (optionally filter with vmType, region)

```bash
curl -sS http://localhost:3000/api/spot-prices
curl -sS "http://localhost:3000/api/spot-prices?vmType=t3.large&region=us-east-1"
```

- GET /api/azure/eviction-rates — Azure eviction rates

```bash
curl -sS "http://localhost:3000/api/azure/eviction-rates?vmSizes=standard_d2s_v4,standard_d4s_v4&regions=eastus"
```
- GET /api/aws/spot-history — EC2 Spot price history

```bash
curl -sS "http://localhost:3000/api/aws/spot-history?instanceTypes=t3.large,t3.xlarge&region=us-east-1"
```

- GET /api/aws/pricing — AWS on-demand prices

```bash
curl -sS "http://localhost:3000/api/aws/pricing?instanceTypes=t3.large&regionName=US%20East%20(N.%20Virginia)"
```

- GET /api/gcp/preemptible-prices — GCP preemptible estimates

```bash
curl -sS "http://localhost:3000/api/gcp/preemptible-prices?machineTypes=n1-standard-2&zone=us-central1-a"
```

- GET /api/compare — cross-cloud comparison

```bash
curl -sS "http://localhost:3000/api/compare?cpu=2&memory=8"
```

- POST /api/alerts — create a new alert (example)

```bash
curl -sS -X POST http://localhost:3000/api/alerts \
  -H "Content-Type: application/json" \
  -d '{"cloud":"AWS","vmType":"t3.large","region":"us-east-1","thresholdPrice":0.05,"notifyEmail":"you@example.com"}'
```

- GET /api/alerts — list all alerts

```bash
curl -sS http://localhost:3000/api/alerts
```

- DELETE /api/alerts/:id — delete alert by ID

```bash
curl -sS -X DELETE http://localhost:3000/api/alerts/1
```

- GET /api/history — get historical data

```bash
curl -sS "http://localhost:3000/api/history?cloud=AWS&vmType=t3.large&region=us-east-1&days=7"
```

## Getting Cloud Credentials

### Azure
```bash
# Create service principal
az ad sp create-for-rbac --name "SpotMonitor" --role "Reader"

# Grant Resource Graph access
az role assignment create --assignee <APP_ID> --role "Reader" --scope "/subscriptions/<SUBSCRIPTION_ID>"
```

### AWS
1. Create IAM user in AWS Console
2. Attach policies: `AmazonEC2ReadOnlyAccess`, `AWSPriceListServiceFullAccess`
3. Generate access keys

### GCP
```bash
# Create service account
gcloud iam service-accounts create spot-monitor

# Grant permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:spot-monitor@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/compute.viewer"

# Create key
gcloud iam service-accounts keys create gcp-credentials.json \
  --iam-account=spot-monitor@YOUR_PROJECT.iam.gserviceaccount.com
```

## Monitoring & Maintenance

```bash
# View logs
pm2 logs spot-monitor

# Monitor status
pm2 status

# Restart application
pm2 restart spot-monitor

# Update application
git pull
npm install
pm2 restart spot-monitor
```

## Cost Optimization

- Lightsail: First 3 months free for $3.50/month instance
- Use smallest instance size (512 MB RAM is sufficient)
- SQLite database keeps storage minimal
- API calls to cloud providers are typically free or very low cost

## Security Notes

- Keep `.env` file secure and never commit to git
- Use environment variables in production
- Enable HTTPS with Let's Encrypt for production
- Regularly update dependencies
- Use firewall rules to restrict access if needed

## License

MIT