'use strict';

/**
 * circleService — membership changes shared by the circle routes and the
 * account-deletion route.
 *
 * Every function here that removes a person from a circle follows the same
 * order: change the database FIRST, then kick sockets out of rooms, so a
 * failed save never leaves someone locked out while still a member.
 */

const mongoose = require('mongoose');
const Circle   = require('../models/Circle');
const SosAlert = require('../models/SosAlert');
const { emitSOSEnded } = require('../sockets/sosSocket');
const { sendAlertEnded } = require('./pushService');

/**
 * End any active SOS for this circle, emit sos_ended and push "alert ended".
 * Safe to call even if there is no active alert.
 */
async function endCircleAlerts(io, circle) {
  const alert = await SosAlert.findOne({ circle: circle._id, status: 'active' });
  if (!alert) return;

  await alert.endAlert('cancelled');
  emitSOSEnded(io, circle._id, { alertId: alert._id, status: 'cancelled', reason: 'circle_dissolved' });

  const sender = await mongoose.model('User').findById(alert.sender).select('name');
  const name = sender ? sender.name : 'Unknown';
  sendAlertEnded(circle.memberIds(), alert._id, name, alert.sender).catch(e =>
    console.error('[push] sendAlertEnded:', e.message)
  );
}

/**
 * Cancel any alert the departing user sent in this circle, then kick their
 * sockets out of the circle room and the SOS rooms.
 */
async function handleMemberExit(io, circleId, userId) {
  const alert = await SosAlert.findOne({ circle: circleId, sender: userId, status: 'active' });
  if (alert) {
    await alert.endAlert('cancelled');
    emitSOSEnded(io, circleId, { alertId: alert._id, status: 'cancelled', reason: 'sender_left' });

    const circle = await Circle.findById(circleId);
    if (circle) {
      const sender = await mongoose.model('User').findById(userId).select('name');
      const name = sender ? sender.name : 'Unknown';
      sendAlertEnded(circle.memberIds(), alert._id, name, userId).catch(() => {});
    }
    io.in(`user:${userId}`).socketsLeave(`sos:${alert._id}`);
  }

  io.in(`user:${userId}`).socketsLeave(`circle:${circleId}`);

  // Leave any other SOS room that belongs to this circle
  const otherAlert = await SosAlert.findOne({ circle: circleId, status: 'active' });
  if (otherAlert) {
    io.in(`user:${userId}`).socketsLeave(`sos:${otherAlert._id}`);
  }
}

/**
 * Remove one user from one circle.
 *  - Last member leaving deletes the circle (and ends its alert).
 *  - If the creator leaves, the role passes to the next member.
 * Returns { ok, deleted }.
 */
async function removeUserFromCircle(io, circleId, userId) {
  const circle = await Circle.findById(circleId);
  if (!circle || !circle.isMember(userId)) return { ok: false, deleted: false };

  circle.members = circle.members.filter(id => id.toString() !== userId.toString());

  if (circle.members.length === 0) {
    await endCircleAlerts(io, circle);
    await Circle.deleteOne({ _id: circle._id });
    await handleMemberExit(io, circle._id, userId);
    return { ok: true, deleted: true };
  }

  if (circle.createdBy.toString() === userId.toString()) {
    circle.createdBy = circle.members[0];
  }

  await circle.save();                         // save FIRST
  await handleMemberExit(io, circle._id, userId); // then kick sockets
  return { ok: true, deleted: false };
}

module.exports = { endCircleAlerts, handleMemberExit, removeUserFromCircle };
