const mysql = require('mysql2/promise');

const TZ_BR = process.env.DB_TIMEZONE || '-03:00';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bolao_online',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: TZ_BR,
});

pool.on('connection', (connection) => {
  connection.query(`SET time_zone = '${TZ_BR}'`);
});

module.exports = pool;
