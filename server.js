const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const JWT_SECRET = process.env.JWT_SECRET || 'ventmaster-secret-key-2026';
const DB_PATH = process.env.DB_PATH || '/tmp/ventmaster.db';

// ============ SQLite Database ============
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      login TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number INTEGER UNIQUE NOT NULL,
      project TEXT NOT NULL,
      foreman_id INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT DEFAULT 'Новый',
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
      comment TEXT,
      attachment TEXT,
      calc_area REAL,
      calc_weight REAL,
      calc_cost INTEGER
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (count.cnt === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name, login, role, password_hash) VALUES (?,?,?,?)')
      .run('Директор', 'director', 'director', hash);
    console.log('Default director: director / admin123');
  }
  console.log('SQLite ready at', DB_PATH);
}

function createUser(name, login, role, passwordHash) {
  const info = db.prepare('INSERT INTO users (name, login, role, password_hash) VALUES (?,?,?,?)').run(name, login, role, passwordHash);
  return findUserById(info.lastInsertRowid);
}
function findByLogin(login) { return db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null; }
function findUserById(id) { return db.prepare('SELECT id,name,login,role,created_at FROM users WHERE id = ?').get(id) || null; }
function countUsers() { return db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt; }
function listUsers() { return db.prepare('SELECT id,name,login,role,created_at FROM users ORDER BY id ASC').all(); }
function updatePassword(userId, hash) { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId); }
function updateUser(userId, name, role) { db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, userId); }
function deleteUser(userId) { db.prepare('DELETE FROM users WHERE id = ?').run(userId); }
function getMaxOrderNumber() { const r = db.prepare('SELECT MAX(order_number) as m FROM orders').get(); return r?.m || 247; }
function createOrder(num, project, fid, due, urgency) {
  const info = db.prepare('INSERT INTO orders (order_number, project, foreman_id, due_date, urgency) VALUES (?,?,?,?,?)').run(num, project, fid, due, urgency);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}
function addOrderItem(oid, item, calc) {
  db.prepare('INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(oid, item.type, item.size, item.quantity, item.length, item.material, item.thickness, item.comment||null, item.attachment||null, calc.area, calc.weight, calc.cost);
}
function addHistory(oid, event) { db.prepare('INSERT INTO history (order_id, event) VALUES (?,?)').run(oid, event); }
function listOrders(f) {
  let sql = 'SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1';
  const p = [];
  if (f.status) { sql += ' AND o.status = ?'; p.push(f.status); }
  if (f.search) { sql += ' AND (CAST(o.order_number AS TEXT) LIKE ? OR o.project LIKE ? OR u.name LIKE ?)'; p.push(`%${f.search}%`,`%${f.search}%`,`%${f.search}%`); }
  sql += ' ORDER BY o.created_at DESC LIMIT 100';
  return db.prepare(sql).all(...p);
}
function getOrderItems(oid) { return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(oid); }
function getOrderHistory(oid) { return db.prepare('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC').all(oid); }
function updateOrderStatus(oid, s) { db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(s, oid); }
function getFullOrder(oid) { return db.prepare('SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = ?').get(oid) || null; }
function getStats() {
  return {
    new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'Новый'").get().c,
    urgent: db.prepare("SELECT COUNT(*) as c FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен'").get().c,
    inWork: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'В производстве'").get().c,
    overdue: db.prepare("SELECT COUNT(*) as c FROM orders WHERE due_date < date('now') AND status NOT IN ('Готов','Отгружен')").get().c,
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
  jwt.verify(t, JWT_SECRET, (err, u) => { if (err) return res.status(403).json({ error: 'Invalid' }); req.user = u; next(); });
}
function requireDirector(req, res, next) { if (req.user?.role === 'director') return next(); res.status(403).json({ error: 'Director only' }); }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('message', (m) => { try { const d = JSON.parse(m); if (d.type === 'auth') jwt.verify(d.token, JWT_SECRET, (e, dec) => { if (!e) { ws.userId = dec.id; ws.role = dec.role; ws.send(JSON.stringify({ type: 'auth_ok' })); } }); } catch(e) {} });
  ws.on('pong', () => { ws.isAlive = true; });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }); }, 30000);
function broadcast(role, msg) { wss.clients.forEach(w => { if (w.readyState === 1 && w.role === role) w.send(JSON.stringify(msg)); }); }

// AUTH
app.post('/api/auth/register', (req, res) => {
  const { name, login, role, password } = req.body;
  if (!name || !login || !role || !password) return res.status(400).json({ error: 'All fields required' });
  if (countUsers() === 0 && role !== 'director') return res.status(400).json({ error: 'First user must be director' });
  if (findByLogin(login)) return res.status(409).json({ error: 'Login taken' });
  const user = createUser(name, login, role, bcrypt.hashSync(password, 10));
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ token, user: { id: user.id, name: user.name, login: user.login, role: user.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = findByLogin(login);
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.use('/api', authenticateToken);

// USERS
app.get('/api/users', requireDirector, (req, res) => res.json(listUsers()));
app.put('/api/users/:id/password', requireDirector, (req, res) => { updatePassword(req.params.id, bcrypt.hashSync(req.body.new_password, 10)); res.json({ success: true }); broadcast('director', { type: 'users_updated' }); });
app.put('/api/users/:id', requireDirector, (req, res) => { updateUser(req.params.id, req.body.name, req.body.role); res.json(findUserById(req.params.id)); });
app.delete('/api/users/:id', requireDirector, (req, res) => { if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot delete self' }); deleteUser(req.params.id); res.json({ success: true }); });

// ORDERS
app.post('/api/orders', (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;
  if (!foreman_id || !project || !items?.length) return res.status(400).json({ error: 'Missing fields' });
  const order = createOrder(getMaxOrderNumber() + 1, project, foreman_id, due_date, urgency);
  for (const item of items) addOrderItem(order.id, item, calcItem(item));
  addHistory(order.id, `Заказ создан ${foreman_name}`);
  const full = { ...order, foreman: findUserById(foreman_id)?.name || foreman_name, items: getOrderItems(order.id), history: getOrderHistory(order.id) };
  res.status(201).json(full);
  broadcast('director', { type: 'new_order', order: full });
});

app.get('/api/orders', (req, res) => res.json(listOrders({ status: req.query.status, search: req.query.search }).map(o => ({ ...o, items: getOrderItems(o.id), history: getOrderHistory(o.id) }))));
app.get('/api/orders/:id', (req, res) => { const o = getFullOrder(req.params.id); if (!o) return res.status(404).json({ error: 'Not found' }); res.json({ ...o, items: getOrderItems(o.id), history: getOrderHistory(o.id) }); });
app.patch('/api/orders/:id/status', (req, res) => {
  updateOrderStatus(req.params.id, req.body.status);
  addHistory(req.params.id, `Статус изменен на «${req.body.status}»`);
  const o = getFullOrder(req.params.id);
  const full = { ...o, items: getOrderItems(o.id), history: getOrderHistory(o.id) };
  res.json(full);
  broadcast('director', { type: 'order_updated', order: full });
});

app.get('/api/stats', (req, res) => res.json(getStats()));

function calcItem(item) {
  const size = String(item.size).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  const qty = item.quantity || 1, len = item.length || 1;
  let area = 0;
  const dm = size.match(/[øoфd]?(\d{2,4})/i);
  if (size.includes('ø') || size.includes('ф') || item.type.includes('Круглый')) { const d = Number(dm?.[1]||0)/1000; if (d) area = Math.PI * d * len * qty * getFF(item.type); }
  else { const dims = size.match(/(\d{2,4})[xх×*](\d{2,4})/i); if (dims) { const w=Number(dims[1])/1000, h=Number(dims[2])/1000; area=2*(w+h)*len*qty*getFF(item.type); } }
  area = Math.round(area*10)/10;
  const ma = area*1.08, w = ma*item.thickness*7.85;
  const p = {'Оцинковка':18,'Нержавейка':54,'Черный металл':15}[item.material]||18;
  return { area, weight: Math.round(w*10)/10, cost: Math.round(ma*p*(item.thickness/0.5)) };
}
function getFF(t) { if(t.includes('Отвод'))return 1.35; if(t.includes('Переход'))return 1.25; if(t.includes('Тройник'))return 1.55; if(t.includes('Зонт'))return 1.7; if(t.includes('Шибер'))return 1.2; if(t.includes('Нестандарт'))return 1.4; return 1; }

// Start
initDatabase();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VentMaster on ${PORT} (SQLite)`));
