const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const JWT_SECRET = process.env.JWT_SECRET || 'ventmaster-secret-key-2026';
const DATABASE_URL = process.env.DATABASE_URL || null;

// ============ Database Layer ============
let usePg = !!DATABASE_URL;
let pgClient = null;

// In-memory fallback
const memUsers = [];
const memOrders = [];
const memOrderItems = [];
const memHistory = [];
let memOrderCounter = 247;

async function initPostgres() {
  if (!DATABASE_URL) return false;
  try {
    pgClient = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    
    // Create tables
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        login TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number INTEGER UNIQUE NOT NULL,
        project TEXT NOT NULL,
        foreman_id INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        urgency TEXT NOT NULL,
        status TEXT DEFAULT 'Новый',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
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
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('PostgreSQL connected and tables created');
    return true;
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
    pgClient = null;
    usePg = false;
    return false;
  }
}

// DB operations abstraction
const db = {
  // Users
  async createUser(name, login, role, passwordHash) {
    if (usePg) {
      const r = await pgClient.query(
        'INSERT INTO users (name, login, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id,name,login,role,created_at',
        [name, login, role, passwordHash]
      );
      return r.rows[0];
    }
    const u = { id: memUsers.length + 1, name, login, role, password_hash: passwordHash, created_at: new Date().toISOString() };
    memUsers.push(u);
    return u;
  },
  
  async findByLogin(login) {
    if (usePg) {
      const r = await pgClient.query('SELECT * FROM users WHERE login = $1', [login]);
      return r.rows[0] || null;
    }
    return memUsers.find(u => u.login === login) || null;
  },
  
  async findUserById(id) {
    if (usePg) {
      const r = await pgClient.query('SELECT id,name,login,role,created_at FROM users WHERE id = $1', [id]);
      return r.rows[0] || null;
    }
    return memUsers.find(u => u.id === id) || null;
  },
  
  async countUsers() {
    if (usePg) {
      const r = await pgClient.query('SELECT COUNT(*) as cnt FROM users');
      return parseInt(r.rows[0].cnt);
    }
    return memUsers.length;
  },
  
  async listUsers() {
    if (usePg) {
      const r = await pgClient.query('SELECT id,name,login,role,created_at FROM users ORDER BY id ASC');
      return r.rows;
    }
    return memUsers.map(u => ({ id: u.id, name: u.name, login: u.login, role: u.role, created_at: u.created_at }));
  },
  
  async updatePassword(userId, hash) {
    if (usePg) {
      await pgClient.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    } else {
      const u = memUsers.find(x => x.id === userId);
      if (u) u.password_hash = hash;
    }
  },
  
  async updateUser(userId, fields) {
    if (usePg) {
      const sets = [];
      const vals = [];
      let i = 1;
      if (fields.name) { sets.push(`name = $${i++}`); vals.push(fields.name); }
      if (fields.role) { sets.push(`role = $${i++}`); vals.push(fields.role); }
      vals.push(userId);
      await pgClient.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    } else {
      const u = memUsers.find(x => x.id === userId);
      if (u) {
        if (fields.name) u.name = fields.name;
        if (fields.role) u.role = fields.role;
      }
    }
  },
  
  async deleteUser(userId) {
    if (usePg) {
      await pgClient.query('DELETE FROM users WHERE id = $1', [userId]);
    } else {
      const idx = memUsers.findIndex(x => x.id === userId);
      if (idx >= 0) memUsers.splice(idx, 1);
    }
  },
  
  // Orders
  async getMaxOrderNumber() {
    if (usePg) {
      const r = await pgClient.query('SELECT MAX(order_number) as m FROM orders');
      return r.rows[0]?.m || 247;
    }
    return memOrderCounter;
  },
  
  async createOrder(orderNumber, projectId, foremanId, dueDate, urgency) {
    if (usePg) {
      const r = await pgClient.query(
        'INSERT INTO orders (order_number, project, foreman_id, due_date, urgency) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [orderNumber, projectId, foremanId, dueDate, urgency]
      );
      return r.rows[0];
    }
    const o = { id: memOrders.length + 1, order_number: orderNumber, project: projectId, foreman_id: foremanId, due_date: dueDate, urgency, status: 'Новый', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    memOrders.push(o);
    memOrderCounter = orderNumber;
    return o;
  },
  
  async addOrderItem(orderId, item, calc) {
    if (usePg) {
      await pgClient.query(
        'INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [orderId, item.type, item.size, item.quantity, item.length, item.material, item.thickness, item.comment, item.attachment, calc.area, calc.weight, calc.cost]
      );
    } else {
      memOrderItems.push({ id: memOrderItems.length + 1, order_id: orderId, ...item, ...calc });
    }
  },
  
  async addHistory(orderId, event) {
    if (usePg) {
      await pgClient.query('INSERT INTO history (order_id, event) VALUES ($1,$2)', [orderId, event]);
    } else {
      memHistory.push({ order_id: orderId, event, created_at: new Date().toISOString() });
    }
  },
  
  async listOrders(where = {}) {
    if (usePg) {
      let sql = 'SELECT o.*, u.name as foreman FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1';
      const params = [];
      let i = 1;
      if (where.status) { sql += ` AND o.status = $${i++}`; params.push(where.status); }
      if (where.urgency) { sql += ` AND o.urgency = $${i++}`; params.push(where.urgency); }
      if (where.search) { sql += ` AND (CAST(o.order_number AS TEXT) LIKE $${i} OR o.project LIKE $${i} OR u.name LIKE $${i})`; params.push(`%${where.search}%`); i++; }
      sql += ' ORDER BY o.created_at DESC LIMIT 100';
      const r = await pgClient.query(sql, params);
      return r.rows;
    }
    let result = [...memOrders];
    if (where.status) result = result.filter(o => o.status === where.status);
    if (where.search) {
      const s = where.search.toLowerCase();
      result = result.filter(o => String(o.order_number).includes(s) || o.project.toLowerCase().includes(s));
    }
    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  
  async getOrderItems(orderId) {
    if (usePg) {
      const r = await pgClient.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
      return r.rows;
    }
    return memOrderItems.filter(i => i.order_id === orderId);
  },
  
  async getOrderHistory(orderId) {
    if (usePg) {
      const r = await pgClient.query('SELECT event, created_at FROM history WHERE order_id = $1 ORDER BY created_at DESC', [orderId]);
      return r.rows;
    }
    return memHistory.filter(h => h.order_id === orderId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  
  async updateOrderStatus(orderId, status) {
    if (usePg) {
      await pgClient.query("UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2", [status, orderId]);
    } else {
      const o = memOrders.find(x => x.id === orderId);
      if (o) { o.status = status; o.updated_at = new Date().toISOString(); }
    }
  },
  
  async getFullOrder(orderId) {
    if (usePg) {
      const r = await pgClient.query('SELECT o.*, u.name as foreman, u.id as foreman_id FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = $1', [orderId]);
      return r.rows[0] || null;
    }
    const o = memOrders.find(x => x.id === orderId);
    return o || null;
  },
  
  async getStats() {
    if (usePg) {
      const r = await pgClient.query(`SELECT
        (SELECT COUNT(*) FROM orders WHERE status = 'Новый') as new,
        (SELECT COUNT(*) FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен') as urgent,
        (SELECT COUNT(*) FROM orders WHERE status = 'В производстве') as inwork,
        (SELECT COUNT(*) FROM orders WHERE due_date < CURRENT_DATE AND status NOT IN ('Готов','Отгружен')) as overdue`);
      return { new: +r.rows[0].new, urgent: +r.rows[0].urgent, inWork: +r.rows[0].inwork, overdue: +r.rows[0].overdue };
    }
    return {
      new: memOrders.filter(o => o.status === 'Новый').length,
      urgent: memOrders.filter(o => o.urgency !== 'Обычный' && o.status !== 'Отгружен').length,
      inWork: memOrders.filter(o => o.status === 'В производстве').length,
      overdue: 0
    };
  }
};

// ============ Express App ============
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function authenticateToken(req, res, next) {
  const h = req.headers['authorization'];
  const t = h && h.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Token required' });
  jwt.verify(t, JWT_SECRET, (err, u) => { if (err) return res.status(403).json({ error: 'Invalid' }); req.user = u; next(); });
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
      if (d.type === 'auth') {
        jwt.verify(d.token, JWT_SECRET, (e, dec) => {
          if (!e) { ws.userId = dec.id; ws.role = dec.role; ws.send(JSON.stringify({ type: 'auth_ok' })); }
        });
      }
    } catch(e) {}
  });
  ws.on('pong', () => { ws.isAlive = true; });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }); }, 30000);

function broadcast(role, msg) { wss.clients.forEach(w => { if (w.readyState === 1 && w.role === role) w.send(JSON.stringify(msg)); }); }

// AUTH
app.post('/api/auth/register', async (req, res) => {
  const { name, login, role, password } = req.body;
  if (!name || !login || !role || !password) return res.status(400).json({ error: 'All fields required' });
  if (await db.countUsers() === 0 && role !== 'director') return res.status(400).json({ error: 'First user must be director' });
  if (await db.findByLogin(login)) return res.status(409).json({ error: 'Login taken' });
  const hash = bcrypt.hashSync(password, 10);
  const user = await db.createUser(name, login, role, hash);
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ token, user: { id: user.id, name: user.name, login: user.login, role: user.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = await db.findByLogin(login);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.use('/api', authenticateToken);

// USERS
app.get('/api/users', requireDirector, async (req, res) => {
  res.json(await db.listUsers());
});

app.put('/api/users/:id/password', requireDirector, async (req, res) => {
  const hash = bcrypt.hashSync(req.body.new_password, 10);
  await db.updatePassword(req.params.id, hash);
  res.json({ success: true });
});

app.put('/api/users/:id', requireDirector, async (req, res) => {
  await db.updateUser(req.params.id, { name: req.body.name, role: req.body.role });
  const user = await db.findUserById(req.params.id);
  res.json(user);
});

app.delete('/api/users/:id', requireDirector, async (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot delete self' });
  await db.deleteUser(req.params.id);
  res.json({ success: true });
});

// ORDERS
app.post('/api/orders', async (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;
  if (!foreman_id || !project || !items?.length) return res.status(400).json({ error: 'Missing fields' });
  const maxNum = await db.getMaxOrderNumber();
  const orderNum = maxNum + 1;
  const order = await db.createOrder(orderNum, project, foreman_id, due_date, urgency);
  for (const item of items) {
    const calc = calcItem(item);
    await db.addOrderItem(order.id, item, calc);
  }
  await db.addHistory(order.id, `Заказ создан ${foreman_name}`);
  const foreman = await db.findUserById(foreman_id);
  const full = { ...order, foreman: foreman?.name || foreman_name, items: await db.getOrderItems(order.id), history: await db.getOrderHistory(order.id) };
  res.status(201).json(full);
  broadcast('director', { type: 'new_order', order: full });
});

app.get('/api/orders', async (req, res) => {
  const orders = await db.listOrders({ status: req.query.status, search: req.query.search });
  const result = [];
  for (const o of orders) {
    const foreman = await db.findUserById(o.foreman_id);
    result.push({ ...o, foreman: foreman?.name || '?', items: await db.getOrderItems(o.id), history: await db.getOrderHistory(o.id) });
  }
  res.json(result);
});

app.get('/api/orders/:id', async (req, res) => {
  const o = await db.getFullOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const foreman = await db.findUserById(o.foreman_id);
  res.json({ ...o, foreman: foreman?.name || '?', items: await db.getOrderItems(o.id), history: await db.getOrderHistory(o.id) });
});

app.patch('/api/orders/:id/status', async (req, res) => {
  await db.updateOrderStatus(req.params.id, req.body.status);
  await db.addHistory(req.params.id, `Статус изменен на «${req.body.status}»`);
  const o = await db.getFullOrder(req.params.id);
  const foreman = await db.findUserById(o.foreman_id);
  const full = { ...o, foreman: foreman?.name || '?', items: await db.getOrderItems(o.id), history: await db.getOrderHistory(o.id) };
  res.json(full);
  broadcast('director', { type: 'order_updated', order: full });
});

app.get('/api/stats', async (req, res) => {
  res.json(await db.getStats());
});

function calcItem(item) {
  const size = String(item.size).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  const qty = item.quantity || 1;
  const len = item.length || 1;
  let area = 0;
  const dm = size.match(/[øoфd]?(\d{2,4})/i);
  if (size.includes('ø') || size.includes('ф') || item.type.includes('Круглый')) {
    const d = Number(dm?.[1]||0)/1000;
    if (d) area = Math.PI * d * len * qty * getFF(item.type);
  } else {
    const dims = size.match(/(\d{2,4})[xх×*](\d{2,4})/i);
    if (dims) { const w=Number(dims[1])/1000; const h=Number(dims[2])/1000; area=2*(w+h)*len*qty*getFF(item.type); }
  }
  area = Math.round(area*10)/10;
  const ma = area*1.08;
  const w = ma*item.thickness*7.85;
  const p = {'Оцинковка':18,'Нержавейка':54,'Черный металл':15}[item.material]||18;
  return { area: Math.round(area*10)/10, weight: Math.round(w*10)/10, cost: Math.round(ma*p*(item.thickness/0.5)) };
}

function getFF(t) { if(t.includes('Отвод'))return 1.35; if(t.includes('Переход'))return 1.25; if(t.includes('Тройник'))return 1.55; if(t.includes('Зонт'))return 1.7; if(t.includes('Шибер'))return 1.2; if(t.includes('Нестандарт'))return 1.4; return 1; }

// Start
initPostgres().then(async () => {
  // Create default director if no users exist
  if (await db.countUsers() === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.createUser('Директор', 'director', 'director', hash);
    console.log('Default director created: director / admin123');
  }
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`VentMaster running on port ${PORT} (${usePg ? 'PostgreSQL' : 'in-memory'})`);
  });
}).catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
