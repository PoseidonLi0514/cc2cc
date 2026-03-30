module.exports = {
  apps: [
    {
      name: 'cc2cc',
      script: 'src/index.js',
      env: {
        PORT: 7500,
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
    },
  ],
};
