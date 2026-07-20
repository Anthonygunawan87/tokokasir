'use strict';
/**
 * TokoKasir — POS (Kasir) + Pemesanan Online terintegrasi
 * Zero-dependency: Node built-in http + node:sqlite (Node >= 22).
 * Jalankan: node server.js   → buka http://localhost:3000
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'data', 'toko.db');

// ---------------------------------------------------------------- DB setup
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Umum',
    price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'kasir',
    items TEXT NOT NULL,
    subtotal REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    paid REAL NOT NULL DEFAULT 0,
    change_due REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'Tunai',
    customer TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    note TEXT,
    items TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    transaction_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Lightweight migration: add payment_method to older DBs that lack it
const trxCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
if (!trxCols.includes('payment_method')) {
  db.exec("ALTER TABLE transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'Tunai'");
  console.log('[migrate] kolom payment_method ditambahkan.');
}

// Seed a few demo products on first run
const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (count === 0) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO products (sku,name,category,price,stock,active,created_at) VALUES (?,?,?,?,?,1,?)'
  );
  const seed = [
    ['MNM-001', 'Air Mineral 600ml', 'Minuman', 3500, 120],
    ['MNM-002', 'Teh Kotak 250ml', 'Minuman', 4500, 80],
    ['MNM-003', 'Kopi Sachet', 'Minuman', 2000, 200],
    ['MKN-001', 'Roti Tawar', 'Makanan', 15000, 30],
    ['MKN-002', 'Mie Instan Goreng', 'Makanan', 3500, 150],
    ['MKN-003', 'Biskuit Coklat', 'Makanan', 9000, 60],
    ['SNK-001', 'Keripik Kentang', 'Snack', 12000, 45],
    ['SNK-002', 'Permen Mint', 'Snack', 1000, 300],
    ['RMT-001', 'Sabun Mandi', 'Rumah Tangga', 5000, 70],
    ['RMT-002', 'Pasta Gigi', 'Rumah Tangga', 14000, 40],
  ];
  for (const s of seed) ins.run(...s, now);
  console.log(`[seed] ${seed.length} produk contoh ditambahkan.`);
}

// ---------------------------------------------------------------- helpers
const nowISO = () => new Date().toISOString();
const genCode = (prefix) =>
  `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Deduct stock for a list of items [{id, qty}]. Throws if insufficient.
function deductStock(items) {
  const getP = db.prepare('SELECT id,name,stock FROM products WHERE id = ?');
  for (const it of items) {
    const p = getP.get(it.id);
    if (!p) throw new Error(`Produk id ${it.id} tidak ditemukan`);
    if (p.stock < it.qty) throw new Error(`Stok "${p.name}" kurang (sisa ${p.stock}, diminta ${it.qty})`);
  }
  const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  for (const it of items) upd.run(it.qty, it.id);
}

// ---------------------------------------------------------------- API
const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

// -- Products
route('GET', /^\/api\/products$/, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  sendJSON(res, 200, rows);
});

route('POST', /^\/api\/products$/, async (req, res) => {
  const b = await readBody(req);
  if (!b.name) return sendJSON(res, 400, { error: 'Nama produk wajib diisi' });
  try {
    const r = db
      .prepare('INSERT INTO products (sku,name,category,price,stock,active,created_at) VALUES (?,?,?,?,?,1,?)')
      .run(b.sku || null, b.name, b.category || 'Umum', Number(b.price) || 0, parseInt(b.stock) || 0, nowISO());
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
    sendJSON(res, 201, row);
  } catch (e) {
    sendJSON(res, 400, { error: e.message.includes('UNIQUE') ? 'SKU sudah dipakai' : e.message });
  }
});

route('PUT', /^\/api\/products\/(\d+)$/, async (req, res, m) => {
  const id = +m[1];
  const b = await readBody(req);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return sendJSON(res, 404, { error: 'Produk tidak ditemukan' });
  try {
    db.prepare('UPDATE products SET sku=?,name=?,category=?,price=?,stock=? WHERE id=?').run(
      b.sku ?? p.sku,
      b.name ?? p.name,
      b.category ?? p.category,
      b.price != null ? Number(b.price) : p.price,
      b.stock != null ? parseInt(b.stock) : p.stock,
      id
    );
    sendJSON(res, 200, db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  } catch (e) {
    sendJSON(res, 400, { error: e.message.includes('UNIQUE') ? 'SKU sudah dipakai' : e.message });
  }
});

route('DELETE', /^\/api\/products\/(\d+)$/, (req, res, m) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(+m[1]);
  sendJSON(res, 200, { ok: true });
});

// -- Cashier transaction (direct sale)
route('POST', /^\/api\/transactions$/, async (req, res) => {
  const b = await readBody(req);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return sendJSON(res, 400, { error: 'Keranjang kosong' });
  try {
    deductStock(items);
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const discount = Number(b.discount) || 0;
    const tax = Number(b.tax) || 0;
    const total = Math.max(0, subtotal - discount + tax);
    const paid = Number(b.paid) || total;
    const code = genCode('TRX');
    const r = db
      .prepare(
        `INSERT INTO transactions (code,source,items,subtotal,discount,tax,total,paid,change_due,payment_method,customer,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(code, 'kasir', JSON.stringify(items), subtotal, discount, tax, total, paid, Math.max(0, paid - total), b.payment_method || 'Tunai', b.customer || null, nowISO());
    sendJSON(res, 201, db.prepare('SELECT * FROM transactions WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

route('GET', /^\/api\/transactions$/, (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  let sql = 'SELECT * FROM transactions';
  const cond = [], args = [];
  if (from) { cond.push('created_at >= ?'); args.push(from + 'T00:00:00.000Z'); }
  if (to) { cond.push('created_at <= ?'); args.push(to + 'T23:59:59.999Z'); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT 1000';
  sendJSON(res, 200, db.prepare(sql).all(...args));
});

// -- Online orders (from customer shop)
route('POST', /^\/api\/orders$/, async (req, res) => {
  const b = await readBody(req);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return sendJSON(res, 400, { error: 'Keranjang kosong' });
  if (!b.customer_name) return sendJSON(res, 400, { error: 'Nama pemesan wajib diisi' });
  // Validate stock availability (soft check, not yet deducted)
  const getP = db.prepare('SELECT name,stock FROM products WHERE id = ?');
  for (const it of items) {
    const p = getP.get(it.id);
    if (!p) return sendJSON(res, 400, { error: `Produk tidak ditemukan` });
    if (p.stock < it.qty) return sendJSON(res, 400, { error: `Stok "${p.name}" tidak cukup (sisa ${p.stock})` });
  }
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const code = genCode('ORD');
  const r = db
    .prepare(
      `INSERT INTO orders (code,customer_name,customer_phone,note,items,total,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)`
    )
    .run(code, b.customer_name, b.customer_phone || null, b.note || null, JSON.stringify(items), total, nowISO(), nowISO());
  sendJSON(res, 201, db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid));
});

route('GET', /^\/api\/orders$/, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();
  sendJSON(res, 200, rows);
});

// Update order status. On 'completed' -> deduct stock + create transaction.
route('PUT', /^\/api\/orders\/(\d+)\/status$/, async (req, res, m) => {
  const id = +m[1];
  const b = await readBody(req);
  const status = b.status;
  const valid = ['accepted', 'completed', 'cancelled', 'pending'];
  if (!valid.includes(status)) return sendJSON(res, 400, { error: 'Status tidak valid' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return sendJSON(res, 404, { error: 'Pesanan tidak ditemukan' });
  if (order.status === 'completed') return sendJSON(res, 400, { error: 'Pesanan sudah selesai' });

  try {
    if (status === 'completed') {
      const items = JSON.parse(order.items);
      deductStock(items);
      const code = genCode('TRX');
      const tr = db
        .prepare(
          `INSERT INTO transactions (code,source,items,subtotal,discount,tax,total,paid,change_due,payment_method,customer,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(code, 'online', order.items, order.total, 0, 0, order.total, order.total, 0, 'Online', order.customer_name, nowISO());
      db.prepare('UPDATE orders SET status=?, transaction_id=?, updated_at=? WHERE id=?').run('completed', tr.lastInsertRowid, nowISO(), id);
    } else {
      db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, nowISO(), id);
    }
    sendJSON(res, 200, db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

// -- Reports
route('GET', /^\/api\/reports\/summary$/, (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'); // YYYY-MM-DD
  const to = url.searchParams.get('to');
  let sql = 'SELECT * FROM transactions';
  const cond = [];
  const args = [];
  if (from) { cond.push('created_at >= ?'); args.push(from + 'T00:00:00.000Z'); }
  if (to) { cond.push('created_at <= ?'); args.push(to + 'T23:59:59.999Z'); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  const trx = db.prepare(sql).all(...args);

  let revenue = 0, txCount = trx.length, itemsSold = 0;
  const productAgg = {};
  const daily = {};
  for (const t of trx) {
    revenue += t.total;
    const day = t.created_at.slice(0, 10);
    daily[day] = (daily[day] || 0) + t.total;
    for (const it of JSON.parse(t.items)) {
      itemsSold += it.qty;
      if (!productAgg[it.name]) productAgg[it.name] = { name: it.name, qty: 0, revenue: 0 };
      productAgg[it.name].qty += it.qty;
      productAgg[it.name].revenue += it.price * it.qty;
    }
  }
  const bestSellers = Object.values(productAgg).sort((a, b) => b.qty - a.qty).slice(0, 10);
  const dailySeries = Object.entries(daily).sort().map(([date, total]) => ({ date, total }));
  sendJSON(res, 200, {
    revenue, txCount, itemsSold,
    avgTx: txCount ? revenue / txCount : 0,
    bestSellers, dailySeries,
    bySource: {
      kasir: trx.filter(t => t.source === 'kasir').reduce((s, t) => s + t.total, 0),
      online: trx.filter(t => t.source === 'online').reduce((s, t) => s + t.total, 0),
    },
  });
});

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const pathname = new URL(req.url, 'http://x').pathname;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (m) return await r.handler(req, res, m);
      }
      return sendJSON(res, 404, { error: 'endpoint tidak ditemukan' });
    }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: e.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  TokoKasir siap 🛒`);
  console.log(`  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  Kasir/Admin : http://localhost:${PORT}/pos.html`);
  console.log(`  │  Toko Online : http://localhost:${PORT}/shop.html`);
  console.log(`  │  Beranda     : http://localhost:${PORT}/`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
});
