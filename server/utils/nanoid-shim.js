const crypto = require('crypto');

// URL-friendly alphabet similar to nanoid
const ALPHABET = "_~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-";

function nanoid(size = 21) {
  const bytes = crypto.randomBytes(size);
  const out = new Array(size);
  const alphabetLen = ALPHABET.length;
  for (let i = 0; i < size; i++) {
    out[i] = ALPHABET[bytes[i] % alphabetLen];
  }
  return out.join('');
}

module.exports = { nanoid };
