const test = require('node:test');
const assert = require('node:assert/strict');

const { annotateDonorWithPlex } = require('./plex');

test('annotateDonorWithPlex reports plexShared when context matches donor plexEmail', () => {
  const donor = {
    email: 'contact@example.com',
    plexEmail: 'plex@example.com',
    invites: [],
  };

  const context = {
    index: [
      {
        emails: new Set(['plex@example.com']),
        ids: new Set(),
        pending: false,
      },
    ],
  };

  const annotated = annotateDonorWithPlex(donor, context);

  assert.equal(annotated.plexShared, true);
  assert.equal(annotated.plexShareState, 'shared');
  assert.equal(annotated.plexPending, false);
});
