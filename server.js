const express = require('express');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const API_KEY = '066ad9bf77875d28f26f955e8cc43b6a';
const GNEWS_BASE = 'https://gnews.io/api/v4';
const PORT = 3100;

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(__dirname, 'newsmatch.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT,
  edad INTEGER,
  genero TEXT,
  fecha_registro TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS preferencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER UNIQUE,
  tema TEXT DEFAULT 'oscuro',
  tamano_fuente TEXT DEFAULT 'normal',
  pais TEXT,
  idioma TEXT DEFAULT 'es',
  categorias_favoritas TEXT DEFAULT '[]',
  usar_gps INTEGER DEFAULT 1,
  fecha_actualizacion TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS seguimiento_uso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  fecha_hora TEXT DEFAULT (datetime('now','localtime')),
  accion TEXT,
  detalle TEXT,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  titulo TEXT,
  cuerpo TEXT,
  fecha_envio TEXT DEFAULT (datetime('now','localtime')),
  articulo_id TEXT,
  url TEXT,
  imagen_url TEXT,
  abierta INTEGER DEFAULT 0,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
CREATE TABLE IF NOT EXISTS favoritos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  articulo_url TEXT,
  titulo TEXT,
  imagen_url TEXT,
  fuente TEXT,
  fecha_guardado TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
`);

// ---------- Caché de respuestas GNews (para respetar el límite diario) ----------
const newsCache = new Map(); // key -> { time, data }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function cacheGet(key) {
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;
  newsCache.delete(key);
  return null;
}
function cacheSet(key, data) { newsCache.set(key, { time: Date.now(), data }); }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
async function gnewsFetch(endpoint, params) {
  params.apikey = API_KEY;
  const url = `${GNEWS_BASE}${endpoint}?${new URLSearchParams(params)}`;
  const cached = cacheGet(url);
  if (cached) return cached;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'GNews error');
  cacheSet(url, data);
  return data;
}

function track(usuario_id, accion, detalle) {
  try {
    db.prepare('INSERT INTO seguimiento_uso (usuario_id, accion, detalle) VALUES (?,?,?)')
      .run(usuario_id || null, accion, detalle || null);
  } catch (e) { console.error('track error', e.message); }
}

// ---------- Usuarios / registro ----------
app.post('/api/registro', (req, res) => {
  const { nombre, email, edad, genero, idioma, pais, categorias_favoritas, usar_gps } = req.body;
  if (!nombre || !edad) return res.status(400).json({ error: 'Nombre y edad son obligatorios' });
  const r = db.prepare('INSERT INTO usuarios (nombre,email,edad,genero) VALUES (?,?,?,?)')
    .run(nombre, email || null, edad, genero || 'no especifico');
  const usuario_id = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO preferencias (usuario_id, pais, idioma, categorias_favoritas, usar_gps)
              VALUES (?,?,?,?,?)`)
    .run(usuario_id, pais || null, idioma || 'es', JSON.stringify(categorias_favoritas || []), usar_gps ? 1 : 0);
  track(usuario_id, 'registro', `nombre=${nombre}; edad=${edad}; idioma=${idioma || 'es'}`);
  res.json({ usuario_id, nombre });
});

app.get('/api/usuarios/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'no encontrado' });
  const p = db.prepare('SELECT * FROM preferencias WHERE usuario_id=?').get(req.params.id);
  res.json({ usuario: u, preferencias: p });
});

app.put('/api/usuarios/:id/preferencias', (req, res) => {
  const { tema, tamano_fuente, pais, idioma, categorias_favoritas, usar_gps, edad, genero } = req.body;
  db.prepare(`UPDATE preferencias SET tema=COALESCE(?,tema), tamano_fuente=COALESCE(?,tamano_fuente),
    pais=?, idioma=COALESCE(?,idioma), categorias_favoritas=COALESCE(?,?), usar_gps=COALESCE(?,usar_gps),
    fecha_actualizacion=datetime('now','localtime') WHERE usuario_id=?`)
    .run(tema || null, tamano_fuente || null, pais || null, idioma || null,
      categorias_favoritas ? JSON.stringify(categorias_favoritas) : null,
      categorias_favoritas ? JSON.stringify(categorias_favoritas) : null,
      typeof usar_gps === 'boolean' ? (usar_gps ? 1 : 0) : null, req.params.id);
  if (edad || genero) {
    db.prepare('UPDATE usuarios SET edad=COALESCE(?,edad), genero=COALESCE(?,genero) WHERE id=?')
      .run(edad || null, genero || null, req.params.id);
  }
  track(req.params.id, 'cambio_de_filtro', JSON.stringify({ tema, tamano_fuente, pais, idioma, categorias_favoritas, edad, genero }));
  res.json({ ok: true });
});

// ---------- Seguimiento ----------
app.post('/api/seguimiento', (req, res) => {
  const { usuario_id, accion, detalle } = req.body;
  track(usuario_id, accion, typeof detalle === 'object' ? JSON.stringify(detalle) : detalle);
  res.json({ ok: true });
});
app.get('/api/seguimiento/:usuario_id', (req, res) => {
  const rows = db.prepare('SELECT * FROM seguimiento_uso WHERE usuario_id=? ORDER BY id DESC LIMIT 200').all(req.params.usuario_id);
  res.json(rows);
});

// ---------- GNews: top headlines y búsqueda (proxy con caché) ----------
app.get('/api/news/top', async (req, res) => {
  try {
    const { country, category, lang, usuario_id } = req.query;
    const params = { lang: lang || 'es', max: 10 };
    if (country) params.country = country;
    if (category) params.category = category;
    const data = await gnewsFetch('/top-headlines', params);
    if (usuario_id) track(usuario_id, 'apertura_app', `top-headlines country=${country} category=${category}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/news/search', async (req, res) => {
  try {
    const { q, country, lang, usuario_id } = req.query;
    if (!q) return res.status(400).json({ error: 'Falta q' });
    const params = { q, lang: lang || 'es', max: 10 };
    if (country) params.country = country;
    const data = await gnewsFetch('/search', params);
    if (usuario_id) track(usuario_id, 'busqueda_realizada', q);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Notificaciones ----------
app.get('/api/notificaciones/:usuario_id', (req, res) => {
  res.json(db.prepare('SELECT * FROM notificaciones_enviadas WHERE usuario_id=? ORDER BY id DESC LIMIT 100').all(req.params.usuario_id));
});
app.post('/api/notificaciones/:id/abierta', (req, res) => {
  db.prepare('UPDATE notificaciones_enviadas SET abierta=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Revisa titulares recientes y genera "alertas" que coincidan con las categorías del perfil
app.post('/api/notificaciones/revisar', async (req, res) => {
  try {
    const { usuario_id } = req.body;
    const pref = db.prepare('SELECT * FROM preferencias WHERE usuario_id=?').get(usuario_id);
    if (!pref) return res.status(404).json({ error: 'sin preferencias' });
    const cats = JSON.parse(pref.categorias_favoritas || '[]');
    const cat = cats[0] || 'general';
    const params = { lang: pref.idioma || 'es', max: 5 };
    if (pref.pais) params.country = pref.pais;
    if (cat !== 'general') params.category = cat;
    const data = await gnewsFetch('/top-headlines', params);
    const creadas = [];
    for (const art of (data.articles || [])) {
      db.prepare(`INSERT INTO notificaciones_enviadas (usuario_id,titulo,cuerpo,articulo_id,url,imagen_url)
                  VALUES (?,?,?,?,?,?)`)
        .run(usuario_id, '📰 ' + (art.title || '').slice(0, 120), (art.description || '').slice(0, 200),
          art.url, art.url, art.image);
      creadas.push(art.title);
    }
    res.json({ creadas: creadas.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Favoritos ----------
app.get('/api/favoritos/:usuario_id', (req, res) => {
  res.json(db.prepare('SELECT * FROM favoritos WHERE usuario_id=? ORDER BY id DESC').all(req.params.usuario_id));
});
app.post('/api/favoritos', (req, res) => {
  const { usuario_id, articulo_url, titulo, imagen_url, fuente } = req.body;
  db.prepare('INSERT INTO favoritos (usuario_id,articulo_url,titulo,imagen_url,fuente) VALUES (?,?,?,?,?)')
    .run(usuario_id, articulo_url, titulo, imagen_url || null, fuente || null);
  res.json({ ok: true });
});
app.delete('/api/favoritos/:id', (req, res) => {
  db.prepare('DELETE FROM favoritos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`NewsMatch corriendo en http://localhost:${PORT}`));
