'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  passwordHash: {
    type: String,
    required: [true, 'Password is required']
  },
  fcmTokens: [{
    type: String,
    trim: true
  }]
}, {
  timestamps: true
});

// (email already has a unique index from `unique: true` above)

// Compare plaintext password against stored hash
userSchema.methods.comparePassword = async function(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

/**
 * Add an FCM token to this user.
 * - First removes the token from every OTHER user (a token belongs to one device).
 * - Skips duplicates.
 * - Keeps at most 5 tokens (drops the oldest when over limit).
 */
userSchema.methods.addFCMToken = async function(token) {
  // Remove from any other user who already has this token
  await mongoose.model('User').updateMany(
    { _id: { $ne: this._id }, fcmTokens: token },
    { $pull: { fcmTokens: token } }
  );

  if (!this.fcmTokens.includes(token)) {
    this.fcmTokens.push(token);
  }

  // Keep at most 5 tokens (oldest first → slice from the end to keep newest)
  if (this.fcmTokens.length > 5) {
    this.fcmTokens = this.fcmTokens.slice(-5);
  }

  return this.save();
};

// Remove a specific FCM token from this user
userSchema.methods.removeFCMToken = function(token) {
  this.fcmTokens = this.fcmTokens.filter(t => t !== token);
  return this.save();
};

module.exports = mongoose.model('User', userSchema);
