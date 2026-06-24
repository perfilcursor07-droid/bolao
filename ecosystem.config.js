module.exports = {
  apps: [
    {
      name: 'bolaopix',
      script: 'server.js',
      cwd: '/home/bolaopix/htdocs/bolaopix.site',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
