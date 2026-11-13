'use strict';

const express   = require('express');
const router    = express.Router();
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { authenticateJWT } = require('../middleware/auth');
const User     = require('../models/User');
const Circle   = require('../models/Circle');
const SosAlert = require('../models/SosAlert');
const { removeUserFromCircle } = require('../services/circleService');

// ── Rate limiters ─────────────────────────────────────────────────────────────

// Per-IP: 100 per 15 min (many phones can share a single IP via NAT/proxy)
const ipAuthLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            100,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: 'Too many attempts from this IP, please try again later.' }
});

// Per-email: 10 per 15 min (prevents password spraying against a specific account)
const emailAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  keyGenerator: (req) => {
    const raw = req.body && req.body.email;
    return typeof raw === 'string' ? raw.trim().toLowerCase() : req.ip;
  },
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: 'Too many attempts for this account, please try again later.' }
});

// Account deletion: few attempts per hour, keyed by user (password is re-checked)
const deleteAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  keyGenerator: (req) => req.user._id.toString(),
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Too many attempts, please try again later.' }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidString(val, maxLen) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= maxLen;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 */
router.post('/register', ipAuthLimiter, emailAuthLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!isValidString(name, 100)) {
      return res.status(400).json({ error: 'Name must be a non-empty string (max 100 chars)' });
    }
    if (!isValidString(email, 254)) {
      return res.status(400).json({ error: 'Email must be a non-empty string (max 254 chars)' });
    }
    if (!isValidString(password, 128)) {
      return res.status(400).json({ error: 'Password must be a non-empty string (max 128 chars)' });
    }

    const normEmail = email.trim().toLowerCase();

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email: normEmail });
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = new User({ name: name.trim(), email: normEmail, passwordHash });
    await user.save();

    // TODO: move to short-lived access tokens + refresh tokens before production
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', ipAuthLimiter, emailAuthLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!isValidString(email, 254)) {
      return res.status(400).json({ error: 'Email must be a non-empty string' });
    }
    if (!isValidString(password, 128)) {
      return res.status(400).json({ error: 'Password must be a non-empty string' });
    }

    const normEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normEmail });

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // TODO: move to short-lived access tokens + refresh tokens before production
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Failed to login' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticateJWT, async (req, res) => {
  try {
    res.status(200).json({
      user: { id: req.user._id, name: req.user.name, email: req.user.email }
    });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * POST /api/auth/fcm-token
 */
router.post('/fcm-token', authenticateJWT, async (req, res) => {
  try {
    const { token } = req.body;

    if (!isValidString(token, 4096)) {
      return res.status(400).json({ error: 'FCM token must be a non-empty string (max 4096 chars)' });
    }

    await req.user.addFCMToken(token.trim());
    res.status(200).json({ message: 'FCM token updated' });
  } catch (err) {
    console.error('[auth] fcm-token error:', err.message);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', authenticateJWT, async (req, res) => {
  try {
    const { token } = req.body;

    if (typeof token === 'string' && token.trim()) {
      await req.user.removeFCMToken(token.trim());
    }

    res.status(200).json({ message: 'Logged out' });
  } catch (err) {
    console.error('[auth] logout error:', err.message);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

/**
 * DELETE /api/auth/me
 * Permanently deletes the account (App Store and Google Play both require
 * in-app account deletion). The password is asked again as confirmation.
 *
 * What happens:
 *  - any active alert the user sent is cancelled and members are told
 *  - the user leaves every circle (empty circles are deleted)
 *  - every alert the user sent, with its location history, is deleted
 *  - the user is removed from other alerts' "responding" lists
 *  - the user's live sockets are disconnected
 *
 * A wrong password answers 403 (not 401) so the app does not mistake it for
 * an expired session and log the person out.
 */
router.delete('/me', authenticateJWT, deleteAccountLimiter, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!isValidString(password, 128)) {
      return res.status(400).json({ error: 'Password is required to delete your account' });
    }

    const user = await User.findById(req.user._id);
    if (!user || !(await user.comparePassword(password))) {
      return res.status(403).json({ error: 'Incorrect password' });
    }

    const io = req.app.get('io');

    const circles = await Circle.find({ members: user._id }).select('_id');
    for (const c of circles) {
      await removeUserFromCircle(io, c._id, user._id);
    }

    await SosAlert.deleteMany({ sender: user._id });
    await SosAlert.updateMany(
      { respondingMembers: user._id },
      { $pull: { respondingMembers: user._id } }
    );

    await User.deleteOne({ _id: user._id });

    if (io) io.in(`user:${user._id}`).disconnectSockets(true);

    res.status(200).json({ message: 'Account deleted' });
  } catch (err) {
    console.error('[auth] delete account error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
