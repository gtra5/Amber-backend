'use strict';

const mongoose = require('mongoose');

const locationPointSchema = new mongoose.Schema({
  lat: { type: Number, required: true, min: -90,  max: 90  },
  lng: { type: Number, required: true, min: -180, max: 180 },
  at:  { type: Date,   default: Date.now }
}, { _id: false });

const sosAlertSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
    required: true
  },
  circle: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'Circle',
    required: true
  },
  status: {
    type:     String,
    enum:     ['active', 'resolved', 'cancelled'],
    default:  'active',
    required: true
  },
  startedAt: { type: Date, default: Date.now, required: true },
  endedAt:   { type: Date },
  locations: {
    type:    [locationPointSchema],
    default: []
  },
  respondingMembers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User'
  }]
}, {
  timestamps: true
});

// Partial unique index: one active alert per sender
sosAlertSchema.index(
  { sender: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'sender_active_unique' }
);

sosAlertSchema.index({ circle: 1, status: 1 });
sosAlertSchema.index({ createdAt: 1 }); // for the 30-day retention job

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Append a location point atomically.
 *
 * Filters on BOTH _id AND status:'active' inside the updateOne so that if
 * the alert is resolved between the application-level check and this write
 * the point is silently dropped and we return false instead of true.
 *
 * Returns true if a document was matched (and updated), false otherwise.
 */
sosAlertSchema.methods.addLocation = async function(lat, lng) {
  const result = await mongoose.model('SosAlert').updateOne(
    { _id: this._id, status: 'active' },        // ← double-check status atomically
    {
      $push: {
        locations: {
          $each: [{ lat, lng, at: new Date() }],
          $slice: -2000
        }
      }
    }
  );
  return result.matchedCount > 0;
};

/**
 * Append multiple location points atomically (for the batch endpoint).
 * Same status:'active' guard.
 * Returns true if matched.
 */
sosAlertSchema.methods.addLocations = async function(points) {
  if (!points || points.length === 0) return true;
  const result = await mongoose.model('SosAlert').updateOne(
    { _id: this._id, status: 'active' },
    {
      $push: {
        locations: {
          $each: points,
          $slice: -2000
        }
      }
    }
  );
  return result.matchedCount > 0;
};

// Mark alert resolved or cancelled
sosAlertSchema.methods.endAlert = function(status) {
  if (this.status !== 'active') throw new Error('Alert is already ended');
  this.status  = status || 'resolved';
  this.endedAt = new Date();
  return this.save();
};

// Add a responding member (idempotent)
sosAlertSchema.methods.addResponder = function(userId) {
  const alreadyIn = this.respondingMembers.some(
    id => id.toString() === userId.toString()
  );
  if (!alreadyIn) {
    this.respondingMembers.push(userId);
  }
  return this.save();
};

module.exports = mongoose.model('SosAlert', sosAlertSchema);
