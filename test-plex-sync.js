#!/usr/bin/env node
require('dotenv').config();
const { db } = require('./server/db');
const plexService = require('./server/services/plex');

console.log('=== Plex Status Sync Test ===\n');

if (!plexService.isConfigured()) {
  console.log('❌ Plex is not configured');
  process.exit(1);
}

console.log('Step 1: Fetching current Plex shares...\n');

(async () => {
  try {
    const plexResult = await plexService.getCurrentPlexShares();

    if (!plexResult.success) {
      console.log('❌ Failed to fetch Plex shares:', plexResult.reason);
      process.exit(1);
    }

    const currentShares = plexResult.shares;
    console.log(`✅ Found ${currentShares.length} current share(s) on Plex:`);

    currentShares.forEach((share, index) => {
      console.log(`\n[${index + 1}] Share ID: ${share.id}`);
      console.log(`    Emails: ${share.emails.join(', ') || 'None'}`);
      console.log(`    User IDs: ${share.userIds.join(', ') || 'None'}`);
      console.log(`    Status: ${share.status}`);
      console.log(`    Pending: ${share.pending}`);
    });

    console.log('\n\nStep 2: Checking database donors with Plex fields...\n');

    const allDonors = db.prepare(`
      SELECT id, email, name, plex_account_id, plex_email
      FROM donors
      WHERE plex_account_id IS NOT NULL OR plex_email IS NOT NULL
    `).all();

    console.log(`Found ${allDonors.length} donor(s) with Plex data in database:`);

    let staleCount = 0;
    const staleDonors = [];

    allDonors.forEach((donor) => {
      const normalizedEmail = donor.plex_email ? donor.plex_email.toLowerCase().trim() : '';
      const normalizedAccountId = donor.plex_account_id ? String(donor.plex_account_id).toLowerCase().trim() : '';

      // Check if donor has a current share
      const hasShare = currentShares.some((share) => {
        // Check by email
        if (normalizedEmail && share.emails) {
          const shareHasEmail = share.emails.some(
            (email) => email.toLowerCase().trim() === normalizedEmail
          );
          if (shareHasEmail) return true;
        }

        // Check by user ID
        if (normalizedAccountId && share.userIds) {
          const shareHasId = share.userIds.some(
            (id) => String(id).toLowerCase().trim() === normalizedAccountId
          );
          if (shareHasId) return true;
        }

        return false;
      });

      const status = hasShare ? '✅ HAS SHARE' : '❌ NO SHARE (STALE)';
      console.log(`\n${status}`);
      console.log(`  Donor ID: ${donor.id}`);
      console.log(`  Email: ${donor.email}`);
      console.log(`  Name: ${donor.name || 'N/A'}`);
      console.log(`  Plex Account ID: ${donor.plex_account_id || 'N/A'}`);
      console.log(`  Plex Email: ${donor.plex_email || 'N/A'}`);

      if (!hasShare) {
        staleCount++;
        staleDonors.push(donor);
      }
    });

    console.log('\n\n=== Summary ===');
    console.log(`Total Plex shares: ${currentShares.length}`);
    console.log(`Database donors with Plex data: ${allDonors.length}`);
    console.log(`Stale records (no current share): ${staleCount}`);

    if (staleCount > 0) {
      console.log('\n⚠️  Stale Records Found:');
      staleDonors.forEach((donor) => {
        console.log(`  - ${donor.email} (ID: ${donor.id})`);
      });
      console.log('\nTo clear these stale records, the admin can:');
      console.log('1. Use the Admin UI (if a sync button is added)');
      console.log('2. Call: POST /admin/plex/sync-status (requires authentication)');
    } else {
      console.log('\n✅ No stale records found! Database is in sync with Plex.');
    }

  } catch (err) {
    console.log('\n❌ ERROR:', err.message);
    console.log('\nFull error:');
    console.error(err);
    process.exit(1);
  }
})();
