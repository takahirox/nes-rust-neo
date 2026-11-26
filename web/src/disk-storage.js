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
    transaction.onabort = () => reject(transaction.error ?? new Error('Disk storage transaction aborted.'));
    try {
      const request = operation(transaction.objectStore('data'));
      transaction.oncomplete = () => resolve(request.result);
      // Queue the write even if navigation suspends callbacks.
      if (mode === 'readwrite') transaction.commit?.();
    } catch (error) {
      transaction.abort();
      reject(error);
    }
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
  static async open(id) {
    if (!navigator.locks) throw new Error('Disk saves require Web Locks in a secure browser context.');
    const release = await holdLock('nes-rust-neo/fds/' + id);
    if (!release) throw new Error('Close the other tab or open another game there, then retry.');
    try {
      return new DiskSave(await openStorage(), release, id);
    } catch (error) {
      await release();
      throw error;
    }
  }

  constructor(db, release, id) {
    this.db = db;
    this.release = release;
    this.id = id;
    this.revision = 0;
  }

  async #readRecord(key) {
    const record = await access(this.db, 'readonly', store => store.get(key));
    if (record !== undefined && !(record?.bytes instanceof Uint8Array)) {
      throw new Error('The stored disk data is invalid.');
    }
    return record;
  }

  async readProfile(key) {
    await this.writing?.promise;
    const record = await this.#readRecord(key);
    if (record === undefined) return;
    if (record.version !== 2) throw new Error('The stored disk data is invalid.');
    return record.bytes;
  }

  async load(key, core) {
    const record = await this.#readRecord(key);
    if (record === undefined) return;
    // Save 1 adopts the old key. Replace the legacy record only after validation.
    if (record.version === 1 && key === this.id && core.restore(record.bytes, true)) {
      await this.write(key, core.diskSave(true));
      return;
    }
    if (record.version === 2) {
      try {
        core.restoreDisk(record.bytes, true);
        return;
      } catch (error) {
        throw new Error('The stored disk data is invalid. ' + error.message);
      }
    }
    throw new Error('The stored disk data is invalid.');
  }

  write(key, bytes) {
    return access(this.db, 'readwrite', store => store.put({ version: 2, bytes }, key));
  }

  remove(key) {
    return access(this.db, 'readwrite', store => store.delete(key));
  }

  track(key, revision) {
    this.key = key;
    this.revision = revision;
    this.failed = false;
  }

  dirty(core) {
    return this.revision !== core.saveRevision();
  }

  flush(core) {
    const revision = core.saveRevision();
    if (this.writing?.revision === revision) return this.writing.promise;
    if (this.revision === revision) return Promise.resolve(true);
    const promise = this.write(this.key, core.diskSave())
      .then(() => true, () => false)
      .then(saved => {
        if (this.writing?.promise === promise) {
          if (saved) this.revision = revision;
          this.failed = !saved;
          this.writing = undefined;
        }
        return saved;
      });
    this.writing = { revision, promise };
    return promise;
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
