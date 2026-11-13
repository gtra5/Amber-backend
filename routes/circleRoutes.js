'use strict';

const express   = require('express');
const router    = express.Router();
const mongoose  = require('mongoose');
const rateLimit = require('express-rate-limit');
const { authenticateJWT } = require('../middleware/auth');
const Circle   = require('../models/Circle');
const SosAlert = require('../models/SosAlert');
const {
  endCircleAlerts,
  removeUserFromCircle
} = require('../services/circleService');

// Rate-limit invite redemption — keyed by user id (not IP)
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  keyGenerator: (req) => req.user._id.toString(),
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Too many join attempts, please try again later.' }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function validId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/circles
 */
router.post('/', authenticateJWT, async (req, res) => {
  try {
    const { name } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Circle name is required' });
    }
    if (name.trim().length > 50) {
      return res.status(400).json({ error: 'Circle name cannot exceed 50 characters' });
    }

    const circle = new Circle({
      name:      name.trim(),
      members:   [req.user._id],
      createdBy: req.user._id
    });

    await circle.save();
    await circle.populate('members', 'name email');

    res.status(201).json({ message: 'Circle created', circle });
  } catch (err) {
    console.error('[circles] create error:', err.message);
    res.status(500).json({ error: 'Failed to create circle' });
  }
});

/**
 * GET /api/circles
 */
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const circles = await Circle.find({ members: req.user._id })
      .populate('members',   'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.status(200).json({ circles });
  } catch (err) {
    console.error('[circles] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch circles' });
  }
});

/**
 * GET /api/circles/:id
 */
router.get('/:id', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const circle = await Circle.findById(req.params.id)
      .populate('members',   'name email')
      .populate('createdBy', 'name email');

    if (!circle)                        return res.status(404).json({ error: 'Circle not found' });
    if (!circle.isMember(req.user._id)) return res.status(403).json({ error: 'Not a member' });

    res.status(200).json({ circle });
  } catch (err) {
    console.error('[circles] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch circle' });
  }
});

/**
 * PATCH /api/circles/:id — rename only
 */
router.patch('/:id', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Circle name is required' });
    }
    if (name.trim().length > 50) {
      return res.status(400).json({ error: 'Circle name cannot exceed 50 characters' });
    }

    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (circle.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the creator can rename this circle' });
    }

    circle.name = name.trim();
    await circle.save();
    await circle.populate('members', 'name email');

    res.status(200).json({ message: 'Circle renamed', circle });
  } catch (err) {
    console.error('[circles] patch error:', err.message);
    res.status(500).json({ error: 'Failed to update circle' });
  }
});

/**
 * DELETE /api/circles/:id
 */
router.delete('/:id', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (circle.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the creator can delete this circle' });
    }

    const io = req.app.get('io');
    await endCircleAlerts(io, circle);
    await Circle.deleteOne({ _id: circle._id });

    res.status(200).json({ message: 'Circle deleted' });
  } catch (err) {
    console.error('[circles] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete circle' });
  }
});

/**
 * POST /api/circles/:id/invites
 */
router.post('/:id/invites', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (!circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'Not a member of this circle' });
    }

    let code;
    try {
      code = circle.createInviteCode();
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await circle.save();

    res.status(201).json({
      message:        'Invite code created',
      code,            // shown ONCE — never retrievable again
      expiresInHours: 24
    });
  } catch (err) {
    console.error('[circles] invite error:', err.message);
    res.status(500).json({ error: 'Failed to create invite code' });
  }
});

/**
 * POST /api/circles/join
 *
 * Uses a single atomic findOneAndUpdate so two concurrent requests with the
 * same code can never both succeed.
 */
router.post('/join', authenticateJWT, joinLimiter, async (req, res) => {
  try {
    const { code } = req.body;

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'Invite code is required' });
    }

    const result = await Circle.atomicJoin(code.trim(), req.user._id);

    if (!result.ok) {
      if (result.reason === 'already_member') {
        return res.status(400).json({ error: 'You are already a member of this circle' });
      }
      if (result.reason === 'full') {
        return res.status(400).json({ error: 'Circle is full (max 5 members)' });
      }
      // not_found covers invalid, expired, or already-used codes
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }

    const circle = result.circle;

    // Join the new member's sockets into the circle room immediately
    const io = req.app.get('io');
    io.in(`user:${req.user._id}`).socketsJoin(`circle:${circle._id}`);

    await circle.populate('members', 'name email');

    res.status(200).json({ message: 'Joined circle', circle });
  } catch (err) {
    console.error('[circles] join error:', err.message);
    res.status(500).json({ error: 'Failed to join circle' });
  }
});

/**
 * POST /api/circles/:id/leave
 * (circleService saves the circle first and only then kicks sockets.)
 */
router.post('/:id/leave', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid circle ID' });

    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (!circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'You are not a member of this circle' });
    }

    const io     = req.app.get('io');
    const result = await removeUserFromCircle(io, circle._id, req.user._id);

    res.status(200).json({
      message: result.deleted ? 'Left and deleted circle (last member)' : 'Left circle'
    });
  } catch (err) {
    console.error('[circles] leave error:', err.message);
    res.status(500).json({ error: 'Failed to leave circle' });
  }
});

/**
 * DELETE /api/circles/:id/members/:userId
 */
router.delete('/:id/members/:userId', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id))     return res.status(400).json({ error: 'Invalid circle ID' });
    if (!validId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const circle = await Circle.findById(req.params.id);
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (circle.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the creator can remove members' });
    }

    const targetId = req.params.userId;
    if (targetId === req.user._id.toString()) {
      return res.status(400).json({ error: 'Use the leave endpoint to remove yourself' });
    }

    if (!circle.isMember(targetId)) {
      return res.status(404).json({ error: 'User is not a member of this circle' });
    }

    const io = req.app.get('io');
    await removeUserFromCircle(io, circle._id, targetId);

    res.status(200).json({ message: 'Member removed' });
  } catch (err) {
    console.error('[circles] remove-member error:', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
