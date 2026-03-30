module.exports = {
  apps: [
    {
      name: 'cc2cc',
      script: 'src/index.js',
      env: {
        PORT: 7500,
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'cc2cc@2024',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
    },
  ],
};
