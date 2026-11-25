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

function lockDraft(key) {
  return new Promise((resolve, reject) => {
    navigator.locks.request(key, { ifAvailable: true }, lock => {
      if (!lock) return resolve(null);
      // The browser releases ownership when this document closes or reloads.
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

async function openDraft(id, backup) {
  if (!navigator.locks) return null;
  const prefix = draftPrefix + id + '/';
  // A tab-local backup can replace only its own older recovery copy.
  const keys = backup ? [backup.key] : Object.keys(localStorage);
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    const release = await lockDraft(key);
    if (!release) continue;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null || backup) return { key, release, raw };
    } catch (error) {
      release();
      throw error;
    }
    release();
  }
  const key = prefix + crypto.randomUUID();
  const release = await lockDraft(key);
  return release ? { key, release, raw: null } : null;
}

function readDraft(raw) {
  const draft = JSON.parse(raw);
  if (draft !== null && (typeof draft.raw !== 'string' ||
      (draft.base !== null && typeof draft.base !== 'string') ||
      (draft.key !== undefined && typeof draft.key !== 'string') ||
      (draft.sequence !== undefined && (!Number.isSafeInteger(draft.sequence) || draft.sequence < 1)))) {
    throw new Error('Battery save recovery data is invalid.');
  }
  return draft;
}

export class BatterySaves {
  #sessions = new Map();

  get warning() {
    return Array.from(this.#sessions.values(), session => {
      const tabOnly = session.pending && session.pending !== session.staged;
      let detail = ' Reopen the cartridge to recover progress after reload or tab closure.';
      if (tabOnly) {
        detail = session.pending === session.backup
          ? ' Progress can be recovered by reloading this tab.'
          : ' Progress is held in this tab.';
      }
      if (session.blocked) {
        return `The battery save for ${session.name} changed in another tab.${tabOnly ? detail : ''} Retry to load the stored version.`;
      }
      if (session.writeFailed || tabOnly) {
        return `Could not finish saving battery data for ${session.name}.${detail}`;
      }
      return '';
    }).filter(Boolean).join(' ');
  }

  async open(id, name, size, core) {
    if (!size) return null;
    const cached = this.#sessions.get(id);
    if (cached?.pending) {
      if (!core.restore(decode(cached.pending.raw, size), true)) throw new Error('Core rejected battery save.');
      cached.name = name;
      return cached;
    }
    const backup = readDraft(sessionStorage.getItem(draftPrefix + id));
    const { key: draftKey, release: releaseDraft, raw } = await openDraft(id, backup) ?? {};
    try {
      const base = localStorage.getItem(savePrefix + id);
      const storedBytes = decode(base, size);
      const staged = readDraft(raw ?? null);
      // Either copy can outlive a failed write or cleanup. Keep the previous
      // backup preference when older records have no sequence to compare.
      const draft = !backup || (staged?.sequence ?? 0) > (backup.sequence ?? 0) ? staged : backup;
      const bytes = draft ? decode(draft.raw, size) : storedBytes;
      if (bytes && !core.restore(bytes, true)) throw new Error('Core rejected battery save.');
      const blocked = Boolean(draft && base !== draft.base && base !== draft.raw);
      const session = {
        id, name, size, revision: 0, pending: draft, staged,
        draftKey, releaseDraft, backup, base: blocked ? draft.base : base,
        blocked, writing: null, writeFailed: false,
      };
      cached?.releaseDraft?.();
      this.#sessions.set(id, session);
      return session;
    } catch (error) {
      releaseDraft?.();
      throw error;
    }
  }

  capture(session, core) {
    if (!session) return;
    const revision = core.saveRevision();
    if (session.revision === revision) return;
    session.revision = revision;
    session.pending = {
      base: session.base,
      raw: encode(core.saveBytes()),
      sequence: (session.pending?.sequence ?? 0) + 1,
    };
  }

  flush(session) {
    if (!session?.pending) return;
    // Save synchronously before queueing a lock, including during pagehide.
    if (session.draftKey && session.staged !== session.pending) {
      try {
        localStorage.setItem(session.draftKey, JSON.stringify(session.pending));
        session.staged = session.pending;
        if (session.backup) {
          sessionStorage.removeItem(draftPrefix + session.id);
          session.backup = null;
        }
      } catch {
        // Session storage can still preserve progress through a reload.
      }
    }
    if (session.staged !== session.pending && session.backup !== session.pending) {
      try {
        const backup = { ...session.pending, key: session.draftKey };
        sessionStorage.setItem(draftPrefix + session.id, JSON.stringify(backup));
        session.backup = session.pending;
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
    if (session.backup) sessionStorage.removeItem(draftPrefix + session.id);
    if (session.draftKey) localStorage.removeItem(session.draftKey);
    session.pending = session.staged = session.backup = null;
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
            const { raw: pendingRaw, sequence = 0 } = session.pending;
            session.pending = { base: raw, raw: pendingRaw, sequence: sequence + 1 };
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
