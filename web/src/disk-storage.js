import { holdLock } from './storage.js';

function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nes-rust-neo/fds', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function access(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', mode, { durability: 'strict' });
    const request = operation(transaction.objectStore('data'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('Disk storage transaction aborted.'));
  });
}

async function accessBios(mode, operation) {
  const db = await openStorage();
  try {
    return await access(db, mode, operation);
  } finally {
    db.close();
  }
}

export const biosSize = 8192;
export const readBios = () => accessBios('readonly', store => store.get('bios'));
export const writeBios = bytes => accessBios('readwrite', store => store.put(bytes, 'bios'));
export const forgetBios = () => accessBios('readwrite', store => store.delete('bios'));

export class DiskSave {
  static async open(id, size, core) {
    if (!navigator.locks) throw new Error('Disk saves require Web Locks in a secure browser context.');
    let release;
    let db;
    try {
      release = await holdLock('nes-rust-neo/fds/' + id);
      if (!release) throw new Error('Close the other tab or open another game there, then retry.');
      db = await openStorage();
      const record = await access(db, 'readonly', store => store.get(id));
      if (record !== undefined &&
          (record.version !== 1 || !(record.bytes instanceof Uint8Array) ||
           record.bytes.byteLength !== size || !core.restore(record.bytes, true))) {
        throw new Error('The stored disk data is invalid.');
      }
      return new DiskSave(db, release, id);
    } catch (error) {
      db?.close();
      await release?.();
      throw error;
    }
  }

  constructor(db, release, id) {
    this.db = db;
    this.release = release;
    this.id = id;
    this.revision = 0;
  }

  dirty(core) {
    return this.revision !== core.saveRevision();
  }

  // Create the transaction in the same turn as the snapshot so it can finish
  // even if the document begins navigating while IndexedDB commits it.
  flush(core) {
    if (this.writing) return this.writing;
    if (!this.dirty(core)) return Promise.resolve(true);
    const revision = core.saveRevision();
    const bytes = core.saveBytes();
    this.writing = access(this.db, 'readwrite', store => store.put({ version: 1, bytes }, this.id))
      .then(() => {
        this.revision = revision;
        this.failed = false;
        return true;
      }, () => {
        this.failed = true;
        return false;
      })
      .finally(() => { this.writing = undefined; });
    return this.writing;
  }

  // The caller suspends emulation until all prior changes are safely stored.
  async finish(core) {
    while (this.dirty(core)) {
      if (!await this.flush(core)) return false;
    }
    return true;
  }

  async close() {
    this.db.close();
    await this.release();
  }
}
