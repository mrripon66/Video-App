'use strict';
const fs = require('node:fs');
const path = require('node:path');

class Vault {
  constructor(dataDir, safeStorage) {
    this.file = path.join(dataDir, 'credentials.bin');
    this.crypto = safeStorage;
    this.value = null;
  }
  async load() {
    if (!fs.existsSync(this.file)) return;
    if (!(await this.crypto.isAsyncEncryptionAvailable())) throw new Error('Windows credential protection is unavailable.');
    const result = await this.crypto.decryptStringAsync(fs.readFileSync(this.file));
    this.value = result.result;
  }
  hasKey() { return Boolean(this.value); }
  getKey() {
    if (!this.value) throw new Error('Add your fal.ai API key in Settings first.');
    return this.value;
  }
  async save(key) {
    if (typeof key !== 'string' || key.length > 2048 || /[\r\n]/.test(key)) throw new Error('Enter a valid fal.ai API key.');
    key = key.trim();
    if (!key) throw new Error('Enter an API key, or use Remove key.');
    if (!(await this.crypto.isAsyncEncryptionAvailable())) throw new Error('Windows credential protection is unavailable. The key was not saved.');
    const encrypted = await this.crypto.encryptStringAsync(key);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.value = key;
  }
  clear() {
    fs.rmSync(this.file, { force: true });
    this.value = null;
  }
}
module.exports = { Vault };
