'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATUSES = new Set(['pending', 'submitting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'needs_attention']);
const clone = value => JSON.parse(JSON.stringify(value));

function validateState(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.jobs) || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) {
    throw new Error('The saved studio data has an unsupported format.');
  }
  const ids = new Set();
  for (const job of value.jobs) {
    if (!job || typeof job.id !== 'string' || !job.id || ids.has(job.id) || typeof job.prompt !== 'string' || !job.prompt.trim() || typeof job.modelId !== 'string' || !STATUSES.has(job.status) || typeof job.createdAt !== 'string') {
      throw new Error('The saved queue contains an invalid job.');
    }
    ids.add(job.id);
  }
  for (const [key, val] of Object.entries(value.settings)) {
    if (/api.?key|token|password|secret|credential/i.test(key) && typeof val === 'string' && val.length) {
      throw new Error('Credentials must be stored in the encrypted credential vault.');
    }
  }
  return value;
}

function atomicWrite(filename, text) {
  const temporary = `${filename}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(handle, text, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filename);
}

class Store {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('A studio data folder is required.');
    this.dataDir = path.resolve(dataDir);
    this.filename = path.join(this.dataDir, 'studio.json');
    this.backupFilename = `${this.filename}.bak`;
    this._state = null;
    this.recoveryWarning = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  load() {
    let primaryError;
    try {
      this._state = validateState(JSON.parse(fs.readFileSync(this.filename, 'utf8')));
    } catch (error) {
      primaryError = error;
      try {
        this._state = validateState(JSON.parse(fs.readFileSync(this.backupFilename, 'utf8')));
        this.recoveryWarning = 'The previous saved queue was restored from its backup. Review jobs before starting.';
        // Preserve the unreadable file for diagnosis; never replace the known-good backup with it.
        if (fs.existsSync(this.filename)) {
          fs.copyFileSync(this.filename, `${this.filename}.damaged-${Date.now()}`);
        }
        atomicWrite(this.filename, JSON.stringify(this._state, null, 2));
      } catch (backupError) {
        if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') {
          this._state = { schemaVersion: 1, revision: 0, jobs: [], settings: {} };
          atomicWrite(this.filename, JSON.stringify(this._state, null, 2));
        } else {
          this._state = null;
          throw new Error('Studio data could not be read, and no valid backup was found. Existing files were preserved.');
        }
      }
    }
    return this.snapshot();
  }

  snapshot() {
    if (!this._state) throw new Error('Load the studio store before using it.');
    return clone(this._state);
  }

  mutate(mutator) {
    if (typeof mutator !== 'function') throw new Error('A store update function is required.');
    const previous = this.snapshot();
    const next = clone(previous);
    const result = mutator(next);
    if (result && typeof result.then === 'function') throw new Error('Store updates must be synchronous.');
    next.revision = previous.revision + 1;
    validateState(next);
    atomicWrite(this.backupFilename, JSON.stringify(previous, null, 2));
    atomicWrite(this.filename, JSON.stringify(next, null, 2));
    this._state = next;
    return result;
  }
}

module.exports = { Store, validateState };
