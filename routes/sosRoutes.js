'use strict';

const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const mongoose  = require('mongoose');
const { authenticateJWT } = require('../middleware/auth');
const SosAlert = require('../models/SosAlert');
const Circle   = require('../models/Circle');
const { sendSOSAlert, sendMemberResponding, sendAlertEnded } = require('../services/pushService');
const { emitSOSTriggered, emitSOSEnded, emitMemberResponding } = require('../sockets/sosSocket');

// ── Rate limiters ─────────────────────────────────────────────────────────────

const sosTriggerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      5,
  keyGenerator: (req) => req.user._id.toString(),
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Too many SOS requests. Please wait before trying again.' }
});

const locationFallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  keyGenerator: (req) => req.user._id.toString(),
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Location update rate limit exceeded.' }
});

const batchLocationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      15,
  keyGenerator: (req) => req.user._id.toString(),
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Batch location rate limit exceeded.' }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function validId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Validate a single { latitude, longitude } pair.
 * Returns an error string, or null if valid.
 * Both must be present together or both absent.
 * Exact (0,0) is rejected as a sentinel "no GPS" value.
 */
function validateCoords(latitude, longitude) {
  const hasLat = latitude  !== undefined && latitude  !== null;
  const hasLng = longitude !== undefined && longitude !== null;

  if (!hasLat && !hasLng) return null; // both absent = allowed (no GPS)
  if (hasLat !== hasLng)  return 'latitude and longitude must be provided together';

  if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
    return 'Invalid latitude';
  }
  if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
    return 'Invalid longitude';
  }
  if (latitude === 0 && longitude === 0) {
    return 'Coordinates (0,0) are not accepted';
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/sos/trigger
 * latitude/longitude are optional; if omitted, the alert is created with an
 * empty locations array. Exact (0,0) is rejected.
 */
router.post('/trigger', authenticateJWT, sosTriggerLimiter, async (req, res) => {
  try {
    const { circleId, latitude, longitude } = req.body;

    if (!circleId || !validId(circleId)) {
      return res.status(400).json({ error: 'Invalid circle ID' });
    }

    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });

    const circle = await Circle.findById(circleId).populate('members');
    if (!circle) return res.status(404).json({ error: 'Circle not found' });

    if (!circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'You are not a member of this circle' });
    }

    const hasCoords = latitude !== undefined && latitude !== null;

    let alert;
    try {
      alert = new SosAlert({
        sender:    req.user._id,
        circle:    circleId,
        status:    'active',
        locations: hasCoords ? [{ lat: latitude, lng: longitude, at: new Date() }] : []
      });
      await alert.save();
    } catch (err) {
      if (err.code === 11000) {
        const existing = await SosAlert.findOne({ sender: req.user._id, status: 'active' });
        if (!existing) {
          // The other alert ended a moment ago — ask the app to try again
          return res.status(409).json({ error: 'Please try again' });
        }
        return res.status(200).json({
          message: 'You already have an active alert',
          alertId: existing._id,
          status:  existing.status
        });
      }
      throw err;
    }

    const memberIds = circle.members.map(m => m._id);
    sendSOSAlert(memberIds, req.user._id, alert._id, req.user.name).catch(e =>
      console.error('[sos] push error:', e.message)
    );

    const io = req.app.get('io');
    emitSOSTriggered(io, circleId, {
      alertId:    alert._id,
      senderId:   req.user._id,
      senderName: req.user.name,
      circleId,
      startedAt:  alert.startedAt
    });

    res.status(201).json({
      message:  'SOS alert triggered',
      alertId:  alert._id,
      status:   alert.status
    });
  } catch (err) {
    console.error('[sos] trigger error:', err.message);
    res.status(500).json({ error: 'Failed to trigger SOS alert' });
  }
});

/**
 * GET /api/sos/active
 * Returns the user's OWN alert first; otherwise the first active alert in
 * any of their circles.
 */
router.get('/active', authenticateJWT, async (req, res) => {
  try {
    const circleIds = await Circle.find({ members: req.user._id }).distinct('_id');

    // Prefer the user's own alert
    let alert = await SosAlert.findOne({ sender: req.user._id, status: 'active' })
      .populate('sender', 'name')
      .populate('circle', 'name members')
      .populate('respondingMembers', 'name');

    if (!alert) {
      // Fall back to any active alert in one of their circles
      alert = await SosAlert.findOne({ status: 'active', circle: { $in: circleIds } })
        .populate('sender', 'name')
        .populate('circle', 'name members')
        .populate('respondingMembers', 'name');
    }

    if (!alert || !alert.circle) {
      return res.status(200).json({ alert: null });
    }

    res.status(200).json({
      alert: {
        id:               alert._id,
        senderId:         alert.sender._id,
        senderName:       alert.sender.name,
        circleId:         alert.circle._id,
        circleName:       alert.circle.name,
        status:           alert.status,
        startedAt:        alert.startedAt,
        respondingMembers: alert.respondingMembers.map(m => ({ id: m._id, name: m.name })),
        lastLocation: alert.locations.length
          ? alert.locations[alert.locations.length - 1]
          : null
      }
    });
  } catch (err) {
    console.error('[sos] active error:', err.message);
    res.status(500).json({ error: 'Failed to fetch active alert' });
  }
});

/**
 * GET /api/sos/:id
 * Details of ONE alert (members of its circle only). The map screen uses this
 * so it always shows the alert that was tapped, even if the user has several.
 */
router.get('/:id', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID' });

    const alert = await SosAlert.findById(req.params.id)
      .populate('sender', 'name')
      .populate('circle', 'name members')
      .populate('respondingMembers', 'name');

    if (!alert || !alert.circle || !alert.sender) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    if (!alert.circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'Not a member of this circle' });
    }

    res.status(200).json({
      alert: {
        id:         alert._id,
        senderId:   alert.sender._id,
        senderName: alert.sender.name,
        circleId:   alert.circle._id,
        circleName: alert.circle.name,
        status:     alert.status,
        startedAt:  alert.startedAt,
        endedAt:    alert.endedAt || null,
        respondingMembers: alert.respondingMembers.map(m => ({ id: m._id, name: m.name })),
        lastLocation: alert.locations.length
          ? alert.locations[alert.locations.length - 1]
          : null
      }
    });
  } catch (err) {
    console.error('[sos] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch alert' });
  }
});

/**
 * PATCH /api/sos/:id/resolve
 */
router.patch('/:id/resolve', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID' });

    const { status: reqStatus } = req.body;
    const endStatus = reqStatus === 'cancelled' ? 'cancelled' : 'resolved';

    const alert = await SosAlert.findById(req.params.id).populate('circle');
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    if (alert.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the sender can resolve this alert' });
    }
    if (alert.status !== 'active') {
      return res.status(400).json({ error: 'Alert is already ended' });
    }

    await alert.endAlert(endStatus);

    const io = req.app.get('io');

    // alert.circle may be null if the circle was deleted
    if (alert.circle) {
      emitSOSEnded(io, alert.circle._id, { alertId: alert._id, status: endStatus });

      const memberIds = alert.circle.memberIds();
      if (memberIds.length) {
        sendAlertEnded(memberIds, alert._id, req.user.name, req.user._id).catch(e =>
          console.error('[sos] push ended error:', e.message)
        );
      }
    }

    res.status(200).json({ message: 'Alert ended', alertId: alert._id, status: endStatus });
  } catch (err) {
    console.error('[sos] resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve alert' });
  }
});

/**
 * POST /api/sos/:id/respond
 */
router.post('/:id/respond', authenticateJWT, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID' });

    const alert = await SosAlert.findById(req.params.id).populate('circle');
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    if (alert.status !== 'active') {
      return res.status(400).json({ error: 'Alert is not active' });
    }
    if (!alert.circle || !alert.circle.isMember(req.user._id)) {
      return res.status(403).json({ error: 'Not a member of this circle' });
    }
    if (alert.sender.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: 'Sender cannot respond to their own alert' });
    }

    await alert.addResponder(req.user._id);

    const io = req.app.get('io');
    emitMemberResponding(io, alert._id, {
      alertId:       alert._id,
      responderId:   req.user._id,
      responderName: req.user.name
    });

    const memberIds = alert.circle.memberIds();
    sendMemberResponding(memberIds, req.user.name, alert._id, req.user._id).catch(e =>
      console.error('[sos] push responding error:', e.message)
    );

    res.status(200).json({ message: 'Response recorded', alertId: alert._id });
  } catch (err) {
    console.error('[sos] respond error:', err.message);
    res.status(500).json({ error: 'Failed to record response' });
  }
});

/**
 * POST /api/sos/:id/location
 * HTTP fallback — single point. Sender only, active only.
 */
router.post('/:id/location', authenticateJWT, locationFallbackLimiter, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID' });

    const { latitude, longitude } = req.body;
    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });
    if (latitude === undefined) return res.status(400).json({ error: 'latitude and longitude are required' });

    const alert = await SosAlert.findById(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    if (alert.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the sender can update location' });
    }

    const matched = await alert.addLocation(latitude, longitude);
    if (!matched) {
      return res.status(400).json({ error: 'Alert is not active' });
    }

    const io = req.app.get('io');
    io.to(`sos:${alert._id}`).emit('location_updated', {
      alertId:  alert._id,
      location: { lat: latitude, lng: longitude, at: new Date() }
    });

    res.status(200).json({ message: 'Location recorded' });
  } catch (err) {
    console.error('[sos] location fallback error:', err.message);
    res.status(500).json({ error: 'Failed to record location' });
  }
});

/**
 * POST /api/sos/:id/locations
 * Batch location upload — up to 50 points. Sender only, active only.
 * Body: { points: [{ latitude, longitude, at? }] }
 */
router.post('/:id/locations', authenticateJWT, batchLocationLimiter, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID' });

    const { points } = req.body;

    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'points must be a non-empty array' });
    }
    if (points.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 points per batch' });
    }

    // Fetch alert before validating to check sender + get startedAt for filtering
    const alert = await SosAlert.findById(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    if (alert.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only the sender can update location' });
    }

    // Validate and filter each point
    const validPoints = [];
    for (const p of points) {
      if (!p || typeof p !== 'object') continue;
      const { latitude, longitude, at } = p;

      const coordError = validateCoords(latitude, longitude);
      if (coordError) continue; // skip invalid points silently

      const ts = at ? new Date(at) : new Date();
      // Ignore points older than the alert start (stale queue from a previous alert)
      if (ts < alert.startedAt) continue;

      validPoints.push({ lat: latitude, lng: longitude, at: ts });
    }

    if (validPoints.length === 0) {
      return res.status(400).json({ error: 'No valid points in batch' });
    }

    const matched = await alert.addLocations(validPoints);
    if (!matched) {
      return res.status(400).json({ error: 'Alert is not active' });
    }

    // Broadcast the newest point to the SOS room
    const newest = validPoints[validPoints.length - 1];
    const io = req.app.get('io');
    io.to(`sos:${alert._id}`).emit('location_updated', {
      alertId:  alert._id,
      location: { lat: newest.lat, lng: newest.lng, at: newest.at }
    });

    res.status(200).json({ message: 'Batch recorded', count: validPoints.length });
  } catch (err) {
    console.error('[sos] batch location error:', err.message);
    res.status(500).json({ error: 'Failed to record batch' });
  }
});

module.exports = router;
