'use strict';

const mongoose = require('mongoose');

/**
 * Invite — one single-use invitation to join a Safety Circle.
 *
 *  kind 'email' : sent to one specific address (bound to that address)
 *  kind 'qr'    : shown on a screen to someone standing next to you (short-lived)
 *
 * Only a keyed hash of the token is stored. If the database leaks, the tokens
 * in it cannot be turned back into working invite links.
 */
const inviteSchema = new mongoose.Schema({
  circle:    { type: mongoose.Schema.Types.ObjectId, ref: 'Circle', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  kind:      { type: String, enum: ['email', 'qr'], required: true },

  // Only for kind 'email'. Lower-cased. Used to bind the invite to that person.
  email:     { type: String, lowercase: true, trim: true, maxlength: 254 },

  tokenHash: { type: String, required: true, unique: true },

  // MongoDB deletes the document itself shortly after this moment (TTL index
  // below). Every query ALSO checks expiresAt, because the TTL cleaner only
  // runs about once a minute.
  expiresAt: { type: Date, required: true },

  // Set when a newer invitation to the same address replaced this one. The
  // record is kept (until it expires) so the per-address daily limit still
  // counts it, but the link no longer works.
  revokedAt: { type: Date, default: null },

  usedAt:    { type: Date, default: null },
  usedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// TTL: expireAfterSeconds 0 = "delete when the date in expiresAt has passed"
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
inviteSchema.index({ circle: 1, kind: 1, createdBy: 1 });
inviteSchema.index({ email: 1, createdAt: 1 });   // per-recipient cool-down counts

module.exports = mongoose.model('Invite', inviteSchema);
