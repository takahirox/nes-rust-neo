const profilePrefix = 'nes-rust-neo/profiles-v1/';
export const defaultProfile = 'save-1';
const profileId = /^(?:save-1|[a-f0-9-]{36})$/;

// Save 1 points at the original storage key for both SRAM and disk progress.
export const nativeKey = (game, profile) => profile === defaultProfile ? game : `${game}:${profile}`;

export function readProfiles(game) {
  const raw = localStorage.getItem(profilePrefix + game);
  if (raw === null) return { selected: defaultProfile, next: 2, profiles: [{ id: defaultProfile, name: 'Save 1' }] };
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog?.profiles) || !catalog.profiles.length ||
      !Number.isSafeInteger(catalog.next) || catalog.next < 2 ||
      !catalog.profiles.every(profile => profile && profileId.test(profile.id) && typeof profile.name === 'string') ||
      new Set(catalog.profiles.map(profile => profile.id)).size !== catalog.profiles.length ||
      !catalog.profiles.some(profile => profile.id === catalog.selected)) {
    throw new Error('The save data profile list is invalid.');
  }
  return catalog;
}

export function writeProfiles(game, catalog) {
  localStorage.setItem(profilePrefix + game, JSON.stringify(catalog));
}

export function addProfile(catalog) {
  const profile = {
    id: crypto.randomUUID(),
    name: `Save ${catalog.next++}`,
  };
  catalog.profiles.push(profile);
  return profile;
}

// Keep screenshot metadata separate from payloads and use a common transaction
// for writing and deleting both parts of a state.
let database;
function openHistory() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('nes-rust-neo/states', 1);
    request.onupgradeneeded = () => {
      const entries = request.result.createObjectStore('entries');
      entries.createIndex('timeline', ['game', 'profile', 'time', 'id']);
      request.result.createObjectStore('snapshots');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  }).catch(error => {
    database = undefined;
    throw error;
  });
}

async function transaction(stores, mode, operation) {
  const db = await openHistory();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    tx.onabort = () => reject(tx.error ?? new Error('Save state storage transaction aborted.'));
    const abort = error => {
      tx.abort();
      reject(error);
    };
    try {
      const read = operation(tx, abort);
      tx.oncomplete = () => resolve(read?.());
    } catch (error) {
      abort(error);
    }
  });
}

const scopeRange = ({ game, profile }, before) =>
  IDBKeyRange.bound([game, profile], before ?? [game, profile, []], false, Boolean(before));

export function listStates(scope, before) {
  return transaction('entries', 'readonly', tx => {
    const request = tx.objectStore('entries').index('timeline').openCursor(scopeRange(scope, before), 'prev');
    const entries = [];
    let next;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (entries.length === 24) {
        const last = entries.at(-1);
        next = [last.game, last.profile, last.time, last.id];
        return;
      }
      entries.push(cursor.value);
      cursor.continue();
    };
    return () => ({ entries, next });
  });
}

export function hasStates(scope) {
  return transaction('entries', 'readonly', tx => {
    const request = tx.objectStore('entries').index('timeline').getKey(scopeRange(scope));
    return () => request.result !== undefined;
  });
}

export function writeState(scope, snapshot, thumbnail, target) {
  const entry = { ...scope, id: target?.id ?? crypto.randomUUID(), time: Date.now(), thumbnail };
  const key = [entry.game, entry.profile, entry.id];
  return transaction(['entries', 'snapshots'], 'readwrite', (tx, abort) => {
    const entries = tx.objectStore('entries');
    const snapshots = tx.objectStore('snapshots');
    let written;
    function write() {
      entries.put(entry, key);
      snapshots.put(snapshot, key);
      written = entry;
    }
    if (target) {
      const metadata = entries.getKey(key);
      const payload = snapshots.getKey(key);
      payload.onsuccess = () => {
        try {
          if (metadata.result !== undefined && payload.result !== undefined) write();
        } catch (error) {
          abort(error);
        }
      };
    } else {
      write();
    }
    return () => written;
  });
}

export async function readState({ game, profile, id }) {
  const payload = await transaction('snapshots', 'readonly', tx => {
    const request = tx.objectStore('snapshots').get([game, profile, id]);
    return () => request.result;
  });
  if (!(payload instanceof Uint8Array)) {
    const error = new Error('This state is unavailable. Choose another state.');
    error.name = 'StateUnavailable';
    throw error;
  }
  return payload;
}

export function removeState({ game, profile, id }) {
  return transaction(['entries', 'snapshots'], 'readwrite', tx => {
    const key = [game, profile, id];
    tx.objectStore('entries').delete(key);
    tx.objectStore('snapshots').delete(key);
  });
}
