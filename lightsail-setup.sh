#!/bin/bash

# This script sets up the application on AWS Lightsail Ubuntu instance

echo "Setting up Multi-Cloud Spot VM Monitor on Lightsail..."

# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo apt-get install -y git

# Install PM2 for process management (alternative to systemd)
sudo npm install -g pm2

# Clone or copy application files
# If using git:
# git clone https://github.com/YOUR_USERNAME/multi-cloud-spot-monitor.git
# cd multi-cloud-spot-monitor

# Install dependencies
npm install

# Copy and configure .env file
cp .env.template .env
echo "Please edit .env file with your credentials"

# Create data directory
mkdir -p data

# Copy frontend to public directory
cp index.html public/

# Setup PM2 to run the application
pm2 start server.js --name spot-monitor
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Setup Nginx (optional, for better performance)
sudo apt-get install -y nginx

# Configure Nginx
sudo cat > /etc/nginx/sites-available/spot-monitor << 'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/spot-monitor /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# Setup firewall
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable

echo "Setup complete!"
echo "Next steps:"
echo "1. Edit .env file with your cloud credentials"
echo "2. Restart the application: pm2 restart spot-monitor"
echo "3. View logs: pm2 logs spot-monitor"
echo "4. Access the dashboard at http://YOUR_LIGHTSAIL_IP"
