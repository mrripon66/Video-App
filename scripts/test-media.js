'use strict';
// Development/CI fixture only; excluded from the Windows application package.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const FIXTURE = Object.freeze({
  source: 'https://raw.githubusercontent.com/chromium/chromium/92146310d35807e58f0d376e8ad9908ba2f4f92f/media/test/data/bear.webm',
  sha256: '7148402273737217b6906704ac430fcfd77268e9f0dbfe19d5f334a496a58d69',
  bytes: 58199
});
async function fixtureBytes(evidence) {
  const filename = path.join(evidence, 'fixtures', 'bear.webm');
  let bytes;
  if (fs.existsSync(filename)) bytes = fs.readFileSync(filename);
  else {
    const response = await fetch(FIXTURE.source, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert.equal(response.status, 200, 'Official Chromium test-media download must succeed.');
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(bytes.length, FIXTURE.bytes, 'Test media must have its expected bounded size.');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FIXTURE.sha256, 'Test media must match the pinned SHA-256.');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes);
  return bytes;
}
module.exports = { FIXTURE, fixtureBytes };
