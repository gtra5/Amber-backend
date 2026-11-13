const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

// JWT middleware for Express routes
const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

    // Verify JWT with pinned algorithm
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256']
    });

    // A token with a malformed id must be a 401, never a 500
    if (!mongoose.Types.ObjectId.isValid(decoded.userId)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Confirm user still exists in database
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Auth error:', error.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Socket.IO handshake authentication middleware
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('No token provided'));
    }

    // Verify JWT with pinned algorithm
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256']
    });

    if (!mongoose.Types.ObjectId.isValid(decoded.userId)) {
      return next(new Error('Invalid token'));
    }

    // Confirm user still exists in database
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) {
      return next(new Error('User not found'));
    }

    // Attach user to socket data for use in handlers
    socket.data.userId = user._id.toString();
    socket.data.user = user;
    // Remember when the token expires so a long-lived connection can be closed then
    socket.data.tokenExp = decoded.exp;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(new Error('Invalid token'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(new Error('Token expired'));
    }
    console.error('Socket auth error:', error.message);
    return next(new Error('Authentication failed'));
  }
};

module.exports = {
  authenticateJWT,
  authenticateSocket
};
