'use strict';

// Controle remoto: transforma os eventos de quem assiste (mouse, teclado) em
// ordens para o Windows. Só funciona no Windows — em outros sistemas
// createInjector() devolve null e o app continua funcionando só para ver.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

// Flags da função SendInput do Windows.
const MOUSE = { MOVE: 0x0001, ABSOLUTE: 0x8000, WHEEL: 0x0800, HWHEEL: 0x1000 };
const BUTTONS = [
  [0x0002, 0x0004], // esquerdo: apertar, soltar
  [0x0020, 0x0040], // meio
  [0x0008, 0x0010], // direito
];
const KEY = { EXTENDED: 0x0001, UP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008 };

// KeyboardEvent.code do navegador -> código da tecla física ("scan code").
// Mandar a tecla física (e não a letra) faz o Windows aplicar o layout de
// teclado dele, como se a tecla tivesse sido apertada lá. Valores 0xE0xx são
// teclas "estendidas".
const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d,
  NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  IntlRo: 0x73, NumpadComma: 0x7e, // teclas "/ ?" e "." do teclado ABNT2
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, AltRight: 0xe038,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052,
  Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class Injector {
  // write(linha) entrega uma ordem ao ajudante (input-agent.cs).
  constructor(write) {
    this.write = write;
  }

  // x e y de 0 a 1, relativos à tela principal.
  move(x, y) {
    const abs = (v) => Math.round(clamp(v, 0, 1) * 65535);
    this.write(`m ${abs(x)} ${abs(y)} 0 ${MOUSE.MOVE | MOUSE.ABSOLUTE}`);
  }

  // button: 0 esquerdo, 1 meio, 2 direito. Devolve false se não existe.
  button(button, down) {
    const flags = Number.isInteger(button) ? BUTTONS[button] : undefined;
    if (!flags) return false;
    this.write(`m 0 0 0 ${flags[down ? 0 : 1]}`);
    return true;
  }

  // dx e dy em pixels, como no evento "wheel" do navegador (dy > 0 = descer).
  // O Windows conta 120 por "clique" da rodinha, com o sinal invertido.
  wheel(dx, dy) {
    const units = (v) => Math.round(clamp(v, -1000, 1000) * 1.2);
    if (units(dy)) this.write(`m 0 0 ${-units(dy)} ${MOUSE.WHEEL}`);
    if (units(dx)) this.write(`m 0 0 ${units(dx)} ${MOUSE.HWHEEL}`);
  }

  // code: KeyboardEvent.code. Devolve false para teclas desconhecidas.
  key(code, down) {
    if (!Object.hasOwn(SCAN, code)) return false;
    const scan = SCAN[code];
    const flags = KEY.SCANCODE | (scan > 0xff ? KEY.EXTENDED : 0) | (down ? 0 : KEY.UP);
    this.write(`k 0 ${scan & 0xff} ${flags}`);
    return true;
  }

  // Texto pronto (teclado virtual do celular), caractere por caractere.
  text(text) {
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit < 0x20 || unit === 0x7f) continue; // sem caracteres de controle
      this.write(`k 0 ${unit} ${KEY.UNICODE}`);
      this.write(`k 0 ${unit} ${KEY.UNICODE | KEY.UP}`);
    }
  }
}

// Compila (uma vez) e inicia o ajudante. O compilador csc.exe faz parte do
// .NET Framework 4, que já vem instalado no Windows 10 e 11.
function startWindowsAgent() {
  const source = path.join(__dirname, 'input-agent.cs');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
  const dir = path.join(__dirname, '.telalink');
  const exe = path.join(dir, `input-agent-${hash}.exe`);

  if (!fs.existsSync(exe)) {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const csc = ['Framework64', 'Framework']
      .map((framework) => path.join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
      .find((file) => fs.existsSync(file));
    if (!csc) throw new Error('compilador csc.exe (.NET Framework 4) não encontrado');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(csc, ['/nologo', '/optimize', '/target:exe', `/out:${exe}`, source], {
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  // O ajudante termina sozinho quando o servidor fecha (a entrada dele acaba).
  const child = spawn(exe, [], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
  child.stdin.on('error', () => {});
  return child;
}

// Devolve um Injector pronto, ou null se este computador não pode ser controlado.
function createInjector() {
  if (process.platform !== 'win32') return null;
  let child;
  try {
    child = startWindowsAgent();
  } catch (err) {
    const detail = err.stdout?.toString().trim() || err.message;
    console.warn(`Controle remoto indisponível: ${detail}`);
    return null;
  }
  child.on('error', (err) => console.warn(`Controle remoto parou: ${err.message}`));
  child.on('exit', () => console.warn('Controle remoto parou: o ajudante foi encerrado.'));
  return new Injector((line) => {
    if (child.exitCode === null && child.stdin.writable) child.stdin.write(`${line}\n`);
  });
}

module.exports = { Injector, createInjector };
