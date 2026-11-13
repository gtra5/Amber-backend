'use strict';

/**
 * inviteService — creating, previewing and redeeming QR / email invitations.
 *
 * Security model
 *  - Tokens are 256 bits from crypto.randomBytes (43 URL-safe characters), so
 *    they cannot be guessed.
 *  - Only an HMAC of the token is stored (keyed with INVITE_HMAC_SECRET).
 *  - A token works once. Redeeming is an atomic "claim" in MongoDB, so two
 *    people scanning the same QR code at the same instant cannot both get in.
 *  - Every kind of "no" for a bad token (wrong, expired, already used, wrong
 *    circle, circle deleted) looks identical from outside, so nobody can use
 *    the endpoints to learn which circles exist.
 *  - Email invitations are bound to the address they were sent to.
 *
 * The caller (route) must already have checked that the user is logged in.
 */

const crypto   = require('crypto');
const Circle   = require('../models/Circle');
const Invite   = require('../models/Invite');
const User     = require('../models/User');
const { maskEmail } = require('./emailService');

const MAX_MEMBERS = 5;

const ID_RE    = /^[0-9a-fA-F]{24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ── Settings (read at call time so tests and deployments can change them) ────

const qrTtlMs    = () => Number(process.env.QR_INVITE_TTL_MINUTES   || 10) * 60 * 1000;
const emailTtlMs = () => Number(process.env.EMAIL_INVITE_TTL_HOURS  || 48) * 60 * 60 * 1000;
const requireEmailMatch = () => process.env.INVITE_REQUIRE_EMAIL_MATCH !== 'false';

function hmacSecret() {
  const s = process.env.INVITE_HMAC_SECRET;
  if (!s) throw new Error('INVITE_HMAC_SECRET is not set');
  return s;
}

// ── Tokens and links ─────────────────────────────────────────────────────────

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');   // 43 characters
}

/** Keyed hash with its own label, so it can never equal the hash of a manual invite code. */
function hashToken(token) {
  return crypto.createHmac('sha256', hmacSecret()).update(`invite-token:v1\n${token}`).digest('hex');
}

function isValidFormat(circleId, token) {
  return typeof circleId === 'string' && ID_RE.test(circleId) &&
         typeof token === 'string'    && TOKEN_RE.test(token);
}

/**
 * The https link that goes in the email and the QR code. It opens the app
 * directly when the phone has "app links" set up, and otherwise lands on the
 * small web page served by routes/inviteLinkRoutes.js.
 */
function buildInviteLink(circleId, token) {
  const base = (process.env.APP_LINK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/+$/, '');
  return `${base}/invite?c=${circleId}&t=${token}`;
}

// ── Creating ─────────────────────────────────────────────────────────────────

async function createInvite({ circleId, createdBy, kind, email, ttlMs }) {
  const token = generateToken();
  const invite = await Invite.create({
    circle:    circleId,
    createdBy,
    kind,
    email:     kind === 'email' ? email : undefined,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + (ttlMs ?? (kind === 'qr' ? qrTtlMs() : emailTtlMs())))
  });
  return { invite, token };
}

// ── Looking up (never consumes) ──────────────────────────────────────────────

async function findLiveInvite(circleId, token) {
  return Invite.findOne({
    tokenHash: hashToken(token),
    circle:    circleId,
    usedAt:    null,
    revokedAt: null,
    expiresAt: { $gt: new Date() }
  });
}

/**
 * What the person should see before they accept. Does NOT use up the invite.
 * Returns { ok:true, preview } or { ok:false, reason, ... }
 */
async function previewInvite({ circleId, token, user }) {
  const invite = await findLiveInvite(circleId, token);
  if (!invite) return { ok: false, reason: 'invalid' };

  const circle = await Circle.findById(circleId).populate('createdBy', 'name').lean();
  if (!circle) return { ok: false, reason: 'invalid' };

  const memberIds = circle.members.map(m => m.toString());
  if (memberIds.includes(user._id.toString())) return { ok: false, reason: 'already_member' };

  if (requireEmailMatch() && invite.email && invite.email !== String(user.email).toLowerCase()) {
    return { ok: false, reason: 'email_mismatch', maskedEmail: maskEmail(invite.email) };
  }
  if (memberIds.length >= MAX_MEMBERS) return { ok: false, reason: 'full' };

  const inviter = await User.findById(invite.createdBy).select('name').lean();

  return {
    ok: true,
    preview: {
      circleId:    String(circle._id),
      circleName:  circle.name,
      inviterName: inviter ? inviter.name : 'A member',
      memberCount: memberIds.length,
      maxMembers:  MAX_MEMBERS,
      expiresAt:   invite.expiresAt
    }
  };
}

// ── Redeeming (single use, atomic) ───────────────────────────────────────────

async function redeemInvite({ circleId, token, user }) {
  const now    = new Date();
  const invite = await findLiveInvite(circleId, token);
  if (!invite) return { ok: false, reason: 'invalid' };

  const circle = await Circle.findById(circleId).select('members');
  if (!circle) return { ok: false, reason: 'invalid' };

  if (circle.isMember(user._id)) return { ok: false, reason: 'already_member' };

  if (requireEmailMatch() && invite.email && invite.email !== String(user.email).toLowerCase()) {
    return { ok: false, reason: 'email_mismatch', maskedEmail: maskEmail(invite.email) };
  }

  // 1. Claim the invite. Only one caller can ever flip usedAt from null.
  const claimed = await Invite.findOneAndUpdate(
    { _id: invite._id, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now, usedBy: user._id } },
    { new: true }
  );
  if (!claimed) return { ok: false, reason: 'invalid' };   // someone else was faster

  // 2. Add the member, atomically enforcing "not already in" and "at most 5".
  const updated = await Circle.findOneAndUpdate(
    {
      _id:     circleId,
      members: { $ne: user._id },
      $expr:   { $lt: [{ $size: '$members' }, MAX_MEMBERS] }
    },
    { $push: { members: user._id } },
    { new: true }
  );

  if (!updated) {
    // 3. The circle filled up (or the user got in some other way) in the
    //    meantime: give the invite back so it is not wasted.
    await Invite.updateOne({ _id: claimed._id, usedBy: user._id }, { $set: { usedAt: null, usedBy: null } });

    const again = await Circle.findById(circleId).select('members');
    if (!again) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: again.isMember(user._id) ? 'already_member' : 'full' };
  }

  return { ok: true, circle: updated };
}

module.exports = {
  MAX_MEMBERS,
  ID_RE,
  TOKEN_RE,
  qrTtlMs,
  emailTtlMs,
  generateToken,
  hashToken,
  isValidFormat,
  buildInviteLink,
  createInvite,
  previewInvite,
  redeemInvite
};
