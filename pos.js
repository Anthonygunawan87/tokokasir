'use strict';
// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const rp = (n) => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
const api = async (url, opts) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Terjadi kesalahan');
  return d;
};
let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    ['kasir', 'produk', 'pesanan', 'laporan'].forEach((t) => ($('#tab-' + t).hidden = t !== b.dataset.tab));
    if (b.dataset.tab === 'produk') loadProducts();
    if (b.dataset.tab === 'pesanan') loadOrders();
    if (b.dataset.tab === 'laporan') runReport();
  };
});

// ================= KASIR =================
let PRODUCTS = [];
let cart = []; // {id,name,price,qty,stock}

async function loadPosProducts() {
  PRODUCTS = await api('/api/products');
  renderPosProducts();
}
function renderPosProducts() {
  const q = $('#posSearch').value.toLowerCase();
  const list = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q));
  $('#posProducts').innerHTML =
    list
      .map((p) => {
        const out = p.stock <= 0;
        return `<button class="prod-card ${out ? 'out' : ''}" ${out ? 'disabled' : ''} onclick="addToCart(${p.id})">
          <div class="nm">${esc(p.name)}</div>
          <div class="pr">${rp(p.price)}</div>
          <div class="st">Stok: ${p.stock}${p.sku ? ' · ' + esc(p.sku) : ''}</div>
        </button>`;
      })
      .join('') || '<div class="empty">Tidak ada produk</div>';
}
$('#posSearch').oninput = renderPosProducts;

// Barcode / SKU quick-add: scanner types code then sends Enter
$('#scanSku').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const code = e.target.value.trim().toLowerCase();
  if (!code) return;
  const p = PRODUCTS.find((x) => (x.sku || '').toLowerCase() === code || String(x.id) === code);
  if (!p) toast('SKU tidak ditemukan: ' + e.target.value, true);
  else if (p.stock <= 0) toast('Stok habis: ' + p.name, true);
  else addToCart(p.id);
  e.target.value = '';
});

window.addToCart = (id) => {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  const line = cart.find((c) => c.id === id);
  const inCart = line ? line.qty : 0;
  if (inCart + 1 > p.stock) return toast('Stok tidak cukup', true);
  if (line) line.qty++;
  else cart.push({ id: p.id, name: p.name, price: p.price, qty: 1, stock: p.stock });
  renderCart();
};
window.chQty = (id, d) => {
  const line = cart.find((c) => c.id === id);
  if (!line) return;
  if (d > 0 && line.qty + 1 > line.stock) return toast('Stok tidak cukup', true);
  line.qty += d;
  if (line.qty <= 0) cart = cart.filter((c) => c.id !== id);
  renderCart();
};
function renderCart() {
  if (!cart.length) {
    $('#cart').innerHTML = '<div class="empty">Keranjang kosong.<br>Klik produk untuk menambah.</div>';
  } else {
    $('#cart').innerHTML = cart
      .map(
        (c) => `<div class="cart-item">
        <div class="nm">${esc(c.name)}<div class="muted" style="font-size:12px">${rp(c.price)}</div></div>
        <div class="qty">
          <button onclick="chQty(${c.id},-1)">−</button>
          <span>${c.qty}</span>
          <button onclick="chQty(${c.id},1)">+</button>
        </div>
        <div style="width:80px;text-align:right;font-weight:600">${rp(c.price * c.qty)}</div>
      </div>`
      )
      .join('');
  }
  updateTotals();
}
function updateTotals() {
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discount = +$('#discount').value || 0;
  const tax = +$('#tax').value || 0;
  const total = Math.max(0, subtotal - discount + tax);
  const paid = +$('#paid').value || 0;
  $('#subtotal').textContent = rp(subtotal);
  $('#grand').textContent = rp(total);
  $('#change').textContent = rp(Math.max(0, paid - total));
}
['#discount', '#tax', '#paid'].forEach((s) => ($(s).oninput = updateTotals));
$('#btnClearCart').onclick = () => { cart = []; $('#paid').value = ''; $('#discount').value = 0; $('#tax').value = 0; $('#custName').value = ''; renderCart(); };

$('#btnCheckout').onclick = async () => {
  if (!cart.length) return toast('Keranjang masih kosong', true);
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discount = +$('#discount').value || 0;
  const tax = +$('#tax').value || 0;
  const total = Math.max(0, subtotal - discount + tax);
  const paid = +$('#paid').value || total;
  if (paid < total) return toast('Uang bayar kurang dari total', true);
  try {
    const trx = await api('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({ items: cart, discount, tax, paid, payment_method: $('#payMethod').value, customer: $('#custName').value.trim() || null }),
    });
    showReceipt(trx);
    cart = [];
    $('#paid').value = ''; $('#discount').value = 0; $('#tax').value = 0; $('#custName').value = '';
    renderCart();
    await loadPosProducts();
    toast('Transaksi berhasil ✓');
  } catch (e) {
    toast(e.message, true);
  }
};

function showReceipt(trx) {
  const items = JSON.parse(trx.items);
  const d = new Date(trx.created_at);
  $('#receiptBody').innerHTML = `
    <div class="c"><strong>TOKOKASIR</strong><br><span class="muted">Struk Penjualan</span></div>
    <hr>
    <div class="li"><span>No</span><span>${trx.code}</span></div>
    <div class="li"><span>Tanggal</span><span>${d.toLocaleString('id-ID')}</span></div>
    <div class="li"><span>Pelanggan</span><span>${esc(trx.customer || 'Umum')}</span></div>
    <div class="li"><span>Sumber</span><span>${trx.source === 'online' ? 'Online' : 'Kasir'}</span></div>
    <hr>
    ${items.map((i) => `<div class="li"><span>${esc(i.name)} x${i.qty}</span><span>${rp(i.price * i.qty)}</span></div>`).join('')}
    <hr>
    <div class="li"><span>Subtotal</span><span>${rp(trx.subtotal)}</span></div>
    ${trx.discount ? `<div class="li"><span>Diskon</span><span>-${rp(trx.discount)}</span></div>` : ''}
    ${trx.tax ? `<div class="li"><span>Pajak</span><span>${rp(trx.tax)}</span></div>` : ''}
    <div class="li" style="font-weight:800;font-size:15px"><span>TOTAL</span><span>${rp(trx.total)}</span></div>
    <div class="li"><span>Metode</span><span>${esc(trx.payment_method || 'Tunai')}</span></div>
    <div class="li"><span>Bayar</span><span>${rp(trx.paid)}</span></div>
    <div class="li"><span>Kembali</span><span>${rp(trx.change_due)}</span></div>
    <hr>
    <div class="c muted">Terima kasih 🙏</div>`;
  $('#receiptModal').classList.add('show');
}
window.closeReceipt = () => $('#receiptModal').classList.remove('show');

// ================= PRODUK =================
let editId = null;
async function loadProducts() {
  PRODUCTS = await api('/api/products');
  renderProdTable();
}
function renderProdTable() {
  const q = ($('#prodSearch').value || '').toLowerCase();
  const list = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q));
  $('#prodTable').innerHTML =
    list
      .map(
        (p) => `<tr>
      <td>${esc(p.sku || '-')}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.category)}</td>
      <td>${rp(p.price)}</td>
      <td><strong>${p.stock}</strong></td>
      <td><span class="badge ${p.stock <= 5 ? 'low' : 'ok'}">${p.stock <= 5 ? 'Menipis' : 'Aman'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" onclick="editProd(${p.id})">Edit</button>
        <button class="btn danger sm" onclick="delProd(${p.id})">Hapus</button>
      </td></tr>`
      )
      .join('') || '<tr><td colspan="7" class="empty">Belum ada produk</td></tr>';
}
$('#prodSearch').oninput = renderProdTable;

$('#btnSaveProd').onclick = async () => {
  const body = {
    sku: $('#fSku').value.trim() || null,
    name: $('#fName').value.trim(),
    category: $('#fCat').value.trim() || 'Umum',
    price: +$('#fPrice').value || 0,
    stock: parseInt($('#fStock').value) || 0,
  };
  if (!body.name) return toast('Nama produk wajib diisi', true);
  try {
    if (editId) await api('/api/products/' + editId, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
    resetProdForm();
    await loadProducts();
    toast(editId ? 'Produk diperbarui ✓' : 'Produk ditambahkan ✓');
    editId = null;
  } catch (e) {
    toast(e.message, true);
  }
};
window.editProd = (id) => {
  const p = PRODUCTS.find((x) => x.id === id);
  editId = id;
  $('#fSku').value = p.sku || ''; $('#fName').value = p.name; $('#fCat').value = p.category;
  $('#fPrice').value = p.price; $('#fStock').value = p.stock;
  $('#prodFormTitle').textContent = 'Edit Produk: ' + p.name;
  $('#btnCancelEdit').hidden = false;
  $('#btnSaveProd').textContent = 'Simpan Perubahan';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
$('#btnCancelEdit').onclick = resetProdForm;
function resetProdForm() {
  editId = null;
  ['#fSku', '#fName', '#fCat', '#fPrice'].forEach((s) => ($(s).value = ''));
  $('#fStock').value = 0;
  $('#prodFormTitle').textContent = 'Tambah Produk';
  $('#btnCancelEdit').hidden = true;
  $('#btnSaveProd').textContent = 'Simpan Produk';
}
window.delProd = async (id) => {
  if (!confirm('Hapus produk ini?')) return;
  await api('/api/products/' + id, { method: 'DELETE' });
  await loadProducts();
  toast('Produk dihapus');
};

// ================= PESANAN ONLINE =================
async function loadOrders() {
  const orders = await api('/api/orders');
  const pending = orders.filter((o) => o.status === 'pending' || o.status === 'accepted').length;
  $('#ordBadge').innerHTML = pending ? `<span class="badge pending">${pending}</span>` : '';
  if (!orders.length) { $('#ordersList').innerHTML = '<div class="empty">Belum ada pesanan online</div>'; return; }
  $('#ordersList').innerHTML = orders
    .map((o) => {
      const items = JSON.parse(o.items);
      const d = new Date(o.created_at);
      const actions =
        o.status === 'pending'
          ? `<button class="btn sm" onclick="setOrder(${o.id},'accepted')">Terima</button>
             <button class="btn danger sm" onclick="setOrder(${o.id},'cancelled')">Tolak</button>`
          : o.status === 'accepted'
          ? `<button class="btn green sm" onclick="setOrder(${o.id},'completed')">Selesaikan &amp; Potong Stok</button>
             <button class="btn danger sm" onclick="setOrder(${o.id},'cancelled')">Batalkan</button>`
          : '';
      return `<div class="card" style="margin-bottom:12px;box-shadow:none;border:1px solid var(--line)">
        <div class="row" style="justify-content:space-between">
          <div><strong>${o.code}</strong> <span class="badge ${o.status}">${statusLabel(o.status)}</span></div>
          <span class="muted" style="font-size:13px">${d.toLocaleString('id-ID')}</span>
        </div>
        <div style="margin:6px 0"><strong>${esc(o.customer_name)}</strong>${o.customer_phone ? ' · ' + esc(o.customer_phone) : ''}${o.note ? '<br><span class="muted">📝 ' + esc(o.note) + '</span>' : ''}</div>
        <div style="font-size:14px">${items.map((i) => `${esc(i.name)} <span class="muted">x${i.qty}</span>`).join(', ')}</div>
        <div class="row" style="justify-content:space-between;margin-top:10px">
          <strong>${rp(o.total)}</strong>
          <div class="row">${actions}</div>
        </div>
      </div>`;
    })
    .join('');
}
function statusLabel(s) {
  return { pending: 'Menunggu', accepted: 'Diproses', completed: 'Selesai', cancelled: 'Dibatalkan' }[s] || s;
}
window.setOrder = async (id, status) => {
  try {
    await api(`/api/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    await loadOrders();
    toast(status === 'completed' ? 'Pesanan selesai, stok terpotong ✓' : 'Status diperbarui');
  } catch (e) {
    toast(e.message, true);
  }
};

// ================= LAPORAN =================
function todayStr() { return new Date().toISOString().slice(0, 10); }
$('#btnToday').onclick = () => { $('#repFrom').value = todayStr(); $('#repTo').value = todayStr(); runReport(); };
$('#btnReport').onclick = runReport;

$('#btnExportCsv').onclick = async () => {
  const from = $('#repFrom').value, to = $('#repTo').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const trx = await api('/api/transactions?' + qs.toString());
  if (!trx.length) return toast('Tidak ada transaksi di rentang ini', true);
  const head = ['Kode', 'Tanggal', 'Sumber', 'Metode', 'Pelanggan', 'Item', 'Subtotal', 'Diskon', 'Pajak', 'Total'];
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = trx.map((t) => {
    const items = JSON.parse(t.items).map((i) => `${i.name} x${i.qty}`).join('; ');
    return [t.code, new Date(t.created_at).toLocaleString('id-ID'), t.source, t.payment_method || 'Tunai', t.customer || 'Umum', items, t.subtotal, t.discount, t.tax, t.total].map(csvCell).join(',');
  });
  const csv = '﻿' + [head.map(csvCell).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `laporan-penjualan_${from || 'awal'}_sd_${to || 'akhir'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${trx.length} transaksi diexport ✓`);
};

async function runReport() {
  const from = $('#repFrom').value, to = $('#repTo').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const r = await api('/api/reports/summary?' + qs.toString());
  $('#stRevenue').textContent = rp(r.revenue);
  $('#stTx').textContent = r.txCount;
  $('#stItems').textContent = r.itemsSold;
  $('#stAvg').textContent = rp(r.avgTx);
  $('#bestTable').innerHTML =
    r.bestSellers.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.qty}</td><td>${rp(b.revenue)}</td></tr>`).join('') ||
    '<tr><td colspan="3" class="empty">Belum ada data</td></tr>';
  // source
  const tot = r.bySource.kasir + r.bySource.online || 1;
  $('#sourceChart').innerHTML = `
    ${barRow('Kasir', r.bySource.kasir, tot, '#2563eb')}
    ${barRow('Online', r.bySource.online, tot, '#16a34a')}`;
  // daily
  const max = Math.max(...r.dailySeries.map((d) => d.total), 1);
  $('#dailyChart').innerHTML =
    r.dailySeries.map((d) => barRow(d.date.slice(5), d.total, max, '#64748b')).join('') ||
    '<div class="empty">Belum ada data</div>';
}
function barRow(label, val, max, color) {
  const pct = Math.round((val / max) * 100);
  return `<div style="margin:8px 0">
    <div style="display:flex;justify-content:space-between;font-size:13px"><span>${label}</span><span>${rp(val)}</span></div>
    <div class="bar" style="width:${pct}%;background:${color};min-width:2px"></div>
  </div>`;
}

// ---------- util ----------
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- init ----------
loadPosProducts();
renderCart();
// auto-refresh online order badge every 15s while on POS
setInterval(async () => {
  try {
    const orders = await api('/api/orders');
    const pending = orders.filter((o) => o.status === 'pending' || o.status === 'accepted').length;
    $('#ordBadge').innerHTML = pending ? `<span class="badge pending">${pending}</span>` : '';
    if (!$('#tab-pesanan').hidden) loadOrders();
  } catch {}
}, 15000);
