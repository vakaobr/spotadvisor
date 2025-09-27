
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