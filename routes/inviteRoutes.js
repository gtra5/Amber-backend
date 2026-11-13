'use strict';

/**
 * Invitation routes (mounted at /api/circles):
 *
 *   POST /invite-email        email an invitation link to up to 5 people
 *   POST /:id/invites/qr      create a short-lived QR invitation
 *   POST /invite-preview      "who invited me to what?" (does not use up the invite)
 *   POST /join-invite         accept an invitation (single use)
 *
 * The older manual 10-character code (POST /:id/invites + POST /join) in
 * circleRoutes.js keeps working unchanged.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const { authenticateJWT } = require('../middleware/auth');
const Circle  = require('../models/Circle');
const Invite  = require('../models/Invite');
const emailService  = require('../services/emailService');
const inviteService = require('../services/inviteService');

const { ID_RE, MAX_MEMBERS } = inviteService;

// ── Limits ───────────────────────────────────────────────────────────────────
// This feature makes our server send email to arbitrary addresses, so it is
// limited on several levels: per request, per user per hour, per circle, and
// per recipient address per day.

const MAX_EMAILS_PER_REQUEST       = 5;
const MAX_EMAILS_PER_USER_PER_HOUR = 10;
const MAX_PENDING_EMAIL_PER_CIRCLE = 10;
const MAX_INVITES_PER_ADDRESS_DAY  = 3;

const byUser = (req) => req.user._id.toString();   // not by IP: phones on mobile networks share IPs

const emailRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, keyGenerator: byUser,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many invitation requests. Please try again later.' }
});
const qrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, keyGenerator: byUser,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many QR invitations. Please try again later.' }
});
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, keyGenerator: byUser,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// Practical email check: one @, sensible characters, a dot in the domain. No
// quotes, spaces, commas or line breaks (those are how header injection works).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// ── Shared answers for a refused invitation ──────────────────────────────────

function refuse(res, result) {
  switch (result.reason) {
    case 'already_member':
      return res.status(409).json({ error: 'You are already a member of this circle', code: 'ALREADY_MEMBER' });
    case 'full':
      return res.status(409).json({ error: 'This circle is full (maximum 5 members)', code: 'CIRCLE_FULL' });
    case 'email_mismatch':
      return res.status(403).json({
        error: `This invitation was sent to ${result.maskedEmail}. Log in with that email address to accept it.`,
        code: 'EMAIL_MISMATCH',
        maskedEmail: result.maskedEmail
      });
    default:
      // wrong / expired / already used / unknown circle: all look the same on purpose
      return res.status(404).json({ error: 'This invitation is invalid or has expired', code: 'INVITE_INVALID' });
  }
}

// ── POST /api/circles/invite-email ───────────────────────────────────────────

router.post('/invite-email', authenticateJWT, emailRequestLimiter, async (req, res) => {
  try {
    const { circleId, emails } = req.body || {};

    if (typeof circleId !== 'string' || !ID_RE.test(circleId)) {
      return res.status(400).json({ error: 'Invalid circle ID' });
    }
    if (!Array.isArray(emails) || emails.length < 1 || emails.length > MAX_EMAILS_PER_REQUEST) {
      return res.status(400).json({ error: `Provide between 1 and ${MAX_EMAILS_PER_REQUEST} email addresses` });
    }

    // Normalise, validate and remove duplicates
    const invalid = [];
    const list    = [];
    const seen    = new Set();
    for (const raw of emails) {
      const e = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (!e || e.length > 254 || !EMAIL_RE.test(e)) { invalid.push(String(raw).slice(0, 60)); continue; }
      if (!seen.has(e)) { seen.add(e); list.push(e); }
    }
    if (invalid.length) {
      return res.status(400).json({ error: 'Some email addresses are not valid', invalid });
    }

    if (!emailService.isConfigured()) {
      return res.status(503).json({ error: 'Email sending is not set up on this server yet' });
    }

    const circle = await Circle.findById(circleId).populate('members', 'email');
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (!circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'Not a member of this circle' });
    }
    if (circle.members.length >= MAX_MEMBERS) {
      return res.status(409).json({ error: 'This circle is full (maximum 5 members)', code: 'CIRCLE_FULL' });
    }

    const now       = new Date();
    const hourAgo   = new Date(now - 60 * 60 * 1000);
    const dayAgo    = new Date(now - 24 * 60 * 60 * 1000);

    let quota = Math.max(0, MAX_EMAILS_PER_USER_PER_HOUR - await Invite.countDocuments({
      createdBy: req.user._id, kind: 'email', createdAt: { $gt: hourAgo }
    }));
    let pendingRoom = Math.max(0, MAX_PENDING_EMAIL_PER_CIRCLE - await Invite.countDocuments({
      circle: circle._id, kind: 'email', usedAt: null, revokedAt: null, expiresAt: { $gt: now }
    }));

    const memberEmails = new Set(circle.members.map(m => String(m.email).toLowerCase()));
    const myEmail      = String(req.user.email).toLowerCase();
    const results      = [];

    for (const email of list) {
      if (email === myEmail)           { results.push({ email, status: 'skipped', reason: 'self' });           continue; }
      if (memberEmails.has(email))     { results.push({ email, status: 'skipped', reason: 'already_member' }); continue; }
      if (quota <= 0)                  { results.push({ email, status: 'skipped', reason: 'rate_limited' });   continue; }

      // An earlier, still-unused invite to the same address is replaced
      const superseded = await Invite.find({
        circle: circle._id, kind: 'email', email, usedAt: null, revokedAt: null, expiresAt: { $gt: now }
      }).select('_id').lean();

      if (superseded.length === 0 && pendingRoom <= 0) {
        results.push({ email, status: 'skipped', reason: 'too_many_pending' });
        continue;
      }
      if (await Invite.countDocuments({ email, createdAt: { $gt: dayAgo } }) >= MAX_INVITES_PER_ADDRESS_DAY) {
        results.push({ email, status: 'skipped', reason: 'recipient_limit' });
        continue;
      }

      const { invite, token } = await inviteService.createInvite({
        circleId: circle._id, createdBy: req.user._id, kind: 'email', email
      });

      try {
        await emailService.sendInviteEmail({
          to:          email,
          inviterName: req.user.name,
          circleName:  circle.name,
          link:        inviteService.buildInviteLink(String(circle._id), token),
          expiresAt:   invite.expiresAt
        });
      } catch (sendErr) {
        // Nothing was delivered, so the stored token must not stay usable
        await Invite.deleteOne({ _id: invite._id });
        console.error(`[invite] email to ${emailService.maskEmail(email)} failed:`, sendErr.message);
        results.push({ email, status: 'failed' });
        continue;
      }

      // Only now do older links to the same address stop working. They are
      // revoked, not deleted, so the per-address daily limit keeps counting them.
      if (superseded.length) {
        await Invite.updateMany(
          { _id: { $in: superseded.map(i => i._id) } },
          { $set: { revokedAt: new Date() } }
        );
      } else {
        pendingRoom -= 1;
      }
      quota -= 1;
      results.push({ email, status: 'sent' });
    }

    const sent   = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;

    if (sent === 0 && failed > 0) {
      return res.status(502).json({ error: 'The email could not be sent. Please try again later.', results });
    }

    res.status(200).json({
      message: sent ? 'Invitations sent' : 'No invitations were sent',
      sent,
      results,
      expiresInHours: Math.round(inviteService.emailTtlMs() / 3_600_000)
    });
  } catch (err) {
    console.error('[invite] invite-email error:', err.message);
    res.status(500).json({ error: 'Failed to send invitations' });
  }
});

// ── POST /api/circles/:id/invites/qr ─────────────────────────────────────────

router.post('/:id/invites/qr', authenticateJWT, qrLimiter, async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const circle = await Circle.findById(req.params.id).select('members');
    if (!circle) return res.status(404).json({ error: 'Circle not found' });
    if (!circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'Not a member of this circle' });
    }
    if (circle.members.length >= MAX_MEMBERS) {
      return res.status(409).json({ error: 'This circle is full (maximum 5 members)', code: 'CIRCLE_FULL' });
    }

    // One live QR per person per circle: showing a new one retires the old one
    await Invite.deleteMany({ circle: circle._id, createdBy: req.user._id, kind: 'qr', usedAt: null });   // QR codes are not counted, so deleting is fine

    const { invite, token } = await inviteService.createInvite({
      circleId: circle._id, createdBy: req.user._id, kind: 'qr'
    });

    res.status(201).json({
      circleId:   String(circle._id),
      token,                                   // shown once, never stored
      link:       inviteService.buildInviteLink(String(circle._id), token),
      expiresAt:  invite.expiresAt,
      ttlSeconds: Math.round(inviteService.qrTtlMs() / 1000)
    });
  } catch (err) {
    console.error('[invite] qr error:', err.message);
    res.status(500).json({ error: 'Failed to create QR invitation' });
  }
});

// ── POST /api/circles/invite-preview ─────────────────────────────────────────
// A POST (not a GET) so the token never lands in URLs, proxies or access logs.

router.post('/invite-preview', authenticateJWT, redeemLimiter, async (req, res) => {
  try {
    const { circleId, token } = req.body || {};
    if (!inviteService.isValidFormat(circleId, token)) {
      return res.status(400).json({ error: 'Invalid invitation', code: 'INVITE_MALFORMED' });
    }

    const result = await inviteService.previewInvite({ circleId, token, user: req.user });
    if (!result.ok) return refuse(res, result);

    res.status(200).json({ invite: result.preview });
  } catch (err) {
    console.error('[invite] preview error:', err.message);
    res.status(500).json({ error: 'Failed to read invitation' });
  }
});

// ── POST /api/circles/join-invite ────────────────────────────────────────────

router.post('/join-invite', authenticateJWT, redeemLimiter, async (req, res) => {
  try {
    const { circleId, token } = req.body || {};
    if (!inviteService.isValidFormat(circleId, token)) {
      return res.status(400).json({ error: 'Invalid invitation', code: 'INVITE_MALFORMED' });
    }

    const result = await inviteService.redeemInvite({ circleId, token, user: req.user });
    if (!result.ok) return refuse(res, result);

    const circle = result.circle;

    // The new member's open sockets join the circle room right away, and the
    // others are told so their member lists can refresh.
    const io = req.app.get('io');
    if (io) {
      io.in(`user:${req.user._id}`).socketsJoin(`circle:${circle._id}`);
      io.to(`circle:${circle._id}`).emit('circle_member_joined', {
        circleId: String(circle._id),
        userId:   String(req.user._id),
        name:     req.user.name
      });
    }

    await circle.populate('members', 'name email');
    res.status(200).json({ message: 'Joined circle', circle });
  } catch (err) {
    console.error('[invite] join error:', err.message);
    res.status(500).json({ error: 'Failed to join circle' });
  }
});

module.exports = router;
