'use strict';

// Servidor do TelaLink: entrega a página e faz a "sinalização" (troca de
// mensagens para os dois navegadores se encontrarem). O vídeo em si NÃO passa
// por aqui: vai direto de um dispositivo para o outro via WebRTC.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_VIEWERS = 10; // por compartilhamento
const MAX_FAILED_JOINS = 10; // códigos errados por conexão antes de derrubar
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function loadIceServers() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!process.env.ICE_SERVERS) return fallback;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* cai no aviso abaixo */
  }
  console.warn('ICE_SERVERS inválido (precisa ser uma lista JSON); usando o padrão.');
  return fallback;
}

function serveStatic(req, res, iceServers) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ iceServers }));
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(PUBLIC_DIR, pathname);
  if (pathname.includes('\0') || !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer() {
  const iceServers = loadIceServers();
  // código de 9 dígitos -> { id, host, viewers: Map(peer -> { ws, name, accepted }) }
  const sessions = new Map();

  const server = http.createServer((req, res) => serveStatic(req, res, iceServers));
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function newSessionId() {
    let id;
    do {
      id = String(crypto.randomInt(100_000_000, 1_000_000_000));
    } while (sessions.has(id));
    return id;
  }

  // Tira a conexão da sessão em que ela está (se estiver em alguma).
  function detach(ws) {
    const session = sessions.get(ws.sessionId);
    const role = ws.role;
    ws.role = null;
    ws.sessionId = null;
    if (!session) return;

    if (role === 'host') {
      sessions.delete(session.id);
      for (const viewer of session.viewers.values()) {
        viewer.ws.role = null;
        viewer.ws.sessionId = null;
        send(viewer.ws, { type: 'ended' });
      }
    } else if (role === 'viewer' && session.viewers.delete(ws.peerId)) {
      send(session.host, { type: 'left', peer: ws.peerId });
    }
  }

  function onMessage(ws, msg) {
    switch (msg.type) {
      case 'host': {
        if (ws.role) return;
        const id = newSessionId();
        sessions.set(id, { id, host: ws, viewers: new Map() });
        ws.role = 'host';
        ws.sessionId = id;
        send(ws, { type: 'hosted', id });
        return;
      }

      case 'join': {
        if (ws.role) return;
        const id = String(msg.id ?? '').replace(/\D/g, '');
        const session = sessions.get(id);
        if (!session) {
          send(ws, { type: 'error', code: 'not-found' });
          if (++ws.failedJoins >= MAX_FAILED_JOINS) ws.close(1008, 'too many attempts');
          return;
        }
        if (session.viewers.size >= MAX_VIEWERS) {
          send(ws, { type: 'error', code: 'full' });
          return;
        }
        const name = String(msg.name ?? '').trim().slice(0, 40) || 'Dispositivo';
        ws.role = 'viewer';
        ws.sessionId = id;
        ws.peerId = crypto.randomBytes(8).toString('hex');
        session.viewers.set(ws.peerId, { ws, name, accepted: false });
        send(session.host, { type: 'request', peer: ws.peerId, name });
        send(ws, { type: 'waiting' });
        return;
      }

      // Quem compartilha decide quem entra — e pode tirar alguém depois.
      case 'accept':
      case 'remove': {
        if (ws.role !== 'host') return;
        const session = sessions.get(ws.sessionId);
        const viewer = session?.viewers.get(msg.peer);
        if (!viewer) return;
        if (msg.type === 'accept') {
          viewer.accepted = true;
          send(viewer.ws, { type: 'accepted' });
        } else {
          session.viewers.delete(msg.peer);
          viewer.ws.role = null;
          viewer.ws.sessionId = null;
          send(viewer.ws, { type: viewer.accepted ? 'removed' : 'rejected' });
        }
        return;
      }

      // Repasse das mensagens do WebRTC, só entre quem já foi aceito.
      case 'signal': {
        const session = sessions.get(ws.sessionId);
        if (!session || msg.data == null) return;
        if (ws.role === 'host') {
          const viewer = session.viewers.get(msg.peer);
          if (viewer?.accepted) send(viewer.ws, { type: 'signal', data: msg.data });
        } else if (ws.role === 'viewer' && session.viewers.get(ws.peerId)?.accepted) {
          send(session.host, { type: 'signal', peer: ws.peerId, data: msg.data });
        }
        return;
      }

      default:
    }
  }

  wss.on('connection', (ws) => {
    ws.role = null;
    ws.sessionId = null;
    ws.failedJoins = 0;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(ws, msg);
    });
    ws.on('close', () => detach(ws));
    ws.on('error', () => {});
  });

  // Derruba conexões mortas e mantém as vivas abertas atrás de proxies.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`TelaLink rodando na porta ${port}`);
    console.log(`  Neste computador:  http://localhost:${port}`);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  Na mesma rede:     http://${addr.address}:${port}`);
        }
      }
    }
  });
}

module.exports = { createServer };
