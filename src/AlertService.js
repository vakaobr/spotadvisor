// src/AlertService.js
const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('./logger');

class AlertService {
  constructor(database) {
    this.db = database;
    this.setupEmailTransporter();

    // simple cooldown map { alertId: lastTriggeredMs }
    this.cooldowns = new Map();
    this.cooldownMs = Number(process.env.ALERT_COOLDOWN_MS || 15 * 60 * 1000); // default 15 min
  }

  setupEmailTransporter() {
    if (process.env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
  }

  // ---- CRUD ----

  async createAlert(alertConfig = {}) {
    const query = `
      INSERT INTO alerts (cloud, vm_type, region, threshold_price, threshold_eviction,
                          notify_email, notify_webhook, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      alertConfig.cloud || null,
      alertConfig.vmType || null,
      alertConfig.region || null,
      alertConfig.thresholdPrice != null ? Number(alertConfig.thresholdPrice) : null,
      alertConfig.thresholdEviction != null ? Number(alertConfig.thresholdEviction) : null,
      alertConfig.notifyEmail || null,
      alertConfig.notifyWebhook || null,
      alertConfig.enabled == null ? 1 : (alertConfig.enabled ? 1 : 0)
    ];

    const result = await this.db.run(query, params);
    const id = result.id || result.lastID || null;

    return {
      id,
      cloud: params[0],
      vmType: params[1],
      region: params[2],
      thresholdPrice: params[3],
      thresholdEviction: params[4],
      notifyEmail: params[5],
      notifyWebhook: params[6],
      enabled: Boolean(params[7])
    };
  }

  async getAlerts() {
    const rows = await this.db.all('SELECT * FROM alerts WHERE enabled = 1');
    return rows.map(r => this.toCamelCase(r));
  }

  async deleteAlert(id) {
    return this.db.run('DELETE FROM alerts WHERE id = ?', [id]);
  }

  async recordAlertHistory(alertId, priceData) {
    try {
      await this.db.run(
        `INSERT INTO alert_history (alert_id, cloud, vm_type, region, price, eviction_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          alertId,
          priceData.cloud,
          priceData.vm_type || priceData.vmType,
          priceData.region,
          priceData.price,
          priceData.eviction_rate || priceData.evictionRate
        ]
      );
    } catch (err) {
      logger.error('Failed to record alert history', err);
    }
  }

  // ---- Alert checking ----

  async checkAlerts() {
    const alerts = await this.db.all('SELECT * FROM alerts WHERE enabled = 1');
    const latestPrices = await this.db.getLatestPrices();

    for (const alert of alerts) {
      try {
        const priceData = latestPrices.find(p =>
          p.cloud === alert.cloud &&
          p.vm_type === alert.vm_type &&
          p.region === alert.region
        );
        if (!priceData) continue;

        const triggeredReasons = [];
        const priceNum = Number(priceData.price);
        const evictionVal = this.parseEviction(priceData.eviction_rate);

        if (alert.threshold_price != null && !isNaN(priceNum)) {
          if (priceNum > alert.threshold_price) {
            triggeredReasons.push(`price ${priceNum} > threshold ${alert.threshold_price}`);
          }
        }

        if (alert.threshold_eviction != null && evictionVal != null) {
          if (evictionVal > alert.threshold_eviction) {
            triggeredReasons.push(`eviction ${evictionVal}% > threshold ${alert.threshold_eviction}%`);
          }
        }

        if (triggeredReasons.length === 0) continue;

        // cooldown check
        const now = Date.now();
        const last = this.cooldowns.get(alert.id) || 0;
        if (now - last < this.cooldownMs) {
          logger.debug(`Skipping alert ${alert.id} due to cooldown`);
          continue;
        }
        this.cooldowns.set(alert.id, now);

        const reason = triggeredReasons.join(' and ');
        await this.sendAlert(alert, priceData, reason);
        await this.recordAlertHistory(alert.id, priceData);
      } catch (err) {
        logger.error('Error while checking alert', err);
      }
    }
  }

  // ---- Notifications ----

  async sendAlert(alert, priceData, reason) {
    const subject = `Spot VM Alert: ${alert.cloud} ${alert.vm_type || alert.vmType}`;
    const body = [
      '⚠️ Alert Triggered!',
      `Cloud: ${alert.cloud}`,
      `VM: ${alert.vm_type || alert.vmType}`,
      `Region: ${alert.region}`,
      `Price: ${priceData.price}`,
      `Eviction rate: ${priceData.eviction_rate || 'n/a'}`,
      `Reason: ${reason}`,
      `Time: ${new Date().toISOString()}`
    ].join('\n');

    // email
    const targetEmail = alert.notify_email || alert.notifyEmail || process.env.DEFAULT_ALERT_EMAIL;
    if (targetEmail && this.transporter) {
      try {
        await this.transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: targetEmail,
          subject,
          text: body
        });
        logger.info(`Sent alert email to ${targetEmail} for alert ${alert.id}`);
      } catch (err) {
        logger.error('Failed to send alert email', err);
      }
    }

    // webhook
    const webhookUrl = alert.notify_webhook || alert.notifyWebhook;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          alertId: alert.id,
          cloud: alert.cloud,
          vm_type: alert.vm_type || alert.vmType,
          region: alert.region,
          price: priceData.price,
          eviction_rate: priceData.eviction_rate,
          reason,
          timestamp: new Date().toISOString()
        }, { timeout: 5000 });
        logger.info(`Sent webhook for alert ${alert.id}`);
      } catch (err) {
        logger.error('Failed to send webhook alert', err);
      }
    }

    // always log
    logger.info({ event: 'alert_triggered', alertId: alert.id, reason, priceData });
  }

  // ---- Helpers ----

  parseEviction(val) {
    if (val == null) return null;
    if (typeof val === 'string') {
      // handle ranges like "5-15%" -> take first number
      const match = val.match(/([\d.]+)/);
      if (match) return parseFloat(match[1]);
      return null;
    }
    if (typeof val === 'number') return val;
    return null;
  }

  toCamelCase(row) {
    if (!row) return null;
    return {
      id: row.id,
      cloud: row.cloud,
      vmType: row.vm_type,
      region: row.region,
      thresholdPrice: row.threshold_price,
      thresholdEviction: row.threshold_eviction,
      notifyEmail: row.notify_email,
      notifyWebhook: row.notify_webhook,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at
    };
  }
}

module.exports = AlertService;
