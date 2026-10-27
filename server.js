import express from 'express';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';

const db = new Database(process.env.DB_PATH || 'data.db');
db.pragma('journal_mode = WAL');
db.exec(`
create table if not exists tours(id text primary key, title text, created int);
create table if not exists scenes(id text primary key, tour_id text, name text, status text, error text, hotspots text default '[]', pos int);
create table if not exists blobs(scene_id text, kind text, data blob, primary key(scene_id, kind));
create table if not exists jobs(id integer primary key autoincrement, scene_id text, state text default 'queued', tries int default 0);
update jobs set state='queued' where state='running';`);

// Storage layer: swap these 3 functions for S3 (PutObject/GetObject/DeleteObject) when you outgrow the DB.
const store = {
  put: (sid, kind, data) => db.prepare('insert or replace into blobs values(?,?,?)').run(sid, kind, data),
  get: (sid, kind) => db.prepare('select data from blobs where scene_id=? and kind=?').get(sid, kind)?.data,
  del: (sid) => db.prepare('delete from blobs where scene_id=?').run(sid),
};
const uid = () => crypto.randomBytes(6).toString('hex');
const scene = (s) => ({
  id: s.id, name: s.name, status: s.status, error: s.error, hotspots: JSON.parse(s.hotspots),
  widths: db.prepare("select kind from blobs where scene_id=? and kind like 'w%'").all(s.id).map((b) => +b.kind.slice(1)).sort((a, b) => a - b),
});

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));
app.get('/t/:id', (_q, r) => r.sendFile(path.resolve('public/index.html')));   // public share/embed page

app.get('/api/tours', (_q, r) => r.json(db.prepare('select t.*, (select count(*) from scenes where tour_id=t.id) n from tours t order by created desc').all()));
app.post('/api/tours', (q, r) => {
  const t = { id: uid(), title: String(q.body.title || 'Untitled').slice(0, 80) };
  db.prepare('insert into tours values(?,?,?)').run(t.id, t.title, Date.now());
  r.json(t);
});
app.get('/api/tours/:id', (q, r) => {
  const t = db.prepare('select * from tours where id=?').get(q.params.id);
  if (!t) return r.sendStatus(404);
  r.json({ ...t, scenes: db.prepare('select * from scenes where tour_id=? order by pos').all(t.id).map(scene) });
});
app.delete('/api/tours/:id', (q, r) => {
  for (const s of db.prepare('select id from scenes where tour_id=?').all(q.params.id)) delScene(s.id);
  db.prepare('delete from tours where id=?').run(q.params.id);
  r.sendStatus(204);
});

function delScene(id) {
  store.del(id);
  db.prepare('delete from scenes where id=?').run(id);
  db.prepare('delete from jobs where scene_id=?').run(id);
}

// Upload: raw image body -> original saved -> job queued -> worker processes it.
app.put('/api/tours/:id/scenes', express.raw({ type: 'image/*', limit: '100mb' }), (q, r) => {
  if (!db.prepare('select 1 from tours where id=?').get(q.params.id)) return r.sendStatus(404);
  if (!Buffer.isBuffer(q.body) || !q.body.length) return r.status(400).json({ error: 'Send an image file' });
  const id = uid();
  const pos = db.prepare('select count(*) n from scenes where tour_id=?').get(q.params.id).n;
  db.transaction(() => {
    db.prepare("insert into scenes(id,tour_id,name,status,pos) values(?,?,?,'queued',?)").run(id, q.params.id, String(q.query.name || 'Scene').slice(0, 60), pos);
    store.put(id, 'original', q.body);
    db.prepare('insert into jobs(scene_id) values(?)').run(id);
  })();
  r.status(202).json({ id });
});
app.put('/api/scenes/:id/hotspots', (q, r) => {
  const h = (Array.isArray(q.body) ? q.body : []).filter((x) => [x.lon, x.lat].every(Number.isFinite) && typeof x.to === 'string').slice(0, 50);
  db.prepare('update scenes set hotspots=? where id=?').run(JSON.stringify(h), q.params.id);
  r.sendStatus(204);
});
app.delete('/api/scenes/:id', (q, r) => { delScene(q.params.id); r.sendStatus(204); });

app.get('/img/:sid/:kind', (q, r) => {
  if (!/^(w\d+|thumb)$/.test(q.params.kind)) return r.sendStatus(404);
  const d = store.get(q.params.sid, q.params.kind);
  if (!d) return r.sendStatus(404);
  r.set({ 'Content-Type': q.params.kind === 'thumb' ? 'image/jpeg' : 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' }).send(d);
});

// Queue worker: one job at a time, 3 tries, bad images fail immediately.
let busy = false;
async function tick() {
  if (busy) return;
  const j = db.prepare("select * from jobs where state='queued' limit 1").get();
  if (!j) return;
  busy = true;
  db.prepare("update jobs set state='running', tries=tries+1 where id=?").run(j.id);
  db.prepare("update scenes set status='processing' where id=?").run(j.scene_id);
  try {
    const src = store.get(j.scene_id, 'original');
    let m;
    try { m = await sharp(src).metadata(); } catch { throw Object.assign(new Error('Not a readable image'), { perm: 1 }); }
    const ratio = m.width / m.height;
    if (ratio < 1.9 || ratio > 2.1) throw Object.assign(new Error('Not a 360° photo: image must be 2:1'), { perm: 1 });
    for (const w of [1024, 2048, 4096, 8192].filter((w) => w <= m.width))
      store.put(j.scene_id, 'w' + w, await sharp(src).resize({ width: w }).webp({ quality: 80 }).toBuffer());
    store.put(j.scene_id, 'thumb', await sharp(src).resize({ width: 320 }).jpeg({ quality: 70 }).toBuffer());
    db.prepare("update scenes set status='ready', error=null where id=?").run(j.scene_id);
    db.prepare("update jobs set state='done' where id=?").run(j.id);
  } catch (e) {
    const fail = e.perm || j.tries + 1 >= 3;
    db.prepare('update jobs set state=? where id=?').run(fail ? 'failed' : 'queued', j.id);
    if (fail) db.prepare("update scenes set status='failed', error=? where id=?").run(e.perm ? e.message : 'Processing failed', j.scene_id);
    console.error(e);
  }
  busy = false;
}
setInterval(tick, 1000);
app.listen(process.env.PORT || 3000, () => console.log('Running on http://localhost:' + (process.env.PORT || 3000)));
