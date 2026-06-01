const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'ventmaster-secret-key-2026';
const DB_PATH = process.env.DB_PATH || '/tmp/ventmaster.db';
const BACKUP_DIR = '/tmp/backups';
const GITHUB_BACKUP_REPO = process.env.GITHUB_BACKUP_REPO || 'ertyyui950-star/ventmaster-api';
const GITHUB_BRANCH = 'backups';

// ============ GitHub Backup System ============
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupDatabase() {
  try {
    ensureBackupDir();
    if (!fs.existsSync(DB_PATH)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `ventmaster_${ts}.db`);
    const latestLink = path.join(BACKUP_DIR, 'ventmaster_latest.db');
    fs.copyFileSync(DB_PATH, backupFile);
    try { fs.unlinkSync(latestLink); } catch(e) {}
    fs.symlinkSync(backupFile, latestLink);
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('ventmaster_') && f.endsWith('.db') && f !== 'ventmaster_latest.db')
      .sort().reverse();
    backups.slice(10).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(e) {} });
    console.log(`[BACKUP] Local: ${path.basename(backupFile)}`);
    pushToGitHub(backupFile, ts);
  } catch(e) {
    console.error('[BACKUP ERROR]', e.message);
  }
}

function pushToGitHub(backupFile, ts) {
  const token = process.env.GITHUB_TOKEN || (fs.existsSync('/tmp/gh_token.txt') ? fs.readFileSync('/tmp/gh_token.txt', 'utf8').trim() : null);
  if (!token) { console.log('[GITHUB BACKUP] No token available, skipping'); return; }
  const https = require('https');
  const { URL } = require('url');
  const content = fs.readFileSync(backupFile);
  const contentB64 = content.toString('base64');
  const apiUrl = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents/ventmaster_latest.db`;
  const makeRequest = (method, url, body, callback) => {
    const u = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `token ${token}`, 'User-Agent': 'VentMaster-Backup', 'Content-Type': 'application/json' };
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { callback(null, JSON.parse(data), res.statusCode); } catch(e) { callback(null, data, res.statusCode); } });
    });
    req.on('error', (e) => callback(e));
    req.setTimeout(30000, () => { req.destroy(); callback(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  };
  makeRequest('GET', apiUrl, null, (err, data, status) => {
    const sha = (status === 200 && data && data.sha) ? data.sha : undefined;
    const body = { message: `Auto-backup ${ts}`, content: contentB64, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    makeRequest('PUT', apiUrl, body, (err2, data2, status2) => {
      if (err2 || status2 >= 400) console.error('[GITHUB BACKUP ERROR]', err2?.message || status2, JSON.stringify(data2).slice(0, 200));
      else console.log(`[GITHUB BACKUP] Pushed to GitHub: ventmaster_latest.db (${ts})`);
    });
  });
}

function restoreFromGitHub() {
  try {
    if (fs.existsSync(DB_PATH)) { console.log('[RESTORE] Local DB exists, skipping GitHub restore'); return false; }
    const localBackup = path.join(BACKUP_DIR, 'ventmaster_latest.db');
    if (fs.existsSync(localBackup)) { fs.copyFileSync(localBackup, DB_PATH); console.log('[RESTORE] Restored from local backup'); return true; }
    const token = process.env.GITHUB_TOKEN || (fs.existsSync('/tmp/gh_token.txt') ? fs.readFileSync('/tmp/gh_token.txt', 'utf8').trim() : null);
    if (!token) { console.log('[RESTORE] No GitHub token, skipping remote restore'); return false; }
    console.log('[RESTORE] Attempting restore from GitHub...');
    const https = require('https');
    const apiUrl = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents/ventmaster_latest.db?ref=${GITHUB_BRANCH}`;
    https.get(apiUrl, { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'VentMaster-Backup' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content) { const buf = Buffer.from(json.content, 'base64'); fs.writeFileSync(DB_PATH, buf); console.log('[RESTORE] Restored from GitHub backup'); }
          else console.log('[RESTORE] No backup found on GitHub');
        } catch(e) { console.error('[RESTORE ERROR]', e.message); }
      });
    }).on('error', (e) => console.error('[RESTORE ERROR]', e.message));
    return false;
  } catch(e) { console.error('[RESTORE ERROR]', e.message); return false; }
}

let backupInterval = null;
function startAutoBackup() { backupInterval = setInterval(backupDatabase, 5 * 60 * 1000); console.log('[BACKUP] Auto-backup enabled (every 5 min, GitHub + local)'); }
function stopAutoBackup() { if (backupInterval) clearInterval(backupInterval); }

// ============ SQLite Database ============
let db;

function initDatabase() {
  restoreFromGitHub();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'foreman',
      phone TEXT DEFAULT '',
      position TEXT DEFAULT 'Прораб',
      blocked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number INTEGER UNIQUE NOT NULL,
      project TEXT NOT NULL,
      customer TEXT DEFAULT '',
      foreman_id INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'Обычный',
      status TEXT DEFAULT 'Новый',
      comment TEXT DEFAULT '',
      calc_cost INTEGER DEFAULT 0,
      manual_cost INTEGER DEFAULT 0,
      cost_diff_reason TEXT DEFAULT '',
      cost_adjusted_by INTEGER DEFAULT 0,
      cost_adjusted_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      size TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      length REAL NOT NULL,
      material TEXT NOT NULL,
      thickness REAL NOT NULL,
      comment TEXT DEFAULT '',
      attachment TEXT DEFAULT '',
      calc_area REAL DEFAULT 0,
      calc_weight REAL DEFAULT 0,
      calc_cost INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      user_id INTEGER DEFAULT 0,
      user_name TEXT DEFAULT '',
      event TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS price_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value REAL NOT NULL,
      label TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default director account (Director123!)
  const dirCount = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'director'").get();
  if (dirCount.cnt === 0) {
    const hash = bcrypt.hashSync('Director123!', 10);
    db.prepare('INSERT INTO users (name, login, password_hash, role, position) VALUES (?,?,?,?,?)')
      .run('Директор', 'director', hash, 'director', 'Директор');
    console.log('Default director: director / Director123!');
  }

  // Seed default price settings (AMD currency)
  const priceCount = db.prepare('SELECT COUNT(*) as cnt FROM price_settings').get();
  if (priceCount.cnt === 0) {
    const defaults = [
      { key: 'price_galvanized', value: 1250, label: 'Оцинковка (AMD/м²)' },
      { key: 'price_stainless', value: 3750, label: 'Нержавейка (AMD/м²)' },
      { key: 'price_black_metal', value: 1050, label: 'Чёрный металл (AMD/м²)' },
      { key: 'price_fabrication', value: 2500, label: 'Стоимость работы (AMD/м²)' },
      { key: 'price_components', value: 1800, label: 'Комплектующие (AMD/м²)' },
    ];
    const stmt = db.prepare('INSERT INTO price_settings (key, value, label) VALUES (?,?,?)');
    for (const d of defaults) stmt.run(d.key, d.value, d.label);
    console.log('[PRICES] Default AMD price settings seeded');
  }

  console.log('SQLite ready at', DB_PATH);
  startAutoBackup();
}

// ============ Helpers ============
function getPriceSettings() {
  const rows = db.prepare('SELECT key, value FROM price_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

function getMaterialPrice(material, ps) {
  const m = material.toLowerCase();
  if (m.includes('нерж') || m.includes('stainless')) return ps.price_stainless || 3750;
  if (m.includes('черн') || m.includes('black')) return ps.price_black_metal || 1050;
  return ps.price_galvanized || 1250;
}

function calcItem(item) {
  const ps = getPriceSettings();
  const size = String(item.size).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  const qty = item.quantity || 1, len = item.length || 1;
  let area = 0;
  const dm = size.match(/[øoфd]?(\d{2,4})/i);
  if (size.includes('ø') || size.includes('ф') || (item.type && item.type.includes('Круглый'))) {
    const d = Number(dm?.[1] || 0) / 1000;
    if (d) area = Math.PI * d * len * qty * getFF(item.type);
  } else {
    const dims = size.match(/(\d{2,4})[xх×*](\d{2,4})/i);
    if (dims) { const w = Number(dims[1]) / 1000, h = Number(dims[2]) / 1000; area = 2 * (w + h) * len * qty * getFF(item.type); }
  }
  area = Math.round(area * 10) / 10;
  const ma = area * 1.08;
  const w = ma * item.thickness * 7.85;
  const materialPrice = getMaterialPrice(item.material, ps);
  const cost = Math.round(ma * materialPrice * (item.thickness / 0.5) + area * ps.price_components + area * ps.price_fabrication);
  return { area, weight: Math.round(w * 10) / 10, cost };
}

function getFF(t) {
  if (!t) return 1;
  if (t.includes('Отвод')) return 1.35;
  if (t.includes('Переход')) return 1.25;
  if (t.includes('Тройник')) return 1.55;
  if (t.includes('Зонт')) return 1.7;
  if (t.includes('Шибер')) return 1.2;
  if (t.includes('Нестандарт')) return 1.4;
  return 1;
}

// ============ User CRUD ============
function findUserById(id) { return db.prepare('SELECT id, name, login, role, phone, position, blocked, created_at FROM users WHERE id = ?').get(id) || null; }
function findByLogin(login) { return db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null; }
function countUsers() { return db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt; }
function listUsers() { return db.prepare('SELECT id, name, login, role, phone, position, blocked, created_at FROM users ORDER BY id ASC').all(); }
function createUser(data) {
  const hash = bcrypt.hashSync(data.password || '123456', 10);
  const info = db.prepare('INSERT INTO users (name, login, password_hash, role, phone, position) VALUES (?,?,?,?,?,?)')
    .run(data.name, data.login, hash, data.role || 'foreman', data.phone || '', data.position || 'Прораб');
  return findUserById(info.lastInsertRowid);
}
function updateUser(id, data) {
  db.prepare("UPDATE users SET name = ?, phone = ?, position = ?, updated_at = datetime('now') WHERE id = ?")
    .run(data.name, data.phone || '', data.position || 'Прораб', id);
  return findUserById(id);
}
function setBlocked(id, blocked) { db.prepare("UPDATE users SET blocked = ?, updated_at = datetime('now') WHERE id = ?").run(blocked ? 1 : 0, id); }
function updatePassword(userId, newPassword) { db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), userId); }

// ============ Order CRUD ============
function getNextOrderNumber() { const r = db.prepare('SELECT MAX(order_number) as m FROM orders').get(); return (r?.m || 247) + 1; }

function createOrder(data, foremanId, foremanName) {
  const orderNumber = getNextOrderNumber();
  const info = db.prepare('INSERT INTO orders (order_number, project, customer, foreman_id, due_date, urgency, comment, status) VALUES (?,?,?,?,?,?,?,?)')
    .run(orderNumber, data.project || '', data.customer || '', foremanId, data.due_date, data.urgency || 'Обычный', data.comment || '', 'Новый');

  const orderId = info.lastInsertRowid;
  let totalCost = 0;
  const items = data.items || [];
  for (const item of items) {
    const calc = calcItem(item);
    totalCost += calc.cost;
    db.prepare('INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(orderId, item.type || '', item.size || '', item.quantity || 1, item.length || 1, item.material || '', item.thickness || 0.5, item.comment || '', item.attachment || '', calc.area, calc.weight, calc.cost);
  }

  // Update total calc_cost
  db.prepare('UPDATE orders SET calc_cost = ? WHERE id = ?').run(totalCost, orderId);

  // History
  addHistory(orderId, foremanId, foremanName, `Заказ #${orderNumber} создан`);

  return getFullOrder(orderId);
}

function addHistory(orderId, userId, userName, event) {
  db.prepare('INSERT INTO history (order_id, user_id, user_name, event) VALUES (?,?,?,?)').run(orderId, userId, userName, event);
}

function getFullOrder(orderId) {
  const o = db.prepare('SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = ?').get(orderId);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  o.history = db.prepare('SELECT * FROM history WHERE order_id = ? ORDER BY created_at ASC').all(orderId);
  return o;
}

function listOrders(filter = {}) {
  let sql = 'SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1';
  const p = [];
  if (filter.status) { sql += ' AND o.status = ?'; p.push(filter.status); }
  if (filter.foreman_id) { sql += ' AND o.foreman_id = ?'; p.push(filter.foreman_id); }
  if (filter.search) { sql += ' AND (CAST(o.order_number AS TEXT) LIKE ? OR o.project LIKE ? OR o.customer LIKE ? OR u.name LIKE ?)'; const s = `%${filter.search}%`; p.push(s, s, s, s); }
  sql += ' ORDER BY o.created_at DESC LIMIT 200';
  return db.prepare(sql).all(...p);
}

function updateOrderStatus(orderId, status, userId, userName) {
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
  addHistory(orderId, userId, userName, `Статус изменён на «${status}»`);
  return getFullOrder(orderId);
}

function adjustOrderCost(orderId, manualCost, reason, userId, userName) {
  db.prepare("UPDATE orders SET manual_cost = ?, cost_diff_reason = ?, cost_adjusted_by = ?, cost_adjusted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(manualCost, reason || '', userId, orderId);
  addHistory(orderId, userId, userName, `Себестоимость скорректирована: ${manualCost} ֏${reason ? ' (' + reason + ')' : ''}`);
  return getFullOrder(orderId);
}

function copyOrder(orderId, foremanId, foremanName) {
  const src = getFullOrder(orderId);
  if (!src) return null;
  const data = {
    project: src.project,
    customer: src.customer,
    due_date: src.due_date,
    urgency: src.urgency,
    comment: src.comment,
    items: (src.items || []).map(i => ({
      type: i.item_type, size: i.size, quantity: i.quantity, length: i.length,
      material: i.material, thickness: i.thickness, comment: i.comment, attachment: i.attachment
    }))
  };
  const newOrder = createOrder(data, foremanId, foremanName);
  addHistory(newOrder.id, foremanId, foremanName, `Создан на основе заказа #${src.order_number}`);
  return newOrder;
}

// ============ Suggestions / Autocomplete ============
function getSuggestions(field, query, limit = 8) {
  const q = `%${query}%`;
  switch (field) {
    case 'project':
      return db.prepare('SELECT DISTINCT project as value FROM orders WHERE project LIKE ? ORDER BY created_at DESC LIMIT ?').all(q, limit);
    case 'customer':
      return db.prepare('SELECT DISTINCT customer as value FROM orders WHERE customer LIKE ? AND customer != "" ORDER BY created_at DESC LIMIT ?').all(q, limit);
    case 'item_type':
      return db.prepare('SELECT DISTINCT item_type as value FROM order_items WHERE item_type LIKE ? ORDER BY id DESC LIMIT ?').all(q, limit);
    case 'material':
      return db.prepare('SELECT DISTINCT material as value FROM order_items WHERE material LIKE ? ORDER BY id DESC LIMIT ?').all(q, limit);
    default:
      return [];
  }
}

// ============ Stats ============
function getStats() {
  return {
    total: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'Новый'").get().c,
    inWork: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'В производстве'").get().c,
    ready: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'Готов'").get().c,
    shipped: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'Отгружен'").get().c,
    urgent: db.prepare("SELECT COUNT(*) as c FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен'").get().c,
    overdue: db.prepare("SELECT COUNT(*) as c FROM orders WHERE due_date < date('now') AND status NOT IN ('Готов','Отгружен')").get().c,
    totalCost: db.prepare('SELECT COALESCE(SUM(CASE WHEN manual_cost > 0 THEN manual_cost ELSE calc_cost END), 0) as c FROM orders').get().c,
  };
}

// ============ Express App ============
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(cors());
app.use(express.json({ limit: '50mb' }));

function authenticateToken(req, res, next) {
  const t = req.headers['authorization']?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Token required' });
  jwt.verify(t, JWT_SECRET, (err, u) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    // Check if user is blocked
    const user = findUserById(u.id);
    if (!user) return res.status(403).json({ error: 'User not found' });
    if (user.blocked) return res.status(403).json({ error: 'Account blocked' });
    req.user = u;
    next();
  });
}

function requireDirector(req, res, next) {
  if (req.user?.role === 'director') return next();
  res.status(403).json({ error: 'Director only' });
}

// WebSocket
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('message', (m) => {
    try {
      const d = JSON.parse(m);
      if (d.type === 'auth') jwt.verify(d.token, JWT_SECRET, (e, dec) => {
        if (!e) { ws.userId = dec.id; ws.role = dec.role; ws.send(JSON.stringify({ type: 'auth_ok' })); }
      });
    } catch(e) {}
  });
  ws.on('pong', () => { ws.isAlive = true; });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }); }, 30000);
function broadcast(role, msg) { wss.clients.forEach(w => { if (w.readyState === 1 && w.role === role) w.send(JSON.stringify(msg)); }); }
function broadcastAll(msg) { wss.clients.forEach(w => { if (w.readyState === 1) w.send(JSON.stringify(msg)); }); }

// ============ API ============

app.get('/api/health', (req, res) => {
  const localBackups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).length : 0;
  res.json({ status: 'ok', db: fs.existsSync(DB_PATH), localBackups, dbPath: DB_PATH, currency: 'AMD' });
});

app.post('/api/backup', authenticateToken, requireDirector, (req, res) => {
  try {
    backupDatabase();
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
    res.json({ success: true, localBackups: backups.length, latest: backups[0] || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AUTH — Login only (no public registration)
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const user = findByLogin(login);
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  if (user.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, login: user.login, role: user.role, phone: user.phone, position: user.position } });
});

// Protected routes
app.use('/api', authenticateToken);

// USERS (director only) — specific routes BEFORE generic :id
app.get('/api/users', requireDirector, (req, res) => res.json(listUsers()));
app.post('/api/users', requireDirector, (req, res) => {
  const { name, login, password, phone, position } = req.body;
  if (!name || !login || !password) return res.status(400).json({ error: 'ФИО, логин и пароль обязательны' });
  if (findByLogin(login)) return res.status(409).json({ error: 'Логин уже занят' });
  const user = createUser({ name, login, password, phone, position, role: 'foreman' });
  addHistory(0, req.user.id, req.user.name, `Создан пользователь: ${name} (${login})`);
  res.status(201).json(user);
  broadcast('director', { type: 'users_updated' });
});
app.put('/api/users/block/:id', requireDirector, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
  setBlocked(req.params.id, req.body.blocked ? 1 : 0);
  const user = findUserById(req.params.id);
  addHistory(0, req.user.id, req.user.name, `${req.body.blocked ? 'Заблокирован' : 'Разблокирован'} пользователь: ${user.name}`);
  res.json({ success: true, blocked: req.body.blocked ? 1 : 0 });
  broadcast('director', { type: 'users_updated' });
});
app.put('/api/users/password/:id', requireDirector, (req, res) => {
  if (!req.body.new_password) return res.status(400).json({ error: 'Новый пароль обязателен' });
  updatePassword(req.params.id, req.body.new_password);
  const user = findUserById(req.params.id);
  addHistory(0, req.user.id, req.user.name, `Сброшен пароль пользователя: ${user.name}`);
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});
app.put('/api/users/:id', requireDirector, (req, res) => {
  const user = updateUser(req.params.id, req.body);
  addHistory(0, req.user.id, req.user.name, `Обновлён пользователь: ${user.name}`);
  res.json(user);
  broadcast('director', { type: 'users_updated' });
});
app.delete('/api/users/:id', requireDirector, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Нельзя удалить себя' });
  const user = findUserById(req.params.id);
  deleteUser(req.params.id);
  addHistory(0, req.user.id, req.user.name, `Удалён пользователь: ${user.name}`);
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});

// PRICE SETTINGS (director only)
app.get('/api/prices', authenticateToken, (req, res) => res.json(getPriceSettings()));
app.get('/api/prices/all', authenticateToken, (req, res) => res.json(db.prepare('SELECT * FROM price_settings ORDER BY id').all()));
app.put('/api/prices/:key', requireDirector, (req, res) => {
  const value = Number(req.body.value);
  if (isNaN(value) || value < 0) return res.status(400).json({ error: 'Некорректное значение' });
  db.prepare("UPDATE price_settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(value, req.params.key);
  addHistory(0, req.user.id, req.user.name, `Обновлена цена: ${req.params.key} = ${value} ֏`);
  res.json({ success: true, key: req.params.key, value });
  broadcastAll({ type: 'prices_updated' });
});

// ORDERS — specific routes BEFORE generic :id
app.post('/api/orders', (req, res) => {
  const { project, customer, due_date, urgency, comment, items } = req.body;
  if (!project || !project.trim()) return res.status(400).json({ error: 'Поле "Объект" обязательно' });
  if (!due_date) return res.status(400).json({ error: 'Поле "Дата выполнения" обязательно' });
  if (!items || !items.length) return res.status(400).json({ error: 'Добавьте хотя бы одну позицию' });

  try {
    const order = createOrder({ project, customer, due_date, urgency, comment, items }, req.user.id, req.user.name);
    res.status(201).json(order);
    broadcast('director', { type: 'new_order', order });
    broadcast('foreman', { type: 'new_order', order });
  } catch (e) {
    console.error('[ORDER CREATE ERROR]', e);
    res.status(500).json({ error: 'Ошибка создания заказа: ' + e.message });
  }
});

app.get('/api/orders', (req, res) => {
  const filter = { status: req.query.status, search: req.query.search };
  const orders = listOrders(filter).map(o => ({
    ...o,
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id),
    history: db.prepare('SELECT * FROM history WHERE order_id = ? ORDER BY created_at ASC').all(o.id)
  }));
  res.json(orders);
});

app.get('/api/orders/:id', (req, res) => {
  const o = getFullOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(o);
});

// Copy order — separate path to avoid :id conflicts
app.post('/api/orders/copy/:id', (req, res) => {
  const src = getFullOrder(req.params.id);
  if (!src) return res.status(404).json({ error: 'Заказ не найден' });
  try {
    const order = copyOrder(req.params.id, req.user.id, req.user.name);
    res.status(201).json(order);
    broadcast('director', { type: 'new_order', order });
  } catch (e) {
    console.error('[ORDER COPY ERROR]', e);
    res.status(500).json({ error: 'Ошибка копирования: ' + e.message });
  }
});

// Adjust cost (director only) — completely separate path to avoid :id conflicts
app.patch('/api/orders/adjust-cost/:id', requireDirector, (req, res) => {
  const { manual_cost, reason } = req.body;
  const cost = Number(manual_cost);
  if (isNaN(cost) || cost < 0) return res.status(400).json({ error: 'Некорректная сумма' });
  const order = adjustOrderCost(req.params.id, cost, reason, req.user.id, req.user.name);
  res.json(order);
  broadcast('director', { type: 'order_updated', order });
  broadcast('foreman', { type: 'order_updated', order });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Статус обязателен' });
  const order = updateOrderStatus(req.params.id, status, req.user.id, req.user.name);
  res.json(order);
  broadcast('director', { type: 'order_updated', order });
  broadcast('foreman', { type: 'order_updated', order });
});

// SUGGESTIONS / Autocomplete
app.get('/api/suggestions/:field', (req, res) => {
  const { field } = req.params;
  const { q } = req.query;
  if (!q || q.length < 1) return res.json([]);
  const allowed = ['project', 'customer', 'item_type', 'material'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'Unknown field' });
  res.json(getSuggestions(field, q));
});

// STATS
app.get('/api/stats', (req, res) => res.json(getStats()));

// Start
initDatabase();
const PORT = process.env.PORT || 3000;
server.listen(PORT, console.log(`VentMaster v4.0 on ${PORT} (SQLite + AMD + GitHub backup)`));

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM - backing up...'); stopAutoBackup(); backupDatabase(); setTimeout(() => process.exit(0), 3000); });
process.on('SIGINT', () => { console.log('SIGINT - backing up...'); stopAutoBackup(); backupDatabase(); setTimeout(() => process.exit(0), 3000); });
