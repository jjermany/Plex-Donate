#!/usr/bin/env node
require('dotenv').config();
const { db } = require('./server/db');
const plexService = require('./server/services/plex');

console.log('=== Plex Access Revocation Test ===\n');

// Find donors with Plex access
const donors = db.prepare(`
  SELECT id, email, name, status, plex_account_id, plex_email, access_expires_at
  FROM donors
  WHERE plex_account_id IS NOT NULL OR plex_email IS NOT NULL
  ORDER BY id DESC
  LIMIT 20
`).all();

if (!donors || donors.length === 0) {
  console.log('❌ No donors found with Plex account linked');
  console.log('\nTo test revocation:');
  console.log('1. Create a trial or subscription');
  console.log('2. Link Plex account');
  console.log('3. Run this script again');
  process.exit(1);
}

console.log('Found donors with Plex access:\n');
donors.forEach((donor, index) => {
  console.log(`[${index + 1}] ID: ${donor.id} | Email: ${donor.email} | Name: ${donor.name || 'N/A'}`);
  console.log(`    Status: ${donor.status || 'N/A'}`);
  console.log(`    Plex Account ID: ${donor.plex_account_id || 'N/A'}`);
  console.log(`    Plex Email: ${donor.plex_email || 'N/A'}`);
  console.log(`    Access Expires: ${donor.access_expires_at || 'Never'}`);
  console.log('');
});

// Get donor ID from command line argument
const donorIndex = parseInt(process.argv[2], 10);
if (Number.isNaN(donorIndex) || donorIndex < 1 || donorIndex > donors.length) {
  console.log('Usage: node test-plex-revoke.js <number>');
  console.log(`Example: node test-plex-revoke.js 1 (to revoke donor #1 from the list above)`);
  process.exit(1);
}

const selectedDonor = donors[donorIndex - 1];

console.log(`\n=== Revoking Plex Access ===`);
console.log(`Donor ID: ${selectedDonor.id}`);
console.log(`Email: ${selectedDonor.email}`);
console.log(`Plex Account ID: ${selectedDonor.plex_account_id || 'N/A'}`);
console.log(`Plex Email: ${selectedDonor.plex_email || 'N/A'}`);
console.log('');

// Test the revoke function
(async () => {
  try {
    const result = await plexService.revokeUser({
      plexAccountId: selectedDonor.plex_account_id,
      email: selectedDonor.plex_email || selectedDonor.email,
    });

    console.log('\n=== Revocation Result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('\n✅ SUCCESS! Plex access has been revoked.');
      console.log('\nWhat happened:');
      console.log('- User was removed from your Plex server');
      console.log('- They can no longer access your content');
      console.log('- They may receive an email from Plex about the removal');

      console.log('\nTo verify:');
      console.log('1. Go to your Plex server settings → Users');
      console.log('2. Confirm the user is no longer in the list');
    } else {
      console.log(`\n⚠️  Revocation returned: ${result.reason}`);
      if (result.reason === 'User not found on Plex server') {
        console.log('\nThis could mean:');
        console.log('- The user was already removed');
        console.log('- The user never had access');
        console.log('- The plexAccountId/email doesn\'t match any user');
      } else if (result.reason === 'Plex integration disabled') {
        console.log('\nPlex integration is not configured. Check your .env file.');
      }
    }
  } catch (err) {
    console.log('\n❌ ERROR:', err.message);
    console.log('\nFull error:');
    console.error(err);
  }
})();
