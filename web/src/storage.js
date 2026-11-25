export const preferencesKey = 'nes-rust-neo/preferences-v1';
const savePrefix = 'nes-rust-neo/battery-v1/';
const draftPrefix = 'nes-rust-neo/battery-draft-v1/';

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

  get warning() {
    return Array.from(this.#sessions.values(), session => {
      const memoryOnly = session.pending && session.pending !== session.staged;
      if (session.blocked) {
        const detail = memoryOnly ? ' Progress is held in this tab.' : '';
        return `The battery save for ${session.name} changed in another tab.${detail} Retry to load the stored version.`;
      }
      if (session.writeFailed || memoryOnly) {
        const detail = memoryOnly ? 'Progress is held in this tab.' : 'Reopen the cartridge in this tab to recover progress after reload.';
        return `Could not finish saving battery data for ${session.name}. ${detail}`;
      }
      return '';
    }).filter(Boolean).join(' ');
  }

  open(id, name, size, core) {
    if (!size) return null;
    const cached = this.#sessions.get(id);
    if (cached?.pending) {
      if (!core.restore(decode(cached.pending.raw, size), true)) throw new Error('Core rejected battery save.');
      cached.name = name;
      return cached;
    }
    const base = localStorage.getItem(savePrefix + id);
    const storedBytes = decode(base, size);
    const draft = JSON.parse(sessionStorage.getItem(draftPrefix + id));
    if (draft !== null && (typeof draft.raw !== 'string' || (draft.base !== null && typeof draft.base !== 'string'))) {
      throw new Error('Battery save recovery data is invalid.');
    }
    const bytes = draft ? decode(draft.raw, size) : storedBytes;
    if (bytes && !core.restore(bytes, true)) throw new Error('Core rejected battery save.');
    const blocked = Boolean(draft && base !== draft.base && base !== draft.raw);
    const session = {
      id, name, size, revision: 0, pending: draft, staged: draft,
      base: blocked ? draft.base : base, blocked, writing: null, writeFailed: false,
    };
    this.#sessions.set(id, session);
    return session;
  }

  capture(session, core) {
    if (!session) return;
    const revision = core.saveRevision();
    if (session.revision === revision) return;
    session.revision = revision;
    session.pending = { base: session.base, raw: encode(core.saveBytes()) };
  }

  flush(session) {
    if (!session?.pending) return;
    // Save synchronously before queueing a lock, including during pagehide.
    // Session storage survives reload and keeps each tab's draft separate.
    if (session.staged !== session.pending) {
      try {
        sessionStorage.setItem(draftPrefix + session.id, JSON.stringify(session.pending));
        session.staged = session.pending;
      } catch {
        // Keep the draft in memory and still attempt the shared save.
      }
    }
    if (session.writing) return session.writing;
    if (session.blocked) return;
    session.writing = this.#write(session).finally(() => { session.writing = null; });
    return session.writing;
  }

  #clearDraft(session) {
    if (session.staged) sessionStorage.removeItem(draftPrefix + session.id);
    session.pending = session.staged = null;
    session.writeFailed = false;
  }

  async #write(session) {
    try {
      const key = savePrefix + session.id;
      // Compare and write under the same origin-wide lock, using the latest
      // capture in case play continued while waiting.
      while (session.pending && !session.blocked) {
        await navigator.locks.request(key, () => {
          const { raw } = session.pending;
          const stored = localStorage.getItem(key);
          if (stored !== session.base && stored !== raw) {
            session.blocked = true;
            return;
          }
          if (stored !== raw) localStorage.setItem(key, raw);
          session.base = raw;
          this.#clearDraft(session);
        });
      }
    } catch {
      session.writeFailed = true;
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
            if (session === active && !core.restore(bytes)) throw new Error('Core rejected battery save.');
            this.#clearDraft(session);
            if (session === active) restored = true;
          } else {
            session.pending = { base: raw, raw: session.pending.raw };
          }
          session.base = raw;
          session.blocked = false;
        } catch {
          continue;
        }
      }
      await this.flush(session);
    }
    return restored;
  }
}
