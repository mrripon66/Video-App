'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const isPending = job => job.status === 'completed' && job.autoExport?.status === 'pending';
const stagingPrefix = id => `.ai-video-studio-${id}-`;
const stagingSuffix = /^[a-f0-9-]{36}\.partial$/;

async function removeTemporary(filename) {
  try { await fs.promises.unlink(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function alreadyPublished(source, destination) {
  let target;
  try { target = await fs.promises.lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!target.isFile() || target.size !== (await fs.promises.stat(source)).size ||
      await fileHash(destination) !== await fileHash(source)) {
    throw new Error('A different file already has this export name. Choose another folder to save this video.');
  }
  return true;
}

function exportError(error) {
  if (error.code === 'ENOSPC') return 'The export folder is out of space. Free some space or choose another folder.';
  if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
    return 'Windows could not safely save the video in this folder. Choose another writable local folder.';
  }
  return String(error.message || error).slice(0, 500);
}

function createAutoExporter({ store, localVideo, resolveFolder, onChange = () => {} }) {
  let running = null;
  let requested = false;
  let stopping = false;

  async function verifiedFolder(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Choose a valid export folder.');
    const canonical = await resolveFolder(directory);
    if (path.relative(directory, canonical)) throw new Error('The export folder has moved. Choose the folder again.');
    return canonical;
  }

  function persist(job, record) {
    store.mutate(state => {
      const live = state.jobs.find(entry => entry.id === job.id);
      if (live && isPending(live) && live.autoExport.directory === job.autoExport.directory) live.autoExport = record;
    });
  }

  async function save(job) {
    let record = job.autoExport;
    try {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(job.id)) throw new Error('This video has an invalid export identifier.');
      const directory = await verifiedFolder(record.directory);
      const prefix = stagingPrefix(job.id);
      if (record.stagingName !== undefined) {
        if (typeof record.stagingName !== 'string' || !record.stagingName.startsWith(prefix) ||
          !stagingSuffix.test(record.stagingName.slice(prefix.length))) throw new Error('This video has invalid saved export details.');
        await removeTemporary(path.join(directory, record.stagingName));
      }

      const source = localVideo(job);
      const extension = path.extname(source).toLowerCase();
      if (!['.mp4', '.webm'].includes(extension)) throw new Error('Only MP4 and WebM videos can be automatically exported.');
      const filePath = path.join(directory, `AI-Video-${job.id}${extension}`);
      if (!(await alreadyPublished(source, filePath))) {
        record = { directory: record.directory, status: 'pending', stagingName: prefix + randomUUID() + '.partial' };
        persist(job, record);
        const temporary = path.join(directory, record.stagingName);
        let ownsTemporary = true;
        try {
          try { await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL); }
          catch (error) {
            if (error.code === 'EEXIST') {
              ownsTemporary = false;
              record = { directory: record.directory, status: 'pending' };
            }
            throw error;
          }
          await verifiedFolder(record.directory);
          // Publish the complete file without replacing any existing destination.
          try { await fs.promises.link(temporary, filePath); }
          catch (error) {
            if (error.code !== 'EEXIST' || !(await alreadyPublished(source, filePath))) throw error;
          }
        } finally {
          if (ownsTemporary) {
            await verifiedFolder(record.directory);
            await removeTemporary(temporary);
          }
        }
      }
      record = { directory: record.directory, status: 'saved', filePath };
    } catch (error) {
      record = { ...record, status: 'failed', error: exportError(error) };
    }
    persist(job, record);
    try { onChange(); } catch { /* A view cannot interrupt the worker. */ }
  }

  function kick() {
    if (stopping) return running || Promise.resolve();
    requested = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        while (requested && !stopping) {
          requested = false;
          for (const job of store.snapshot().jobs.filter(isPending)) {
            if (stopping) break;
            await save(job);
          }
        }
      }).finally(() => { running = null; });
    }
    return running;
  }

  function stop() {
    stopping = true;
    return running || Promise.resolve();
  }

  return { kick, stop };
}

module.exports = { createAutoExporter };
