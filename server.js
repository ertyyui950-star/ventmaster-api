const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');

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

// Director-only middleware
function requireDirector(req, res, next) {
  if (req.user && req.user.role === 'director') {
    next();
  } else {
    res.status(403).json({ error: 'Director access required' });
  }
}

// SQLite Database — use /tmp for Render read-only filesystem
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/ventmaster.db' : './ventmaster.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Create users table (legacy-compatible)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate: add login column if missing
  db.all("PRAGMA table_info(users)", (err, cols) => {
    const names = (cols || []).map(c => c.name);
    if (!names.includes('login')) {
      db.run("ALTER TABLE users ADD COLUMN login TEXT");
      // Backfill: set login = name for existing users
      db.run("UPDATE users SET login = name WHERE login IS NULL");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login)");
    }
    if (!names.includes('password_hash')) {
      db.run("ALTER TABLE users ADD COLUMN password_hash TEXT");
      // Backfill: set default password "123456" for existing users
      const bcrypt = require('bcryptjs');
      db.all("SELECT id FROM users WHERE password IS NULL OR password_hash IS NULL", (err, rows) => {
        (rows || []).forEach(row => {
          const hash = bcrypt.hashSync('123456', 10);
          db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, row.id]);
        });
      });
    }
  });

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

  // Add login column if not exists (migration)
  try {
    db.run('ALTER TABLE users ADD COLUMN login TEXT');
  } catch (e) { /* column already exists */ }
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

// Broadcast to all directors
function broadcastToDirectors(message) {
  broadcast('director', message);
}

// API

// POST /api/auth/login — accepts { login, password }
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Login and password required' });
  }

  db.get('SELECT id, name, role, password_hash FROM users WHERE login = ?', [login], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(401).json({ error: 'Invalid login or password' });

    bcrypt.compare(password, row.password_hash, (err, match) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!match) return res.status(401).json({ error: 'Invalid login or password' });

      const user = { id: row.id, name: row.name, role: row.role };
      const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, user });
    });
  });
});

// POST /api/auth/register — first user (director) is open; subsequent users require director auth
app.post('/api/auth/register', (req, res) => {
  const { name, login, role, password } = req.body;

  if (!name || !login || !role || !password) {
    return res.status(400).json({ error: 'Name, login, role, and password are required' });
  }

  // Check if any users exist
  db.get('SELECT COUNT(*) as cnt FROM users', (err, row) => {
    const isFirstUser = !row || row.cnt === 0;

    if (isFirstUser) {
      // First user must be director
      if (role !== 'director') {
        return res.status(400).json({ error: 'First user must be director' });
      }
    }

    const hash = bcrypt.hashSync(password, 10);

    db.run(
      'INSERT INTO users (name, login, role, password_hash) VALUES (?, ?, ?, ?)',
      [name, login, role, hash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Name or login already exists' });
          }
          return res.status(500).json({ error: err.message });
        }
        const user = { id: this.lastID, name, login, role };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
        res.status(201).json({ token, user });
      }
    );
  });
});

// GET /api/users — list all users (director only)
app.get('/api/users', authenticateToken, requireDirector, (req, res) => {
  db.all(
    'SELECT id, name, login, role, created_at FROM users ORDER BY created_at ASC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// PUT /api/users/:id/password — change user password (director only)
app.put('/api/users/:id/password', authenticateToken, requireDirector, (req, res) => {
  const { new_password } = req.body;
  const targetId = req.params.id;

  if (!new_password) {
    return res.status(400).json({ error: 'new_password is required' });
  }

  const hash = bcrypt.hashSync(new_password, 10);

  db.run(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [hash, targetId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
      getUsersForBroadcast(() => {});
    }
  );
});

// PUT /api/users/:id — update user info (director only)
app.put('/api/users/:id', authenticateToken, requireDirector, (req, res) => {
  const { name, role } = req.body;
  const targetId = req.params.id;

  if (!name && !role) {
    return res.status(400).json({ error: 'At least name or role must be provided' });
  }

  let query = 'UPDATE users SET ';
  const sets = [];
  const params = [];

  if (name) { sets.push('name = ?'); params.push(name); }
  if (role) { sets.push('role = ?'); params.push(role); }

  query += sets.join(', ') + ' WHERE id = ?';
  params.push(targetId);

  db.run(query, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });

    db.get(
      'SELECT id, name, login, role, created_at FROM users WHERE id = ?',
      [targetId],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
        broadcastToDirectors({ type: 'users_updated' });
      }
    );
  });
});

// DELETE /api/users/:id — delete user (director only, cannot delete self)
app.delete('/api/users/:id', authenticateToken, requireDirector, (req, res) => {
  const targetId = req.params.id;

  if (String(targetId) === String(req.user.id)) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  db.run('DELETE FROM users WHERE id = ?', [targetId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
    broadcastToDirectors({ type: 'users_updated' });
  });
});

// Helper to get users for broadcast (no password_hash)
function getUsersForBroadcast(callback) {
  db.all(
    'SELECT id, name, login, role, created_at FROM users ORDER BY created_at ASC',
    (err, rows) => {
      if (!err) {
        broadcastToDirectors({ type: 'users_updated' });
      }
      callback(null, rows);
    }
  );
}

// Protect all API routes except auth endpoints
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
