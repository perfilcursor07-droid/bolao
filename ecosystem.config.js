module.exports = {
  apps: [
    {
      name: 'bolaopix',
      script: 'server.js',
      cwd: '/home/bolaopix/htdocs/bolaopix.site',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env_file: '/home/bolaopix/htdocs/bolaopix.site/.env',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
