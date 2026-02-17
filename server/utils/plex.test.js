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

test('annotateDonorWithPlex matches donor via contact email when plexEmail differs', () => {
  const donor = {
    email: 'billing@example.com',
    plexEmail: 'relay@privaterelay.appleid.com',
    plexAccountId: 'plex-acct-111',
    status: 'active',
    invites: [],
  };

  const context = {
    configured: true,
    index: [
      {
        emails: new Set(['billing@example.com']),
        ids: new Set(['different-id']),
        pending: false,
      },
    ],
  };

  const annotated = annotateDonorWithPlex(donor, context);

  assert.equal(annotated.plexShared, true);
  assert.equal(annotated.needsPlexInvite, false);
  assert.equal(annotated.plexShareState, 'shared');
});

test('annotateDonorWithPlex matches via latest active invite recipient email', () => {
  const donor = {
    email: 'billing@example.com',
    plexEmail: 'relay@privaterelay.appleid.com',
    plexAccountId: 'plex-acct-222',
    status: 'active',
    invites: [
      {
        recipientEmail: 'trial-user@example.com',
        revokedAt: null,
      },
    ],
  };

  const context = {
    configured: true,
    index: [
      {
        emails: new Set(['trial-user@example.com']),
        ids: new Set(['other-id']),
        pending: true,
      },
    ],
  };

  const annotated = annotateDonorWithPlex(donor, context);

  assert.equal(annotated.plexShared, false);
  assert.equal(annotated.plexPending, true);
  assert.equal(annotated.needsPlexInvite, false);
  assert.equal(annotated.plexShareState, 'pending');
});
