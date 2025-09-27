// src/Database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

class Database {
  constructor() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = path.join(dataDir, 'spot-monitor.db');
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

  async createTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cloud TEXT NOT NULL,
        vm_type TEXT NOT NULL,
        region TEXT NOT NULL,
        price REAL,
        eviction_rate TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS alerts (
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
      )`,
      
      `CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER,
        cloud TEXT,
        vm_type TEXT,
        region TEXT,
        price REAL,
        eviction_rate TEXT,
        triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(alert_id) REFERENCES alerts(id)
      )`,

      `CREATE INDEX IF NOT EXISTS idx_prices_lookup 
       ON prices(cloud, vm_type, region, timestamp)`,
       
      `CREATE INDEX IF NOT EXISTS idx_alerts_enabled 
       ON alerts(enabled)`
    ];

    for (const q of queries) {
      await this.run(q);
    }
  }

  run(query, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(query, params, function (err) {
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

  // ---- Domain helpers ----

  async savePrice(data) {
    const query = `
      INSERT INTO prices (cloud, vm_type, region, price, eviction_rate)
      VALUES (?, ?, ?, ?, ?)
    `;
    return this.run(query, [
      data.cloud,
      data.vm_type,
      data.region,
      data.price,
      data.eviction_rate
    ]);
  }

  async getHistory(cloud, vm_type, region, days = 7) {
    const query = `
      SELECT * FROM prices
      WHERE cloud = ? 
        AND vm_type = ? 
        AND region = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY timestamp DESC
    `;
    return this.all(query, [cloud, vm_type, region, days]);
  }

  async getLatestPrices() {
    const query = `
      SELECT p1.* FROM prices p1
      INNER JOIN (
        SELECT cloud, vm_type, region, MAX(timestamp) as max_time
        FROM prices
        GROUP BY cloud, vm_type, region
      ) p2 ON p1.cloud = p2.cloud 
         AND p1.vm_type = p2.vm_type 
         AND p1.region = p2.region 
         AND p1.timestamp = p2.max_time
    `;
    return this.all(query);
  }

  close() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      this.db.close((err) => {
        if (err) {
          logger.error('Error closing database:', err);
          reject(err);
        } else {
          logger.info('Database connection closed');
          resolve();
        }
      });
    });
  }
}

module.exports = Database;
