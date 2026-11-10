'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server.js');

let server;
let base;

test.before(async () => {
  server = createServer();
  server.listen(0);
  await once(server, 'listening');
  base = `localhost:${server.address().port}`;
});

test.after(() => server.close());

// Cliente de teste: guarda as mensagens recebidas e deixa esperar a próxima.
async function client() {
  const ws = new WebSocket(`ws://${base}/ws`);
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

async function hostSession() {
  const host = await client();
  host.send({ type: 'host' });
  const { type, id } = await host.next();
  assert.equal(type, 'hosted');
  return { host, id };
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
