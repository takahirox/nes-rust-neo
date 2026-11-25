export const preferencesKey = 'nes-rust-neo/preferences-v1';
const savePrefix = 'nes-rust-neo/battery-v1/';

export async function identify(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nes-rust-neo', 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('roms', { keyPath: 'id' });
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close other emulator tabs to open the cartridge library.'));
    };
  });
}

async function transaction(mode, useStore) {
  const database = await openLibrary();
  try {
    return await new Promise((resolve, reject) => {
      const txn = database.transaction('roms', mode);
      const request = useStore(txn.objectStore('roms'));
      txn.oncomplete = () => resolve(request.result);
      txn.onabort = () => reject(txn.error ?? new Error('Cartridge storage aborted.'));
    });
  } finally {
    database.close();
  }
}

export function remember(record) {
  return transaction('readwrite', store => store.put(record));
}

export function remembered(id) {
  return transaction('readonly', store => store.get(id));
}

// Read names and identities without holding every imported ROM in memory.
export async function listCartridges() {
  const database = await openLibrary();
  try {
    return await new Promise((resolve, reject) => {
      const txn = database.transaction('roms', 'readonly');
      const request = txn.objectStore('roms').openCursor();
      const list = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const { id, name } = cursor.value;
        list.push({ id, name });
        cursor.continue();
      };
      txn.oncomplete = () => resolve(list.sort((a, b) => a.name.localeCompare(b.name)));
      txn.onabort = () => reject(txn.error);
    });
  } finally {
    database.close();
  }
}

export function removeCartridge(id) {
  return transaction('readwrite', store => store.delete(id));
}

function decode(raw, size) {
  if (raw === null) return null;
  const data = atob(raw);
  if (data.length !== size) throw new Error('Saved data has an unexpected size.');
  return Uint8Array.from(data, char => char.charCodeAt(0));
}

function encode(bytes) {
  // Supported cartridge save RAM is 8 KiB.
  return btoa(String.fromCharCode(...bytes));
}

export class BatterySaves {
  #sessions = new Map();

  get hasWarnings() {
    return Array.from(this.#sessions.values()).some(session => session.message);
  }

  get warning() {
    return Array.from(this.#sessions.values(), session => session.message).filter(Boolean).join(' ');
  }

  open(id, name, size, core) {
    if (!size) return null;
    const cached = this.#sessions.get(id);
    if (cached?.pending) {
      if (!core.restore(cached.pending, true)) throw new Error('Core rejected battery save.');
      cached.name = name;
      return cached;
    }
    const base = localStorage.getItem(savePrefix + id);
    const bytes = decode(base, size);
    if (bytes && !core.restore(bytes, true)) throw new Error('Core rejected battery save.');
    const session = { id, name, size, revision: 0, pending: null, base, blocked: false, writing: null, message: '' };
    this.#sessions.set(id, session);
    return session;
  }

  capture(session, core) {
    if (!session || session.revision === core.saveRevision()) return;
    session.revision = core.saveRevision();
    session.pending = core.saveBytes();
  }

  flush(session) {
    if (!session) return;
    if (session.writing) return session.writing;
    if (!session.pending || session.blocked) return;
    session.writing = this.#write(session).finally(() => { session.writing = null; });
    return session.writing;
  }

  async #write(session) {
    try {
      const key = savePrefix + session.id;
      // Keep the comparison and write under the same origin-wide lock. Encode
      // the latest capture after acquiring it in case play continued while waiting.
      while (session.pending && !session.blocked) {
        await navigator.locks.request(key, () => {
          const raw = encode(session.pending);
          const stored = localStorage.getItem(key);
          if (stored !== session.base && stored !== raw) {
            session.blocked = true;
            session.message = `The battery save for ${session.name} changed in another tab. Retry to load the stored version.`;
            return;
          }
          if (stored !== raw) localStorage.setItem(key, raw);
          session.base = raw;
          session.pending = null;
          session.message = '';
        });
      }
    } catch {
      session.message = `Could not write the battery save for ${session.name}. Progress is held in this tab.`;
    }
  }

  async retry(active, core) {
    let restored = false;
    for (const session of this.#sessions.values()) {
      if (session.writing) await session.writing;
      if (session.blocked) {
        try {
          const raw = localStorage.getItem(savePrefix + session.id);
          const bytes = decode(raw, session.size);
          if (bytes) {
            if (session === active) {
              if (!core.restore(bytes)) throw new Error('Core rejected battery save.');
              restored = true;
            }
            session.pending = null;
          }
          session.base = raw;
          session.blocked = false;
          session.message = '';
        } catch {
          continue;
        }
      }
      await this.flush(session);
    }
    return restored;
  }
}
