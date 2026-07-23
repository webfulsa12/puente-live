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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Salas ----------
// rooms: código -> Set de clientes (ws). Cada ws lleva ws.meta = {id, room, lang, name}
const rooms = new Map();
let nextId = 1;

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
  ws.meta = { id: nextId++, room: null, lang: 'es', name: '', lastInterim: 0 };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const m = ws.meta;

    // Crear sala
    if (msg.t === 'create') {
      const code = genCode();
      m.lang = String(msg.lang || 'es').slice(0, 2);
      m.name = String(msg.name || '').slice(0, 30);
      m.room = code;
      rooms.set(code, new Set([ws]));
      ws.send(JSON.stringify({ t: 'joined', code, you: m.id, members: membersOf(code) }));
      return;
    }

    // Unirse a sala existente
    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      if (!rooms.has(code)) {
        ws.send(JSON.stringify({ t: 'error', msg: 'La sala ' + code + ' no existe o ya se cerró.' }));
        return;
      }
      m.lang = String(msg.lang || 'es').slice(0, 2);
      m.name = String(msg.name || '').slice(0, 30);
      m.room = code;
      rooms.get(code).add(ws);
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
      if (set.size === 0) rooms.delete(m.room);
      else broadcast(m.room, { t: 'members', members: membersOf(m.room) });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Puente Live escuchando en el puerto ' + PORT));
