'use strict';

// ── Environment ───────────────────────────────────────────────────────────────
require('dotenv').config();

// Validate JWT_SECRET before anything else boots
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_PLACEHOLDER = 'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARS';
if (!JWT_SECRET) {
  console.error('[startup] FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error('[startup] FATAL: JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (JWT_SECRET === JWT_PLACEHOLDER || JWT_SECRET.toLowerCase().includes('change-this') || JWT_SECRET.toLowerCase().includes('your-super-secret')) {
  console.error('[startup] FATAL: JWT_SECRET is still set to a placeholder value. Generate a real secret.');
  process.exit(1);
}

// Validate INVITE_HMAC_SECRET
const INVITE_HMAC_SECRET = process.env.INVITE_HMAC_SECRET;
if (!INVITE_HMAC_SECRET || INVITE_HMAC_SECRET.length < 32) {
  console.error('[startup] FATAL: INVITE_HMAC_SECRET must be set and at least 32 characters.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ── Dependencies ──────────────────────────────────────────────────────────────
// ── Invitation links / email ─────────────────────────────────────────────────
// Invitation links (QR codes and emails) point at APP_LINK_BASE_URL. In
// production it MUST be https: phones only open app links over https.
{
  const base = process.env.APP_LINK_BASE_URL || '';
  if (process.env.NODE_ENV === 'production' && !/^https:\/\/[^\s/]+/.test(base)) {
    console.error('[startup] FATAL: APP_LINK_BASE_URL must be an https:// address in production (e.g. https://amber.example.com).');
    process.exit(1);
  }
  if (process.env.NODE_ENV !== 'production' && !base) {
    console.warn('[startup] APP_LINK_BASE_URL is not set: invite links will use http://localhost. They will not open on a real phone.');
  }
}

const express   = require('express');
const mongoose  = require('mongoose');
const http      = require('http');
const { Server } = require('socket.io');
const helmet    = require('helmet');
const cors      = require('cors');
const cron      = require('node-cron');
const rateLimit = require('express-rate-limit');

const { authenticateSocket } = require('./middleware/auth');
const authRoutes   = require('./routes/authRoutes');
const circleRoutes = require('./routes/circleRoutes');
const sosRoutes    = require('./routes/sosRoutes');
const inviteRoutes     = require('./routes/inviteRoutes');
const inviteLinkRoutes = require('./routes/inviteLinkRoutes');
const emailService     = require('./services/emailService');
const { setupSOSHandlers, emitSOSEnded } = require('./sockets/sosSocket');
const SosAlert = require('./models/SosAlert');
// pushService initialises Firebase on require — fail fast if env var is missing
const { sendAlertEnded } = require('./services/pushService');

// ── Global error guards ───────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  // Log safely — never log stack traces that might contain user data in production
  console.error('[process] uncaughtException:', err.message);
  // Keep the server running for transient errors; exit on truly fatal ones
  if (err.code === 'ERR_INVALID_ARG_TYPE' || err.code === 'MODULE_NOT_FOUND') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[process] unhandledRejection:', msg);
});

// ── App ───────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: {
    origin:  process.env.CLIENT_URL || 'http://localhost:8081',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ── HTTP middleware ───────────────────────────────────────────────────────────
// Trust proxy hops as configured (0 = no proxy, 1 = one reverse proxy, etc.)
// This makes req.ip accurate when running behind nginx/load-balancer.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

app.use(helmet());

app.use(cors({
  origin:         process.env.CLIENT_URL || 'http://localhost:8081',
  credentials:    true,
  methods:        ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Broad safety net for the whole API. Deliberately generous: many phones can
// share one IP on a mobile network, so real users must never be blocked by it.
// Stricter per-user / per-email limits sit on the sensitive routes.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
}));

app.use(express.json({ limit: '10kb' }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/amber-sos')
  .then(() => console.log('[db] Connected to MongoDB'))
  .catch(err => {
    console.error('[db] MongoDB connection error:', err.message);
    process.exit(1);
  });

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.use(authenticateSocket);
setupSOSHandlers(io);
app.set('io', io);

if (emailService.isConfigured()) {
  console.log(`[startup] Email invitations: ${process.env.EMAIL_DRY_RUN === 'true' ? 'DRY RUN (nothing is sent)' : 'enabled'}`);
} else {
  console.warn('[startup] Email invitations are DISABLED (set SMTP_HOST and MAIL_FROM). QR and code invitations still work.');
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/circles', inviteRoutes);   // QR + email invitations (before circleRoutes)
app.use('/api/circles', circleRoutes);
app.use('/api/sos',     sosRoutes);

// Public pages that make invitation links work (landing page + app-link verification files)
app.use('/', inviteLinkRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Scheduled jobs ────────────────────────────────────────────────────────────

// Auto-resolve alerts older than 12 hours (runs every hour)
cron.schedule('0 * * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const expired = await SosAlert.find({ status: 'active', startedAt: { $lt: cutoff } })
      .populate('circle')
      .populate('sender', 'name');

    for (const alert of expired) {
      try {
        await alert.endAlert('resolved');

        if (alert.circle) {
          emitSOSEnded(io, alert.circle._id, { alertId: alert._id, status: 'resolved', reason: 'auto_expired' });
          const memberIds = alert.circle.memberIds();
          const name = alert.sender ? alert.sender.name : 'Unknown';
          sendAlertEnded(memberIds, alert._id, name, alert.sender && alert.sender._id).catch(() => {});
        }
      } catch (e) {
        console.error('[cron] Failed to expire alert:', e.message);
      }
    }

    if (expired.length) console.log(`[cron] Auto-resolved ${expired.length} expired alert(s)`);
  } catch (err) {
    console.error('[cron] Auto-expire job error:', err.message);
  }
});

// Delete alerts (and their location data) older than 30 days (runs daily at 02:00)
cron.schedule('0 2 * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await SosAlert.deleteMany({
      status: { $in: ['resolved', 'cancelled'] },
      endedAt: { $lt: cutoff }
    });
    if (result.deletedCount) {
      console.log(`[cron] Deleted ${result.deletedCount} alert(s) older than 30 days`);
    }
  } catch (err) {
    console.error('[cron] Data-retention job error:', err.message);
  }
});

// ── Error handling middleware ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[http] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Amber SOS backend running on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down gracefully`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('[server] Closed');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
