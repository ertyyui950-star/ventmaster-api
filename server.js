const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// JWT middleware
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
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

// SQLite Database
const db = new sqlite3.Database('./ventmaster.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(foreman_id) REFERENCES users(id)
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
    calc_cost INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);
});

// WebSocket authentication
wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        const token = data.token;
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
          if (err) {
            ws.close(4001, 'Invalid token');
            return;
          }
          ws.userId = decoded.id;
          ws.role = decoded.role;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        });
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    // Clean up any references if needed
  });
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

// API

app.post('/api/auth/login', (req, res) => {
  const { name, role } = req.body;
  
  db.get('SELECT id FROM users WHERE name = ?', [name], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      const user = { id: row.id, name, role };
      const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, user });
    }
    
    db.run('INSERT INTO users (name, role) VALUES (?, ?)', [name, role], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const user = { id: this.lastID, name, role };
      const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, user });
    });
  });
});

// Protect all API routes except login
app.use('/api', authenticateToken);

app.post('/api/orders', (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;

  if (!foreman_id || !project || !items || items.length === 0) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  db.run('BEGIN TRANSACTION');

  db.get('SELECT MAX(order_number) as max_num FROM orders', (err, row) => {
    const orderNumber = (row?.max_num || 247) + 1;

    db.run(
      'INSERT INTO orders (order_number, project, foreman_id, due_date, urgency) VALUES (?, ?, ?, ?, ?)',
      [orderNumber, project, foreman_id, due_date, urgency],
      function(err) {
        const orderId = this.lastID;
        let processed = 0;

        items.forEach((item) => {
          const calc = calculateItem(item);
          db.run(
            `INSERT INTO order_items (order_id, item_type, size, quantity, length, material, thickness, comment, attachment, calc_area, calc_weight, calc_cost) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderId, item.type, item.size, item.quantity, item.length, item.material, item.thickness, item.comment, item.attachment, calc.area, calc.weight, calc.cost],
            () => {
              processed++;
              if (processed === items.length) {
                db.run('INSERT INTO history (order_id, event) VALUES (?, ?)', [orderId, `Заказ создан ${foreman_name}`]);
                db.run('COMMIT');
                
                getOrderById(orderId, (order) => {
                  res.status(201).json(order);
                  broadcast('director', { type: 'new_order', order });
                });
              }
            }
          );
        });
      }
    );
  });
});

app.get('/api/orders', (req, res) => {
  const { status, urgency, project, search } = req.query;

  let query = `SELECT o.id, o.order_number, o.project, o.due_date, o.urgency, o.status, o.created_at, o.updated_at, u.name as foreman
               FROM orders o JOIN users u ON o.foreman_id = u.id WHERE 1=1`;
  const params = [];

  if (status) { query += ' AND o.status = ?'; params.push(status); }
  if (urgency) { query += ' AND o.urgency = ?'; params.push(urgency); }
  if (project) { query += ' AND o.project = ?'; params.push(project); }
  if (search) {
    query += ' AND (CAST(o.order_number AS TEXT) LIKE ? OR o.project LIKE ? OR u.name LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  query += ' ORDER BY o.created_at DESC LIMIT 100';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const orders = [];
    let loaded = 0;

    rows.forEach((row) => {
      db.all('SELECT * FROM order_items WHERE order_id = ?', [row.id], (err, items) => {
        db.all('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC', [row.id], (err, history) => {
          orders.push({ ...row, items: items || [], history: history || [] });
          loaded++;
          if (loaded === rows.length) res.json(orders);
        });
      });
    });

    if (!rows.length) res.json([]);
  });
});

app.get('/api/orders/:id', (req, res) => {
  getOrderById(req.params.id, (order) => {
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(order);
  });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  if (!status) return res.status(400).json({ error: 'Status required' });

  db.run('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, orderId], () => {
    db.run('INSERT INTO history (order_id, event) VALUES (?, ?)', [orderId, `Статус изменен на «${status}»`]);

    getOrderById(orderId, (order) => {
      res.json(order);
      broadcast('director', { type: 'order_updated', order });
    });
  });
});

app.get('/api/stats', (req, res) => {
  db.all(`SELECT 
    (SELECT COUNT(*) FROM orders WHERE status = 'Новый') as new,
    (SELECT COUNT(*) FROM orders WHERE urgency != 'Обычный' AND status != 'Отгружен') as urgent,
    (SELECT COUNT(*) FROM orders WHERE status = 'В производстве') as inWork,
    (SELECT COUNT(*) FROM orders WHERE due_date < date('now') AND status NOT IN ('Готов', 'Отгружен')) as overdue`, (err, rows) => {
    res.json(rows[0] || { new: 0, urgent: 0, inWork: 0, overdue: 0 });
  });
});

function getOrderById(orderId, callback) {
  db.get(
    `SELECT o.id, o.order_number, o.project, o.due_date, o.urgency, o.status, o.created_at, o.updated_at, u.name as foreman, u.id as foreman_id
     FROM orders o JOIN users u ON o.foreman_id = u.id WHERE o.id = ?`,
    [orderId],
    (err, order) => {
      if (!order) return callback(null);

      db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId], (err, items) => {
        db.all('SELECT event, created_at FROM history WHERE order_id = ? ORDER BY created_at DESC', [orderId], (err, history) => {
          callback({ ...order, items: items || [], history: history || [] });
        });
      });
    }
  );
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

  return {
    area: Math.round(area * 10) / 10,
    weight: Math.round(weight * 10) / 10,
    cost: Math.round(cost)
  };
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
  console.log(`🚀 VentMaster запущен на порту ${PORT}`);
});
