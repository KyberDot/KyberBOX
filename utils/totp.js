const crypto = require('crypto');
const { generateSecret, verify, generateURI } = require('otplib');
const QRCode = require('qrcode');

// otplib's epochTolerance is in seconds and is symmetric (past+future) -
// 30s covers one time-step of drift either direction, which is the
// standard tolerance most authenticator apps and services use. Verified
// empirically before relying on it: without this, even a few seconds of
// clock drift between the user's device and this server would reject an
// otherwise-correct code.
const TOLERANCE_SECONDS = 30;

function newSecret() {
  return generateSecret();
}

async function buildQrDataUrl(secret, email, issuer) {
  const uri = generateURI({ issuer, label: email, secret });
  return QRCode.toDataURL(uri);
}

// Returns { valid, timeStep }. lastTimeStep, if given, blocks re-using the
// exact same code (or an older one) within the tolerance window - without
// this, a code that leaked once (screen-shoulder-surfed, intercepted,
// etc) would stay valid for the whole tolerance window rather than
// single-use. Caller owns persisting timeStep back onto the user record;
// this module has no access to per-user state itself.
async function verifyCode(secret, token, lastTimeStep) {
  const cleaned = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };

  const result = await verify({ secret, token: cleaned, epochTolerance: TOLERANCE_SECONDS });
  if (!result.valid) return { valid: false };
  if (lastTimeStep != null && result.timeStep <= lastTimeStep) return { valid: false };

  return { valid: true, timeStep: result.timeStep };
}

// Recovery codes are single-use backup credentials for when the user's
// authenticator device is unavailable. Formatted like XXXXX-XXXXX for
// readability; stored as bcrypt hashes, never plaintext, matching how
// passwords are handled elsewhere in this app.
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}

module.exports = { newSecret, buildQrDataUrl, verifyCode, generateRecoveryCodes };
