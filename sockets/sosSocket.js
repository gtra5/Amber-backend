'use strict';

const mongoose = require('mongoose');
const Circle   = require('../models/Circle');
const SosAlert = require('../models/SosAlert');

// In-memory rate limit map: userId → last update timestamp (ms)
const locationUpdateRateLimit = new Map();

// ── Setup ─────────────────────────────────────────────────────────────────────

function setupSOSHandlers(io) {
  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    // ── Register ALL event handlers FIRST, synchronously. ─────────────────
    // This avoids a race where a client emits join_sos immediately after
    // connecting, before the await-based room-join code below has finished.

    // ── join_sos ──────────────────────────────────────────────────────────────
    socket.on('join_sos', async (payload) => {
      try {
        if (!payload || typeof payload !== 'object') return;
        const { alertId } = payload;

        if (!alertId || !mongoose.Types.ObjectId.isValid(alertId)) {
          return socket.emit('error', { message: 'Invalid alert ID' });
        }

        const alert = await SosAlert.findById(alertId).populate('circle');
        if (!alert) return socket.emit('error', { message: 'Alert not found' });
        if (alert.status !== 'active') return socket.emit('error', { message: 'Alert is not active' });

        // Guard against deleted circle
        if (!alert.circle || !alert.circle.isMember(userId)) {
          return socket.emit('error', { message: 'You are not a member of this circle' });
        }

        socket.join(`sos:${alertId}`);

        // Send the stored path immediately so a late-joiner sees history
        socket.emit('location_history', {
          alertId:   alert._id,
          locations: alert.locations
        });
      } catch (err) {
        console.error('[socket] join_sos error:', err.message);
        socket.emit('error', { message: 'Failed to join SOS room' });
      }
    });

    // ── update_location ───────────────────────────────────────────────────────
    socket.on('update_location', async (payload) => {
      try {
        if (!payload || typeof payload !== 'object') return;
        const { alertId, latitude, longitude } = payload;

        if (!alertId || !mongoose.Types.ObjectId.isValid(alertId)) {
          return socket.emit('error', { message: 'Invalid alert ID' });
        }
        if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
          return socket.emit('error', { message: 'Invalid latitude' });
        }
        if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
          return socket.emit('error', { message: 'Invalid longitude' });
        }

        // Rate limit: 1 update per second per user
        const now = Date.now();
        if (now - (locationUpdateRateLimit.get(userId) || 0) < 1000) {
          return; // silently drop
        }
        locationUpdateRateLimit.set(userId, now);

        // Verify sender and active status, then add location atomically.
        // addLocation filters on { _id, status:'active' } inside the updateOne,
        // so if the alert was resolved between the check and the write it is safe.
        const alert = await SosAlert.findById(alertId);
        if (!alert) return socket.emit('error', { message: 'Alert not found' });

        if (alert.sender.toString() !== userId) {
          return socket.emit('error', { message: 'Only the sender can update location' });
        }
        if (alert.status !== 'active') {
          return socket.emit('error', { message: 'Alert is not active' });
        }

        const matched = await alert.addLocation(latitude, longitude);
        if (!matched) {
          return socket.emit('error', { message: 'Alert is not active' });
        }

        socket.to(`sos:${alertId}`).emit('location_updated', {
          alertId:  alert._id,
          location: { lat: latitude, lng: longitude, at: new Date() }
        });
      } catch (err) {
        console.error('[socket] update_location error:', err.message);
        socket.emit('error', { message: 'Failed to update location' });
      }
    });

    // ── leave_sos ─────────────────────────────────────────────────────────────
    socket.on('leave_sos', (payload) => {
      try {
        if (!payload || typeof payload !== 'object') return;
        const { alertId } = payload;
        if (alertId) {
          socket.leave(`sos:${alertId}`);
        }
      } catch (err) {
        console.error('[socket] leave_sos error:', err.message);
      }
    });

    // ── Close the connection when the login token expires ───────────────────
    // The token is only checked at connect time, so without this a socket
    // would stay authenticated forever after the token had expired.
    let expiryTimer = null;
    if (socket.data.tokenExp) {
      const msLeft = socket.data.tokenExp * 1000 - Date.now();
      // setTimeout cannot take more than 2^31-1 ms (~24.8 days); tokens last 7 days
      expiryTimer = setTimeout(() => {
        socket.emit('error', { message: 'Token expired' });
        socket.disconnect(true);
      }, Math.max(0, Math.min(msLeft, 2147483647)));
    }

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      locationUpdateRateLimit.delete(userId);
    });

    // ── Async room setup (AFTER handlers are registered) ──────────────────────
    // Joining the user's private room and circle rooms is async, but handlers
    // are already registered above so no events are lost.
    socket.join(`user:${userId}`);

    Circle.find({ members: userId })
      .then(circles => circles.forEach(c => socket.join(`circle:${c._id}`)))
      .catch(err => console.error('[socket] Error auto-joining circles:', err.message));
  });
}

// ── Emitters ──────────────────────────────────────────────────────────────────

function emitSOSTriggered(io, circleId, data) {
  io.to(`circle:${circleId}`).emit('sos_triggered', data);
}

function emitSOSEnded(io, circleId, data) {
  io.to(`circle:${circleId}`).emit('sos_ended', data);
}

function emitMemberResponding(io, alertId, data) {
  io.to(`sos:${alertId}`).emit('member_responding', data);
}

module.exports = { setupSOSHandlers, emitSOSTriggered, emitSOSEnded, emitMemberResponding };
