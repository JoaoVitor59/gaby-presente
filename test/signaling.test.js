'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server.js');
const { Injector } = require('../input.js');

const CONTROL_KEY = 'a'.repeat(32);
const injected = []; // ordens que iriam para o Windows

let server;
let base;

test.before(async () => {
  server = createServer({ injector: new Injector((line) => injected.push(line)), controlKey: CONTROL_KEY });
  server.listen(0);
  await once(server, 'listening');
  base = `localhost:${server.address().port}`;
});

test.after(() => server.close());

// Cliente de teste: guarda as mensagens recebidas e deixa esperar a próxima.
// Por padrão o cliente se apresenta como vindo de outro aparelho (os testes
// rodam todos na mesma máquina); { sameMachine: true } tira o disfarce.
const REMOTE = { headers: { 'x-forwarded-for': '203.0.113.7' } };

async function client({ sameMachine = false } = {}) {
  const ws = new WebSocket(`ws://${base}/ws`, sameMachine ? {} : REMOTE);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  await once(ws, 'open');
  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: () =>
      queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)),
    close: () => ws.close(),
  };
}

async function hostSession(key) {
  const host = await client();
  host.send({ type: 'host', key });
  const { type, id, control } = await host.next();
  assert.equal(type, 'hosted');
  return { host, id, control };
}

// Sessão com uma pessoa já aceita.
async function watchedSession(key) {
  const { host, id, control } = await hostSession(key);
  const viewer = await client();
  viewer.send({ type: 'join', id });
  const { peer } = await host.next();
  await viewer.next(); // waiting
  host.send({ type: 'accept', peer });
  await viewer.next(); // accepted
  return { host, viewer, peer, control };
}

// As mensagens de uma mesma conexão são tratadas em ordem: quando a resposta
// a um código inexistente chega, tudo o que foi mandado antes já foi tratado.
async function settled(c) {
  c.send({ type: 'join', id: '000000000' });
  const reply = await c.next();
  if (reply.type !== 'error') throw new Error(`inesperado: ${JSON.stringify(reply)}`);
}

test('entrega a página e a configuração', async () => {
  const page = await fetch(`http://${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TelaLink/);

  const config = await (await fetch(`http://${base}/config.json`)).json();
  assert.ok(Array.isArray(config.iceServers));
});

test('não entrega arquivos de fora da pasta public', async () => {
  for (const url of ['/%2e%2e/server.js', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
    const res = await fetch(`http://${base}${url}`);
    assert.notEqual(res.status, 200, url);
  }
});

test('gera um código de 9 dígitos para quem compartilha', async () => {
  const { host, id } = await hostSession();
  assert.match(id, /^\d{9}$/);
  host.close();
});

test('código inexistente devolve erro', async () => {
  const viewer = await client();
  viewer.send({ type: 'join', id: '000000000' });
  assert.deepEqual(await viewer.next(), { type: 'error', code: 'not-found' });
  viewer.close();
});

test('pedido aceito: mensagens do WebRTC passam nos dois sentidos', async () => {
  const { host, id } = await hostSession();
  const viewer = await client();

  // o código pode vir formatado com espaços
  viewer.send({ type: 'join', id: `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`, name: 'Celular' });
  const request = await host.next();
  assert.equal(request.type, 'request');
  assert.equal(request.name, 'Celular');
  assert.deepEqual(await viewer.next(), { type: 'waiting' });

  host.send({ type: 'accept', peer: request.peer });
  assert.deepEqual(await viewer.next(), { type: 'accepted' });

  host.send({ type: 'signal', peer: request.peer, data: { description: 'oferta' } });
  assert.deepEqual(await viewer.next(), { type: 'signal', data: { description: 'oferta' } });

  viewer.send({ type: 'signal', data: { description: 'resposta' } });
  assert.deepEqual(await host.next(), {
    type: 'signal',
    peer: request.peer,
    data: { description: 'resposta' },
  });

  viewer.close();
  assert.deepEqual(await host.next(), { type: 'left', peer: request.peer });
  host.close();
});

test('antes de ser aceito, quem pediu não consegue falar com quem compartilha', async () => {
  const { host, id } = await hostSession();
  const viewer = await client();
  viewer.send({ type: 'join', id });
  const request = await host.next();
  await viewer.next(); // waiting

  viewer.send({ type: 'signal', data: { description: 'intruso' } });
  host.send({ type: 'remove', peer: request.peer });
  assert.deepEqual(await viewer.next(), { type: 'rejected' });

  // a única coisa que chegou a quem compartilha foi o pedido
  const other = await client();
  other.send({ type: 'join', id, name: 'Outro' });
  assert.equal((await host.next()).name, 'Outro');

  for (const c of [host, viewer, other]) c.close();
});

test('quem compartilha pode remover alguém já conectado', async () => {
  const { host, id } = await hostSession();
  const viewer = await client();
  viewer.send({ type: 'join', id });
  const { peer } = await host.next();
  await viewer.next(); // waiting
  host.send({ type: 'accept', peer });
  await viewer.next(); // accepted

  host.send({ type: 'remove', peer });
  assert.deepEqual(await viewer.next(), { type: 'removed' });
  host.close();
  viewer.close();
});

test('encerrar o compartilhamento avisa quem está assistindo e invalida o código', async () => {
  const { host, id } = await hostSession();
  const viewer = await client();
  viewer.send({ type: 'join', id });
  const { peer } = await host.next();
  await viewer.next(); // waiting
  host.send({ type: 'accept', peer });
  await viewer.next(); // accepted

  host.close();
  assert.deepEqual(await viewer.next(), { type: 'ended' });

  viewer.send({ type: 'join', id });
  assert.deepEqual(await viewer.next(), { type: 'error', code: 'not-found' });
  viewer.close();
});

test('muitos códigos errados seguidos derrubam a conexão', async () => {
  const viewer = await client();
  for (let i = 0; i < 10; i++) {
    viewer.send({ type: 'join', id: '000000000' });
    await viewer.next();
  }
  const [code] = await once(viewer.ws, 'close');
  assert.equal(code, 1008);
});

// ------------------------------------------------------------ controle remoto

const MOVE = 0x8001; // mover + coordenadas absolutas

test('sem a chave do terminal, a página não pode oferecer controle', async () => {
  for (const key of [undefined, 'errada', 'b'.repeat(32), 42]) {
    const { host, viewer, peer, control } = await watchedSession(key);
    assert.equal(control, 'no-key');

    injected.length = 0;
    host.send({ type: 'control', peer, on: true });
    viewer.send({ type: 'input', kind: 'key', code: 'KeyA', down: true });
    viewer.send({ type: 'signal', data: 'marcador' });
    assert.equal((await host.next()).type, 'signal'); // tudo antes disso já foi tratado
    assert.deepEqual(injected, []);
    host.close();
    viewer.close();
  }
});

test('quem assiste só controla depois de receber o controle', async () => {
  const { host, viewer, peer, control } = await watchedSession(CONTROL_KEY);
  assert.equal(control, 'ok');
  const other = await client(); // conexão sem papel nenhum

  injected.length = 0;
  viewer.send({ type: 'input', kind: 'move', x: 0.5, y: 0.5 });
  other.send({ type: 'input', kind: 'move', x: 0.5, y: 0.5 });
  host.send({ type: 'input', kind: 'move', x: 0.5, y: 0.5 });
  await settled(other);
  viewer.send({ type: 'signal', data: 'marcador' });
  await host.next();
  assert.deepEqual(injected, []);

  host.send({ type: 'control', peer, on: true });
  assert.deepEqual(await viewer.next(), { type: 'control', on: true });

  viewer.send({ type: 'input', kind: 'move', x: 0.5, y: 1 });
  viewer.send({ type: 'input', kind: 'button', button: 0, down: true, x: 0, y: 0 });
  viewer.send({ type: 'input', kind: 'button', button: 0, down: false });
  viewer.send({ type: 'input', kind: 'wheel', dx: 0, dy: 100 });
  viewer.send({ type: 'input', kind: 'key', code: 'KeyA', down: true });
  viewer.send({ type: 'input', kind: 'key', code: 'KeyA', down: false });
  viewer.send({ type: 'input', kind: 'text', text: 'é' });
  // lixo não vira ordem
  viewer.send({ type: 'input', kind: 'key', code: 'TeclaInventada', down: true });
  viewer.send({ type: 'input', kind: 'key', code: 'constructor', down: true });
  viewer.send({ type: 'input', kind: 'button', button: 7, down: true });
  viewer.send({ type: 'input', kind: 'button', button: '__proto__', down: true });
  viewer.send({ type: 'input', kind: 'move', x: 'a', y: null });
  viewer.send({ type: 'input', kind: 'key', code: 'KeyB', down: false }); // soltar o que não apertou
  viewer.send({ type: 'signal', data: 'marcador' });
  await host.next();

  assert.deepEqual(injected, [
    `m 32768 65535 0 ${MOVE}`,
    `m 0 0 0 ${MOVE}`,
    'm 0 0 0 2', // botão esquerdo aperta
    'm 0 0 0 4', // e solta
    'm 0 0 -120 2048', // rodinha para baixo
    'k 0 30 8', // A aperta (tecla física 0x1E)
    'k 0 30 10', // A solta
    'k 0 233 4', // "é" como texto
    'k 0 233 6',
  ]);
  for (const c of [host, viewer, other]) c.close();
});

test('tirar o controle solta o que ficou apertado e bloqueia novos comandos', async () => {
  const { host, viewer, peer } = await watchedSession(CONTROL_KEY);
  host.send({ type: 'control', peer, on: true });
  await viewer.next();

  injected.length = 0;
  viewer.send({ type: 'input', kind: 'key', code: 'ShiftLeft', down: true });
  viewer.send({ type: 'input', kind: 'key', code: 'ShiftLeft', down: true }); // repetição da tecla
  viewer.send({ type: 'input', kind: 'button', button: 2, down: true });
  viewer.send({ type: 'signal', data: 'marcador' });
  await host.next();
  host.send({ type: 'control', peer, on: false });
  assert.deepEqual(await viewer.next(), { type: 'control', on: false });

  viewer.send({ type: 'input', kind: 'key', code: 'KeyA', down: true });
  viewer.send({ type: 'signal', data: 'marcador' });
  await host.next();

  assert.deepEqual(injected, [
    'k 0 42 8', // Shift aperta
    'k 0 42 8',
    'm 0 0 0 8', // botão direito aperta
    'k 0 42 10', // ao tirar o controle: Shift solta
    'm 0 0 0 16', // e o botão direito também
  ]);
  host.close();
  viewer.close();
});

test('se quem controla cai, ou o compartilhamento acaba, nada fica apertado', async () => {
  for (const who of ['viewer', 'host']) {
    const session = await watchedSession(CONTROL_KEY);
    session.host.send({ type: 'control', peer: session.peer, on: true });
    await session.viewer.next();

    injected.length = 0;
    session.viewer.send({ type: 'input', kind: 'key', code: 'ArrowUp', down: true });
    session.viewer.send({ type: 'signal', data: 'marcador' });
    await session.host.next();

    session[who].close();
    const other = who === 'viewer' ? session.host : session.viewer;
    assert.equal((await other.next()).type, who === 'viewer' ? 'left' : 'ended');
    // seta para cima é tecla "estendida": 8 (tecla física) + 1, e + 2 ao soltar
    assert.deepEqual(injected, ['k 0 72 9', 'k 0 72 11'], who);
    other.close();
  }
});

test('em computador sem suporte, o controle aparece como indisponível', async () => {
  const plain = createServer();
  plain.listen(0);
  await once(plain, 'listening');
  const ws = new WebSocket(`ws://localhost:${plain.address().port}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'host', key: CONTROL_KEY }));
  const [raw] = await once(ws, 'message');
  assert.equal(JSON.parse(raw).control, 'unsupported');
  ws.close();
  plain.close();
});

test('posições e rolagem são limitadas ao que o Windows aceita', () => {
  const lines = [];
  const injector = new Injector((line) => lines.push(line));
  injector.move(-3, 9);
  injector.wheel(40, -99999);
  injector.wheel(0, 0);
  injector.text('a\n\u0007b');
  assert.deepEqual(lines, [
    `m 0 65535 0 ${MOVE}`,
    'm 0 0 1200 2048', // para cima, no limite
    'm 0 0 48 4096', // para a direita
    'k 0 97 4',
    'k 0 97 6',
    'k 0 98 4',
    'k 0 98 6',
  ]);
});

// ------------------------------------------------- código fixo e entrada direta

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../server.js');

async function fixedServer(password) {
  const lines = [];
  const srv = createServer({
    injector: new Injector((line) => lines.push(line)),
    controlKey: CONTROL_KEY,
    fixedId: '123456789',
    password,
  });
  srv.listen(0);
  await once(srv, 'listening');
  const connect = async () => {
    const ws = new WebSocket(`ws://localhost:${srv.address().port}/ws`, REMOTE);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    await once(ws, 'open');
    return {
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
      close: () => ws.close(),
    };
  };
  return { srv, connect };
}

test('o código fixo é só da página aberta no próprio computador', async () => {
  const { srv, connect } = await fixedServer('');
  const local = await connect();
  local.send({ type: 'host', key: CONTROL_KEY });
  const first = await local.next();
  assert.equal(first.id, '123456789');
  assert.equal(first.fixed, true);
  assert.equal(first.unattended, false);

  // segunda página local ao mesmo tempo e página sem a chave: código sorteado
  for (const key of [CONTROL_KEY, undefined]) {
    const other = await connect();
    other.send({ type: 'host', key });
    const reply = await other.next();
    assert.notEqual(reply.id, '123456789');
    assert.equal(reply.fixed, false);
    other.close();
  }

  // sem senha definida, entrar continua pedindo permissão
  const viewer = await connect();
  viewer.send({ type: 'join', id: '123456789', password: 'qualquer' });
  const request = await local.next();
  assert.equal(request.auto, false);
  assert.deepEqual(await viewer.next(), { type: 'waiting' });

  // o código volta a valer depois que o compartilhamento termina
  local.close();
  await viewer.next(); // ended
  const again = await connect();
  again.send({ type: 'host', key: CONTROL_KEY });
  assert.equal((await again.next()).id, '123456789');
  for (const c of [viewer, again]) c.close();
  srv.close();
});

test('com senha: só entra direto quem acerta a senha', async () => {
  const { srv, connect } = await fixedServer('senha-bem-longa');
  const host = await connect();
  host.send({ type: 'host', key: CONTROL_KEY });
  assert.equal((await host.next()).unattended, true);

  const viewer = await connect();
  for (const password of [undefined, '', 'errada', 'senha-bem-longa ', 42, { a: 1 }]) {
    viewer.send({ type: 'join', id: '123456789', password });
    assert.deepEqual(await viewer.next(), { type: 'error', code: 'password' }, String(password));
  }
  viewer.send({ type: 'join', id: '123 456 789', name: 'Chromebook', password: 'senha-bem-longa' });
  assert.deepEqual(await viewer.next(), { type: 'waiting' });
  // quem compartilha só ficou sabendo de quem acertou
  const request = await host.next();
  assert.equal(request.type, 'request');
  assert.equal(request.name, 'Chromebook');
  assert.equal(request.auto, true);

  for (const c of [host, viewer]) c.close();
  srv.close();
});

test('muitas senhas erradas travam a entrada por senha', async () => {
  const { srv, connect } = await fixedServer('senha-bem-longa');
  const host = await connect();
  host.send({ type: 'host', key: CONTROL_KEY });
  await host.next();

  for (let i = 0; i < 20; i++) {
    const guesser = await connect(); // conexão nova a cada tentativa
    guesser.send({ type: 'join', id: '123456789', password: `chute-${i}` });
    assert.equal((await guesser.next()).code, 'password');
    guesser.close();
  }
  const viewer = await connect();
  viewer.send({ type: 'join', id: '123456789', password: 'senha-bem-longa' });
  assert.deepEqual(await viewer.next(), { type: 'error', code: 'locked' });
  for (const c of [host, viewer]) c.close();
  srv.close();
});

test('a configuração guarda o código fixo e recusa senha curta', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telalink-')), 'config.json');
  const first = loadConfig(file);
  assert.match(first.fixedId, /^\d{9}$/);
  assert.equal(first.password, '');
  assert.deepEqual(loadConfig(file), first); // o mesmo código na vez seguinte

  fs.writeFileSync(file, JSON.stringify({ codigo: first.fixedId, senha: 'curta' }));
  assert.equal(loadConfig(file).password, '');
  fs.writeFileSync(file, JSON.stringify({ codigo: first.fixedId, senha: 'senha-bem-longa' }));
  assert.deepEqual(loadConfig(file), { fixedId: first.fixedId, password: 'senha-bem-longa' });
});

test('arquivo salvo pelo Bloco de Notas (com BOM, código como número) é aceito', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telalink-')), 'config.json');
  fs.writeFileSync(file, '﻿{ "codigo": 482913765, "senha": 87654321 }');
  assert.deepEqual(loadConfig(file), { fixedId: '482913765', password: '87654321' });
  assert.deepEqual(loadConfig(file), { fixedId: '482913765', password: '87654321' });
});

test('arquivo com erro não é apagado; o comando de senha refaz', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telalink-')), 'config.json');
  const typed = '{ "codigo": "482913765" "senha": "87654321" }'; // faltou a vírgula
  fs.writeFileSync(file, typed);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(loadConfig(file).password, '');
    assert.equal(fs.readFileSync(file, 'utf8'), typed);
    const fixed = loadConfig(file, { senha: '87654321' });
    assert.equal(fixed.password, '87654321');
    assert.deepEqual(loadConfig(file), fixed);
  } finally {
    console.warn = warn;
  }
});

test('o comando de senha mantém o código que já existia', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telalink-')), 'config.json');
  const { fixedId } = loadConfig(file);
  assert.deepEqual(loadConfig(file, { senha: '87654321' }), { fixedId, password: '87654321' });
  assert.deepEqual(loadConfig(file, { senha: 'outra-senha', codigo: '111222333' }), {
    fixedId: '111222333',
    password: 'outra-senha',
  });
});

test('quem assiste no mesmo computador não recebe o controle', async () => {
  const { host, id } = await hostSession(CONTROL_KEY);
  const viewer = await client({ sameMachine: true });
  viewer.send({ type: 'join', id });
  const request = await host.next();
  assert.equal(request.sameMachine, true);
  await viewer.next(); // waiting
  host.send({ type: 'accept', peer: request.peer });
  await viewer.next(); // accepted

  injected.length = 0;
  host.send({ type: 'control', peer: request.peer, on: true });
  viewer.send({ type: 'input', kind: 'move', x: 0.5, y: 0.5 });
  viewer.send({ type: 'signal', data: 'marcador' });
  assert.equal((await host.next()).type, 'signal');
  assert.deepEqual(injected, []);
  host.close();
  viewer.close();
});
