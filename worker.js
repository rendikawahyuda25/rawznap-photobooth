// RAWZNAP Photobooth - penghitung pengguna (Cloudflare Worker + D1)
// Binding D1 bernama DB, secret bernama ADMIN_KEY.
const AMBANG = 1000; // angka publik baru tampil kalau sudah segini orang selesai berfoto
const EVENT = ["kunjungan", "sesi", "unduh_foto", "unduh_gif", "ig"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

async function siapkan(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS stat (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS harian (hari TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hari, k))"),
  ]);
}
const up = (db, tbl, ...a) =>
  tbl === "stat"
    ? db.prepare("INSERT INTO stat (k,n) VALUES (?,1) ON CONFLICT(k) DO UPDATE SET n=n+1").bind(...a)
    : db.prepare("INSERT INTO harian (hari,k,n) VALUES (?,?,1) ON CONFLICT(hari,k) DO UPDATE SET n=n+1").bind(...a);

function sama(a, b) { // perbandingan kunci tanpa bocor waktu
  if (typeof a !== "string" || typeof b !== "string" || b.length < 8 || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      await siapkan(env.DB);

      // ---- catat kejadian (dipanggil website) ----
      if (u.pathname === "/hit" && req.method === "POST") {
        const e = u.searchParams.get("e");
        if (!EVENT.includes(e)) return json({ ok: false }, 400);
        let f = (u.searchParams.get("f") || "").slice(0, 40).replace(/[^\w \-]/g, "");
        const hari = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // hari WIB
        const q = [up(env.DB, "stat", e), up(env.DB, "harian", hari, e)];
        if (e === "sesi" && f) q.push(up(env.DB, "stat", "frame:" + f));
        await env.DB.batch(q);
        return json({ ok: true });
      }

      // ---- angka publik: HANYA keluar kalau sudah >= AMBANG ----
      if (u.pathname === "/publik") {
        const r = await env.DB.prepare("SELECT n FROM stat WHERE k='sesi'").first();
        const n = r ? r.n : 0;
        return n >= AMBANG ? json({ tampil: true, jumlah: n }) : json({ tampil: false });
      }

      // ---- dashboard pribadi (butuh kunci rahasia) ----
      if (u.pathname === "/admin") {
        if (!sama(u.searchParams.get("key") || "", env.ADMIN_KEY || "")) return json({ error: "ditolak" }, 401);
        const total = (await env.DB.prepare("SELECT k,n FROM stat ORDER BY k").all()).results;
        const harian = (await env.DB.prepare("SELECT hari,k,n FROM harian ORDER BY hari DESC LIMIT 400").all()).results;
        const t = {}, frame = {};
        total.forEach((x) => (x.k.startsWith("frame:") ? (frame[x.k.slice(6)] = x.n) : (t[x.k] = x.n)));
        const per = {};
        harian.forEach((x) => ((per[x.hari] = per[x.hari] || {})[x.k] = x.n));
        const data = { total: t, frame_favorit: frame, per_hari: per, ambang_publik: AMBANG };
        if (u.searchParams.get("format") === "json") return json(data);
        const nm = { kunjungan: "Kunjungan", sesi: "Orang selesai berfoto", unduh_foto: "Unduh foto", unduh_gif: "Unduh GIF", ig: "Klik Instagram" };
        const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
        const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Statistik RAWZNAP</title>
<style>body{font:16px system-ui;background:#0f2a1f;color:#fff;margin:0;padding:20px;max-width:640px;margin:auto}h1{font-size:20px}h2{font-size:16px;margin-top:28px;color:#e8c872}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}.k{background:#ffffff14;border-radius:12px;padding:14px}.k b{display:block;font-size:28px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid #ffffff22;text-align:left;font-size:14px}</style>
<h1>Statistik Photobooth Natal</h1><div class=g>${EVENT.map((e) => `<div class=k>${h(nm[e])}<b>${t[e] || 0}</b></div>`).join("")}</div>
<p>Angka publik tampil di website setelah <b>${AMBANG}</b> orang selesai berfoto. Saat ini: <b>${t.sesi || 0}</b>.</p>
<h2>Frame favorit</h2><table>${Object.entries(frame).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${h(k)}</td><td>${n}</td></tr>`).join("") || "<tr><td>belum ada</td></tr>"}</table>
<h2>Per hari</h2><table><tr><th>Tanggal</th><th>Kunj.</th><th>Foto</th><th>Unduh</th><th>IG</th></tr>${Object.keys(per).sort().reverse().map((d) => { const p = per[d]; return `<tr><td>${h(d)}</td><td>${p.kunjungan || 0}</td><td>${p.sesi || 0}</td><td>${(p.unduh_foto || 0) + (p.unduh_gif || 0)}</td><td>${p.ig || 0}</td></tr>`; }).join("")}</table>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
      }
      return json({ ok: true, nama: "rawznap-counter" });
    } catch (err) {
      return json({ ok: false }, 500);
    }
  },
};
