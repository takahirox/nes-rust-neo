import { loadCore } from './wasm.js';
import { Sound } from './audio.js';
import { controls } from './controls.js';
import {
  BatterySaves, identify, listCartridges, preferencesKey, remember, remembered, removeCartridge,
} from './storage.js';

const get = id => document.getElementById(id);
const presentation = get('game-presentation');
const screen = get('screen');
const canvas = screen.querySelector('canvas');
const context = canvas.getContext('2d', { alpha: false });
const image = context.createImageData(256, 240);
const picker = get('rom');
const cartridgePicker = get('cartridge-picker');
const cartridgeButton = get('change-cartridge');
const library = get('library');
const play = get('play');
const help = get('help');
const prefs = { scale: '3', display: 'crt', volume: 100, muted: false };
const sound = new Sound();
const saves = new BatterySaves();
const warnings = new Map();
const frameMs = 1000 / 60.0988;
let core;
let active;
let running = false;
let busy = false;
let previous;
let budget = 0;
let lastSave = 0;

function notice(message) {
  get('status').textContent = message;
}

function warn(category, message) {
  if (message) warnings.set(category, message);
  else warnings.delete(category);
  const parts = [...warnings.values(), saves.warning].filter(Boolean);
  const text = parts.join(' ');
  if (get('warnings').textContent !== text) get('warnings').textContent = text;
  get('warnings').hidden = parts.length === 0;
  get('retry-save').hidden = !saves.hasWarnings;
}

function soundError(error) {
  warn('audio', `Audio is unavailable (${error.message}).`);
}

function unlockAudio() {
  if (!document.hidden && !prefs.muted && !sound.active) {
    sound.unlock().then(() => {
      warn('audio', '');
      if (document.hidden) return sound.suspend();
    }).catch(soundError);
  }
}

function enabled() {
  return Boolean(active && running && !busy && !document.hidden);
}
const pads = controls(document.querySelector('.touch'), enabled, unlockAudio);

function syncUI() {
  play.textContent = running ? 'Pause' : 'Play';
  play.disabled = !active || busy;
  get('reset').disabled = !active || busy;
  cartridgeButton.disabled = !core;
  get('open-file').disabled = !core || busy;
  for (const button of library.querySelectorAll('button')) button.disabled = busy;
  pads.setEnabled(enabled());
}

function flushSave() {
  saves.capture(active?.save, core);
  saves.flush(active?.save);
  warn('save', '');
}

function applyPreferences() {
  screen.dataset.scale = get('scale').value = prefs.scale;
  screen.dataset.display = get('display').value = prefs.display;
  const volume = prefs.muted ? 0 : prefs.volume;
  get('volume').value = volume;
  get('volume').setAttribute('aria-valuetext', volume ? `${volume}%` : '0% (muted)');
  get('mute').setAttribute('aria-pressed', String(prefs.muted));
  get('mute').textContent = prefs.muted ? 'Unmute' : 'Mute';
  sound.settings(prefs.volume / 100, prefs.muted);
}

try {
  const stored = JSON.parse(localStorage.getItem(preferencesKey));
  if (stored) {
    if (['fit', '1', '2', '3'].includes(stored.scale)) prefs.scale = stored.scale;
    if (['pixel', 'crt'].includes(stored.display)) prefs.display = stored.display;
    if (Number.isFinite(stored.volume) && stored.volume > 0) prefs.volume = Math.min(100, stored.volume);
    prefs.muted = stored.muted === true || stored.volume === 0;
  }
} catch {
  warn('preferences', 'Could not read preferences from browser storage.');
}
applyPreferences();

function storePreferences() {
  applyPreferences();
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(prefs));
    warn('preferences', '');
  } catch {
    warn('preferences', 'Could not save preferences in this browser.');
  }
}

async function refreshLibrary() {
  try {
    const cartridges = await listCartridges();
    const rows = cartridges.map(({ id, name }) => {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.textContent = name;
      open.type = 'button';
      open.onclick = () => {
        unlockAudio();
        operate(async () => {
          const record = await remembered(id);
          if (!record) throw new Error('This ROM is missing from local storage.');
          if (await identify(record.bytes) !== id) throw new Error('The remembered ROM no longer matches its identity.');
          insert(record);
        });
      };
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.type = 'button';
      remove.className = 'remove-cartridge';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.onclick = () => operate(async () => {
        await removeCartridge(id);
        await refreshLibrary();
        get('library-status').textContent = `Removed ${name} from this browser’s list.`;
      });
      row.append(open, remove);
      return row;
    });
    library.replaceChildren(...rows);
    get('my-cartridges').hidden = rows.length === 0;
    warn('library', '');
    syncUI();
  } catch {
    warn('library', 'The remembered cartridge list is unavailable.');
  }
}

function clearTransient() {
  pads.clear();
  sound.clear();
  previous = undefined;
  budget = 0;
}

async function operate(operation) {
  if (busy || !core) return;
  busy = true;
  get('library-status').textContent = '';
  clearTransient();
  syncUI();
  try {
    await operation();
  } catch (error) {
    if (cartridgePicker.matches(':popover-open')) get('library-status').textContent = error.message;
    else notice(error.message);
  } finally {
    busy = false;
    syncUI();
    if (cartridgePicker.matches(':popover-open')) {
      if (!cartridgePicker.contains(document.activeElement)) get('open-file').focus({ preventScroll: true });
    } else if (active && running && !document.hidden && !help.open) {
      canvas.focus({ preventScroll: true });
    }
  }
}

function insert({ bytes, id, name }) {
  const size = core.prepare(new Uint8Array(bytes));
  flushSave();
  const save = saves.open(id, name, size, core);
  core.activate();
  if (save) save.revision = core.saveRevision();
  active = { name, save };
  running = true;
  budget = frameMs;
  get('empty').hidden = true;
  get('inserted').textContent = name;
  get('inserted').title = name;
  cartridgeButton.textContent = 'Change cartridge';
  cartridgePicker.hidePopover();
  notice('');
  warn('save', '');
}

function openPicker() {
  unlockAudio();
  cartridgePicker.hidePopover();
  picker.value = '';
  picker.click();
}

get('open-file').onclick = openPicker;
cartridgePicker.addEventListener('beforetoggle', event => {
  if (event.newState === 'open') {
    pads.clear();
    get('library-status').textContent = warnings.get('library') || '';
  }
});
picker.addEventListener('cancel', () => {
  notice('File selection cancelled.');
  if (active) canvas.focus({ preventScroll: true });
});
picker.addEventListener('change', () => {
  const [file] = picker.files;
  picker.value = '';
  if (!file) return;
  operate(async () => {
    if (file.size > 8 * 1024 * 1024) throw new Error('ROM file is too large (maximum 8 MiB).');
    const bytes = await file.arrayBuffer();
    const id = await identify(bytes);
    const record = { id, name: file.name, bytes };
    insert(record);
    try {
      await remember(record);
      await refreshLibrary();
    } catch {
      warn('library', 'This cartridge could not be remembered. It can still be played.');
    }
  });
});

play.onclick = () => {
  if (!active || busy) return;
  running = !running;
  clearTransient();
  if (running) {
    unlockAudio();
    canvas.focus({ preventScroll: true });
  } else {
    flushSave();
  }
  syncUI();
};
function restart() {
  clearTransient();
  core.reset();
  if (core.runFrame(0, 0)) core.draw(context, image);
  else {
    running = false;
    notice('The cartridge stopped on a CPU jam.');
  }
  if (running) canvas.focus({ preventScroll: true });
  syncUI();
}
get('reset').onclick = () => {
  if (!active || busy) return;
  flushSave();
  restart();
};
get('retry-save').onclick = () => {
  if (busy) return;
  flushSave();
  if (saves.retry(active?.save, core)) {
    restart();
    if (running) notice('Battery save restored. Cartridge restarted.');
  }
  warn('save', '');
};
help.addEventListener('toggle', () => {
  if (help.open) pads.clear();
});
help.addEventListener('keydown', event => {
  if (event.key === 'Escape' && help.open) {
    event.preventDefault();
    help.open = false;
    help.querySelector('summary').focus();
  }
});
help.addEventListener('focusout', event => {
  if (!help.contains(event.relatedTarget)) help.open = false;
});
document.addEventListener('pointerdown', event => {
  if (help.open && !help.contains(event.target)) help.open = false;
});
get('mute').onclick = () => {
  prefs.muted = !prefs.muted;
  storePreferences();
  if (!prefs.muted) unlockAudio();
};
get('volume').oninput = event => {
  const volume = Number(event.target.value);
  prefs.muted = volume === 0;
  if (volume) prefs.volume = volume;
  storePreferences();
  if (volume) unlockAudio();
};
get('scale').onchange = event => { prefs.scale = event.target.value; storePreferences(); };
get('display').onchange = event => { prefs.display = event.target.value; storePreferences(); };

const fullscreen = get('fullscreen');
const playerChrome = document.querySelectorAll('header, .toolbar, .game-entry, .notices');
let fullscreenFromKeyboard = false;
fullscreen.onclick = async event => {
  fullscreenFromKeyboard = event.detail === 0;
  try {
    await presentation.requestFullscreen();
  } catch {
    notice('Fullscreen is unavailable in this browser.');
  }
};
get('exit-fullscreen').onclick = () => document.exitFullscreen().catch(() => notice('Could not leave fullscreen.'));
document.addEventListener('fullscreenchange', () => {
  const expanded = document.fullscreenElement === presentation;
  for (const element of playerChrome) element.inert = expanded;
  pads.clear();
  if (expanded) {
    const target = active ? canvas : get('exit-fullscreen');
    target.focus({ preventScroll: true });
  } else if (fullscreenFromKeyboard || !active) {
    fullscreen.focus({ preventScroll: true });
  } else {
    canvas.focus({ preventScroll: true });
  }
});
document.addEventListener('visibilitychange', () => {
  clearTransient();
  flushSave();
  if (document.hidden) sound.suspend().catch(soundError);
  else if (running) sound.resume().catch(soundError);
  syncUI();
});
window.addEventListener('pagehide', () => {
  clearTransient();
  flushSave();
});

function animate(now) {
  if (enabled()) {
    if (previous !== undefined) budget = Math.min(5 * frameMs, budget + now - previous);
    previous = now;
    const input = pads.sample();
    let drew = false;
    while (budget >= frameMs) {
      budget -= frameMs;
      if (!core.runFrame(...input)) {
        running = false;
        clearTransient();
        flushSave();
        notice('The cartridge stopped on a CPU jam.');
        syncUI();
        break;
      }
      sound.queue(core.audio());
      drew = true;
    }
    if (drew) core.draw(context, image);
    if (now - lastSave >= 500) {
      flushSave();
      lastSave = now;
    }
  }
  requestAnimationFrame(animate);
}

try {
  core = await loadCore();
  syncUI();
  notice('');
  requestAnimationFrame(animate);
  await refreshLibrary();
} catch (error) {
  notice(`Could not start the emulator. ${error.message}`);
}
