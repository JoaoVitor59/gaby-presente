(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TITLE = document.title;

  const views = { home: $('view-home'), host: $('view-host'), watch: $('view-watch') };
  function show(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    window.scrollTo(0, 0);
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  const digits = (value) => String(value).replace(/\D/g, '').slice(0, 9);
  const formatCode = (value) => digits(value).replace(/(\d{3})(?=\d)/g, '$1 ');

  // ---------------------------------------------------------------- conexão

  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  fetch('config.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((config) => {
      if (Array.isArray(config?.iceServers)) iceServers = config.iceServers;
    })
    .catch(() => {});

  function openSocket() {
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    return new WebSocket(url);
  }

  const sendTo = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Uma ligação WebRTC com o outro dispositivo. As mensagens são tratadas em
  // fila, uma por vez, para um "candidato" nunca chegar antes da descrição.
  function makeLink(signal, onState) {
    const pc = new RTCPeerConnection({ iceServers });
    let queue = Promise.resolve();
    const enqueue = (step) => {
      queue = queue.then(step).catch((err) => console.warn('WebRTC:', err));
    };
    const sendDescription = async () => {
      await pc.setLocalDescription();
      signal({ description: pc.localDescription });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => onState(pc.connectionState);

    return {
      pc,
      offer: () => enqueue(sendDescription),
      handle: (data) =>
        enqueue(async () => {
          if (data.description) {
            await pc.setRemoteDescription(data.description);
            if (data.description.type === 'offer') await sendDescription();
          } else if (data.candidate) {
            await pc.addIceCandidate(data.candidate);
          }
        }),
      close: () => {
        pc.onconnectionstatechange = null;
        pc.close();
      },
    };
  }

  // ----------------------------------------------------------- compartilhar

  let host = null; // { stream, ws, id, peers: Map(peer -> { name, state, link }) }

  const PEER_STATUS = {
    pending: ['quer ver sua tela', 'wait'],
    connecting: ['Conectando…', ''],
    connected: ['Assistindo', 'ok'],
    failed: ['Não conseguiu conectar', 'bad'],
  };

  function renderPeers() {
    const list = $('peer-list');
    list.replaceChildren();
    let pending = 0;

    for (const [peer, info] of host?.peers ?? []) {
      const [label, tone] = PEER_STATUS[info.state];
      if (info.state === 'pending') pending++;

      const item = document.createElement('li');
      item.className = `peer ${info.state}`;

      const text = document.createElement('div');
      text.className = 'peer-info';
      const name = document.createElement('div');
      name.className = 'peer-name';
      name.textContent = info.name;
      const status = document.createElement('div');
      status.className = `peer-status ${tone}`;
      status.textContent = label;
      text.append(name, status);

      const actions = document.createElement('div');
      actions.className = 'peer-actions';
      const button = (labelText, className, onClick) => {
        const btn = document.createElement('button');
        btn.className = `btn small ${className}`;
        btn.textContent = labelText;
        btn.addEventListener('click', onClick);
        actions.append(btn);
      };
      if (info.state === 'pending') {
        button('Permitir', 'primary', () => acceptPeer(peer));
        button('Recusar', 'danger', () => removePeer(peer));
      } else {
        button('Remover', 'danger', () => removePeer(peer));
      }

      item.append(text, actions);
      list.append(item);
    }

    $('peer-empty').hidden = list.childElementCount > 0;
    document.title = pending ? `(${pending}) Pedido de acesso — TelaLink` : TITLE;
  }

  function acceptPeer(peer) {
    const info = host?.peers.get(peer);
    if (!info || info.state !== 'pending') return;
    const { ws, stream } = host;

    info.state = 'connecting';
    info.link = makeLink(
      (data) => sendTo(ws, { type: 'signal', peer, data }),
      (state) => {
        if (state === 'connected') info.state = 'connected';
        else if (state === 'failed') info.state = 'failed';
        else if (state === 'disconnected') info.state = 'connecting';
        else return;
        renderPeers();
      },
    );
    for (const track of stream.getTracks()) info.link.pc.addTrack(track, stream);

    sendTo(ws, { type: 'accept', peer });
    info.link.offer();
    renderPeers();
  }

  function removePeer(peer) {
    const info = host?.peers.get(peer);
    if (!info) return;
    info.link?.close();
    host.peers.delete(peer);
    sendTo(host.ws, { type: 'remove', peer });
    renderPeers();
  }

  function onHostMessage(msg) {
    if (msg.type === 'hosted') {
      host.id = msg.id;
      $('host-code').textContent = formatCode(msg.id);
    } else if (msg.type === 'request') {
      host.peers.set(msg.peer, { name: msg.name, state: 'pending', link: null });
      renderPeers();
    } else if (msg.type === 'left') {
      host.peers.get(msg.peer)?.link?.close();
      host.peers.delete(msg.peer);
      renderPeers();
    } else if (msg.type === 'signal') {
      host.peers.get(msg.peer)?.link?.handle(msg.data);
    }
  }

  async function startShare(kind) {
    if (host || watch) return;
    let stream;
    try {
      stream =
        kind === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true })
          : await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
              audio: false,
            });
    } catch (err) {
      toast(
        err.name === 'NotAllowedError' || err.name === 'AbortError'
          ? 'Compartilhamento cancelado ou não permitido.'
          : 'Não foi possível iniciar o compartilhamento neste dispositivo.',
      );
      return;
    }

    const [video] = stream.getVideoTracks();
    if (kind === 'screen') video.contentHint = 'detail'; // prioriza nitidez
    // dispara quando a pessoa clica em "Parar de compartilhar" no navegador
    video.addEventListener('ended', () => stopShare('Compartilhamento encerrado.'));

    const ws = openSocket();
    host = { stream, ws, id: null, peers: new Map() };
    ws.onopen = () => sendTo(ws, { type: 'host' });
    ws.onmessage = (event) => host?.ws === ws && onHostMessage(JSON.parse(event.data));
    ws.onclose = () => {
      if (host?.ws === ws) stopShare('A conexão com o servidor caiu e o compartilhamento foi encerrado.');
    };

    $('local-video').srcObject = stream;
    $('host-code').textContent = '— — —';
    renderPeers();
    show('host');
  }

  function stopShare(message) {
    if (!host) return;
    const { stream, ws, peers } = host;
    host = null;
    for (const track of stream.getTracks()) track.stop();
    for (const info of peers.values()) info.link?.close();
    ws.close();
    $('local-video').srcObject = null;
    renderPeers();
    show('home');
    if (message) toast(message);
  }

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fora de https/localhost não existe navigator.clipboard
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast(done);
  }

  // --------------------------------------------------------------- assistir

  let watch = null; // { ws, id, link, wakeLock }

  const remoteVideo = $('remote-video');

  function setOverlay(message, busy = true) {
    $('watch-overlay').hidden = !message;
    $('watch-status').textContent = message || '';
    $('watch-spinner').hidden = !busy;
  }

  function keepScreenOn() {
    const session = watch;
    if (!session || !navigator.wakeLock) return;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        if (watch === session) session.wakeLock = lock;
        else lock.release();
      })
      .catch(() => {});
  }

  function onWatchMessage(msg) {
    const { ws } = watch;
    switch (msg.type) {
      case 'waiting':
        setOverlay('Aguardando a permissão de quem está compartilhando…');
        break;
      case 'accepted':
        setOverlay('Permitido! Conectando…');
        watch.link = makeLink(
          (data) => sendTo(ws, { type: 'signal', data }),
          (state) => {
            if (state === 'connected' && remoteVideo.srcObject) setOverlay(null);
            else if (state === 'disconnected') setOverlay('A conexão oscilou. Reconectando…');
            else if (state === 'failed') {
              setOverlay(
                'Não foi possível ligar os dois dispositivos diretamente. A rede de um deles pode estar bloqueando — tente com os dois no mesmo Wi‑Fi.',
                false,
              );
            }
          },
        );
        watch.link.pc.ontrack = (event) => {
          const [stream] = event.streams;
          remoteVideo.srcObject = stream;
          remoteVideo.play().catch(() => {});
          if (event.track.kind === 'audio') $('btn-sound').hidden = false;
        };
        break;
      case 'signal':
        watch.link?.handle(msg.data);
        break;
      case 'error':
        endWatch(
          null,
          msg.code === 'full'
            ? 'Esse compartilhamento já atingiu o limite de pessoas.'
            : 'Não encontramos nenhum compartilhamento com esse código. Confira os números.',
        );
        break;
      case 'rejected':
        endWatch(null, 'O pedido de acesso foi recusado.');
        break;
      case 'removed':
        endWatch('Você foi removido do compartilhamento.');
        break;
      case 'ended':
        endWatch('O compartilhamento foi encerrado.');
        break;
      default:
    }
  }

  function startWatch(code) {
    if (host || watch) return;
    const name = $('join-name').value.trim() || guessDevice();
    const ws = openSocket();
    watch = { ws, id: code, link: null, wakeLock: null };
    ws.onopen = () => sendTo(ws, { type: 'join', id: code, name });
    ws.onmessage = (event) => watch?.ws === ws && onWatchMessage(JSON.parse(event.data));
    ws.onclose = () => {
      if (watch?.ws === ws) endWatch('A conexão com o servidor caiu.');
    };

    $('join-error').hidden = true;
    $('watch-code').textContent = formatCode(code);
    $('btn-sound').hidden = true;
    remoteVideo.muted = true;
    $('btn-sound').textContent = 'Ativar som';
    setOverlay('Conectando…');
    show('watch');
    keepScreenOn();
  }

  function endWatch(message, formError) {
    if (!watch) return;
    const { ws, link, wakeLock } = watch;
    watch = null;
    link?.close();
    ws.close();
    wakeLock?.release().catch(() => {});
    remoteVideo.srcObject = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    show('home');
    if (formError) {
      $('join-error').textContent = formError;
      $('join-error').hidden = false;
      $('join-code').focus();
    }
    if (message) toast(message);
  }

  function guessDevice() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad';
    if (/Windows/i.test(ua)) return 'Computador Windows';
    if (/Mac/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Computador Linux';
    return 'Dispositivo';
  }

  // ---------------------------------------------------------------- eventos

  $('btn-share-screen').addEventListener('click', () => startShare('screen'));
  $('btn-share-camera').addEventListener('click', () => startShare('camera'));
  $('btn-stop').addEventListener('click', () => stopShare());
  $('btn-copy-code').addEventListener('click', () => host?.id && copy(host.id, 'Código copiado.'));
  $('btn-copy-link').addEventListener('click', () => {
    if (host?.id) copy(`${location.origin}${location.pathname}?c=${host.id}`, 'Link copiado.');
  });

  $('join-code').addEventListener('input', (event) => {
    event.target.value = formatCode(event.target.value);
    $('join-error').hidden = true;
  });
  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = digits($('join-code').value);
    if (code.length !== 9) {
      $('join-error').textContent = 'O código tem 9 dígitos.';
      $('join-error').hidden = false;
      return;
    }
    try {
      localStorage.setItem('telalink:name', $('join-name').value.trim());
    } catch {
      /* sem armazenamento (aba anônima): segue sem lembrar o nome */
    }
    startWatch(code);
  });

  $('btn-leave').addEventListener('click', () => endWatch());
  $('btn-sound').addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    $('btn-sound').textContent = remoteVideo.muted ? 'Ativar som' : 'Silenciar';
  });
  $('btn-full').addEventListener('click', () => {
    const stage = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else remoteVideo.webkitEnterFullscreen?.(); // iPhone só deixa o vídeo em tela cheia
  });
  document.addEventListener('fullscreenchange', () => {
    $('btn-full').textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
  remoteVideo.addEventListener('playing', () => watch && setOverlay(null));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepScreenOn(); // o navegador solta a trava ao sair da aba
  });

  // ----------------------------------------------------------------- início

  const canScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const canCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  const note = $('share-note');
  if (!canScreen && !canCamera) {
    $('btn-share-screen').disabled = true;
    $('btn-share-camera').disabled = true;
    note.textContent = window.isSecureContext
      ? 'Este navegador não permite compartilhar. Você ainda pode ver outro dispositivo.'
      : 'Para compartilhar, abra esta página por https:// (ou por http://localhost no computador onde o servidor está rodando). Para ver outro dispositivo, funciona assim mesmo.';
    note.hidden = false;
  } else if (!canScreen) {
    $('btn-share-screen').hidden = true;
    $('btn-share-camera').classList.add('primary');
    note.textContent = 'Este navegador não permite compartilhar a tela (comum em celulares), mas você pode compartilhar a câmera.';
    note.hidden = false;
  }

  try {
    $('join-name').value = localStorage.getItem('telalink:name') || '';
  } catch {
    /* sem armazenamento */
  }

  // Link compartilhado (?c=123456789): já entra pedindo acesso.
  const linked = digits(new URLSearchParams(location.search).get('c') || '');
  if (linked) {
    $('join-code').value = formatCode(linked);
    history.replaceState(null, '', location.pathname);
    if (linked.length === 9) startWatch(linked);
  }
})();
