module.exports = {
  apps: [
    {
      name: 'nort-finance',
      script: 'index.js',
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 10
    }
  ]
};
