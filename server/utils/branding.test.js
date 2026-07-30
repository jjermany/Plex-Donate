const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DEFAULT_BRAND_NAME,
  formatEmailFrom,
  getBranding,
} = require('./branding');

test('branding defaults empty optional email fields to the application name', () => {
  assert.deepEqual(
    getBranding({
      brandName: 'Community Library',
      emailSenderName: '',
      emailSignoff: '',
    }),
    {
      brandName: 'Community Library',
      emailSenderName: 'Community Library',
      emailSignoff: 'Community Library',
    }
  );
  assert.equal(getBranding({}).brandName, DEFAULT_BRAND_NAME);
});

test('formatEmailFrom preserves the mailbox while replacing its display name', () => {
  const branding = getBranding({
    brandName: 'Community Library',
    emailSenderName: 'Community Team',
    emailSignoff: 'Community Team',
  });

  assert.equal(
    formatEmailFrom('Old Product <alerts@example.com>', branding),
    'Community Team <alerts@example.com>'
  );
  assert.equal(
    formatEmailFrom('alerts@example.com', branding),
    'Community Team <alerts@example.com>'
  );
});
