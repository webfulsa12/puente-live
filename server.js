// ============================================================
// PUENTE LIVE — Servidor de traducción en tiempo real
// Arquitectura B3: cada celular escucha en SU idioma,
// el servidor traduce y reenvía texto a los demás.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Códigos de acceso (candado para CREAR salas) ----------
// Pensado para el modelo de alquiler: cada cliente (hotel, operador, parroquia)
// recibe un código propio, válido por las horas de su alquiler. Vive en memoria:
// se reinicia si el servidor se reinicia (ver README sobre el plan gratuito de Render).
// El candado solo se activa cuando defines ADMIN_KEY en el servidor — mientras no
// exista, "crear sala" funciona libre, igual que hasta ahora.
const accessCodes = new Map(); // code -> {label, createdAt, expiresAt, maxUses, uses}
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function genAccessCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = 'COD-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return accessCodes.has(c) ? genAccessCode() : c;
}

function validateAccessCode(code) {
  const d = accessCodes.get(code);
  if (!d) return 'Código de acceso inválido.';
  if (d.expiresAt && Date.now() > d.expiresAt) return 'Este código de acceso ya venció.';
  if (d.maxUses && d.uses >= d.maxUses) return 'Este código alcanzó su límite de usos.';
  return null;
}

function checkAdmin(req, res) {
  if (!ADMIN_KEY) { res.status(503).json({ error: 'Configura ADMIN_KEY en el servidor para activar el panel.' }); return false; }
  if (req.headers['x-admin-key'] !== ADMIN_KEY) { res.status(401).json({ error: 'Clave de administrador incorrecta.' }); return false; }
  return true;
}

// Lista de códigos (activos y vencidos, para que Pedro vea el historial)
app.get('/admin/api/codes', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const list = [...accessCodes.entries()]
    .map(([code, d]) => ({ code, ...d, expired: d.expiresAt ? Date.now() > d.expiresAt : false }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ codes: list, lockEnabled: true });
});

// Genera un código nuevo: label identifica al cliente, hours es su ventana de alquiler
app.post('/admin/api/codes', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { label, hours, maxUses } = req.body || {};
  const h = Number(hours) > 0 ? Number(hours) : 24;
  const code = genAccessCode();
  accessCodes.set(code, {
    label: String(label || 'Sin nombre').slice(0, 60),
    createdAt: Date.now(),
    expiresAt: Date.now() + h * 60 * 60 * 1000,
    maxUses: (maxUses && Number(maxUses) > 0) ? Number(maxUses) : null,
    uses: 0
  });
  res.json({ code });
});

app.delete('/admin/api/codes/:code', (req, res) => {
  if (!checkAdmin(req, res)) return;
  accessCodes.delete(req.params.code);
  res.json({ ok: true });
});

// ---------- Salas ----------
// rooms: código -> Set de clientes (ws). Cada ws lleva ws.meta = {id, room, lang, name}
const rooms = new Map();
const emptyTimers = new Map(); // salas vacías en periodo de gracia antes de eliminarse
const GRACE_MS = 10 * 60 * 1000; // 10 minutos
const MAX_ROOM_SIZE = 2; // conversación 1 a 1. Súbelo si más adelante quieres tours grupales.
let nextId = 1;

function keepRoomAlive(code) {
  // Cancela la eliminación pendiente si alguien vuelve a entrar
  if (emptyTimers.has(code)) {
    clearTimeout(emptyTimers.get(code));
    emptyTimers.delete(code);
  }
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin letras/números confusos
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? genCode() : c;
}

function membersOf(code) {
  const set = rooms.get(code);
  if (!set) return [];
  return [...set].map(ws => ({ id: ws.meta.id, name: ws.meta.name, lang: ws.meta.lang }));
}

function broadcast(code, payload, exceptWs = null) {
  const set = rooms.get(code);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const client of set) {
    if (client !== exceptWs && client.readyState === 1) client.send(msg);
  }
}

// ---------- Traducción (MyMemory: gratuita, sin clave) ----------
// NOTA ESTRATÉGICA: esta función es el único punto a reemplazar cuando
// pasemos a la API de Claude + glosario cultural. Todo lo demás queda igual.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

const cache = new Map(); // clave: from|to|texto -> traducción (evita llamadas repetidas)

async function translate(text, from, to) {
  if (from === to) return text;
  const key = from + '|' + to + '|' + text;
  if (cache.has(key)) return cache.get(key);
  const url = 'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) + '&langpair=' + from + '|' + to;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const out = decodeEntities((data?.responseData?.translatedText || '').trim());
  if (!out) throw new Error('sin resultado');
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}

// Traduce un texto a todos los idiomas distintos presentes en la sala (una sola vez por idioma)
async function translateForRoom(code, text, fromLang) {
  const langs = new Set(membersOf(code).map(m => m.lang));
  langs.delete(fromLang);
  const result = {};
  await Promise.all([...langs].map(async l => {
    try { result[l] = await translate(text, fromLang, l); } catch (_) { /* preview fallida: se ignora */ }
  }));
  return result;
}

// ---------- Protocolo WebSocket ----------
wss.on('connection', (ws) => {
  ws.lastSeen = Date.now(); // se actualiza con cada mensaje real que llega del celular
  ws.meta = { id: nextId++, room: null, lang: 'es', name: '', clientId: '', lastInterim: 0 };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    ws.lastSeen = Date.now();
    const m = ws.meta;

    // Latido de aplicación: el celular avisa "aquí sigo" cada 15s. No hace nada
    // más que mantener lastSeen al día (ya se actualizó arriba).
    if (msg.t === 'ping') return;

    // Crear sala
    if (msg.t === 'create') {
      if (ADMIN_KEY) { // el candado solo se activa cuando tú lo enciendes con ADMIN_KEY
        const accessCode = String(msg.accessCode || '').toUpperCase().trim();
        const err = validateAccessCode(accessCode);
        if (err) { ws.send(JSON.stringify({ t: 'error', msg: err })); return; }
        accessCodes.get(accessCode).uses++;
      }
      const code = genCode();
      m.lang = String(msg.lang || 'es').slice(0, 2);
      m.name = String(msg.name || '').slice(0, 30);
      m.clientId = String(msg.clientId || '').slice(0, 64);
      m.room = code;
      rooms.set(code, new Set([ws]));
      ws.send(JSON.stringify({ t: 'joined', code, you: m.id, members: membersOf(code) }));
      return;
    }

    // Unirse a sala (si no existe, se crea con ese mismo código:
    // así una sala expirada revive y no importa quién llega primero)
    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      if (code.length !== 4) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Código de sala inválido.' }));
        return;
      }
      keepRoomAlive(code);
      if (!rooms.has(code)) rooms.set(code, new Set());
      const set = rooms.get(code);
      const clientId = String(msg.clientId || '').slice(0, 64);

      // Si este mismo dispositivo ya tenía una conexión en la sala (reconexión
      // tras ir a WhatsApp, cambiar de red, etc.), se reemplaza: no ocupa cupo nuevo.
      if (clientId) {
        for (const other of set) {
          if (other !== ws && other.meta.clientId === clientId) {
            set.delete(other);
            try { other.close(); } catch (_) { /* ya estaba muerta */ }
          }
        }
      }

      // Cupo lleno: bloquea a cualquier tercero que no sea ya parte de la sala
      if (set.size >= MAX_ROOM_SIZE && !set.has(ws)) {
        ws.send(JSON.stringify({
          t: 'error',
          msg: 'Esta sala ya tiene ' + MAX_ROOM_SIZE + ' personas conectadas. Pide al anfitrión que cree una sala nueva.'
        }));
        return;
      }

      m.lang = String(msg.lang || 'es').slice(0, 2);
      m.name = String(msg.name || '').slice(0, 30);
      m.clientId = clientId;
      m.room = code;
      set.add(ws);
      ws.send(JSON.stringify({ t: 'joined', code, you: m.id, members: membersOf(code) }));
      broadcast(code, { t: 'members', members: membersOf(code) }, ws);
      return;
    }

    if (!m.room) return;

    // Texto provisional (mientras la persona aún habla): traducción en vivo con freno de 900ms
    if (msg.t === 'interim') {
      const now = Date.now();
      if (now - m.lastInterim < 900) return;
      m.lastInterim = now;
      const text = String(msg.text || '').slice(0, 500);
      if (text.trim().length < 3) return;
      const versions = await translateForRoom(m.room, text, m.lang);
      const set = rooms.get(m.room);
      if (!set) return;
      for (const client of set) {
        if (client === ws || client.readyState !== 1) continue;
        const v = versions[client.meta.lang];
        if (v) client.send(JSON.stringify({ t: 'preview', id: m.id, name: m.name, text: v }));
      }
      return;
    }

    // Frase final: traducción definitiva + voz en el celular receptor
    if (msg.t === 'final') {
      const text = String(msg.text || '').slice(0, 500);
      if (!text.trim()) return;
      const versions = await translateForRoom(m.room, text, m.lang);
      const set = rooms.get(m.room);
      if (!set) return;
      for (const client of set) {
        if (client.readyState !== 1) continue;
        if (client === ws) continue; // el emisor ya ve su propio original en pantalla
        const v = versions[client.meta.lang];
        client.send(JSON.stringify({
          t: 'speech', id: m.id, name: m.name,
          text: v || text, ok: Boolean(v)
        }));
      }
      return;
    }
  });

  ws.on('close', () => {
    const m = ws.meta;
    if (m.room && rooms.has(m.room)) {
      const set = rooms.get(m.room);
      set.delete(ws);
      if (set.size === 0) {
        // No se elimina de inmediato: sobrevive el periodo de gracia
        // (cubre el caso de ir a WhatsApp a enviar la invitación)
        const code = m.room;
        keepRoomAlive(code);
        emptyTimers.set(code, setTimeout(() => {
          rooms.delete(code);
          emptyTimers.delete(code);
        }, GRACE_MS));
      } else {
        broadcast(m.room, { t: 'members', members: membersOf(m.room) });
      }
    }
  });
});

// Cada 20s revisa cuánto hace que cada celular mandó su último mensaje real
// (incluye el latido de aplicación 'ping' cada 15s). Si pasaron más de 45s sin
// noticias, se da de baja: cubre el caso de una app cerrada del todo.
// A propósito NO se usa ping/pong de WebSocket a nivel de protocolo: algunos
// proxies de hosting no lo dejan pasar bien, y eso causaba desconexiones falsas.
const STALE_MS = 45000;
const HEARTBEAT_MS = 20000;
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (now - (ws.lastSeen || 0) > STALE_MS) { try { ws.terminate(); } catch (_) {} }
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Puente Live escuchando en el puerto ' + PORT));
