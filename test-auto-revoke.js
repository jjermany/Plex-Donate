#!/usr/bin/env node
require('dotenv').config();
const { db } = require('./server/db');
const { processAccessExpirations } = require('./server/index');

async function main() {
  console.log('=== Automatic Access Expiration Test ===\n');

  // Find donors with active access
  const donors = db.prepare(`
    SELECT id, email, name, status, plex_account_id, plex_email, access_expires_at
    FROM donors
    WHERE (plex_account_id IS NOT NULL OR plex_email IS NOT NULL)
      AND status IN ('trial', 'active', 'paid')
    ORDER BY id DESC
    LIMIT 20
  `).all();

  if (!donors || donors.length === 0) {
    console.log('❌ No active donors found with Plex account linked');
    console.log('\nTo test automatic expiration:');
    console.log('1. Create a trial or subscription');
    console.log('2. Link Plex account');
    console.log('3. Run this script again');
    return;
  }

  console.log('Found active donors with Plex access:\n');
  donors.forEach((donor, index) => {
    console.log(`[${index + 1}] ID: ${donor.id} | Email: ${donor.email} | Status: ${donor.status}`);
    console.log(`    Plex Account ID: ${donor.plex_account_id || 'N/A'}`);
    console.log(`    Access Expires: ${donor.access_expires_at || 'Never'}`);
    console.log('');
  });

  // Get donor ID from command line argument
  const donorIndex = parseInt(process.argv[2], 10);
  if (Number.isNaN(donorIndex) || donorIndex < 1 || donorIndex > donors.length) {
    console.log('Usage: node test-auto-revoke.js <number>');
    console.log(`Example: node test-auto-revoke.js 1 (to expire and revoke donor #1 from the list above)`);
    return;
  }

  const selectedDonor = donors[donorIndex - 1];

  console.log(`\n=== Setting Access Expiration ===`);
  console.log(`Donor ID: ${selectedDonor.id}`);
  console.log(`Email: ${selectedDonor.email}`);
  console.log(`Current Status: ${selectedDonor.status}`);
  console.log(`Current Expiration: ${selectedDonor.access_expires_at || 'Never'}`);

  // Set access expiration to 1 minute ago
  const pastDate = new Date(Date.now() - 60000).toISOString();
  console.log(`Setting expiration to: ${pastDate} (1 minute ago)`);

  try {
    db.prepare(`
      UPDATE donors
      SET access_expires_at = ?
      WHERE id = ?
    `).run(pastDate, selectedDonor.id);

    console.log('✅ Expiration date updated\n');

    console.log('=== Running Access Expiration Job ===');
    console.log('This simulates the automatic job that runs every 60 seconds...\n');

    await processAccessExpirations();

    console.log('\n=== Job Completed ===');

    // Check the donor's new status
    const updatedDonor = db.prepare(`
      SELECT id, email, status, access_expires_at
      FROM donors
      WHERE id = ?
    `).get(selectedDonor.id);

    console.log('\nUpdated Donor Status:');
    console.log(`- Status: ${updatedDonor.status}`);
    console.log(`- Access Expires: ${updatedDonor.access_expires_at || 'Cleared'}`);

    if (updatedDonor.status === 'trial_expired') {
      console.log('\n✅ SUCCESS! Trial expired and access revoked.');
    } else if (updatedDonor.access_expires_at === null) {
      console.log('\n✅ SUCCESS! Access expiration processed and cleared.');
    } else {
      console.log('\n⚠️  Status unchanged. Check the logs for details.');
    }

    console.log('\nTo verify:');
    console.log('1. Check your application logs for "plex.access.revoked" event');
    console.log('2. Go to your Plex server settings → Users');
    console.log('3. Confirm the user is no longer in the list');
  } catch (err) {
    console.log('\n❌ ERROR updating database:', err.message);
    console.error(err);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
