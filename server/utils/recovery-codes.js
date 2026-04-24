const crypto = require('crypto');
const {
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync,
} = require('./passwords');

const DEFAULT_CODE_COUNT = 8;
const DEFAULT_SEGMENT_LENGTH = 4;
const DEFAULT_SEGMENT_COUNT = 3;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCodeCharacter() {
  const index = crypto.randomInt(0, CODE_ALPHABET.length);
  return CODE_ALPHABET[index];
}

function generateRecoveryCode({
  segmentLength = DEFAULT_SEGMENT_LENGTH,
  segmentCount = DEFAULT_SEGMENT_COUNT,
} = {}) {
  const segments = [];

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    let segment = '';
    for (let charIndex = 0; charIndex < segmentLength; charIndex += 1) {
      segment += randomCodeCharacter();
    }
    segments.push(segment);
  }

  return segments.join('-');
}

function normalizeRecoveryCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return hashPasswordSync(normalizeRecoveryCode(code));
}

function createRecoveryCodeSet(count = DEFAULT_CODE_COUNT) {
  const codes = [];
  const records = [];

  for (let index = 0; index < count; index += 1) {
    const code = generateRecoveryCode();
    codes.push(code);
    records.push({
      code,
      codeHash: hashRecoveryCode(code),
    });
  }

  return {
    codes,
    records,
  };
}

async function verifyRecoveryCode(code, codeHash) {
  return verifyPassword(normalizeRecoveryCode(code), codeHash);
}

function verifyRecoveryCodeSync(code, codeHash) {
  return verifyPasswordSync(normalizeRecoveryCode(code), codeHash);
}

module.exports = {
  createRecoveryCodeSet,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
  verifyRecoveryCodeSync,
};
