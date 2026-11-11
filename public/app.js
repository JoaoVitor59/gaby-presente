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

  // Chave do controle remoto: vem no link que o servidor mostra no terminal
  // (#chave=...). Sai da barra de endereço para não ser copiada sem querer.
  let controlKey = null;
  try {
    controlKey = sessionStorage.getItem('telalink:key');
  } catch {
    /* sem armazenamento */
  }
  function readKeyFromLink() {
    const found = location.hash.match(/chave=([0-9a-f]{32})/);
    if (!found) return;
    controlKey = found[1];
    try {
      sessionStorage.setItem('telalink:key', controlKey);
    } catch {
      /* sem armazenamento: vale até recarregar a página */
    }
    history.replaceState(null, '', location.pathname + location.search);
  }
  readKeyFromLink();
  // colar o link numa aba que já está no TelaLink não recarrega a página
  window.addEventListener('hashchange', readKeyFromLink);

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

  // { stream, kind, ws, id, control, canControl, peers: Map(peer -> { name, state, link, control }) }
  let host = null;

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
      let [label, tone] = info.control ? ['Controlando este computador', 'wait'] : PEER_STATUS[info.state];
      if (info.sameMachine && info.state === 'connected') {
        label = 'Assistindo neste mesmo computador — para controlar, entre por outro aparelho';
      }
      if (info.state === 'pending') pending++;

      const item = document.createElement('li');
      item.className = `peer ${info.state}${info.control ? ' controlling' : ''}`;

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
        if (host.canControl && !info.sameMachine && (info.state === 'connected' || info.control)) {
          button(info.control ? 'Tirar controle' : 'Dar controle', '', () => toggleControl(peer));
        }
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

  function toggleControl(peer) {
    const info = host?.peers.get(peer);
    if (!info || !host.canControl) return;
    info.control = !info.control;
    sendTo(host.ws, { type: 'control', peer, on: info.control });
    renderPeers();
  }

  // Explica, para quem compartilha, se dá para entregar o controle e por quê.
  function controlNote() {
    if (host.kind !== 'screen') return '';
    if (host.control === 'unsupported') {
      return 'Controle remoto indisponível: ele só funciona quando o TelaLink está rodando em um computador com Windows.';
    }
    if (host.control !== 'ok') {
      return 'Esta página não foi aberta pelo link com chave do terminal, então o código fixo, a senha e o controle remoto não valem aqui. Encerre, abra o link "Neste computador" que aparece no terminal e compartilhe de novo.';
    }
    if (!host.canControl) {
      return 'Para poder dar o controle do mouse e teclado, compartilhe a tela inteira (não uma janela ou aba).';
    }
    return 'Você pode dar o controle do mouse e teclado a quem estiver assistindo, e tirar quando quiser. Com mais de um monitor, compartilhe o principal.';
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
      host.control = msg.control;
      // O mouse remoto é posicionado em relação à tela inteira, então só faz
      // sentido se for ela que está sendo compartilhada. (Nem todo navegador
      // informa o que foi escolhido; na dúvida, deixa.)
      const surface = host.stream.getVideoTracks()[0].getSettings().displaySurface;
      host.canControl = msg.control === 'ok' && host.kind === 'screen' && (!surface || surface === 'monitor');
      $('host-code').textContent = formatCode(msg.id);
      $('control-note').textContent = controlNote();
      $('control-note').hidden = !$('control-note').textContent;
      $('host-note').textContent = msg.unattended
        ? 'Este é o código fixo deste computador. Quem digitar o código e a senha entra direto, sem pedir permissão.'
        : msg.fixed
          ? 'Este é o código fixo deste computador. Ninguém entra sem a sua permissão.'
          : 'Passe o código ou o link para quem vai assistir. Ninguém entra sem a sua permissão.';
    } else if (msg.type === 'request') {
      host.peers.set(msg.peer, {
        name: msg.name,
        state: 'pending',
        link: null,
        control: false,
        sameMachine: msg.sameMachine === true,
      });
      renderPeers();
      // quem entrou com a senha não espera permissão e já recebe o controle
      if (msg.auto) {
        acceptPeer(msg.peer);
        if (host.canControl && !msg.sameMachine) toggleControl(msg.peer);
      }
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
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 30 }, displaySurface: 'monitor' }, // já abre em "Tela inteira"
              audio: true,
            })
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
    host = { stream, kind, ws, id: null, control: null, canControl: false, peers: new Map() };
    ws.onopen = () => sendTo(ws, { type: 'host', key: controlKey });
    ws.onmessage = (event) => host?.ws === ws && onHostMessage(JSON.parse(event.data));
    ws.onclose = () => {
      if (host?.ws === ws) stopShare('A conexão com o servidor caiu e o compartilhamento foi encerrado.');
    };

    $('local-video').srcObject = stream;
    $('host-code').textContent = '— — —';
    $('control-note').hidden = true;
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
      case 'control':
        setControl(msg.on === true);
        break;
      case 'error':
        endWatch(
          null,
          {
            full: 'Esse compartilhamento já atingiu o limite de pessoas.',
            password: $('join-password').value ? 'Senha incorreta.' : 'Esse computador pede senha.',
            locked: 'Muitas senhas erradas. A entrada por senha foi travada até o TelaLink ser reiniciado naquele computador.',
          }[msg.code] ?? 'Não encontramos nenhum compartilhamento com esse código. Confira os números.',
        );
        if (msg.code === 'password') $('join-password').focus();
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
    const password = $('join-password').value || undefined;
    ws.onopen = () => sendTo(ws, { type: 'join', id: code, name, password });
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
    setControl(false, true);
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
    else $('toast').hidden = true; // não deixa um aviso antigo sobre a tela inicial
  }

  // ------------------------------------------------------- controle remoto
  // Quando quem compartilha dá o controle, o mouse, o toque e o teclado sobre
  // o vídeo são enviados para o computador remoto.

  let controlling = false;
  let pendingMove = null;
  let typed = ''; // o que o teclado do celular já mandou
  const stage = $('stage');
  const kbd = $('kbd-proxy');

  const sendInput = (data) => {
    if (watch && controlling) sendTo(watch.ws, { type: 'input', ...data });
  };
  const tapKey = (code) => {
    sendInput({ kind: 'key', code, down: true });
    sendInput({ kind: 'key', code, down: false });
  };

  function setControl(on, silent) {
    if (controlling === on) return;
    if (!on) sendInput({ kind: 'release' });
    controlling = on;
    pendingMove = null;
    kbd.value = typed = '';
    stage.classList.toggle('controlling', on);
    $('watch-mode').textContent = on ? 'Controlando' : 'Vendo';
    $('btn-keyboard').hidden = !(on && matchMedia('(pointer: coarse)').matches);
    if (on) {
      remoteVideo.focus({ preventScroll: true });
    } else {
      kbd.blur();
      navigator.keyboard?.unlock?.();
    }
    if (!silent) toast(on ? 'Você recebeu o controle do mouse e teclado.' : 'O controle foi retirado.');
  }

  // Posição do ponteiro dentro da imagem (0 a 1), descontando as faixas pretas.
  function videoPoint(event) {
    const { videoWidth, videoHeight } = remoteVideo;
    if (!videoWidth || !videoHeight) return null;
    const box = remoteVideo.getBoundingClientRect();
    const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width;
    const y = (event.clientY - box.top - (box.height - height) / 2) / height;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return { x: clamp(x), y: clamp(y), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  remoteVideo.addEventListener('pointermove', (event) => {
    const point = controlling && videoPoint(event);
    if (!point) return;
    // no máximo um movimento por quadro
    if (!pendingMove) {
      requestAnimationFrame(() => {
        if (pendingMove) sendInput({ kind: 'move', ...pendingMove });
        pendingMove = null;
      });
    }
    pendingMove = { x: point.x, y: point.y };
  });

  remoteVideo.addEventListener('pointerdown', (event) => {
    const point = controlling && videoPoint(event);
    if (!point?.inside) return;
    event.preventDefault();
    // não tira o foco do teclado do celular, se ele estiver aberto
    if (document.activeElement !== kbd) remoteVideo.focus({ preventScroll: true });
    remoteVideo.setPointerCapture(event.pointerId);
    pendingMove = null;
    sendInput({ kind: 'button', button: event.button, down: true, x: point.x, y: point.y });
  });

  remoteVideo.addEventListener('pointerup', (event) => {
    const point = controlling && videoPoint(event);
    if (point) sendInput({ kind: 'button', button: event.button, down: false, x: point.x, y: point.y });
  });
  remoteVideo.addEventListener('pointercancel', () => sendInput({ kind: 'release' }));

  // o clique no vídeo não pode roubar o foco nem abrir o menu do navegador
  remoteVideo.addEventListener('mousedown', (event) => controlling && event.preventDefault());
  remoteVideo.addEventListener('contextmenu', (event) => controlling && event.preventDefault());

  remoteVideo.addEventListener(
    'wheel',
    (event) => {
      const point = controlling && videoPoint(event);
      if (!point) return;
      event.preventDefault();
      const unit = [1, 40, 800][event.deltaMode] ?? 1; // pixels, linhas ou páginas
      sendInput({ kind: 'wheel', dx: event.deltaX * unit, dy: event.deltaY * unit, x: point.x, y: point.y });
    },
    { passive: false },
  );

  // Teclado: só quando o foco está no vídeo (ou no campo do teclado do
  // celular), para os botões da página continuarem funcionando normalmente.
  function onKey(event, down) {
    if (!controlling) return;
    if (document.activeElement !== remoteVideo && document.activeElement !== kbd) return;
    if (event.code && event.code !== 'Unidentified') {
      event.preventDefault();
      sendInput({ kind: 'key', code: event.code, down });
    } else if (down && event.key === 'Enter') {
      // teclado virtual: não informa a tecla física
      event.preventDefault();
      tapKey('Enter');
    }
  }
  document.addEventListener('keydown', (event) => onKey(event, true));
  document.addEventListener('keyup', (event) => onKey(event, false));

  // Teclado do celular: compara o que está no campo com o que já foi mandado
  // e envia só a diferença (funciona também com corretor e sugestões).
  kbd.addEventListener('input', () => {
    const now = kbd.value;
    let same = 0;
    while (same < typed.length && same < now.length && typed[same] === now[same]) same++;
    for (let i = typed.length; i > same; i--) tapKey('Backspace');
    if (now.length > same) sendInput({ kind: 'text', text: now.slice(same) });
    typed = now;
  });
  kbd.addEventListener('beforeinput', (event) => {
    if (kbd.value === '' && event.inputType.startsWith('delete')) tapKey('Backspace');
  });
  kbd.addEventListener('blur', () => {
    kbd.value = typed = '';
  });
  $('btn-keyboard').addEventListener('click', () => kbd.focus({ preventScroll: true }));

  // Depois de usar um botão da barra (tela cheia, som), o teclado volta a
  // valer para o computador remoto sem precisar clicar no vídeo de novo.
  stage.addEventListener('click', (event) => {
    const button = event.target.closest('.stage-bar button');
    if (controlling && button && button.id !== 'btn-keyboard') remoteVideo.focus({ preventScroll: true });
  });

  // Saiu da página com algo apertado? Solta tudo no computador remoto.
  window.addEventListener('blur', () => sendInput({ kind: 'release' }));

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
    // em tela cheia o Chrome deixa capturar também Esc, Alt+Tab e a tecla Windows
    if (document.fullscreenElement && controlling) navigator.keyboard?.lock?.().catch(() => {});
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
