import * as THREE from 'three';
import {
  DIRECTION_VECTORS,
  type Channel,
  type CharacterSummary,
  type Direction,
  type ServerMessage,
  type WireEntity,
} from '@rc/shared';
import { Connection } from './net/connection';
import { GameScene } from './render/scene';
import { Terrain } from './render/terrain';
import { CharacterVisual } from './render/character';
import { isMoving, stepToward, type InterpolatedPosition } from './game/interpolation';

/**
 * Client glue: UI flow (login → character → world), the entity mirror driven
 * by snapshot + deltas (D-107), input → move intents (D-102), and the render
 * loop. The client renders what it is told and decides nothing.
 */

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const overlay = $('overlay');
const loginForm = $('login-form');
const charForm = $('char-form');
const statusMsg = $('status-msg');
const charList = $<HTMLUListElement>('char-list');
const hud = $('hud');
const chat = $('chat');
const chatLog = $('chat-log');
const chatBar = $('chat-bar');
const chatHint = $('chat-hint');
const chatInput = $<HTMLInputElement>('in-chat');
const declareInput = $<HTMLInputElement>('in-declare');

const defaultServer = `ws://${location.hostname || 'localhost'}:8080`;
$<HTMLInputElement>('in-server').value = localStorage.getItem('rc.server') ?? defaultServer;

function setStatus(text: string, isError = true): void {
  statusMsg.textContent = text;
  statusMsg.style.color = isError ? 'var(--bad)' : 'var(--dim)';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface EntityState {
  wire: WireEntity;
  render: InterpolatedPosition;
  visual: CharacterVisual;
}

const conn = new Connection();
let scene: GameScene | null = null;
let terrain: Terrain | null = null;
const entities = new Map<number, EntityState>();
let youId: number | null = null;
let areaName = '';
let coin = 0;
let inventory: Extract<ServerMessage, { t: 'inventory' }>['items'] = [];
let currentLanguage: string | null = null; // null = common

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

function beginAuth(kind: 'login' | 'register'): void {
  const server = $<HTMLInputElement>('in-server').value.trim();
  const username = $<HTMLInputElement>('in-user').value.trim();
  const password = $<HTMLInputElement>('in-pass').value;
  if (!username || !password) return setStatus('username and password required');
  localStorage.setItem('rc.server', server);
  setStatus('connecting…', false);
  conn.connect(server);
  conn.onOpen = () => {
    setStatus('', false);
    conn.send({ t: kind, username, password });
  };
}

$('btn-login').onclick = () => beginAuth('login');
$('btn-register').onclick = () => beginAuth('register');
$<HTMLInputElement>('in-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') beginAuth('login');
});

$('btn-create').onclick = () => {
  const name = $<HTMLInputElement>('in-charname').value.trim();
  if (!name) return setStatus('a character needs a name');
  conn.send({ t: 'create_character', name, appearanceSeed: Math.floor(Math.random() * 2 ** 31) });
};

function showCharacters(characters: CharacterSummary[]): void {
  loginForm.classList.add('hidden');
  charForm.classList.remove('hidden');
  charList.innerHTML = '';
  for (const c of characters) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${c.name}</span><span class="where">${c.areaId}</span>`;
    li.onclick = () => conn.send({ t: 'enter_world', characterId: c.id });
    charList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

conn.onClose = (reason) => {
  overlay.classList.remove('hidden');
  loginForm.classList.remove('hidden');
  charForm.classList.add('hidden');
  hud.classList.add('hidden');
  chat.classList.add('hidden');
  chatHint.classList.add('hidden');
  clearWorld();
  setStatus(`disconnected: ${reason}`);
};
conn.onProtocolError = (detail) => setStatus(`protocol error: ${detail}`);

conn.onMessage = (msg: ServerMessage) => {
  switch (msg.t) {
    case 'error':
      if (msg.code === 'auth_failed' || msg.code === 'username_taken') setStatus(msg.message);
      else if (msg.code === 'character_name_taken') setStatus(msg.message);
      else setStatus(`${msg.code}: ${msg.message}`);
      return;
    case 'auth_ok':
      localStorage.setItem('rc.token', msg.token);
      showCharacters(msg.characters);
      return;
    case 'character_created':
      conn.send({ t: 'enter_world', characterId: msg.character.id });
      return;
    case 'snapshot':
      applySnapshot(msg);
      return;
    case 'delta':
      for (const event of msg.events) applyEvent(event);
      return;
    case 'inventory':
      coin = msg.coin;
      inventory = msg.items;
      return;
    case 'speech':
      appendSpeech(msg);
      return;
    case 'item_text':
      appendDocument(msg.title, msg.text);
      return;
    case 'descriptor': {
      const e = entities.get(msg.entityId);
      if (e) e.wire.descriptor = msg.descriptor;
      return;
    }
    case 'narrate': {
      const line = document.createElement('div');
      line.className = 'line narration';
      line.textContent = msg.text;
      chatLog.appendChild(line);
      trimAndScrollChat();
      return;
    }
    case 'area_lighting':
      scene?.applyLighting(msg.lighting);
      return;
    case 'pong':
      return;
  }
};

// ---------------------------------------------------------------------------
// World mirror → visuals
// ---------------------------------------------------------------------------

function ensureScene(): GameScene {
  if (!scene) scene = new GameScene($('stage'));
  return scene;
}

function clearWorld(): void {
  for (const e of entities.values()) e.visual.dispose();
  entities.clear();
  if (terrain && scene) terrain.dispose(scene.scene);
  terrain = null;
  youId = null;
}

function addEntity(wire: WireEntity): void {
  const s = ensureScene();
  const visual = new CharacterVisual(wire.appearanceSeed, s.scene);
  visual.setPosition(wire.x, wire.y);
  visual.setFacing(wire.facing);
  visual.setPosture(wire.posture);
  visual.setPresentation(wire.presentation);
  entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
}

function applySnapshot(snap: Extract<ServerMessage, { t: 'snapshot' }>): void {
  const s = ensureScene();
  clearWorld();
  s.applyLighting(snap.area.lighting);
  terrain = new Terrain(snap.area, s.scene);
  for (const e of snap.entities) addEntity(e);
  youId = snap.you;
  areaName = snap.area.name;
  coin = snap.coin;
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  chat.classList.remove('hidden');
  chatHint.classList.remove('hidden');
  $('hud-area').textContent = areaName;
  appendSystemLine(`${snap.area.name}.`);
}

function applyEvent(event: { type: string } & Record<string, unknown>): void {
  if (event.type === 'entity_entered') {
    const wire = event.entity as WireEntity;
    if (!entities.has(wire.id)) addEntity(wire);
  } else if (event.type === 'entity_left') {
    const e = entities.get(event.id as number);
    if (e) {
      e.visual.dispose();
      entities.delete(event.id as number);
    }
  } else if (event.type === 'entity_moved') {
    const e = entities.get(event.id as number);
    if (e) {
      e.wire.x = event.x as number;
      e.wire.y = event.y as number;
      e.wire.facing = event.facing as Direction;
      e.wire.posture = 'standing';
      e.visual.setFacing(e.wire.facing);
      e.visual.setPosture('standing');
    }
  } else if (event.type === 'entity_emote') {
    const e = entities.get(event.id as number);
    if (e) {
      const posture = event.posture as WireEntity['posture'] | undefined;
      if (posture) {
        e.wire.posture = posture;
        e.visual.setPosture(posture);
      }
      e.visual.playTransients(event.transients as Parameters<typeof e.visual.playTransients>[0]);
    }
  } else if (event.type === 'entity_presentation') {
    const e = entities.get(event.id as number);
    if (e) {
      const state = event.state as WireEntity['presentation'];
      e.wire.presentation = state;
      e.visual.setPresentation(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Chat (D-306: a reading application first)
// ---------------------------------------------------------------------------

/** Renders *emote spans* italic-amber; everything else plain text. */
function renderSpeechText(target: HTMLElement, text: string): void {
  const parts = text.split(/(\*[^*]+\*)/g);
  for (const part of parts) {
    if (part.length === 0) continue;
    const span = document.createElement('span');
    if (part.startsWith('*') && part.endsWith('*')) {
      span.className = 'emote-text';
      span.textContent = part;
    } else {
      span.textContent = part;
    }
    target.appendChild(span);
  }
}

function appendSpeech(msg: Extract<ServerMessage, { t: 'speech' }>): void {
  const line = document.createElement('div');
  line.className = `line ${msg.channel}`;
  const who = document.createElement('span');
  who.className = 'who';
  const verb = msg.channel === 'whisper' ? 'whispers' : msg.channel === 'shout' ? 'shouts' : 'says';
  const tongue =
    msg.language === 'unknown'
      ? ' in an unfamiliar tongue'
      : msg.language !== 'Common'
        ? ` in ${msg.language}`
        : '';
  who.textContent = `${msg.speakerDescriptor} ${verb}`;
  line.appendChild(who);
  if (tongue) {
    const t = document.createElement('span');
    t.className = 'tongue';
    t.textContent = tongue;
    line.appendChild(t);
  }
  line.appendChild(document.createTextNode(': '));
  renderSpeechText(line, msg.text);
  chatLog.appendChild(line);
  if (msg.impression) {
    const imp = document.createElement('div');
    imp.className = 'line impression';
    imp.textContent =
      msg.impression === 'certain_false'
        ? 'You are certain that name is not their own.'
        : 'Something about that rings false.';
    chatLog.appendChild(imp);
  }
  trimAndScrollChat();
}

function appendSystemLine(text: string): void {
  const line = document.createElement('div');
  line.className = 'line system';
  line.textContent = text;
  chatLog.appendChild(line);
  trimAndScrollChat();
}

function appendDocument(title: string, text: string): void {
  const doc = document.createElement('div');
  doc.className = 'document';
  if (title) {
    const t = document.createElement('div');
    t.className = 'doc-title';
    t.textContent = title;
    doc.appendChild(t);
  }
  doc.appendChild(document.createTextNode(text));
  chatLog.appendChild(doc);
  trimAndScrollChat();
}

function trimAndScrollChat(): void {
  while (chatLog.childElementCount > 200) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat(): void {
  const raw = chatInput.value.trim();
  if (!raw) return;
  chatInput.value = '';

  // Slash commands — the placeholder UI until real inventory/interaction
  // panels exist. /w /y are channels; the rest are actions.
  if (raw.startsWith('/write ')) {
    const body = raw.slice(7);
    const sep = body.indexOf('|');
    const title = (sep >= 0 ? body.slice(0, sep) : 'A note').trim();
    const text = (sep >= 0 ? body.slice(sep + 1) : body).trim();
    if (text) conn.send({ t: 'write', title, text });
    return;
  }
  if (raw === '/read' || raw.startsWith('/read ')) {
    const wanted = raw.slice(5).trim().toLowerCase();
    const item = inventory.find(
      (i) => i.label && (wanted === '' || i.label.toLowerCase().includes(wanted)),
    );
    if (item) conn.send({ t: 'read_item', itemId: item.id });
    else appendSystemLine('You carry nothing written.');
    return;
  }
  if (raw.startsWith('/introduce ')) {
    const name = raw.slice(11).trim();
    const target = nearestOther();
    if (!name) return appendSystemLine('Introduce them as what?');
    if (!target) return appendSystemLine('There is nobody close enough to introduce.');
    conn.send({
      t: 'say',
      channel: 'say',
      text: `This is ${name}.`,
      introduce: { entityId: target, name },
      ...(currentLanguage ? { language: currentLanguage } : {}),
    });
    return;
  }
  if (raw === '/hood') {
    toggleHood();
    return;
  }
  if (raw.startsWith('/lang')) {
    const lang = raw.slice(5).trim();
    currentLanguage = lang === '' || lang === 'common' ? null : lang;
    appendSystemLine(`You will speak ${currentLanguage ?? 'common'}.`);
    return;
  }

  let channel: Channel = 'say';
  let text = raw;
  if (text.startsWith('/w ')) {
    channel = 'whisper';
    text = text.slice(3).trim();
  } else if (text.startsWith('/y ') || text.startsWith('/shout ')) {
    channel = 'shout';
    text = text.slice(text.indexOf(' ') + 1).trim();
  }
  if (!text) return;
  const declareAs = declareInput.value.trim();
  conn.send({
    t: 'say',
    channel,
    text,
    ...(currentLanguage ? { language: currentLanguage } : {}),
    ...(declareAs ? { declareAs } : {}),
  });
  declareInput.value = '';
  declareInput.classList.remove('armed');
}

/** Nearest other entity by chebyshev distance, within speech range. */
function nearestOther(): number | null {
  if (youId === null) return null;
  const you = entities.get(youId);
  if (!you) return null;
  let best: number | null = null;
  let bestDist = 11;
  for (const [id, e] of entities) {
    if (id === youId) continue;
    const d = Math.max(Math.abs(e.wire.x - you.wire.x), Math.abs(e.wire.y - you.wire.y));
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

function toggleHood(): void {
  if (youId === null) return;
  const you = entities.get(youId);
  if (!you) return;
  conn.send({
    t: 'set_presentation',
    state: you.wire.presentation === 'hooded' ? 'normal' : 'hooded',
  });
}

function chatOpen(): boolean {
  return chatBar.classList.contains('open');
}

declareInput.addEventListener('input', () => {
  declareInput.classList.toggle('armed', declareInput.value.trim().length > 0);
});

// ---------------------------------------------------------------------------
// Input → intent
// ---------------------------------------------------------------------------

const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('hidden') && !isTyping()) held.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());

function isTyping(): boolean {
  return document.activeElement instanceof HTMLInputElement;
}

// Enter opens the composer / sends; Escape closes it. Movement keys are
// ignored while typing.
window.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('hidden')) return;
  if (e.key === 'Enter') {
    if (!chatOpen()) {
      chatBar.classList.add('open');
      chatHint.classList.add('hidden');
      chatInput.focus();
    } else if (isTyping()) {
      sendChat();
      chatInput.blur();
      chatBar.classList.remove('open');
      chatHint.classList.remove('hidden');
    } else {
      chatInput.focus();
    }
    e.preventDefault();
  } else if (e.key === 'Escape' && chatOpen()) {
    chatBar.classList.remove('open');
    chatHint.classList.remove('hidden');
    chatInput.blur();
    declareInput.blur();
    held.clear();
  }
});

function heldDirection(): Direction | null {
  const n = held.has('w') || held.has('arrowup');
  const s = held.has('s') || held.has('arrowdown');
  const w = held.has('a') || held.has('arrowleft');
  const e = held.has('d') || held.has('arrowright');
  const dy = (s ? 1 : 0) - (n ? 1 : 0);
  const dx = (e ? 1 : 0) - (w ? 1 : 0);
  if (dx === 0 && dy === 0) return null;
  for (const [dir, v] of Object.entries(DIRECTION_VECTORS)) {
    if (v.x === dx && v.y === dy) return dir as Direction;
  }
  return null;
}

setInterval(() => {
  const dir = heldDirection();
  if (dir && conn.open && youId !== null) conn.send({ t: 'move', dir });
}, 90);

// Debug: runtime equipment swap on your own character (M1 requirement that
// equipment is geometry on bones, swappable live). Inventory drives this
// from M5.
window.addEventListener('keydown', (e) => {
  if (youId === null || isTyping()) return;
  const you = entities.get(youId);
  if (!you) return;
  if (e.key === '1') you.visual.setEquipment({ helm: !you.visual.equipment.helm });
  if (e.key === '2') you.visual.setEquipment({ pauldrons: !you.visual.equipment.pauldrons });
  if (e.key === '3') you.visual.setEquipment({ weapon: !you.visual.equipment.weapon });
  if (e.key === '4') you.visual.setEquipment({ cape: !you.visual.equipment.cape });
  if (e.key === 'h') toggleHood();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let t = 0;
const followPoint = new THREE.Vector3();

function stepFrame(dt: number): void {
  if (!scene) return;
  t += dt;
  const wind = 0.22 + Math.sin(t * 0.13) * 0.12;

  for (const e of entities.values()) {
    const target = { x: e.wire.x, y: e.wire.y };
    const moving = isMoving(e.render, target);
    stepToward(e.render, target, dt);
    e.visual.setPosition(e.render.x, e.render.y);
    e.visual.update(dt, t, moving, wind);
  }

  const you = youId !== null ? entities.get(youId) : undefined;
  if (you) {
    followPoint.set(you.render.x, 0, you.render.y);
    scene.follow(followPoint);
    $('hud-pos').textContent = `${you.wire.x},${you.wire.y}`;
    $('hud-coin').textContent = String(coin);
    $('hud-conn').textContent = conn.open ? '' : 'connection lost';
  }

  scene.render();
}

function frame(): void {
  requestAnimationFrame(frame);
  stepFrame(Math.min(clock.getDelta(), 0.033));
}
frame();

// ---------------------------------------------------------------------------
// Headless verification hook (D-114): automated checks pump frames and read
// mirror state without depending on requestAnimationFrame (which stops in
// non-composited tabs). Not part of the game surface.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __rc?: {
      step: (dt: number) => void;
      entities: () => { id: number; x: number; y: number; rx: number; ry: number }[];
      you: () => number | null;
      /** Sends through the real connection — background tabs throttle the
       * input timers, so automated checks inject intents directly. The
       * server validates everything regardless (D-102). */
      send: (msg: Parameters<Connection['send']>[0]) => void;
    };
  }
}
window.__rc = {
  step: stepFrame,
  entities: () =>
    [...entities.entries()].map(([id, e]) => ({
      id,
      x: e.wire.x,
      y: e.wire.y,
      rx: e.render.x,
      ry: e.render.y,
    })),
  you: () => youId,
  send: (msg) => conn.send(msg),
};
