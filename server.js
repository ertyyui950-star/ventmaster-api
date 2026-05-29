const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'ventmaster-secret-2026';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// In-memory store for Render (no SQLite)
const users = [];
const orders = [];
const orderItems = [];
const history = [];
let orderCounter = 247;

// Auth middleware
function auth(req, res, next) {
  const h = req.headers['authorization'];
  const t = h && h.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Token required' });
  jwt.verify(t, JWT_SECRET, (err, u) => { if (err) return res.status(403).json({ error: 'Invalid' }); req.user = u; next(); });
}

function requireDirector(req, res, next) {
  if (req.user && req.user.role === 'director') return next();
  res.status(403).json({ error: 'Director only' });
}

// WS
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('message', (m) => { try { const d = JSON.parse(m); if (d.type === 'auth') { jwt.verify(d.token, JWT_SECRET, (e, dec) => { if (!e) { ws.userId = dec.id; ws.role = dec.role; ws.send(JSON.stringify({type:'auth_ok'})); } }); } } catch(e) {} });
  ws.on('pong', () => { ws.isAlive = true; });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }); }, 30000);

function broadcast(role, msg) { wss.clients.forEach(w => { if (w.readyState === 1 && w.role === role) w.send(JSON.stringify(msg)); }); }

// AUTH
app.post('/api/auth/register', (req, res) => {
  const { name, login, role, password } = req.body;
  if (!name || !login || !role || !password) return res.status(400).json({ error: 'All fields required' });
  if (users.length === 0 && role !== 'director') return res.status(400).json({ error: 'First user must be director' });
  if (users.find(u => u.login === login)) return res.status(409).json({ error: 'Login taken' });
  const hash = bcrypt.hashSync(password, 10);
  const user = { id: users.length + 1, name, login, role, password_hash: hash, created_at: new Date().toISOString() };
  users.push(user);
  const token = jwt.sign({ id: user.id, name, role }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ token, user: { id: user.id, name, login, role } });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = users.find(u => u.login === login);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.use('/api', auth);

// USERS (director only)
app.get('/api/users', requireDirector, (req, res) => {
  res.json(users.map(u => ({ id: u.id, name: u.name, login: u.login, role: u.role, created_at: u.created_at })));
});

app.put('/api/users/:id/password', requireDirector, (req, res) => {
  const u = users.find(x => x.id === parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  u.password_hash = bcrypt.hashSync(req.body.new_password, 10);
  res.json({ success: true });
});

app.put('/api/users/:id', requireDirector, (req, res) => {
  const u = users.find(x => x.id === parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) u.name = req.body.name;
  if (req.body.role) u.role = req.body.role;
  res.json({ id: u.id, name: u.name, login: u.login, role: u.role, created_at: u.created_at });
});

app.delete('/api/users/:id', requireDirector, (req, res) => {
  const idx = users.findIndex(x => x.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (users[idx].id === req.user.id) return res.status(400).json({ error: 'Cannot delete self' });
  users.splice(idx, 1);
  res.json({ success: true });
});

// ORDERS
app.post('/api/orders', (req, res) => {
  const { foreman_id, foreman_name, project, due_date, urgency, items } = req.body;
  if (!foreman_id || !project || !items || !items.length) return res.status(400).json({ error: 'Missing' });
  orderCounter++;
  const order = { id: orders.length + 1, order_number: orderCounter, project, foreman_id, due_date, urgency, status: 'Новый', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), foreman: foreman_name };
  orders.push(order);
  for (const item of items) {
    const calc = calcItem(item);
    orderItems.push({ id: orderItems.length + 1, order_id: order.id, ...item, ...calc });
  }
  history.push({ order_id: order.id, event: `Заказ создан ${foreman_name}`, created_at: new Date().toISOString() });
  const full = { ...order, items: orderItems.filter(i => i.order_id === order.id), history: history.filter(h => h.order_id === order.id) };
  res.status(201).json(full);
  broadcast('director', { type: 'new_order', order: full });
});

app.get('/api/orders', (req, res) => {
  const { status, search } = req.query;
  let result = [...orders];
  if (status) result = result.filter(o => o.status === status);
  if (search) { const s = search.toLowerCase(); result = result.filter(o => String(o.order_number).includes(s) || o.project.toLowerCase().includes(s) || o.foreman.toLowerCase().includes(s)); }
  res.json(result.map(o => ({ ...o, items: orderItems.filter(i => i.order_id === o.id), history: history.filter(h => h.order_id === o.id) })));
});

app.get('/api/orders/:id', (req, res) => {
  const o = orders.find(x => x.id === parseInt(req.params.id));
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json({ ...o, items: orderItems.filter(i => i.order_id === o.id), history: history.filter(h => h.order_id === o.id) });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const o = orders.find(x => x.id === parseInt(req.params.id));
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = req.body.status;
  o.updated_at = new Date().toISOString();
  history.push({ order_id: o.id, event: `Статус изменен на «${req.body.status}»`, created_at: new Date().toISOString() });
  const full = { ...o, items: orderItems.filter(i => i.order_id === o.id), history: history.filter(h => h.order_id === o.id) };
  res.json(full);
  broadcast('director', { type: 'order_updated', order: full });
});

app.get('/api/stats', (req, res) => {
  res.json({
    new: orders.filter(o => o.status === 'Новый').length,
    urgent: orders.filter(o => o.urgency !== 'Обычный' && o.status !== 'Отгружен').length,
    inWork: orders.filter(o => o.status === 'В производстве').length,
    overdue: 0
  });
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
  return { calc_area: area, calc_weight: Math.round(w*10)/10, calc_cost: Math.round(ma*p*(item.thickness/0.5)) };
}

function getFF(t) { if(t.includes('Отвод'))return 1.35; if(t.includes('Переход'))return 1.25; if(t.includes('Тройник'))return 1.55; if(t.includes('Зонт'))return 1.7; if(t.includes('Шибер'))return 1.2; if(t.includes('Нестандарт'))return 1.4; return 1; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VentMaster on ${PORT}`));
