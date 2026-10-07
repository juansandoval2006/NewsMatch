// ================= Estado local =================
const CATS = { general:'General', world:'Mundo', nation:'Nación', business:'Negocios', technology:'Tecnología', entertainment:'Entretenimiento', sports:'Deportes', science:'Ciencia', health:'Salud' };
const state = {
  usuarioId: JSON.parse(localStorage.getItem('usuario_id') || 'null'),
  perfil: JSON.parse(localStorage.getItem('perfil_local') || 'null'),
  interfaz: JSON.parse(localStorage.getItem('preferencias_interfaz_local') || '{"tema":"oscuro","tamano_fuente":"normal"}'),
  sesion: JSON.parse(localStorage.getItem('sesion_actual') || 'null'),
  catActual: 'general',
};
function guardarLocal() {
  localStorage.setItem('usuario_id', JSON.stringify(state.usuarioId));
  localStorage.setItem('perfil_local', JSON.stringify(state.perfil));
  localStorage.setItem('preferencias_interfaz_local', JSON.stringify(state.interfaz));
  localStorage.setItem('sesion_actual', JSON.stringify(state.sesion));
}
function aplicarInterfaz() {
  document.body.className = (state.interfaz.tema === 'oscuro' ? 'tema-oscuro ' : '') + (state.interfaz.tamano_fuente === 'grande' ? 'fuente-grande' : '');
}
function api(path, opts={}) {
  return fetch(path, { headers: {'Content-Type':'application/json'}, ...opts }).then(r => r.json());
}
function track(accion, detalle) {
  if (state.usuarioId) api('/api/seguimiento', { method:'POST', body: JSON.stringify({ usuario_id: state.usuarioId, accion, detalle }) });
}
function mostrar(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ================= GPS / país =================
async function detectarPais() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.coords.latitude}&longitude=${pos.coords.longitude}&localityLanguage=es`);
        const d = await r.json();
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, pais: (d.countryCode || '').toLowerCase(), paisNombre: d.countryName });
      } catch { resolve(null); }
    }, () => resolve(null), { timeout: 8000 });
  });
}

// ================= Categorías sugeridas =================
function sugerirCategorias(edad, genero) {
  let cats;
  if (edad < 25) cats = ['technology', 'entertainment', 'sports'];
  else if (edad <= 45) cats = ['business', 'technology', 'world'];
  else cats = ['health', 'science', 'world'];
  if (genero === 'femenino' && !cats.includes('health')) cats.push('health');
  return cats.slice(0, 4);
}

// ================= Feed / caché =================
async function cargarFeed(category) {
  state.catActual = category;
  const p = state.perfil || {};
  const params = new URLSearchParams({ lang: p.idioma || 'es', usuario_id: state.usuarioId });
  if (p.usar_gps && state.sesion?.pais_detectado) params.set('country', state.sesion.pais_detectado);
  else if (p.pais) params.set('country', p.pais);
  if (category && category !== 'general') params.set('category', category);
  try {
    const data = await api(`/api/news/top?${params}`);
    if (data.error) throw new Error(data.error);
    state.perfil.ultimoFeed = data.articles || [];
    localStorage.setItem('articulos_cache', JSON.stringify(data.articles || []));
    guardarLocal();
    renderFeed(data.articles || []);
  } catch (e) {
    const cache = JSON.parse(localStorage.getItem('articulos_cache') || '[]');
    document.getElementById('feed').innerHTML = '<p>📡 Sin conexión: mostrando caché local.</p>' + '';
    renderFeed(cache);
  }
}
function renderFeed(articles) {
  const feed = document.getElementById('feed');
  feed.innerHTML = '';
  if (!articles.length) feed.innerHTML = '<p>No hay noticias.</p>';
  articles.forEach(a => {
    const div = document.createElement('div');
    div.className = 'noticia';
    div.innerHTML = `${a.image ? `<img src="${a.image}" onerror="this.remove()">` : ''}
      <h3>${a.title || ''}</h3><p>${a.description || ''}</p>
      <p class="meta">${a.source?.name || ''} · ${a.publishedAt ? new Date(a.publishedAt).toLocaleString('es') : ''}</p>
      <button data-url="${encodeURIComponent(a.url)}">Leer</button>
      <button data-fav="${encodeURIComponent(JSON.stringify({url:a.url,title:a.title,image:a.image,source:a.source?.name}))}">⭐</button>`;
    div.querySelector('[data-url]').onclick = () => abrirDetalle(a);
    div.querySelector('[data-fav]').onclick = () => {
      api('/api/favoritos', { method:'POST', body: JSON.stringify({ usuario_id: state.usuarioId, articulo_url: a.url, titulo: a.title, imagen_url: a.image, fuente: a.source?.name }) });
      alert('Guardado en favoritos');
    };
    feed.appendChild(div);
  });
}
function renderChips() {
  const cont = document.getElementById('cat-chips');
  cont.innerHTML = '';
  (state.perfil?.categorias || Object.keys(CATS)).forEach(c => {
    const b = document.createElement('button');
    b.textContent = CATS[c] || c;
    if (c === state.catActual) b.className = 'activo';
    b.onclick = () => { track('cambio_de_filtro', `categoria=${c}`); cargarFeed(c); renderChips(); };
    cont.appendChild(b);
  });
}
let artActuales = [];
function abrirDetalle(a) {
  track('apertura_de_una_noticia', a.title);
  document.getElementById('detalle-contenido').innerHTML = `
    ${a.image ? `<img src="${a.image}">` : ''}<h2>${a.title}</h2>
    <p class="meta">${a.source?.name || ''} · ${a.publishedAt ? new Date(a.publishedAt).toLocaleString('es') : ''}</p>
    <p>${a.description || ''}</p>
    <p>${a.content || ''}</p>
    <a href="${a.url}" target="_blank"><button>Leer noticia completa</button></a>`;
  mostrar('screen-detalle');
}

// ================= Búsqueda =================
let tSearch;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(tSearch);
  tSearch = setTimeout(async () => {
    const q = e.target.value.trim();
    if (!q) return cargarFeed(state.catActual);
    track('busqueda_realizada', q);
    const p = state.perfil || {};
    const params = new URLSearchParams({ q, lang: p.idioma || 'es', usuario_id: state.usuarioId });
    if (p.usar_gps && state.sesion?.pais_detectado) params.set('country', state.sesion.pais_detectado);
    else if (p.pais) params.set('country', p.pais);
    const data = await api(`/api/news/search?${params}`);
    renderFeed(data.articles || []);
  }, 600);
});

// ================= Flujo inicial =================
document.getElementById('btn-start').onclick = async () => {
  track('apertura_de_la_app', 'splash');
  const geo = await detectarPais();
  state.sesion = { usuario_id: state.usuarioId, latitud: geo?.lat, longitud: geo?.lon, pais_detectado: geo?.pais, fecha_inicio_sesion: new Date().toISOString() };
  guardarLocal();
  if (state.usuarioId && state.perfil) { iniciarHome(); }
  else mostrar('screen-registro');
};

document.getElementById('btn-registro').onclick = async () => {
  const nombre = document.getElementById('reg-nombre').value.trim();
  const edad = parseInt(document.getElementById('reg-edad').value);
  if (!nombre || !edad) return alert('Nombre y edad son obligatorios');
  const genero = document.getElementById('reg-genero').value;
  const idioma = document.getElementById('reg-idioma').value;
  const res = await api('/api/registro', { method:'POST', body: JSON.stringify({ nombre, email: document.getElementById('reg-email').value, edad, genero, idioma, pais: state.sesion?.pais_detectado, usar_gps: true, categorias_favoritas: sugerirCategorias(edad, genero) }) });
  state.usuarioId = res.usuario_id;
  state.perfil = { edad, genero, idioma, categorias: sugerirCategorias(edad, genero), pais: state.sesion?.pais_detectado, usar_gps: true };
  state.sesion.usuario_id = res.usuario_id;
  guardarLocal();
  track('registro', nombre);
  renderOnboarding();
  mostrar('screen-onboarding');
};
function renderOnboarding() {
  const cont = document.getElementById('onboarding-cats');
  cont.innerHTML = '';
  Object.entries(CATS).forEach(([k, v]) => {
    const on = state.perfil.categorias.includes(k);
    cont.innerHTML += `<label><input type="checkbox" value="${k}" ${on ? 'checked' : ''}> ${v}</label>`;
  });
}
document.getElementById('btn-empezar').onclick = async () => {
  state.perfil.categorias = [...document.querySelectorAll('#onboarding-cats input:checked')].map(i => i.value);
  guardarLocal();
  await api(`/api/usuarios/${state.usuarioId}/preferencias`, { method:'PUT', body: JSON.stringify({ pais: state.perfil.pais, idioma: state.perfil.idioma, categorias_favoritas: state.perfil.categorias, usar_gps: state.perfil.usar_gps, tema: state.interfaz.tema, tamano_fuente: state.interfaz.tamano_fuente }) });
  iniciarHome();
};
function iniciarHome() {
  aplicarInterfaz();
  const loc = document.getElementById('ubicacion-info');
  loc.innerHTML = `📍 ${state.perfil?.usar_gps ? (state.sesion?.pais_detectado || '¿?').toUpperCase() : (state.perfil?.pais || '').toUpperCase()}
    <button id="btn-cambiar-pais">Cambiar país</button>`;
  document.getElementById('btn-cambiar-pais').onclick = () => mostrar('screen-config');
  renderChips();
  cargarFeed(state.perfil?.categorias?.[0] || 'general');
  track('apertura_de_la_app', 'home');
  mostrar('screen-home');
}

// ================= Configuración =================
document.getElementById('btn-config').onclick = () => {
  document.getElementById('cfg-edad').value = state.perfil?.edad || '';
  document.getElementById('cfg-genero').value = state.perfil?.genero || 'no especifico';
  document.getElementById('cfg-tema').value = state.interfaz.tema;
  document.getElementById('cfg-fuente').value = state.interfaz.tamano_fuente;
  document.getElementById('cfg-usar-gps').checked = !!state.perfil?.usar_gps;
  document.getElementById('cfg-pais').value = state.perfil?.pais || '';
  document.getElementById('cfg-idioma').value = state.perfil?.idioma || 'es';
  const cont = document.getElementById('cfg-cats');
  cont.innerHTML = '';
  Object.entries(CATS).forEach(([k, v]) => {
    cont.innerHTML += `<label><input type="checkbox" value="${k}" ${state.perfil?.categorias?.includes(k) ? 'checked' : ''}> ${v}</label>`;
  });
  mostrar('screen-config');
};
document.getElementById('btn-config-volver').onclick = () => mostrar('screen-home');
document.getElementById('btn-guardar').onclick = async () => {
  state.perfil.edad = parseInt(document.getElementById('cfg-edad').value);
  state.perfil.genero = document.getElementById('cfg-genero').value;
  state.interfaz.tema = document.getElementById('cfg-tema').value;
  state.interfaz.tamano_fuente = document.getElementById('cfg-fuente').value;
  state.perfil.usar_gps = document.getElementById('cfg-usar-gps').checked;
  state.perfil.pais = document.getElementById('cfg-pais').value.toLowerCase();
  state.perfil.idioma = document.getElementById('cfg-idioma').value;
  state.perfil.categorias = [...document.querySelectorAll('#cfg-cats input:checked')].map(i => i.value);
  guardarLocal();
  aplicarInterfaz();
  await api(`/api/usuarios/${state.usuarioId}/preferencias`, { method:'PUT', body: JSON.stringify({ tema: state.interfaz.tema, tamano_fuente: state.interfaz.tamano_fuente, pais: state.perfil.pais, idioma: state.perfil.idioma, categorias_favoritas: state.perfil.categorias, usar_gps: state.perfil.usar_gps, edad: state.perfil.edad, genero: state.perfil.genero }) });
  track('cambio_de_filtro', 'configuración guardada');
  alert('Guardado');
  iniciarHome();
};
document.getElementById('btn-ver-tracking').onclick = async () => {
  const rows = await api(`/api/seguimiento/${state.usuarioId}`);
  document.getElementById('tracking-log').textContent = rows.map(r => `${r.fecha_hora} | ${r.accion} | ${r.detalle || ''}`).join('\n');
};

// ================= Notificaciones =================
document.getElementById('btn-nav-notif').onclick = async () => {
  await cargarNotifs();
  mostrar('screen-notif');
};
async function cargarNotifs() {
  const rows = await api(`/api/notificaciones/${state.usuarioId}`);
  document.getElementById('notif-lista').innerHTML = rows.map(n => `
    <div class="notif ${n.abierta ? 'abierta' : ''}">
      <strong>${n.titulo}</strong><p>${n.cuerpo}</p>
      <small>${n.fecha_envio} ${n.abierta ? '· abierta' : ''}</small><br>
      <button data-id="${n.id}" data-url="${encodeURIComponent(n.url || '')}">Abrir</button>
    </div>`).join('') || '<p>Sin notificaciones.</p>';
  document.querySelectorAll('#notif-lista button[data-id]').forEach(b => b.onclick = async () => {
    await api(`/api/notificaciones/${b.dataset.id}/abierta`, { method:'POST' });
    track('apertura_de_una_notificacion', b.dataset.url);
    if (b.dataset.url) window.open(decodeURIComponent(b.dataset.url), '_blank');
    cargarNotifs();
  });
}
document.getElementById('btn-revisar-notif').onclick = async () => {
  const r = await api('/api/notificaciones/revisar', { method:'POST', body: JSON.stringify({ usuario_id: state.usuarioId }) });
  alert(`${r.creadas || 0} alertas nuevas`);
  cargarNotifs();
};
document.getElementById('btn-notif-volver').onclick = () => mostrar('screen-home');

// ================= Favoritos =================
document.getElementById('btn-nav-fav').onclick = async () => {
  const rows = await api(`/api/favoritos/${state.usuarioId}`);
  document.getElementById('fav-lista').innerHTML = rows.map(f => `
    <div class="noticia">${f.imagen_url ? `<img src="${f.imagen_url}">` : ''}<h3>${f.titulo}</h3><small>${f.fuente} · ${f.fecha_guardado}</small><br>
    <a href="${f.articulo_url}" target="_blank"><button>Leer</button></a>
    <button data-del="${f.id}">Eliminar</button></div>`).join('') || '<p>Sin favoritos.</p>';
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/api/favoritos/${b.dataset.del}`, { method:'DELETE' }); document.getElementById('btn-nav-fav').click(); });
  mostrar('screen-fav');
};
document.getElementById('btn-fav-volver').onclick = () => mostrar('screen-home');

document.getElementById('btn-volver').onclick = () => mostrar('screen-home');
document.getElementById('btn-nav-home').onclick = () => iniciarHome();

aplicarInterfaz();
