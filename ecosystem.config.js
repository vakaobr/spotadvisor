module.exports = {
  apps: [
    {
      name: 'spot-monitor',
      script: './server.js',
      args: '',
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      // restart settings
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // log files (pm2 will manage)
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'DD-MM-YYYY HH:mm Z'
    }
  ]
};
