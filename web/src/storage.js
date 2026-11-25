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
      reject(new Error('Close other emulator tabs to open the game library.'));
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
      txn.onabort = () => reject(txn.error ?? new Error('Game library storage aborted.'));
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
export async function listGames() {
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

export function removeGame(id) {
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

export function holdLock(key) {
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request(key, { ifAvailable: true }, lock => {
      if (!lock) return resolve(null);
      // The browser releases ownership when this document closes or reloads.
      return new Promise(release => resolve(() => {
        release();
        return request;
      }));
    });
    request.catch(reject);
  });
}

function withAbandonedDrafts(id, useDrafts) {
  if (!navigator.locks) return useDrafts([]);
  const prefix = draftPrefix + id + '/';
  // Scan as a group so simultaneous readers cannot each claim half a conflict.
  return navigator.locks.request(draftPrefix + id, async () => {
    const drafts = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        const release = await holdLock(key);
        if (!release) continue; // A live tab still owns this copy.
        const entry = { key, release };
        drafts.push(entry);
        entry.staged = entry.draft = readDraft(localStorage.getItem(key));
      }
      return await useDrafts(drafts);
    } finally {
      await Promise.all(drafts.map(entry => entry.release?.()));
    }
  });
}

function readDraft(raw) {
  const draft = JSON.parse(raw);
  if (draft !== null && (typeof draft.raw !== 'string' ||
      (draft.base !== null && typeof draft.base !== 'string') ||
      (draft.key !== undefined && typeof draft.key !== 'string') ||
      (draft.sequence !== undefined && (!Number.isSafeInteger(draft.sequence) || draft.sequence < 1)) ||
      (draft.savedAt !== undefined && !Number.isSafeInteger(draft.savedAt)))) {
    throw new Error('Battery save recovery data is invalid.');
  }
  return draft;
}

function hasCompetingDraft(drafts, stored, pending) {
  return pending.raw !== stored &&
    drafts.some(({ draft }) => draft && draft.raw !== stored && draft.raw !== pending.raw);
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
      if (session.competing) {
        return `Multiple recovery copies exist for ${session.name}.${tabOnly ? detail : ''} Close all emulator tabs and reopen the cartridge to choose a version.`;
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

  async open(id, name, size, core, selection) {
    if (!size) return null;
    const cached = this.#sessions.get(id);
    if (cached?.pending) {
      if (!core.restore(decode(cached.pending.raw, size), true)) throw new Error('Core rejected battery save.');
      cached.name = name;
      return cached;
    }
    const key = savePrefix + id;
    const backupKey = draftPrefix + id;
    const recover = () => withAbandonedDrafts(id, async drafts => {
      const backup = readDraft(sessionStorage.getItem(backupKey));
      if (backup) {
        // Compare sequence numbers only for copies from the same writer.
        const entry = drafts.find(entry => entry.key === backup.key);
        if (!entry) drafts.push({ draft: backup });
        else if ((entry.staged?.sequence ?? 0) <= (backup.sequence ?? 0)) entry.draft = backup;
      }
      let base = localStorage.getItem(key);
      const storedBytes = decode(base, size);
      const recoveries = drafts.filter(({ draft }) => draft);
      const changes = recoveries.filter(({ draft }) => draft.raw !== base);
      const versions = Array.from(new Map(changes.map(({ draft }) => [draft.raw, draft])).values())
        .sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
      const needsChoice = selection
        ? selection.conflict.base !== base || selection.conflict.versions.length !== versions.length ||
          !versions.every(({ raw }) => selection.conflict.versions.some(version => version.raw === raw))
        : versions.length > 1;
      if (needsChoice) return { conflict: { base, versions } };

      const entry = selection ? undefined : changes.find(({ draft }) => draft.base === base) ??
        changes[0] ?? recoveries[0];
      const draft = entry?.draft ?? null;
      const raw = selection ? selection.raw : draft?.raw ?? base;
      const bytes = raw === base ? storedBytes : decode(raw, size);
      if (bytes && !core.restore(bytes, true)) throw new Error('Core rejected battery save.');
      if (selection) {
        // Commit the chosen version before removing any recovery copies.
        if (raw !== base) localStorage.setItem(key, raw);
        for (const entry of drafts) {
          if (entry.key) localStorage.removeItem(entry.key);
        }
        if (backup) sessionStorage.removeItem(backupKey);
        base = raw;
      }
      const blocked = Boolean(draft && base !== draft.base && base !== draft.raw);
      const draftKey = navigator.locks ? entry?.key ?? backupKey + '/' + crypto.randomUUID() : undefined;
      const releaseDraft = entry?.release ?? (draftKey && await holdLock(draftKey));
      if (entry) entry.release = null;
      const session = {
        id, name, size, revision: 0, pending: draft, staged: entry?.staged,
        draftKey, releaseDraft, backup: selection ? null : backup, base: blocked ? draft.base : base,
        blocked, competing: false, writing: null, writeFailed: false,
      };
      cached?.releaseDraft?.();
      this.#sessions.set(id, session);
      return session;
    });
    // Normal opens can still read while another tab is waiting to save.
    return selection ? navigator.locks.request(key, recover) : recover();
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
      savedAt: Date.now(),
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
    if (session.blocked || session.competing) return;
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
      while (session.pending && !session.blocked && !session.competing) {
        await navigator.locks.request(key, () => withAbandonedDrafts(session.id, drafts => {
          const { raw } = session.pending;
          const stored = localStorage.getItem(key);
          if (hasCompetingDraft(drafts, stored, session.pending)) {
            session.competing = true;
            return;
          }
          if (stored !== session.base && stored !== raw) {
            session.blocked = true;
            return;
          }
          if (stored !== raw) localStorage.setItem(key, raw);
          session.base = raw;
          // Retire redundant abandoned copies before the shared save advances again.
          for (const { key: draftKey, draft } of drafts) {
            if (draft && (draft.raw === raw || draft.raw === stored)) localStorage.removeItem(draftKey);
          }
          this.#clearDraft(session);
        }));
      }
    } catch {
      session.writeFailed = true;
    }
  }

  async retry(active, core) {
    let restored = false;
    for (const session of this.#sessions.values()) {
      if (session.writing) await session.writing;
      session.competing = false;
      if (session.blocked) {
        try {
          const key = savePrefix + session.id;
          await navigator.locks.request(key, () => withAbandonedDrafts(session.id, drafts => {
            const raw = localStorage.getItem(key);
            if (hasCompetingDraft(drafts, raw, session.pending)) {
              session.competing = true;
              return;
            }
            const bytes = decode(raw, session.size);
            if (bytes) {
              if (session === active && !core.restore(bytes)) throw new Error('Core rejected battery save.');
              this.#clearDraft(session);
              if (session === active) restored = true;
            } else {
              session.pending = { ...session.pending, base: raw, sequence: (session.pending.sequence ?? 0) + 1 };
            }
            session.base = raw;
            session.blocked = false;
          }));
        } catch {
          continue;
        }
      }
      await this.flush(session);
    }
    return restored;
  }
}
