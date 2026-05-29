const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ventmaster-secret-key-2026';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function requireDirector(req, res, next) {
  if (req.user && req.user.role === 'director') {
    next();
  } else {
    res.status(403).json({ error: 'Director access required' });
  }
}

// Database — use /tmp for Render read-only filesystem
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/ventmaster.db' : './ventmaster.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables + migrate
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number INTEGER UNIQUE NOT NULL,
    project TEXT NOT NULL,
    foreman_id INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    urgency TEXT NOT NULL,
    status TEXT DEFAULT 'Новый',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(foreman_id) REFERENCES users(id)
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
    calc_cost INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );
`);

// Migrate: add login/password_hash columns if missing
try { db.exec("ALTER TABLE users ADD COLUMN login TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT"); } catch(e) {}
try { db.exec("UPDATE users SET login = name WHERE login IS NULL"); } catch(e) {}
try {
  const missing = db.prepare("SELECT id FROM users WHERE password_hash IS NULL").all();
  for (const row of missing) {
    const hash = bcrypt.hashSync('123456', 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.id);
  }
} catch(e) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login)"); } catch(e) {}

// WebSocket
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        jwt.verify(data.token, JWT_SECRET, (err, decoded) => {
          if (err) { ws.close(4001, 'Invalid token'); return; }
          ws.userId = decoded.id;
          ws.role = decoded.role;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      }
    } catch (err) { console.error('WS error:', err); }
  });
  ws.on('pong', () => { ws.isAlive = true; });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function broadcast(role, message) {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.role === role) {
      ws.send(JSON.stringify(message));
    }
  });
}

// ===== AUTH ENDPOINTS (no auth required) =====

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Login and password required' });
  }
  const row = db.prepare('SELECT id, name, role, password_hash FROM users WHERE login = ?').get(login);
  if (!row) return res.status(401).json({ error: 'Invalid login or password' });
  
  if (!row.password_hash) {
    return res.status(401).json({ error: 'Password not set. Contact director.' });
  }
  
  if (!bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid login or password' });
  }
  
  const user = { id: row.id, name: row.name, role: row.role };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user });
});

// POST /api/auth/register — first user (director) is open
app.post('/api/auth/register', (req, res) => {
  const { name, login, role, password } = req.body;
  if (!name || !login || !role || !password) {
    return res.status(400).json({ error: 'Name, login, role, and password are required' });
  }
  
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (count === 0 && role !== 'director') {
    return res.status(400).json({ error: 'First user must be director' });
  }
  
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare(
      'INSERT INTO users (name, login, role, password_hash) VALUES (?, ?, ?, ?)'
    ).run(name, login, role, hash);
    
    const user = { id: result.lastInsertRowid, name, login, role };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Name or login already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ===== PROTECTED API =====
app.use('/api', authenticateToken);

// GET /api/users (director only)
app.get('/api/users', requireDirector, (req, res) => {
  const rows = db.prepare('SELECT id, name, login, role, created_at FROM users ORDER BY created_at ASC').all();
  res.json(rows);
});

// PUT /api/users/:id/password (director only)
app.put('/api/users/:id/password', requireDirector, (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password is required' });
  
  const hash = bcrypt.hashSync(new_password, 10);
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});

// PUT /api/users/:id (director only)
app.put('/api/users/:id', requireDirector, (req, res) => {
  const { name, role } = req.body;
  if (!name && !role) return res.status(400).json({ error: 'At least name or role required' });
  
  const sets = [];
  const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (role) { sets.push('role = ?'); params.push(role); }
  params.push(req.params.id);
  
  const result = db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  
  const row = db.prepare('SELECT id, name, login, role, created_at FROM users WHERE id = ?').get(req.params.id);
  res.json(row);
  broadcast('director', { type: 'users_updated' });
});

// DELETE /api/users/:id (director only, cannot delete self)
app.delete('/api/users/:id', requireDirector, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});

// ===== ORDERS =====

app.post('/api/orders', (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;
  if (!foreman_id || !project || !items || items.length === 0) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  const maxRow = db.prepare('SELECT MAX(order_number) as max_num FROM orders').get();
  const orderNumber = (maxRow?.max_num || 247) + 1;
  
  const insertOrder = db.prepare(
    'INSERT INTO orders (order_number, project, foreman_id, due_date, urgency) VALUES (?, ?, ?, ?, ?)'
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertHistory = db.prepare('INSERT INTO history (order_id, event) VALUES (?, ?)');
  
  const orderId = insertOrder.run(orderNumber, project, foreman_id, due_date, urgency).lastInsertRowid;
  
  for (const item of items) {
    const calc = calculateItem(item);
    insertItem.run(orderId, item.type, item.size, item.quantity, item.length, item.material, item.thickness, item.comment, item.attachment, calc.area, calc.weight, calc.cost);
  }
  
  insertHistory.run(orderId, `Заказ создан ${foreman_name}`);
  
  const order = getOrderById(orderId);
  res.status(201).json(order);
  broadcast('director', { type: 'new_order', order });
});

app.get('/api/orders', (req, res) => {
  const { status, urgency, project, search } = req.query;
  let query = `SELECT o.id, o.order_number, o.project, o.due_date, o.urgency, o.status, o.created_at, o.updated_at, u.name as foreman
               FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1`;
  const params = [];
  if (status) { query += ' AND o.status = ?'; params.push(status); }
  if (urgency) { query += ' AND o.urgency = ?'; params.push(urgency); }
  if (project) { query += ' AND o.project = ?'; params.push(project); }
  if (search) { query += ' AND (CAST(o.order_number AS TEXT) LIKE ? OR o.project LIKE ? OR u.name LIKE ?)'; const t = `%${search}%`; params.push(t, t, t); }
  query += ' ORDER BY o.created_at DESC LIMIT 100';
  
  const rows = db.prepare(query).all(...params);
  const orders = rows.map(row => ({
    ...row,
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id),
    history: db.prepare('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC').all(row.id)
  }));
  res.json(orders);
});

app.get('/api/orders/:id', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status required' });
  db.prepare("UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, req.params.id);
  db.prepare("INSERT INTO history (order_id, event) VALUES (?, ?)").run(req.params.id, `Статус изменен на «${status}»`);
  const order = getOrderById(req.params.id);
  res.json(order);
  broadcast('director', { type: 'order_updated', order });
});

app.get('/api/stats', (req, res) => {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM orders WHERE status = 'Новый') as new,
    (SELECT COUNT(*) FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен') as urgent,
    (SELECT COUNT(*) FROM orders WHERE status = 'В производстве') as inWork,
    (SELECT COUNT(*) FROM orders WHERE due_date < date('now') AND status NOT IN ('Готов', 'Отгружен')) as overdue`).get();
  res.json(row || { new: 0, urgent: 0, inWork: 0, overdue: 0 });
});

function getOrderById(orderId) {
  const order = db.prepare(
    `SELECT o.id, o.order_number, o.project, o.due_date, o.urgency, o.status, o.created_at, o.updated_at, u.name as foreman, u.id as foreman_id
     FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = ?`
  ).get(orderId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  order.history = db.prepare('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC').all(orderId);
  return order;
}

function calculateItem(item) {
  const size = String(item.size).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  const qty = item.quantity || 1;
  const length = item.length || 1;
  let area = 0;
  const diameterMatch = size.match(/[øoфd]?(\d{2,4})/i);
  if (size.includes('ø') || size.includes('ф') || item.type.includes('Круглый')) {
    const d = Number(diameterMatch?.[1] || 0) / 1000;
    if (d) area = Math.PI * d * length * qty * getFittingFactor(item.type);
  } else {
    const dims = size.match(/(\d{2,4})[xх×*](\d{2,4})/i);
    if (dims) {
      const w = Number(dims[1]) / 1000;
      const h = Number(dims[2]) / 1000;
      area = 2 * (w + h) * length * qty * getFittingFactor(item.type);
    }
  }
  area = Math.round(area * 10) / 10;
  const metalArea = area * 1.08;
  const weight = metalArea * item.thickness * 7.85;
  const prices = { 'Оцинковка': 18, 'Нержавейка': 54, 'Черный металл': 15 };
  const price = prices[item.material] || 18;
  const cost = metalArea * price * (item.thickness / 0.5);
  return { area: Math.round(area * 10) / 10, weight: Math.round(weight * 10) / 10, cost: Math.round(cost) };
}

function getFittingFactor(type) {
  if (type.includes('Отвод')) return 1.35;
  if (type.includes('Переход')) return 1.25;
  if (type.includes('Тройник')) return 1.55;
  if (type.includes('Зонт')) return 1.7;
  if (type.includes('Шибер')) return 1.2;
  if (type.includes('Нестандарт')) return 1.4;
  return 1;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VentMaster running on port ${PORT}`);
});
