'use strict';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User   = require('../models/User');
const Circle = require('../models/Circle');

const JWT_SECRET        = 'test-secret-that-is-at-least-32-characters-long!!';
const INVITE_HMAC_SECRET = 'test-invite-hmac-secret-at-least-32-chars!!';

// Set env vars before any module that reads them is imported
process.env.JWT_SECRET         = JWT_SECRET;
process.env.INVITE_HMAC_SECRET = INVITE_HMAC_SECRET;
process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(JSON.stringify({
  type:             'service_account',
  project_id:       'test',
  private_key_id:   'key',
  private_key:      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4lSFRBpQmjbvRGNqWGMXNf8e3Hg\n-----END RSA PRIVATE KEY-----',
  client_email:     'test@test.iam.gserviceaccount.com',
  client_id:        '123',
  auth_uri:         'https://accounts.google.com/o/oauth2/auth',
  token_uri:        'https://oauth2.googleapis.com/token'
})).toString('base64');

async function createUser(overrides = {}) {
  const hash = await bcrypt.hash(overrides.password || 'Password1!', 10);
  return User.create({
    name:         overrides.name  || 'Test User',
    email:        overrides.email || `user_${Date.now()}_${Math.random()}@example.com`,
    passwordHash: hash,
    fcmTokens:    overrides.fcmTokens || []
  });
}

function tokenFor(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

async function createCircleWithMember(creatorId, ...extraMemberIds) {
  return Circle.create({
    name:      'Test Circle',
    members:   [creatorId, ...extraMemberIds],
    createdBy: creatorId
  });
}

module.exports = { createUser, tokenFor, createCircleWithMember, JWT_SECRET, INVITE_HMAC_SECRET };
