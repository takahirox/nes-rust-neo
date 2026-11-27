import { loadCore } from './wasm.js';
import { biosSize, DiskSave, forgetBios, readBios, writeBios } from './disk-storage.js';
import { Sound } from './audio.js';
import { controls } from './controls.js';
import { createSaveControls } from './saves.js';
import { addProfile, hasStates, nativeKey, readProfiles, readState, writeProfiles } from './save-storage.js';
import {
  BatterySaves, identify, listGames, preferencesKey, remember, remembered, removeGame,
} from './storage.js';

const get = id => document.getElementById(id);
const presentation = get('game-presentation');
const screen = get('screen');
const canvas = screen.querySelector('canvas');
const context = canvas.getContext('2d', { alpha: false });
const image = context.createImageData(256, 240);
const picker = get('rom');
const gamePicker = get('cartridge-picker');
const gameButton = get('change-cartridge');
const library = get('library');
const play = get('play');
const diskSide = get('disk-side');
const diskToggle = get('disk-toggle');
const biosInput = get('bios');
const biosButton = get('open-bios');
const help = get('help');
const prefs = { scale: '3', display: 'crt', volume: 100, muted: false };
const sound = new Sound();
const saves = new BatterySaves();
const warnings = new Map();
const diskSideBytes = 65_500;
const maxGameBytes = 16 + 255 * diskSideBytes;
const frameMs = 1000 / 60.0988;
let core;
let active;
let pendingGame;
let biosRequest;
let biosRemembered = false;
let running = false;
let busy = false;
let restoringState = false;
let previous;
let budget = 0;
let lastSave = 0;
let noticeTimer;

function notice(message, duration) {
  clearTimeout(noticeTimer);
  get('status').textContent = message;
  if (duration) noticeTimer = setTimeout(() => notice(''), duration);
}

function warn(category, message) {
  if (message) warnings.set(category, message);
  else warnings.delete(category);
  const diskWarning = active?.diskSave?.failed
    ? `Could not save disk changes for ${active.name}. Keep this tab open and retry save storage.` : '';
  const saveWarning = [saves.warning, diskWarning].filter(Boolean).join(' ');
  const parts = [...warnings.values(), saveWarning].filter(Boolean);
  const text = parts.join(' ');
  if (get('warnings').textContent !== text) get('warnings').textContent = text;
  get('warnings').hidden = parts.length === 0;
  get('retry-save').hidden = Boolean(pendingGame?.conflict) || (!pendingGame && !saveWarning);
  const fullscreenWarning = get('fullscreen-save-message');
  if (fullscreenWarning.textContent !== saveWarning) fullscreenWarning.textContent = saveWarning;
  get('fullscreen-save-warning').hidden = !saveWarning;
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
const saveControls = createSaveControls({
  current: () => ({ active, busy, core }), operate, notice, releaseInput: pads.clear,
  focusSaveControl, restoreState, changeProfile, importProfile, removeProfile,
});

function focusSaveControl(control) {
  const focus = () => control.focus({ preventScroll: true });
  if (document.fullscreenElement !== presentation && presentation.contains(control)) {
    // Fullscreen styles can change a frame before fullscreenchange moves the controls back.
    document.addEventListener('fullscreenchange', focus, { once: true });
  } else {
    focus();
  }
}

function syncUI() {
  play.textContent = running ? 'Pause' : 'Play';
  play.disabled = !active || busy;
  get('reset').disabled = !active || busy;
  gameButton.disabled = !core || busy;
  get('open-file').disabled = !core || busy;
  get('retry-save').disabled = get('fullscreen-retry-save').disabled = busy;
  get('save-choices').disabled = busy;
  diskSide.disabled = diskToggle.disabled = busy;
  biosButton.disabled = get('forget-bios').disabled = get('cancel-bios').disabled = busy;
  for (const button of library.querySelectorAll('button')) button.disabled = busy;
  pads.setEnabled(enabled());
  saveControls.sync();
}

async function flushDisk(force = false) {
  const disk = active?.diskSave;
  if (disk?.dirty(core) && (force || (!disk.failed && !disk.writing))) {
    await disk.flush(core);
    warn('save', '');
  }
}

async function flushSave() {
  if (active?.diskSave) await flushDisk(true);
  saves.capture(active?.save, core);
  const writing = saves.flush(active?.save);
  warn('save', '');
  if (writing) {
    await writing;
    warn('save', '');
  }
}

function updateScanlines(height) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const samplesPerRow = Math.round(height * ratio) / canvas.height;
  const strength = Math.max(0, Math.min(1, samplesPerRow - 1.5));
  screen.style.setProperty('--scanline-height', `${height / canvas.height}px`);
  screen.style.setProperty('--scanline-opacity', String(strength * .07));
}

// Fade the scanlines at small output sizes, as in the SNES reference.
const picture = canvas.parentElement;
new ResizeObserver(([entry]) => updateScanlines(entry.contentRect.height)).observe(picture);
window.addEventListener('resize', () => updateScanlines(picture.getBoundingClientRect().height));

function applyPreferences() {
  screen.dataset.scale = get('scale').value = prefs.scale;
  screen.dataset.display = get('display').value = prefs.display;
  const volume = prefs.muted ? 0 : prefs.volume;
  get('volume').value = volume;
  get('volume').setAttribute('aria-valuetext', volume ? `${volume}%` : '0% (muted)');
  const mute = get('mute');
  const muteLabel = prefs.muted ? 'Unmute' : 'Mute';
  mute.setAttribute('aria-pressed', String(prefs.muted));
  mute.setAttribute('aria-label', muteLabel);
  mute.title = muteLabel;
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
    const games = await listGames();
    const nameCounts = new Map();
    for (const { name } of games) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    const rows = games.map(({ id, name }, index) => {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.textContent = name;
      open.type = 'button';
      open.onclick = () => {
        unlockAudio();
        operate(async () => {
          const record = await remembered(id);
          if (!record || record.id !== id) throw new Error('This game is missing from local storage.');
          await insert(record);
        });
      };
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.type = 'button';
      remove.className = 'remove-cartridge';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.onclick = () => operate(async () => {
        await removeGame(id);
        await refreshLibrary();
        get('library-status').textContent = `Removed ${name} from this browser’s list.`;
      });
      if (nameCounts.get(name) > 1) {
        const hash = document.createElement('small');
        hash.id = `rom-hash-${index}`;
        hash.textContent = id.slice(0, 12);
        open.setAttribute('aria-label', name);
        open.setAttribute('aria-describedby', hash.id);
        remove.setAttribute('aria-describedby', hash.id);
        open.append(hash);
      }
      row.append(open, remove);
      return row;
    });
    library.replaceChildren(...rows);
    get('my-cartridges').hidden = rows.length === 0;
    warn('library', '');
    syncUI();
  } catch {
    warn('library', 'The remembered game list is unavailable.');
  }
}

function clearTransient() {
  pads.clear();
  sound.clear();
  previous = undefined;
  budget = 0;
}

async function operate(operation, { message, preserveInput = false } = {}) {
  if (busy || !core) return;
  busy = true;
  get('library-status').textContent = '';
  if (!preserveInput) clearTransient();
  syncUI();
  try {
    await operation();
  } catch (error) {
    if (message) message.textContent = error.message;
    else if (gamePicker.matches(':popover-open')) get('library-status').textContent = error.message;
    else notice(error.message);
  } finally {
    busy = false;
    syncUI();
    if (gamePicker.matches(':popover-open')) {
      if (biosRequest || !gamePicker.contains(document.activeElement)) {
        (biosRequest ? biosButton : get('open-file')).focus({ preventScroll: true });
      }
    } else if (pendingGame?.conflict) {
      get('save-versions').querySelector('button').focus({ preventScroll: true });
    } else if (active && running && !document.hidden && !help.open && !saveControls.dialogOpen()) {
      canvas.focus({ preventScroll: true });
    }
  }
}

function showSaveChoices(record, rememberImport, conflict) {
  const options = get('save-versions');
  options.replaceChildren();
  get('save-choices').hidden = !conflict;
  if (!conflict) return;
  const addChoice = (label, raw) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => {
      unlockAudio();
      operate(() => insert(record, rememberImport, { conflict, raw }));
    };
    options.append(button);
  };
  conflict.versions.forEach(({ raw, savedAt }, index) => {
    const date = savedAt ? ` (${new Date(savedAt).toLocaleString()})` : '';
    addChoice(`Use recovery copy ${index + 1}${date}`, raw);
  });
  addChoice(conflict.base === null ? 'Start without a save' : 'Use the stored save', conflict.base);
}

function showDiskState() {
  if (!active?.diskSave) return;
  const side = core.requestedDiskSide();
  const requested = side < 0 ? null : side;
  const inserted = core.diskSide();
  const action = requested === null ? 'Insert' : 'Eject';
  const status = requested === null ? 'Drive empty' : inserted === requested ? 'Inserted' : 'Changing side…';
  if (diskToggle.textContent !== action) diskToggle.textContent = action;
  if (get('disk-status').textContent !== status) get('disk-status').textContent = status;
}

function selectDisk(side) {
  if (busy || !active?.diskSave || !core.selectDisk(side ?? -1)) return;
  showDiskState();
  if (enabled()) canvas.focus({ preventScroll: true });
  flushDisk(true);
}

diskSide.onchange = () => {
  if (active?.diskSave && core.requestedDiskSide() >= 0) selectDisk(Number(diskSide.value));
};
diskToggle.onclick = () => selectDisk(core.requestedDiskSide() < 0 ? Number(diskSide.value) : null);

function syncBios() {
  get('bios-required').hidden = get('cancel-bios').hidden = !biosRequest;
  get('forget-bios').hidden = !biosRemembered || Boolean(biosRequest);
  biosButton.textContent = biosRequest || !biosRemembered ? 'Choose FDS BIOS…' : 'Replace FDS BIOS…';
}

function clearBiosRequest() {
  if (biosRequest) core.discard();
  biosRequest = undefined;
  syncBios();
}

async function insert(record, rememberImport = false, selection, suppliedBios) {
  clearBiosRequest();
  const { name } = record;
  const bytes = new Uint8Array(record.bytes);
  const sides = core.inspect(bytes);
  const diskBytes = sides ? bytes.subarray(bytes.length - sides * diskSideBytes) : bytes;
  const hash = await identify(diskBytes);
  const id = sides ? `fds-${hash}` : hash;
  if (!rememberImport && record.id !== id) {
    core.discard();
    throw new Error('The remembered game no longer matches its identity.');
  }
  if (rememberImport) record = { ...record, id };
  let bios;
  if (sides) {
    let reason = '';
    try {
      bios = suppliedBios ?? await readBios();
      if (bios && (!(bios instanceof Uint8Array) || bios.byteLength !== biosSize)) {
        reason = 'The remembered FDS BIOS is invalid. Choose another file.';
        bios = undefined;
      }
    } catch {
      reason = 'Could not read the remembered FDS BIOS. Choose a local file.';
    }
    if (!bios) {
      biosRequest = { record, rememberImport };
      syncBios();
      if (!gamePicker.matches(':popover-open')) gamePicker.showPopover();
      biosButton.focus({ preventScroll: true });
      get('library-status').textContent = reason;
      return;
    }
  }
  const size = core.prepare(bios);
  await flushSave();
  const previousDisk = active?.diskSave;
  if (previousDisk && !await previousDisk.finish(core)) {
    core.discard();
    warn('save', '');
    throw new Error('Save the current disk changes before opening another game.');
  }
  let save;
  let diskSave;
  let profile;
  try {
    if (size) {
      // Take the FDS game-wide lock before reading the selected profile.
      if (sides) diskSave = previousDisk?.id === id ? previousDisk : await DiskSave.open(id);
      const catalog = readProfiles(id);
      profile = catalog.profiles.find(item => item.id === catalog.selected);
      const key = nativeKey(id, profile.id);
      if (sides) await diskSave.load(key, core);
      else save = await saves.open(key, name, size, core, selection);
    }
  } catch (error) {
    core.discard();
    if (diskSave && diskSave !== previousDisk) await diskSave.close();
    pendingGame = { record, rememberImport };
    showSaveChoices();
    gamePicker.hidePopover();
    const kind = sides ? 'disk progress' : 'battery save';
    warn('restore', `Could not restore the ${kind} for ${name}. Existing data is protected. ${error.message}`);
    return;
  }
  if (save?.conflict) {
    core.discard();
    pendingGame = { record, rememberImport, conflict: save.conflict };
    gamePicker.hidePopover();
    showSaveChoices(record, rememberImport, save.conflict);
    const reason = selection ? `The available save versions for ${name} changed.` : `Multiple recovery copies exist for ${name}.`;
    warn('restore', `${reason} Choose the version to keep. This removes the other copies.`);
    return;
  }
  if (previousDisk && previousDisk !== diskSave) await previousDisk.close();
  core.activate();
  if (diskSave) diskSave.track(nativeKey(id, profile.id), core.saveRevision());
  if (save) save.revision = core.saveRevision();
  pendingGame = undefined;
  showSaveChoices();
  active = { id, name, size, sides, bios, record, profile, save, diskSave };
  core.draw(context, image);
  get('disk-controls').hidden = !sides;
  diskSide.replaceChildren(...Array.from({ length: sides }, (_, side) =>
    new Option(`Disk ${Math.floor(side / 2) + 1} — ${side % 2 ? 'B' : 'A'}`, String(side))));
  showDiskState();
  running = true;
  budget = frameMs;
  get('empty').hidden = true;
  get('inserted').textContent = name;
  get('inserted').title = name;
  gameButton.textContent = 'Change game';
  gamePicker.hidePopover();
  notice('');
  warn('restore', '');
  if (rememberImport) {
    try {
      await remember(record);
      await refreshLibrary();
    } catch {
      warn('library', 'This game could not be remembered. It can still be played.');
    }
  }
}

async function flushRequired() {
  await flushSave();
  if (active.diskSave?.dirty(core) || active.save?.pending) {
    throw new Error('Save the current progress before continuing. Use Retry save storage and try again.');
  }
}

function nativeBytes(candidate = false) {
  return active.diskSave ? core.diskSave(candidate) : core.saveBytes(candidate);
}

function writeNative(profile, bytes) {
  const key = nativeKey(active.id, profile.id);
  return active.diskSave ? active.diskSave.write(key, bytes) : saves.writeProfile(key, bytes);
}

function removeNative(profile) {
  const key = nativeKey(active.id, profile.id);
  return active.diskSave ? active.diskSave.remove(key) : saves.removeProfile(key);
}

async function persistNewProfile(catalog, profile, bytes, select = false) {
  await writeNative(profile, bytes);
  try {
    const save = select && !active.diskSave
      ? await saves.open(nativeKey(active.id, profile.id), active.name, active.size, core)
      : undefined;
    if (select) catalog.selected = profile.id;
    writeProfiles(active.id, catalog);
    return save;
  } catch (error) {
    // The new key is still private to this operation.
    await removeNative(profile).catch(() => {});
    throw error;
  }
}

async function prepareProfile(profile, bytes) {
  core.inspect(new Uint8Array(active.record.bytes));
  core.prepare(active.bios);
  if (profile) {
    const key = nativeKey(active.id, profile.id);
    if (active.diskSave) await active.diskSave.load(key, core);
    else {
      const session = await saves.open(key, active.name, active.size, core);
      if (session.conflict) {
        throw new Error('This profile has multiple recovery copies. Close other emulator tabs and try again.');
      }
      return session;
    }
  } else if (bytes) {
    if (active.diskSave) core.restoreDisk(bytes, true);
    else if (!core.restore(bytes, true)) throw new Error(`Choose a raw ${active.size}-byte SRAM file from this ROM.`);
  }
}

function activatePrepared() {
  core.activate();
  if (active.diskSave) {
    active.diskSave.track(nativeKey(active.id, active.profile.id), core.saveRevision());
    const requested = core.requestedDiskSide();
    diskSide.value = String(Math.max(0, requested));
    showDiskState();
  }
  if (active.save) active.save.revision = core.saveRevision();
  clearTransient();
  core.draw(context, image);
  warn('save', '');
}

async function changeProfile({ id, duplicate } = {}) {
  if (id === active.profile.id) return;
  try {
    await flushRequired();
    const catalog = readProfiles(active.id);
    let profile = catalog.profiles.find(item => item.id === id);
    if (id && !profile) throw new Error('This profile is unavailable.');
    let save = await prepareProfile(profile, duplicate ? nativeBytes() : undefined);
    if (profile) {
      catalog.selected = profile.id;
      writeProfiles(active.id, catalog);
    } else {
      profile = addProfile(catalog);
      save = await persistNewProfile(catalog, profile, nativeBytes(true), true);
    }
    Object.assign(active, { profile, save });
    activatePrepared();
    notice(`Restarted with ${profile.name}.`);
  } finally {
    core.discard();
  }
}

async function importProfile(bytes) {
  try {
    await prepareProfile(undefined, bytes);
    const catalog = readProfiles(active.id);
    const profile = addProfile(catalog);
    await persistNewProfile(catalog, profile, nativeBytes(true));
    return profile;
  } finally {
    core.discard();
  }
}

async function removeProfile(profile, confirmRemoval) {
  const catalog = readProfiles(active.id);
  if (await hasStates({ game: active.id, profile: profile.id })) {
    throw new Error(`Remove the saved states for ${profile.name} before removing this profile.`);
  }
  if (!await confirmRemoval(`Remove ${profile.name} and its game save data?`)) return;
  const updated = { ...catalog, profiles: catalog.profiles.filter(item => item.id !== profile.id) };
  try {
    let replacement;
    let newProfile;
    let save;
    if (profile.id === active.profile.id) {
      await flushRequired();
      replacement = updated.profiles[0];
      save = await prepareProfile(replacement);
      if (replacement) {
        updated.selected = replacement.id;
      } else {
        replacement = newProfile = addProfile(updated);
      }
    }
    if (newProfile) save = await persistNewProfile(updated, newProfile, nativeBytes(true), true);
    else writeProfiles(active.id, updated);
    try {
      await removeNative(profile);
    } catch (error) {
      // Keep the original record reachable if native storage rejects the deletion.
      writeProfiles(active.id, catalog);
      if (newProfile) await removeNative(newProfile).catch(() => {});
      throw error;
    }
    if (replacement) {
      Object.assign(active, { profile: replacement, save });
      activatePrepared();
    }
    return true;
  } finally {
    core.discard();
  }
}

function sameBytes(first, second) {
  return first.length === second.length && first.every((value, i) => value === second[i]);
}

async function preserveDisplacedProgress(copies) {
  if (!copies.length) return;
  const catalog = readProfiles(active.id);
  const written = [];
  try {
    for (const { source, bytes } of copies) {
      const profile = addProfile(catalog, source);
      await writeNative(profile, bytes);
      written.push(profile);
    }
    writeProfiles(active.id, catalog);
  } catch (error) {
    // Publish the recovery profiles only after all copies have been stored.
    for (const profile of written) await removeNative(profile).catch(() => {});
    throw error;
  }
}

async function restoreNativeProgress() {
  const restored = nativeBytes(true);
  const live = nativeBytes();
  const stored = active.diskSave
    ? await active.diskSave.readProfile(nativeKey(active.id, active.profile.id))
    : await saves.readProfile(active.save);
  const matchesLive = sameBytes(restored, live);
  const copies = [];
  if (!matchesLive) copies.push({ source: 'Current progress', bytes: live });
  if (stored && !sameBytes(stored, restored) && !sameBytes(stored, live)) {
    copies.push({ source: 'Last saved progress', bytes: stored });
  }
  await preserveDisplacedProgress(copies);
  if (matchesLive) {
    // Persist matching live bytes before activation resets the save revision.
    await flushRequired();
  } else if (active.diskSave) {
    await writeNative(active.profile, restored);
  } else {
    await saves.replace(active.save, restored);
  }
  return copies.length;
}

async function restoreState(entry) {
  // Defer lifecycle saves while the load checks and stores native progress.
  restoringState = true;
  try {
    core.prepareSnapshot(await readState(entry));
    let recoveries = 0;
    if (active.profile) {
      try {
        recoveries = await restoreNativeProgress();
      } catch (error) {
        throw new Error(`State load stopped because save data could not be stored. Check browser storage and retry. ${error.message}`);
      }
    }
    activatePrepared();
    if (recoveries > 1) notice('State loaded. Previous progress is in Save data as recovery profiles.');
    else if (recoveries) notice('State loaded. Previous progress is in Save data as a recovery profile.');
    else notice('State loaded.', 3000);
  } finally {
    core.discard();
    restoringState = false;
  }
}

function openPicker() {
  unlockAudio();
  gamePicker.hidePopover();
  picker.value = '';
  picker.click();
}

get('open-file').onclick = openPicker;
gamePicker.addEventListener('beforetoggle', event => {
  if (event.newState === 'open') {
    pads.clear();
    get('library-status').textContent = warnings.get('library') || '';
    readBios().then(bios => {
      biosRemembered = bios != null;
      syncBios();
    }).catch(() => {});
  } else {
    clearBiosRequest();
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
    if (file.size > maxGameBytes) throw new Error('Game file exceeds the maximum supported image size.');
    const bytes = await file.arrayBuffer();
    await insert({ name: file.name, bytes }, true);
  });
});

biosButton.onclick = () => {
  unlockAudio();
  biosInput.value = '';
  biosInput.click();
};
get('cancel-bios').onclick = () => {
  clearBiosRequest();
  gamePicker.hidePopover();
  notice('Disk load cancelled.');
  if (active) canvas.focus({ preventScroll: true });
};
get('forget-bios').onclick = () => operate(async () => {
  await forgetBios();
  biosRemembered = false;
  syncBios();
  get('library-status').textContent = 'The remembered FDS BIOS was removed.';
});
biosInput.addEventListener('cancel', () => {
  get('library-status').textContent = 'BIOS selection cancelled.';
  biosButton.focus({ preventScroll: true });
});
biosInput.addEventListener('change', () => {
  const [file] = biosInput.files;
  biosInput.value = '';
  if (!file) return;
  operate(async () => {
    if (file.size !== biosSize) throw new Error('The FDS BIOS must be exactly 8192 bytes (8 KiB).');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const request = biosRequest;
    try {
      await writeBios(bytes);
      biosRemembered = true;
      syncBios();
      warn('bios', '');
    } catch {
      warn('bios', 'Could not remember the FDS BIOS in this browser.');
    }
    if (request && request === biosRequest) await insert(request.record, request.rememberImport, undefined, bytes);
    else if (biosRemembered) get('library-status').textContent = 'The FDS BIOS was saved locally.';
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
    notice('The game stopped on a CPU jam.');
  }
  if (running) canvas.focus({ preventScroll: true });
  syncUI();
}
get('reset').onclick = () => {
  if (!active || busy) return;
  operate(async () => {
    if (active.profile) await flushRequired();
    restart();
  });
};
async function retryActiveSave() {
  if (active?.diskSave) await active.diskSave.finish(core);
  else await flushSave();
  if (await saves.retry(active?.save, core)) {
    restart();
    if (running) notice('Battery save restored. Game restarted.');
  }
  warn('save', '');
}
get('fullscreen-retry-save').onclick = () => operate(retryActiveSave);
get('retry-save').onclick = () => {
  if (!pendingGame) return operate(retryActiveSave);
  unlockAudio();
  const { record, rememberImport } = pendingGame;
  return operate(() => insert(record, rememberImport));
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
const exitFullscreen = get('exit-fullscreen');
const stateControls = get('state-controls');
const saveData = get('save-data');
const normalSaveData = saveData.parentElement;
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
exitFullscreen.onclick = () => document.exitFullscreen().catch(() => notice('Could not leave fullscreen.'));
document.addEventListener('fullscreenchange', () => {
  const expanded = document.fullscreenElement === presentation;
  for (const element of playerChrome) element.inert = expanded;
  if (expanded) {
    exitFullscreen.before(stateControls, saveData);
  } else {
    fullscreen.before(stateControls);
    normalSaveData.append(saveData);
  }
  pads.clear();
  // A native picker or browser shortcut can leave fullscreen while a dialog is open.
  if (saveControls.dialogOpen()) return;
  if (expanded) {
    const target = active ? canvas : exitFullscreen;
    target.focus({ preventScroll: true });
  } else if (fullscreenFromKeyboard || !active) {
    fullscreen.focus({ preventScroll: true });
  } else {
    canvas.focus({ preventScroll: true });
  }
});
document.addEventListener('visibilitychange', () => {
  clearTransient();
  if (!restoringState && (document.hidden || !busy)) flushSave();
  if (document.hidden) sound.suspend().catch(soundError);
  else if (running) sound.resume().catch(soundError);
  syncUI();
});
window.addEventListener('beforeunload', event => {
  const disk = active?.diskSave;
  if (disk?.dirty(core)) {
    event.preventDefault();
    event.returnValue = true;
  }
});
window.addEventListener('pagehide', () => {
  clearTransient();
  if (!restoringState) flushSave();
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
        notice('The game stopped on a CPU jam.');
        syncUI();
        break;
      }
      sound.queue(core.audio());
      drew = true;
    }
    if (drew) core.draw(context, image);
    showDiskState();
    flushDisk();
    if (now - lastSave >= 500 && !active.diskSave?.writing) {
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
