#!/usr/bin/env node

/**
 * Test script to diagnose Plex invite issues
 * Run: node test-plex-invite.js
 */

const Database = require('better-sqlite3');
const path = require('path');

// Get the most recent donor with Plex linked
const dbPath = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'plex-donate.db');
const db = new Database(dbPath, { readonly: true });

console.log('\n=== Checking Database ===');
const donor = db.prepare(`
  SELECT id, email, plex_account_id, plex_email, status
  FROM donors
  WHERE plex_account_id IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
`).get();

if (!donor) {
  console.error('❌ No donors found with plex_account_id set');
  console.log('   Link a Plex account first, then run this script');
  process.exit(1);
}

console.log('✓ Found donor with Plex linked:');
console.log(`  ID: ${donor.id}`);
console.log(`  Email: ${donor.email}`);
console.log(`  Plex Account ID: ${donor.plex_account_id}`);
console.log(`  Plex Email: ${donor.plex_email}`);
console.log(`  Status: ${donor.status}`);

// Get Plex config from environment
console.log('\n=== Checking Plex Configuration ===');
const plexToken = process.env.PLEX_TOKEN;
const serverIdentifier = process.env.PLEX_SERVER_IDENTIFIER || 'b644837c-6145-4e38-b6c6-95c9c989ac1b';
const librarySectionIds = process.env.PLEX_LIBRARY_SECTION_IDS || '1,2';

if (!plexToken) {
  console.error('❌ PLEX_TOKEN not set in environment');
  process.exit(1);
}

console.log(`✓ Server ID: ${serverIdentifier}`);
console.log(`✓ Library Sections: ${librarySectionIds}`);
console.log(`✓ Token: ${plexToken.substring(0, 10)}...`);

// Test the API call
console.log('\n=== Testing Plex API Call ===');

const fetch = require('node-fetch');

const sections = librarySectionIds.split(',').map(s => s.trim()).filter(Boolean);

const body = {
  machineIdentifier: serverIdentifier,
  librarySectionIds: sections,
  invitedId: donor.plex_account_id,
  settings: {
    allowSync: '0',
    allowCameraUpload: '0',
    allowChannels: '0'
  }
};

console.log('Request body:', JSON.stringify(body, null, 2));

const url = `https://plex.tv/api/v2/friends?X-Plex-Token=${plexToken}`;

fetch(url, {
  method: 'POST',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Plex-Product': 'Plex-Donate',
    'X-Plex-Version': '1.0',
    'X-Plex-Device': 'Server',
    'X-Plex-Platform': 'Web',
    'X-Plex-Client-Identifier': 'plex-donate-test'
  },
  body: JSON.stringify(body)
})
.then(async (response) => {
  console.log(`\nResponse status: ${response.status} ${response.statusText}`);

  const text = await response.text();
  console.log('Response body:', text);

  if (response.ok) {
    console.log('\n✅ SUCCESS! Invite created!');
  } else {
    console.log('\n❌ FAILED');
    console.log('\nTroubleshooting:');
    if (response.status === 404) {
      console.log('  - 404 usually means:');
      console.log('    1. invitedId is the server owner (can\'t invite yourself)');
      console.log('    2. machineIdentifier is wrong');
      console.log('    3. librarySectionIds are invalid');
    } else if (response.status === 401 || response.status === 403) {
      console.log('  - Token is invalid or expired');
    }
  }
})
.catch((err) => {
  console.error('\n❌ Network error:', err.message);
});
