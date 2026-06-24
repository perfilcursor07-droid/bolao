require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  const dbName = process.env.DB_NAME || 'bolao_online';
  console.log(`Criando banco de dados "${dbName}"...`);
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE \`${dbName}\``);

  const migrationsDir = __dirname;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ignorableSqlErrors = new Set([
    'ER_DUP_FIELDNAME',
    'ER_DUP_KEYNAME',
    'ER_CANT_DROP_FIELD_OR_KEY',
    'ER_DROP_INDEX_FK',
  ]);

  for (const file of files) {
    console.log(`Executando: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').trim();
    if (!sql || sql.startsWith('--')) continue;
    try {
      await connection.query(sql);
    } catch (err) {
      if (!ignorableSqlErrors.has(err.code)) throw err;
    }
  }

  // Colunas para participação rápida (idempotente)
  const alters = [
    `ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL AFTER cpf`,
    `ALTER TABLE users MODIFY password VARCHAR(255) NULL`,
    `ALTER TABLE users MODIFY role ENUM('admin', 'user', 'guest') NOT NULL DEFAULT 'user'`,
  ];
  for (const sql of alters) {
    try {
      await connection.query(sql);
    } catch (err) {
      if (!['ER_DUP_FIELDNAME', 'ER_PARSE_ERROR'].includes(err.code)) {
        // ENUM já atualizado ou coluna existe
      }
    }
  }

  try {
    await connection.query('ALTER TABLE bets ADD INDEX idx_bets_user (user_id)');
  } catch (err) {
    if (!ignorableSqlErrors.has(err.code)) throw err;
  }
  try {
    await connection.query('ALTER TABLE bets DROP INDEX unique_user_game');
  } catch (err) {
    if (!ignorableSqlErrors.has(err.code)) throw err;
  }

  const adminPassword = await bcrypt.hash('admin123', 10);
  await connection.query(
    `UPDATE users SET password = ? WHERE email = 'admin@bolao.com'`,
    [adminPassword]
  );

  const [admins] = await connection.query(`SELECT id FROM users WHERE email = 'admin@bolao.com'`);
  if (admins.length === 0) {
    await connection.query(
      `INSERT INTO users (name, email, password, cpf, role) VALUES (?, ?, ?, ?, ?)`,
      ['Administrador', 'admin@bolao.com', adminPassword, '00000000000', 'admin']
    );
  }

  console.log('\n✅ Migrations executadas com sucesso!');
  console.log('   Admin: admin@bolao.com / admin123');
  await connection.end();
}

run().catch((err) => {
  console.error('❌ Erro nas migrations:', err.message || err);
  if (err.code === 'ECONNREFUSED') {
    console.error('\n💡 Verifique se o MySQL (WAMP) está rodando.');
  }
  process.exit(1);
});
