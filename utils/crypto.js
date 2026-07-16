const crypto = require('crypto');

function getKey() {
  const hex = process.env.CREDENTIAL_ENC_KEY;
  if (!hex || hex.length < 64) {
    throw new Error(
      'CREDENTIAL_ENC_KEY is missing or too short. Set a 64-character hex string (32 bytes) in your .env file. Generate one with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

// Returns a single string "iv:authTag:ciphertext" (all hex) for easy DB storage.
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function decrypt(payload) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
