# 🛒 TokoKasir — POS + Pemesanan Online Terintegrasi

Sistem kasir (POS) untuk toko retail **plus** halaman pemesanan online untuk pelanggan.
Keduanya berbagi **satu database** — stok, produk, dan penjualan selalu sinkron.

Dibangun **tanpa dependency eksternal**: hanya Node.js bawaan (`http` + `node:sqlite`).
Tidak perlu `npm install`.

## Fitur

**Kasir & Admin** (`/pos.html`)
- 🧾 **Transaksi kasir** — pilih produk, keranjang, diskon/pajak, hitung kembalian, cetak struk
- 📦 **Manajemen produk & stok** — tambah/edit/hapus produk, indikator stok menipis, stok terpotong otomatis
- 📥 **Pesanan online masuk** — terima / tolak / selesaikan; saat selesai stok terpotong & tercatat sebagai penjualan
- 📊 **Laporan penjualan** — omzet, jumlah transaksi, item terjual, produk terlaris, omzet harian, per sumber (kasir vs online)

**Toko Online** (`/shop.html`)
- 📱 Katalog produk untuk pelanggan, keranjang, kirim pesanan (nama, HP, catatan)
- Pesanan langsung muncul di dashboard kasir

## Cara Menjalankan

Butuh **Node.js 24** (disarankan — untuk `node:sqlite` tanpa flag). Cek: `node -v`.
Di Node 22.5–23 masih bisa, tapi jalankan dengan `node --experimental-sqlite server.js`.

```bash
cd pos-retail
node server.js
```

Lalu buka di browser:

| Halaman | URL |
|---|---|
| Beranda | http://localhost:3000/ |
| Kasir / Admin | http://localhost:3000/pos.html |
| Toko Online | http://localhost:3000/shop.html |

Database otomatis dibuat di `data/toko.db` (dengan 10 produk contoh saat pertama jalan).
Ganti port dengan `PORT=8080 node server.js`.

## Alur Integrasi

```
Pelanggan (shop.html) ── buat pesanan ──► [orders: pending]
                                                │
Kasir (pos.html) ── Terima ──► [accepted] ── Selesaikan ──► potong stok
                                                │                │
                                                └──► [transactions] ◄── kasir langsung
                                                          │
                                                    Laporan penjualan
```

Stok dipakai bersama: penjualan di kasir maupun penyelesaian pesanan online sama-sama memotong stok dari tabel `products` yang sama.

## Struktur

```
pos-retail/
├── server.js          # backend: HTTP server + REST API + SQLite
├── package.json
├── data/toko.db       # database (auto-generate, di-gitignore)
└── public/
    ├── index.html     # beranda
    ├── pos.html       # kasir & admin (4 tab)
    ├── pos.js
    ├── shop.html      # toko online pelanggan
    └── styles.css
```

## Deploy Online

Karena ada backend Node, aplikasi ini **tidak bisa** di GitHub Pages. Pakai host yang menjalankan Node (butuh **Node 24** untuk `node:sqlite`). Repo sudah menyertakan `Dockerfile`, `render.yaml`, dan `Procfile`.

**Render.com (gratis, paling gampang):**
1. Push repo ini ke GitHub.
2. Buka [render.com](https://render.com) → **New** → **Blueprint** → pilih repo ini (otomatis baca `render.yaml`).
3. Deploy. Selesai — dapat URL publik.

**Railway.app:** New Project → Deploy from GitHub → pilih repo. Railway auto-detect `Procfile`. Set env `NODE_VERSION=24` bila perlu.

**Docker (VPS sendiri):**
```bash
docker build -t tokokasir .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data tokokasir
```

> ⚠️ Plan gratis biasanya pakai penyimpanan *ephemeral* — file `data/toko.db` bisa ter-reset saat re-deploy. Untuk data permanen: pasang persistent disk (mount ke `/app/data`) atau pindah ke database eksternal.

## API (ringkas)

| Method | Endpoint | Fungsi |
|---|---|---|
| GET | `/api/products` | daftar produk |
| POST/PUT/DELETE | `/api/products[/:id]` | kelola produk & stok |
| POST | `/api/transactions` | transaksi kasir (potong stok) |
| GET | `/api/transactions` | riwayat transaksi |
| POST | `/api/orders` | buat pesanan online |
| GET | `/api/orders` | daftar pesanan |
| PUT | `/api/orders/:id/status` | ubah status (selesai → potong stok) |
| GET | `/api/reports/summary?from=&to=` | ringkasan laporan |
