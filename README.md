# Multi-Cloud Spot VM Monitor

Monitor and compare Spot/Preemptible VM prices and eviction rates across AWS, Azure, and GCP.

## Features

- Real-time monitoring of Spot VM prices across all three major clouds
- Azure eviction rate monitoring
- Historical data tracking with SQLite
- Email and webhook alerts for price/eviction thresholds
- Web dashboard with charts and comparisons
- REST API for programmatic access

## Setup Instructions

### 1. Prerequisites

- AWS Lightsail instance (Ubuntu 20.04 or later)
- Cloud provider credentials:
  - Azure: Service Principal with Resource Graph access
  - AWS: IAM user with EC2 and Pricing API access
  - GCP: Service account with Compute Engine access

### 2. Quick Setup on Lightsail

```bash
# SSH into your Lightsail instance
ssh -i your-key.pem ubuntu@your-lightsail-ip

# Download and run setup script
curl -O https://raw.githubusercontent.com/YOUR_REPO/lightsail-setup.sh
chmod +x lightsail-setup.sh
./lightsail-setup.sh
```

### 3. Configure Credentials

Edit the `.env` file with your cloud credentials:

```bash
nano .env
```

### 4. Start the Application

```bash
# Using PM2
pm2 start spot-monitor

# Or using systemd
sudo systemctl start spot-monitor
```

### 5. Access the Dashboard

Open your browser and navigate to: `http://YOUR_LIGHTSAIL_IP`

## API Endpoints

- `GET /api/spot-prices` - Get current spot prices
- `GET /api/azure/eviction-rates` - Get Azure eviction rates
- `GET /api/aws/spot-history` - Get AWS spot price history
- `GET /api/gcp/preemptible-prices` - Get GCP preemptible prices
- `GET /api/compare` - Compare similar VMs across clouds
- `POST /api/alerts` - Create price/eviction alerts
- `GET /api/history` - Get historical data

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
