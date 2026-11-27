import { listStates, readProfiles, readState, removeState, writeState } from './save-storage.js';

const get = id => document.getElementById(id);
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' });

function button(text, click, label) {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = text;
  if (label) control.setAttribute('aria-label', label);
  control.onclick = click;
  return control;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function thumbnail(core, candidate) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 240;
  const context = canvas.getContext('2d', { alpha: false });
  core.draw(context, context.createImageData(canvas.width, canvas.height), candidate);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture a state preview.')));
  });
}

const scopeFor = active => ({ game: active.id, profile: active.profile?.id ?? 'game' });
const scopeKey = ({ game, profile }) => `${game}/${profile}`;
const stateName = ({ time }) => date.format(time);

export function createSaveControls({
  current, operate, notice, releaseInput, focusSaveControl, restoreState, changeProfile, importProfile, removeProfile,
}) {
  const states = get('state-picker');
  const profiles = get('save-data-dialog');
  const confirmation = get('remove-save-dialog');
  const chooseState = get('choose-state');
  const chooseProfile = get('save-data');
  const stateMessage = get('state-message');
  const profileMessage = get('save-data-message');
  const stateList = get('state-history');
  const newState = get('new-state');
  const more = get('more-states');
  const previews = [];
  const targets = new Map();
  let view;

  function selected(active) {
    return active && targets.get(scopeKey(scopeFor(active)));
  }

  function select(scope, entry) {
    const key = scopeKey(scope);
    if (entry) targets.set(key, { game: entry.game, profile: entry.profile, time: entry.time, id: entry.id });
    else targets.delete(key);
    sync();
  }

  function sync() {
    const { active, busy } = current();
    const target = selected(active);
    get('state-controls').hidden = !active;
    chooseState.disabled = get('save-state').disabled = !active || busy;
    get('load-state').disabled = !target || busy;
    const label = get('state-target');
    const text = target ? shortDate.format(target.time) : 'New state';
    if (label.textContent !== text) label.textContent = text;
    label.title = target ? stateName(target) : '';
    chooseProfile.hidden = !active?.profile;
    chooseProfile.disabled = busy;
    const profileName = get('active-save-name');
    profileName.textContent = active?.profile?.name ?? '';
    profileName.title = profileName.textContent;
    for (const dialog of [states, profiles]) {
      for (const control of dialog.querySelectorAll('button')) control.disabled = busy;
    }
  }

  async function act(dialog, action, focused = document.activeElement) {
    const message = dialog === states ? stateMessage : profileMessage;
    message.textContent = '';
    await operate(action, { message, preserveInput: true });
    if (dialog.open) {
      const next = dialog.contains(focused) ? focused : dialog.querySelector('[autofocus]');
      next?.focus({ preventScroll: true });
    }
  }

  function confirmRemoval(message) {
    get('remove-save-message').textContent = message;
    confirmation.returnValue = '';
    confirmation.showModal();
    return new Promise(resolve => {
      confirmation.addEventListener('close', () => resolve(confirmation.returnValue === 'remove'), { once: true });
    });
  }

  function releasePreviews() {
    for (const url of previews.splice(0)) URL.revokeObjectURL(url);
  }

  function closeStates() {
    states.close();
    focusSaveControl(chooseState);
    view = undefined;
    releasePreviews();
    stateList.replaceChildren();
  }

  function appendEntry(scope, entry) {
    const label = stateName(entry);
    const row = document.createElement('li');
    const option = button('', () => {
      select(scope, entry);
      closeStates();
    }, `Select state saved ${label}`);
    option.className = 'state-option';
    option.setAttribute('aria-current', String(selected(current().active)?.id === entry.id));
    const image = document.createElement('img');
    const url = URL.createObjectURL(entry.thumbnail);
    previews.push(url);
    image.src = url;
    image.alt = '';
    image.width = 256;
    image.height = 240;
    const time = document.createElement('time');
    time.dateTime = new Date(entry.time).toISOString();
    time.textContent = label;
    const check = document.createElement('span');
    check.className = 'state-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    option.append(image, time, check);
    const exportButton = button('Export', () => act(states, async () => {
      const snapshot = await readState(entry);
      download(snapshot, `${entry.game.slice(0, 16)}-${entry.time}.nesstate`);
    }), `Export state saved ${label}`);
    const removeButton = button('Remove', () => act(states, async () => {
      if (!await confirmRemoval(`Remove the state saved ${label}?`)) return;
      await removeState(entry);
      if (selected(current().active)?.id === entry.id) select(scope, undefined);
      await openHistory();
      stateMessage.textContent = 'State removed.';
    }), `Remove state saved ${label}`);
    row.append(option, exportButton, removeButton);
    stateList.append(row);
  }

  async function renderPage(history) {
    more.hidden = true;
    try {
      const page = await listStates(history.scope, history.next);
      if (view !== history) return;
      for (const entry of page.entries) appendEntry(history.scope, entry);
      history.next = page.next;
      more.hidden = !page.next;
    } catch (error) {
      if (view === history) stateMessage.textContent = `Could not read save states. ${error.message}`;
    }
  }

  function openHistory() {
    releasePreviews();
    stateList.replaceChildren();
    const { active } = current();
    newState.setAttribute('aria-current', String(!selected(active)));
    return renderPage(view = { scope: scopeFor(active) });
  }

  chooseState.onclick = () => {
    stateMessage.textContent = '';
    releaseInput();
    states.showModal();
    openHistory();
  };
  get('close-state-picker').onclick = closeStates;
  get('state-picker-backdrop').onclick = () => { if (!current().busy) closeStates(); };
  states.oncancel = event => {
    if (event.target !== states) return;
    event.preventDefault();
    if (!current().busy) closeStates();
  };
  newState.onclick = () => {
    select(view.scope, undefined);
    closeStates();
  };
  more.onclick = () => { if (view) renderPage(view); };

  get('save-state').onclick = () => operate(async () => {
    try {
      const { active, core } = current();
      const scope = scopeFor(active);
      const snapshot = core.snapshot();
      const preview = await thumbnail(core);
      const entry = await writeState(scope, snapshot, preview, selected(active));
      if (!entry) {
        select(scope, undefined);
        throw new Error('The selected state is unavailable. Save again to create a new entry.');
      }
      select(scope, entry);
      notice('State saved.', 3000);
    } catch (error) {
      throw new Error(`Could not save the state. Check browser storage and try again. ${error.message}`);
    }
  }, { preserveInput: true });

  get('load-state').onclick = () => operate(async () => {
    const entry = selected(current().active);
    try {
      await restoreState(entry);
    } catch (error) {
      if (error.name === 'StateUnavailable') select(entry, undefined);
      const detail = error.name === 'QuotaExceededError'
        ? 'Browser storage is full. Free up space and retry.'
        : error.message;
      throw new Error(`Could not load the state. ${detail}`);
    }
  }, { preserveInput: true });

  const stateFile = get('state-file');
  const importState = get('import-state');
  importState.onclick = () => stateFile.click();
  stateFile.oncancel = () => { if (states.open) importState.focus({ preventScroll: true }); };
  stateFile.onchange = () => {
    const [file] = stateFile.files;
    stateFile.value = '';
    if (!file || !states.open) return;
    act(states, async () => {
      const { active, core } = current();
      if (file.size > core.snapshotLimit()) throw new Error('This state file exceeds the supported size.');
      const snapshot = new Uint8Array(await file.arrayBuffer());
      try {
        core.prepareSnapshot(snapshot);
        const preview = await thumbnail(core, true);
        await writeState(scopeFor(active), snapshot, preview);
      } finally {
        core.discard();
      }
      await openHistory();
      stateMessage.textContent = 'State imported. Select it and use Load to restore it.';
    }, importState);
  };

  function renderProfiles() {
    const { active } = current();
    const { profiles: available } = readProfiles(active.id);
    get('save-profiles').replaceChildren(...available.map(profile => {
      const row = document.createElement('li');
      const option = button(profile.name, () => restartWith({ id: profile.id }));
      if (active.profile.id === profile.id) option.setAttribute('aria-current', 'true');
      const remove = button('Remove', () => act(profiles, async () => {
        if (await removeProfile(profile, confirmRemoval)) {
          renderProfiles();
          profileMessage.textContent = `Removed ${profile.name}.`;
        }
      }), `Remove ${profile.name}`);
      row.append(option, remove);
      return row;
    }));
  }

  function closeProfiles() {
    profiles.close();
    focusSaveControl(chooseProfile);
  }

  async function restartWith(options) {
    let restarted = false;
    await act(profiles, async () => {
      await changeProfile(options);
      restarted = true;
    });
    if (restarted) closeProfiles();
  }

  chooseProfile.onclick = () => {
    const { active } = current();
    get('save-data-guide').textContent = active.diskSave
      ? 'Use disk save files with the same original FDS image.'
      : `Use raw ${active.size}-byte SRAM files from this same ROM.`;
    profileMessage.textContent = '';
    get('save-profiles').replaceChildren();
    releaseInput();
    profiles.showModal();
    try { renderProfiles(); }
    catch (error) { profileMessage.textContent = error.message; }
  };
  get('close-save-data').onclick = closeProfiles;
  profiles.oncancel = event => {
    if (event.target !== profiles) return;
    event.preventDefault();
    if (!current().busy) closeProfiles();
  };
  get('new-save-profile').onclick = () => restartWith();
  get('duplicate-save-profile').onclick = () => restartWith({ duplicate: true });
  get('export-save-data').onclick = () => act(profiles, () => {
    const { active, core } = current();
    const bytes = active.diskSave ? core.diskSave() : core.saveBytes();
    download(bytes, `${active.id.slice(0, 16)}-${active.profile.name.replaceAll(/[^a-z0-9-]+/gi, '-')}${active.diskSave ? '.fds-save' : '.srm'}`);
  });
  const nativeFile = get('save-data-file');
  const importData = get('import-save-data');
  importData.onclick = () => {
    nativeFile.accept = current().active.diskSave ? '.fds-save' : '.srm,.sav';
    nativeFile.click();
  };
  nativeFile.oncancel = () => { if (profiles.open) importData.focus({ preventScroll: true }); };
  nativeFile.onchange = () => {
    const [file] = nativeFile.files;
    nativeFile.value = '';
    if (!file || !profiles.open) return;
    act(profiles, async () => {
      const { active, core } = current();
      if (active.diskSave ? file.size > core.diskSaveLimit() : file.size !== active.size) {
        throw new Error(active.diskSave ? 'This disk save exceeds the supported size.'
          : `Choose a raw ${active.size}-byte SRAM file from this ROM.`);
      }
      const profile = await importProfile(new Uint8Array(await file.arrayBuffer()));
      renderProfiles();
      profileMessage.textContent = `Imported as ${profile.name}. Select it to play.`;
    }, importData);
  };

  return { sync, dialogOpen: () => states.open || profiles.open };
}
