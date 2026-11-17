// Server minimo: serve il gioco (PC) e il telecomando (telefono) e fa passare i messaggi.
// Non contiene logica di gioco: la fa tutta la pagina del PC.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f));
const PORT = process.env.PORT || 3000;

const pages = { '/': 'game.html', '/pad': 'pad.html', '/porto': 'porto.html' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.end('ok'); return; }
  const f = pages[url.pathname];
  if (!f) { res.writeHead(404); res.end('Non trovato'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(read(f));
});

const rooms = new Map(); // codice -> { host, pads: Map(id -> ws) }
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join(''); } while (rooms.has(c)); return c; };
let nextId = 1;
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('role');
  let room = null, id = 0;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'host') {
    let code = (q.get('code') || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(code) || (rooms.has(code) && rooms.get(code).host && rooms.get(code).host.readyState === 1)) code = newCode();
    room = rooms.get(code) || { host: null, pads: new Map() };
    room.host = ws; rooms.set(code, room); room.code = code;
    send(ws, { t: 'room', code });
    for (const [pid, p] of room.pads) send(ws, { t: 'join', id: pid, name: p.name });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.to) { const p = room.pads.get(m.to); if (p) send(p.ws, m); }
      else for (const [, p] of room.pads) send(p.ws, m); // senza destinatario: a tutti i telefoni
    });
    ws.on('close', () => { if (room.host === ws) room.host = null; setTimeout(() => { if (!room.host && rooms.get(room.code) === room) { for (const [, p] of room.pads) p.ws.close(); rooms.delete(room.code); } }, 60000); });
  } else if (role === 'pad') {
    const code = (q.get('code') || '').toUpperCase();
    room = rooms.get(code);
    if (!room || !room.host) { send(ws, { t: 'err', msg: 'Codice non trovato: controlla lo schermo del PC' }); ws.close(); return; }
    if (room.pads.size >= 4) { send(ws, { t: 'err', msg: 'Stanza piena (max 4)' }); ws.close(); return; }
    id = nextId++;
    const name = String(q.get('name') || 'Pirata').slice(0, 14);
    const w = q.get('w') === 'gun' ? 'gun' : 'sword';
    room.pads.set(id, { ws, name });
    send(ws, { t: 'ok', id, name });
    send(room.host, { t: 'join', id, name, w });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.t === 'ping') { send(ws, { t: 'pong', c: m.c }); return; }
      m.id = id;
      send(room.host, m);
    });
    ws.on('close', () => { room.pads.delete(id); send(room.host, { t: 'leave', id }); });
  } else { ws.close(); }
});

// chiude le connessioni morte (telefono spento, wifi caduto)
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);

server.listen(PORT, () => console.log('Server pronto sulla porta ' + PORT));
