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
const { createInjector } = require('./input.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_VIEWERS = 10; // por compartilhamento
const MAX_FAILED_JOINS = 10; // códigos ou senhas erradas por conexão antes de derrubar
const MAX_BAD_PASSWORDS = 20; // senhas erradas seguidas antes de travar a entrada por senha
const MIN_PASSWORD = 8;
const CONFIG_FILE = path.join(__dirname, 'telalink.config.json');
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

// Código fixo e senha deste computador, guardados em telalink.config.json
// (criado na primeira vez). Sem senha, cada entrada continua pedindo permissão.
function loadConfig(file = CONFIG_FILE) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Não foi possível ler ${path.basename(file)}: ${err.message}`);
  }
  const fixedId = /^\d{9}$/.test(saved.codigo) ? saved.codigo : String(crypto.randomInt(100_000_000, 1_000_000_000));
  let password = typeof saved.senha === 'string' ? saved.senha : '';
  if (password && password.length < MIN_PASSWORD) {
    console.warn(`A senha em ${path.basename(file)} precisa ter pelo menos ${MIN_PASSWORD} caracteres; ignorada.`);
    password = '';
  }
  if (saved.codigo !== fixedId || typeof saved.senha !== 'string') {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ codigo: fixedId, senha: saved.senha ?? '' }, null, 2)}\n`);
    } catch (err) {
      console.warn(`Não foi possível salvar ${path.basename(file)}: ${err.message}`);
    }
  }
  return { fixedId, password };
}

// injector: quem executa mouse e teclado neste computador (null = sem controle
// remoto). controlKey: chave que só a página aberta neste computador conhece
// (aparece no terminal); é ela que libera o controle e o código fixo.
// fixedId: código fixo deste computador. password: se definida, quem digitar
// o código fixo e a senha entra sem pedir permissão.
function createServer({ injector = null, controlKey = null, fixedId = null, password = '' } = {}) {
  const iceServers = loadIceServers();
  let badPasswords = 0;
  const digest = (text) => crypto.createHash('sha256').update(String(text)).digest();
  const passwordMatches = (given) =>
    typeof given === 'string' && crypto.timingSafeEqual(digest(given), digest(password));
  // código de 9 dígitos -> { id, host, control, viewers }
  // viewers: Map(peer -> { ws, name, accepted, control, held })
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

  const keyMatches = (key) =>
    typeof controlKey === 'string' &&
    typeof key === 'string' &&
    key.length === controlKey.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(controlKey));

  // Solta as teclas e botões que a pessoa deixou apertados, para nada ficar
  // "preso" no computador controlado quando o controle acaba.
  function releaseHeld(viewer) {
    for (const item of viewer.held) {
      if (item.startsWith('button:')) injector.button(Number(item.slice(7)), false);
      else injector.key(item.slice(4), false);
    }
    viewer.held.clear();
  }

  function applyInput(viewer, msg) {
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const down = msg.down === true;
    const x = num(msg.x);
    const y = num(msg.y);
    const moveIfGiven = () => {
      if (x !== null && y !== null) injector.move(x, y);
    };
    const track = (item) => (down ? viewer.held.add(item) : viewer.held.delete(item));

    switch (msg.kind) {
      case 'move':
        moveIfGiven();
        return;
      case 'button':
        if (!down && !viewer.held.has(`button:${msg.button}`)) return;
        moveIfGiven();
        if (injector.button(msg.button, down)) track(`button:${msg.button}`);
        return;
      case 'wheel':
        moveIfGiven();
        injector.wheel(num(msg.dx) ?? 0, num(msg.dy) ?? 0);
        return;
      case 'key':
        if (typeof msg.code !== 'string') return;
        if (!down && !viewer.held.has(`key:${msg.code}`)) return;
        if (injector.key(msg.code, down)) track(`key:${msg.code}`);
        return;
      case 'text':
        if (typeof msg.text === 'string') injector.text(msg.text.slice(0, 200));
        return;
      case 'release':
        releaseHeld(viewer);
        return;
      default:
    }
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
        releaseHeld(viewer);
        viewer.ws.role = null;
        viewer.ws.sessionId = null;
        send(viewer.ws, { type: 'ended' });
      }
    } else if (role === 'viewer') {
      const viewer = session.viewers.get(ws.peerId);
      if (!viewer) return;
      releaseHeld(viewer);
      session.viewers.delete(ws.peerId);
      send(session.host, { type: 'left', peer: ws.peerId });
    }
  }

  function onMessage(ws, msg) {
    switch (msg.type) {
      case 'host': {
        if (ws.role) return;
        const local = keyMatches(msg.key); // página aberta neste computador
        // O código fixo é só deste computador (e de um compartilhamento por vez).
        const fixed = local && fixedId !== null && !sessions.has(fixedId);
        const id = fixed ? fixedId : newSessionId();
        // 'ok' | 'no-key' (página aberta sem a chave) | 'unsupported' (não é Windows)
        const control = !injector ? 'unsupported' : local ? 'ok' : 'no-key';
        const unattended = fixed && password !== '';
        sessions.set(id, { id, host: ws, control: control === 'ok', unattended, viewers: new Map() });
        ws.role = 'host';
        ws.sessionId = id;
        send(ws, { type: 'hosted', id, control, fixed, unattended });
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
        // Com senha definida, o código fixo só abre com ela — e aí entra direto.
        if (session.unattended) {
          if (badPasswords >= MAX_BAD_PASSWORDS) {
            send(ws, { type: 'error', code: 'locked' });
            return;
          }
          if (!passwordMatches(msg.password)) {
            if (msg.password) badPasswords++;
            send(ws, { type: 'error', code: 'password' });
            if (++ws.failedJoins >= MAX_FAILED_JOINS) ws.close(1008, 'too many attempts');
            return;
          }
          badPasswords = 0;
        }
        const name = String(msg.name ?? '').trim().slice(0, 40) || 'Dispositivo';
        ws.role = 'viewer';
        ws.sessionId = id;
        ws.peerId = crypto.randomBytes(8).toString('hex');
        session.viewers.set(ws.peerId, { ws, name, accepted: false, control: false, held: new Set() });
        send(session.host, { type: 'request', peer: ws.peerId, name, auto: session.unattended });
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
          releaseHeld(viewer);
          session.viewers.delete(msg.peer);
          viewer.ws.role = null;
          viewer.ws.sessionId = null;
          send(viewer.ws, { type: viewer.accepted ? 'removed' : 'rejected' });
        }
        return;
      }

      // Quem compartilha dá (ou tira) o controle do mouse e teclado.
      case 'control': {
        if (ws.role !== 'host') return;
        const session = sessions.get(ws.sessionId);
        const viewer = session?.viewers.get(msg.peer);
        if (!session?.control || !viewer?.accepted) return;
        viewer.control = msg.on === true;
        if (!viewer.control) releaseHeld(viewer);
        send(viewer.ws, { type: 'control', on: viewer.control });
        return;
      }

      // Mouse e teclado de quem recebeu o controle.
      case 'input': {
        if (ws.role !== 'viewer') return;
        const viewer = sessions.get(ws.sessionId)?.viewers.get(ws.peerId);
        if (viewer?.control) applyInput(viewer, msg);
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
  const injector = createInjector();
  const controlKey = crypto.randomBytes(16).toString('hex');
  const { fixedId, password } = loadConfig();
  createServer({ injector, controlKey, fixedId, password }).listen(port, () => {
    console.log(`TelaLink rodando na porta ${port}`);
    console.log(`  Neste computador:  http://localhost:${port}/#chave=${controlKey}`);
    console.log('                     (link só deste computador; não passe para ninguém)');
    console.log(`  Código fixo:       ${fixedId.replace(/(\d{3})(?=\d)/g, '$1 ')}`);
    console.log(
      password
        ? '  Entrada:           direto, com a senha de telalink.config.json'
        : '  Entrada:           pedindo permissão (defina "senha" em telalink.config.json para entrar direto)',
    );
    if (!injector) console.log('  Controle remoto:   indisponível (só no Windows)');
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  Na mesma rede:     http://${addr.address}:${port}`);
        }
      }
    }
  });
}

module.exports = { createServer, loadConfig };
