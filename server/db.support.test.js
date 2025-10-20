process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_FILE || process.env.DATABASE_FILE === ':memory:') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-donate-db-support-'));
  process.env.DATABASE_FILE = path.join(dir, 'database.sqlite');
}

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  db,
  createDonor,
  createSupportRequest,
  addSupportMessageToRequest,
  markSupportRequestResolved,
  listSupportRequests,
  getSupportThreadById,
  deleteSupportRequestById,
} = require('./db');

function resetDatabase() {
  db.exec(`
    DELETE FROM support_messages;
    DELETE FROM support_requests;
    DELETE FROM donors;
  `);
}

test('createSupportRequest persists request and initial message', (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const donor = createDonor({
    email: 'supporter@example.com',
    name: 'Supporter One',
    status: 'active',
  });

  const thread = createSupportRequest({
    donorId: donor.id,
    subject: 'Need assistance',
    message: 'Hello team, I need help with my account.',
    donorDisplayName: 'Supporter One',
    authorName: 'Supporter One',
  });

  assert.ok(thread);
  assert.ok(thread.request);
  assert.equal(thread.request.donorId, donor.id);
  assert.equal(thread.request.subject, 'Need assistance');
  assert.equal(thread.request.resolved, false);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].authorRole, 'donor');
  assert.equal(thread.messages[0].authorName, 'Supporter One');
  assert.equal(
    thread.messages[0].body,
    'Hello team, I need help with my account.'
  );

  const requests = listSupportRequests({ donorId: donor.id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].subject, 'Need assistance');
  assert.equal(requests[0].resolved, false);
});

test('support message flow reopens and resolves requests correctly', (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const donor = createDonor({
    email: 'flow@example.com',
    name: 'Flow User',
    status: 'active',
  });

  const thread = createSupportRequest({
    donorId: donor.id,
    subject: 'Streaming issue',
    message: 'Playback is buffering a lot.',
    donorDisplayName: 'Flow User',
    authorName: 'Flow User',
  });

  const requestId = thread.request.id;
  const resolvedThread = markSupportRequestResolved(requestId, true);
  assert.ok(resolvedThread);
  assert.equal(resolvedThread.request.resolved, true);
  assert.equal(resolvedThread.request.status, 'resolved');

  const reopenedThread = addSupportMessageToRequest({
    requestId,
    donorId: donor.id,
    authorRole: 'donor',
    authorName: 'Flow User',
    message: 'It is still happening after reboot.',
  });
  assert.ok(reopenedThread);
  assert.equal(reopenedThread.request.resolved, false);
  assert.equal(reopenedThread.messages.length, 2);
  assert.equal(reopenedThread.messages[1].authorRole, 'donor');

  const adminReplyThread = addSupportMessageToRequest({
    requestId,
    donorId: donor.id,
    authorRole: 'admin',
    authorName: 'Support Agent',
    message: 'We adjusted settings on our end. Please try again.',
  });
  assert.ok(adminReplyThread);
  assert.equal(adminReplyThread.messages.length, 3);
  assert.equal(adminReplyThread.messages[2].authorRole, 'admin');

  const openRequests = listSupportRequests({ includeResolved: false });
  assert.equal(openRequests.length, 1);
  assert.equal(openRequests[0].resolved, false);

  const finalThread = markSupportRequestResolved(requestId, true);
  assert.ok(finalThread);
  assert.equal(finalThread.request.resolved, true);

  const stillOpen = listSupportRequests({ includeResolved: false });
  assert.equal(stillOpen.length, 0);
  const allRequests = listSupportRequests({ includeResolved: true });
  assert.equal(allRequests.length, 1);
  assert.equal(allRequests[0].resolved, true);
});

test('deleteSupportRequestById removes related messages', (t) => {
  resetDatabase();
  t.after(resetDatabase);

  const donor = createDonor({
    email: 'delete@example.com',
    name: 'Delete User',
    status: 'active',
  });

  const thread = createSupportRequest({
    donorId: donor.id,
    subject: 'Please delete this',
    message: 'You can close this ticket.',
    donorDisplayName: 'Delete User',
    authorName: 'Delete User',
  });

  const deleted = deleteSupportRequestById(thread.request.id);
  assert.equal(deleted, true);
  const fetched = getSupportThreadById(thread.request.id);
  assert.equal(fetched, null);
  const requests = listSupportRequests({ includeResolved: true });
  assert.equal(requests.length, 0);
});
