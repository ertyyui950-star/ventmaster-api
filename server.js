const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const JWT_SECRET = process.env.JWT_SECRET || 'ventmaster-secret-key-2026';

let db;
let dbFile = Buffer.alloc(0);

async function initDb() {
  const SQL = await initSqlJs();
  
  // Try to load existing DB from file
  const fs = require('fs');
  const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/ventmaster.db' : './ventmaster.db';
  try {
    dbFile = fs.readFileSync(dbPath);
    db = new SQL.Database(dbFile);
  } catch(e) {
    db = new SQL.Database();
  }
  
  // Create tables if not exist
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number INTEGER UNIQUE NOT NULL,
    project TEXT NOT NULL,
    foreman_id INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    urgency TEXT NOT NULL,
    status TEXT DEFAULT 'Новый',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS order_items (
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
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Migrate: add login/password_hash
  try {
    db.run("ALTER TABLE users ADD COLUMN login TEXT");
    db.run("UPDATE users SET login = name WHERE login IS NULL");
  } catch(e) {}
  try {
    db.run("ALTER TABLE users ADD COLUMN password_hash TEXT");
    // Backfill default password
    const rows = db.exec("SELECT id FROM users WHERE password_hash IS NULL");
    if (rows.length > 0 && rows[0].values) {
      for (const [id] of rows[0].values) {
        const hash = bcrypt.hashSync('123456', 10);
        db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
      }
    }
  } catch(e) {}
  
  saveDb();
  console.log('Database initialized');
}

function saveDb() {
  try {
    const data = db.export();
    const fs = require('fs');
    const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/ventmaster.db' : './ventmaster.db';
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch(e) { console.error('Save DB error:', e.message); }
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// Express setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
  if (req.user && req.user.role === 'director') return next();
  res.status(403).json({ error: 'Director access required' });
}

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
    } catch(err) {}
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

function broadcast(role, msg) {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.role === role) ws.send(JSON.stringify(msg));
  });
}

// AUTH ENDPOINTS (no auth required)

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  
  const row = dbGet('SELECT id, name, role, password_hash FROM users WHERE login = ?', [login]);
  if (!row) return res.status(401).json({ error: 'Invalid login or password' });
  if (!row.password_hash) return res.status(401).json({ error: 'Password not set. Contact director.' });
  if (!bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'Invalid login or password' });
  
  const user = { id: row.id, name: row.name, role: row.role };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user });
});

app.post('/api/auth/register', (req, res) => {
  const { name, login, role, password } = req.body;
  if (!name || !login || !role || !password) return res.status(400).json({ error: 'All fields required' });
  
  const count = dbGet('SELECT COUNT(*) as cnt FROM users');
  if (count.cnt === 0 && role !== 'director') return res.status(400).json({ error: 'First user must be director' });
  
  const hash = bcrypt.hashSync(password, 10);
  try {
    dbRun('INSERT INTO users (name, login, role, password_hash) VALUES (?, ?, ?, ?)', [name, login, role, hash]);
    const user = dbGet('SELECT id, name, login, role FROM users WHERE login = ?', [login]);
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user });
  } catch(err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Name or login already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PROTECTED API
app.use('/api', authenticateToken);

app.get('/api/users', requireDirector, (req, res) => {
  const rows = dbAll('SELECT id, name, login, role, created_at FROM users ORDER BY created_at ASC');
  res.json(rows);
});

app.put('/api/users/:id/password', requireDirector, (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  const hash = bcrypt.hashSync(new_password, 10);
  dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  const user = dbGet('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});

app.put('/api/users/:id', requireDirector, (req, res) => {
  const { name, role } = req.body;
  if (!name && !role) return res.status(400).json({ error: 'name or role required' });
  if (name) dbRun('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
  if (role) dbRun('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  const user = dbGet('SELECT id, name, login, role, created_at FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
  broadcast('director', { type: 'users_updated' });
});

app.delete('/api/users/:id', requireDirector, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot delete yourself' });
  dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ success: true });
  broadcast('director', { type: 'users_updated' });
});

// ORDERS

app.post('/api/orders', (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;
  if (!foreman_id || !project || !items || items.length === 0) return res.status(400).json({ error: 'Missing fields' });
  
  const maxRow = dbGet('SELECT MAX(order_number) as max_num FROM orders');
  const orderNumber = (maxRow?.max_num || 247) + 1;
  
  dbRun('INSERT INTO orders (order_number, project, foreman_id, due_date, urgency) VALUES (?, ?, ?, ?, ?)',
    [orderNumber, project, foreman_id, due_date, urgency]);
  
  const orderRow = dbGet('SELECT id FROM orders WHERE order_number = ?', [orderNumber]);
  const orderId = orderRow.id;
  
  for (const item of items) {
    const calc = calculateItem(item);
    dbRun(`INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, item.type, item.size, item.quantity, item.length, item.material, item.thickness, item.comment, item.attachment, calc.area, calc.weight, calc.cost]);
  }
  
  dbRun('INSERT INTO history (order_id, event) VALUES (?, ?)', [orderId, `Заказ создан ${foreman_name}`]);
  
  const order = getOrderById(orderId);
  res.status(201).json(order);
  broadcast('director', { type: 'new_order', order });
});

app.get('/api/orders', (req, res) => {
  const { status, urgency, project, search } = req.query;
  let sql = 'SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  if (urgency) { sql += ' AND o.urgency = ?'; params.push(urgency); }
  if (project) { sql += ' AND o.project = ?'; params.push(project); }
  if (search) { sql += ' AND (CAST(o.order_number AS TEXT) LIKE ? OR o.project LIKE ? OR u.name LIKE ?)'; const t = `%${search}%`; params.push(t,t,t); }
  sql += ' ORDER BY o.created_at DESC LIMIT 100';
  
  const rows = dbAll(sql, params);
  const orders = rows.map(row => ({
    ...row,
    items: dbAll('SELECT * FROM order_items WHERE order_id = ?', [row.id]),
    history: dbAll('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC', [row.id])
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
  dbRun("UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, req.params.id]);
  dbRun("INSERT INTO history (order_id, event) VALUES (?, ?)", [req.params.id, `Статус изменен на «${status}»`]);
  const order = getOrderById(req.params.id);
  res.json(order);
  broadcast('director', { type: 'order_updated', order });
});

app.get('/api/stats', (req, res) => {
  const row = dbGet(`SELECT
    (SELECT COUNT(*) FROM orders WHERE status = 'Новый') as new,
    (SELECT COUNT(*) FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен') as urgent,
    (SELECT COUNT(*) FROM orders WHERE status = 'В производстве') as inWork,
    (SELECT COUNT(*) FROM orders WHERE due_date < date('now') AND status NOT IN ('Готов', 'Отгружен')) as overdue`);
  res.json(row || { new: 0, urgent: 0, inWork: 0, overdue: 0 });
});

function getOrderById(id) {
  const row = dbGet('SELECT o.*, u.name as foreman, u.id as foreman_id FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = ?', [id]);
  if (!row) return null;
  row.items = dbAll('SELECT * FROM order_items WHERE order_id = ?', [id]);
  row.history = dbAll('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC', [id]);
  return row;
}

function calculateItem(item) {
  const size = String(item.size).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  const qty = item.quantity || 1;
  const length = item.length || 1;
  let area = 0;
  const dm = size.match(/[øoфd]?(\d{2,4})/i);
  if (size.includes('ø') || size.includes('ф') || item.type.includes('Круглый')) {
    const d = Number(dm?.[1]||0)/1000;
    if (d) area = Math.PI * d * length * qty * getFittingFactor(item.type);
  } else {
    const dims = size.match(/(\d{2,4})[xх×*](\d{2,4})/i);
    if (dims) { const w=Number(dims[1])/1000; const h=Number(dims[2])/1000; area=2*(w+h)*length*qty*getFittingFactor(item.type); }
  }
  area = Math.round(area*10)/10;
  const ma = area*1.08;
  const weight = ma*item.thickness*7.85;
  const prices={'Оцинковка':18,'Нержавейка':54,'Черный металл':15};
  const price=prices[item.material]||18;
  const cost=ma*price*(item.thickness/0.5);
  return {area:Math.round(area*10)/10,weight:Math.round(weight*10)/10,cost:Math.round(cost)};
}

function getFittingFactor(type) {
  if(type.includes('Отвод'))return 1.35;
  if(type.includes('Переход'))return 1.25;
  if(type.includes('Тройник'))return 1.55;
  if(type.includes('Зонт'))return 1.7;
  if(type.includes('Шибер'))return 1.2;
  if(type.includes('Нестандарт'))return 1.4;
  return 1;
}

// Start
initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`VentMaster on ${PORT}`));
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});
