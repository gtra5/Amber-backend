'use strict';

const mongoose = require('mongoose');
const crypto   = require('crypto');

// ── HMAC secret — required at startup ────────────────────────────────────────
// Loaded lazily so the model can be required in tests without the server
// startup check running. The server/startup code validates it explicitly.
function getHmacSecret() {
  const s = process.env.INVITE_HMAC_SECRET;
  if (!s) throw new Error('[Circle] INVITE_HMAC_SECRET is not set');
  return s;
}

/**
 * Unambiguous alphabet: uppercase letters minus O and I; digits minus 0 and 1.
 * 32 characters → 32^10 ≈ 1.1 × 10^15 possible codes.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 10;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

function hmacCode(code) {
  return crypto
    .createHmac('sha256', getHmacSecret())
    .update(code)
    .digest('hex');
}

// ── Invite code sub-document ──────────────────────────────────────────────────
const inviteSchema = new mongoose.Schema({
  // HMAC-SHA256 of the plaintext code (using INVITE_HMAC_SECRET)
  codeHash:  { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  used:      { type: Boolean, default: false }
}, { _id: false });

// ── Circle schema ─────────────────────────────────────────────────────────────
const circleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Circle name is required'],
    trim: true,
    maxlength: [50, 'Circle name cannot exceed 50 characters']
  },
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
    required: true
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
    required: true
  },
  invites: {
    type:    [inviteSchema],
    default: []
  }
}, {
  timestamps: true
});

// Never expose invite hashes in API responses
circleSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.invites;
    return ret;
  }
});

circleSchema.index({ createdBy: 1 });
circleSchema.index({ members:   1 });
// Index on invite hash so the atomic join query is fast
circleSchema.index({ 'invites.codeHash': 1 });

// Enforce max 5 members before every save
circleSchema.pre('save', function(next) {
  if (this.members.length > 5) {
    return next(new Error('Circle cannot have more than 5 members'));
  }
  next();
});

// ── Instance methods ──────────────────────────────────────────────────────────

circleSchema.methods.memberIds = function() {
  return this.members.map(member => {
    const id = member && member._id ? member._id : member;
    return id ? id.toString() : null;
  }).filter(Boolean);
};

circleSchema.methods.isMember = function(userId) {
  const target = userId && userId.toString ? userId.toString() : String(userId);
  return this.members.some(member => {
    const id = member && member._id ? member._id : member;
    return id && id.toString() === target;
  });
};

/**
 * Create a new single-use invite code.
 * Returns the plaintext code (shown once to the creator, never stored).
 * Enforces max 5 pending (unused, unexpired) invites per circle.
 * Caller MUST call circle.save() after this.
 */
circleSchema.methods.createInviteCode = function() {
  // Prune expired / used invites before counting
  const now = Date.now();
  this.invites = this.invites.filter(
    inv => !inv.used && inv.expiresAt.getTime() > now
  );

  if (this.invites.length >= 5) {
    throw new Error('Maximum of 5 pending invites per circle');
  }

  const code     = generateCode();
  const codeHash = hmacCode(code);

  this.invites.push({
    codeHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  return code;
};

// ── Static: atomic join ───────────────────────────────────────────────────────

/**
 * Atomically join a user to a circle using an invite code.
 *
 * Uses a single findOneAndUpdate so two concurrent requests with the same
 * code cannot both succeed, and the circle can never exceed 5 members.
 *
 * Returns:
 *   { ok: true,  circle }                 — success
 *   { ok: false, reason: 'not_found' }    — no matching pending invite
 *   { ok: false, reason: 'already_member' }
 *   { ok: false, reason: 'full' }
 */
circleSchema.statics.atomicJoin = async function(rawCode, userId) {
  const codeHash = hmacCode(rawCode.toUpperCase());
  const now      = new Date();

  // One atomic operation: find a circle that has a matching, unused, unexpired
  // invite AND has fewer than 5 members AND does not already contain the user.
  // Mark the invite used and push the user in the same update.
  const updated = await this.findOneAndUpdate(
    {
      'invites': {
        $elemMatch: {
          codeHash,
          used:      false,
          expiresAt: { $gt: now }
        }
      },
      $expr: { $lt: [{ $size: '$members' }, 5] },
      members: { $ne: userId }
    },
    {
      $push: { members: userId },
      $set:  { 'invites.$[inv].used': true }
    },
    {
      arrayFilters:  [{ 'inv.codeHash': codeHash, 'inv.used': false, 'inv.expiresAt': { $gt: now } }],
      new:           true,
      runValidators: false   // validators run on members.length in pre-save; skip here to keep atomic
    }
  );

  if (updated) return { ok: true, circle: updated };

  // ── Determine why it failed (read-only follow-up, best-effort) ─────────────
  const existing = await this.findOne({
    'invites': { $elemMatch: { codeHash, used: false, expiresAt: { $gt: now } } }
  });

  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.isMember(userId)) return { ok: false, reason: 'already_member' };
  if (existing.members.length >= 5) return { ok: false, reason: 'full' };

  // The invite exists but another concurrent request just consumed it
  return { ok: false, reason: 'not_found' };
};

module.exports = mongoose.model('Circle', circleSchema);
