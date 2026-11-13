'use strict';

// Connect/disconnect MongoDB for this test file
require('./setup');

// Mock firebase-admin so tests don't need real credentials
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: () => ({
    sendEachForMulticast: jest.fn().mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      responses: []
    })
  })
}));

const request  = require('supertest');
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

const { authenticateJWT, authenticateSocket } = require('../middleware/auth');
const authRoutes   = require('../routes/authRoutes');
const circleRoutes = require('../routes/circleRoutes');
const sosRoutes    = require('../routes/sosRoutes');
const { setupSOSHandlers } = require('../sockets/sosSocket');
const SosAlert = require('../models/SosAlert');
const Circle   = require('../models/Circle');
const { createUser, tokenFor, createCircleWithMember } = require('./helpers');

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { transports: ['websocket'] });

  io.use(authenticateSocket);
  setupSOSHandlers(io);
  app.set('io', io);
  app.use(express.json());
  app.use('/api/auth',    authRoutes);
  app.use('/api/circles', circleRoutes);
  app.use('/api/sos',     sosRoutes);
  return { app, server, io };
}

/** Connect a socket.io-client and wait for 'connect' event */
function connectSocket(port, token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth:       { token },
      transports: ['websocket'],
      forceNew:   true
    });
    socket.on('connect',       () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

/** Start server and return the bound port */
function startServer(server) {
  return new Promise(resolve => server.listen(0, () => resolve(server.address().port)));
}

/** Stop server, disconnect sockets */
function stopServer(server) {
  return new Promise(resolve => server.close(resolve));
}

// ── SOS API (HTTP) ────────────────────────────────────────────────────────────

describe('SOS API — HTTP', () => {
  let app, server, userA, userB, circle, tokenA, tokenB;

  beforeEach(async () => {
    ({ app, server } = buildApp());
    await startServer(server);
    userA  = await createUser({ name: 'Alice', email: 'alice@test.com' });
    userB  = await createUser({ name: 'Bob',   email: 'bob@test.com' });
    circle = await createCircleWithMember(userA._id, userB._id);
    tokenA = tokenFor(userA._id);
    tokenB = tokenFor(userB._id);
  });

  afterEach(() => stopServer(server));

  it('401 without token', async () => {
    const res = await request(app)
      .post('/api/sos/trigger')
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(401);
  });

  it('403 for non-member', async () => {
    const outsider = await createUser({ email: 'out@test.com' });
    const res = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenFor(outsider._id)}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(403);
  });

  it('creates alert and returns alertId + status', async () => {
    const res = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('alertId');
    expect(res.body.status).toBe('active');
  });

  it('trigger with no coordinates succeeds', async () => {
    const res = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id });
    expect(res.status).toBe(201);
    const alert = await SosAlert.findById(res.body.alertId);
    expect(alert.locations).toHaveLength(0);
  });

  it('trigger with (0,0) is rejected', async () => {
    const res = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 0, longitude: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0,0/);
  });

  it('duplicate trigger returns same alertId (200)', async () => {
    const first = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 52.0, longitude: -1.0 });
    expect(second.status).toBe(200);
    expect(second.body.alertId.toString()).toBe(first.body.alertId.toString());
  });

  it('only sender can push single location via HTTP', async () => {
    const { body: { alertId } } = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });

    const senderRes = await request(app)
      .post(`/api/sos/${alertId}/location`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ latitude: 51.6, longitude: -0.2 });
    expect(senderRes.status).toBe(200);

    const memberRes = await request(app)
      .post(`/api/sos/${alertId}/location`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ latitude: 51.6, longitude: -0.2 });
    expect(memberRes.status).toBe(403);
  });

  it('location rejected after resolve', async () => {
    const { body: { alertId } } = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });

    await request(app)
      .patch(`/api/sos/${alertId}/resolve`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'resolved' });

    const locRes = await request(app)
      .post(`/api/sos/${alertId}/location`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ latitude: 51.6, longitude: -0.2 });
    expect(locRes.status).toBe(400);
  });

  it('rate-limits excessive trigger calls', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/sos/trigger')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
      if (res.body.alertId) {
        await SosAlert.findByIdAndUpdate(res.body.alertId, {
          status: 'resolved', endedAt: new Date()
        });
      }
    }
    const blocked = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(blocked.status).toBe(429);
  });

  // ── Batch endpoint ─────────────────────────────────────────────────────────

  it('batch endpoint — only sender, max 50 points', async () => {
    const { body: { alertId } } = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id });

    // Non-sender rejected
    const nonSender = await request(app)
      .post(`/api/sos/${alertId}/locations`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ points: [{ latitude: 51.5, longitude: -0.1 }] });
    expect(nonSender.status).toBe(403);

    // Good batch from sender
    const points = Array.from({ length: 10 }, (_, i) => ({
      latitude: 51.5 + i * 0.001, longitude: -0.1
    }));
    const good = await request(app)
      .post(`/api/sos/${alertId}/locations`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ points });
    expect(good.status).toBe(200);
    expect(good.body.count).toBe(10);

    // Too many points
    const big = await request(app)
      .post(`/api/sos/${alertId}/locations`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ points: Array.from({ length: 51 }, (_, i) => ({ latitude: 51.5, longitude: -0.1 + i * 0.001 })) });
    expect(big.status).toBe(400);
  });

  it('batch endpoint — (0,0) points are skipped, not rejected', async () => {
    const { body: { alertId } } = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ circleId: circle._id });

    const res = await request(app)
      .post(`/api/sos/${alertId}/locations`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        points: [
          { latitude: 0, longitude: 0 },        // skipped
          { latitude: 51.5, longitude: -0.1 },   // valid
        ]
      });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

// ── Circle invite & membership ────────────────────────────────────────────────

describe('Circle invite & membership', () => {
  let app, server, creator, stranger, circle, tokenCreator, tokenStranger;

  beforeEach(async () => {
    ({ app, server } = buildApp());
    await startServer(server);
    creator  = await createUser({ name: 'Creator', email: 'creator@test.com' });
    stranger = await createUser({ name: 'Stranger', email: 'stranger@test.com' });
    circle   = await createCircleWithMember(creator._id);
    tokenCreator  = tokenFor(creator._id);
    tokenStranger = tokenFor(stranger._id);
  });

  afterEach(() => stopServer(server));

  it('invite code is single-use', async () => {
    const { body: { code } } = await request(app)
      .post(`/api/circles/${circle._id}/invites`)
      .set('Authorization', `Bearer ${tokenCreator}`);
    expect(code).toBeDefined();
    expect(code.length).toBe(10);

    const join1 = await request(app)
      .post('/api/circles/join')
      .set('Authorization', `Bearer ${tokenStranger}`)
      .send({ code });
    expect(join1.status).toBe(200);

    const stranger2 = await createUser({ email: 'stranger2@test.com' });
    const join2 = await request(app)
      .post('/api/circles/join')
      .set('Authorization', `Bearer ${tokenFor(stranger2._id)}`)
      .send({ code });
    expect(join2.status).toBe(400);
  });

  it('two parallel joins — only one succeeds', async () => {
    const { body: { code } } = await request(app)
      .post(`/api/circles/${circle._id}/invites`)
      .set('Authorization', `Bearer ${tokenCreator}`);

    const user1 = await createUser({ email: 'p1@test.com' });
    const user2 = await createUser({ email: 'p2@test.com' });

    // Fire both requests concurrently
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/circles/join')
        .set('Authorization', `Bearer ${tokenFor(user1._id)}`)
        .send({ code }),
      request(app)
        .post('/api/circles/join')
        .set('Authorization', `Bearer ${tokenFor(user2._id)}`)
        .send({ code })
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one success and one failure
    expect(statuses).toEqual([200, 400]);

    // Circle must not exceed 2 members (creator + 1 joiner)
    const updated = await Circle.findById(circle._id);
    expect(updated.members.length).toBe(2);
  });

  it('joining a full circle (5 members) fails', async () => {
    // Fill the circle to 5 members
    for (let i = 0; i < 4; i++) {
      const u = await createUser({ email: `fill${i}@test.com` });
      circle.members.push(u._id);
    }
    await circle.save();

    const { body: { code } } = await request(app)
      .post(`/api/circles/${circle._id}/invites`)
      .set('Authorization', `Bearer ${tokenCreator}`);

    const res = await request(app)
      .post('/api/circles/join')
      .set('Authorization', `Bearer ${tokenStranger}`)
      .send({ code });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full/i);
  });

  it('expired invite code is rejected', async () => {
    const crypto = require('crypto');
    const secret = process.env.INVITE_HMAC_SECRET;
    const code   = 'EXPIREDXAB';
    const hash   = crypto.createHmac('sha256', secret).update(code).digest('hex');
    circle.invites.push({
      codeHash:  hash,
      expiresAt: new Date(Date.now() - 1000),
      used:      false
    });
    await circle.save();

    const res = await request(app)
      .post('/api/circles/join')
      .set('Authorization', `Bearer ${tokenStranger}`)
      .send({ code });
    expect(res.status).toBe(400);
  });

  it('a member can leave a circle', async () => {
    circle.members.push(stranger._id);
    await circle.save();

    const res = await request(app)
      .post(`/api/circles/${circle._id}/leave`)
      .set('Authorization', `Bearer ${tokenStranger}`);
    expect(res.status).toBe(200);

    const updated = await Circle.findById(circle._id);
    expect(updated.members.map(id => id.toString())).not.toContain(stranger._id.toString());
  });

  it('sender leaving cancels the active alert', async () => {
    // Stranger joins, then creator triggers SOS, then creator leaves
    circle.members.push(stranger._id);
    await circle.save();

    const trigRes = await request(app)
      .post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenCreator}`)
      .send({ circleId: circle._id, latitude: 51.5, longitude: -0.1 });
    expect(trigRes.status).toBe(201);
    const alertId = trigRes.body.alertId;

    const leaveRes = await request(app)
      .post(`/api/circles/${circle._id}/leave`)
      .set('Authorization', `Bearer ${tokenCreator}`);
    expect(leaveRes.status).toBe(200);

    const alert = await SosAlert.findById(alertId);
    expect(alert.status).toBe('cancelled');
  });

  it('invites field is not present in API response', async () => {
    const res = await request(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${tokenCreator}`);
    expect(res.status).toBe(200);
    expect(res.body.circle.invites).toBeUndefined();
  });
});

// ── Socket tests ──────────────────────────────────────────────────────────────

describe('Socket', () => {
  let app, server, io, port;
  let userA, userB, circle, tokenA, tokenB;

  beforeEach(async () => {
    ({ app, server, io } = buildApp());
    port = await startServer(server);
    userA  = await createUser({ name: 'Alice', email: 'alice@sock.com' });
    userB  = await createUser({ name: 'Bob',   email: 'bob@sock.com' });
    circle = await createCircleWithMember(userA._id, userB._id);
    tokenA = tokenFor(userA._id);
    tokenB = tokenFor(userB._id);
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it('join_sos immediately after connect receives location_history', async () => {
    // Create an active alert first
    const alert = await SosAlert.create({
      sender:    userA._id,
      circle:    circle._id,
      status:    'active',
      locations: [{ lat: 51.5, lng: -0.1, at: new Date() }]
    });

    const socket = await connectSocket(port, tokenA);
    try {
      const history = await new Promise((resolve, reject) => {
        // Emit join_sos IMMEDIATELY (no await, synchronous after connect)
        socket.emit('join_sos', { alertId: alert._id.toString() });
        socket.on('location_history', resolve);
        socket.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 4000);
      });
      expect(history).toHaveProperty('locations');
      expect(Array.isArray(history.locations)).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it('non-member cannot join_sos', async () => {
    const outsider = await createUser({ email: 'out@sock.com' });
    const alert = await SosAlert.create({
      sender: userA._id, circle: circle._id, status: 'active', locations: []
    });

    const socket = await connectSocket(port, tokenFor(outsider._id));
    try {
      const err = await new Promise((resolve, reject) => {
        socket.emit('join_sos', { alertId: alert._id.toString() });
        socket.on('error', resolve);
        setTimeout(() => reject(new Error('timeout')), 4000);
      });
      expect(err.message).toMatch(/not a member/i);
    } finally {
      socket.disconnect();
    }
  });

  it('only sender can send update_location', async () => {
    const alert = await SosAlert.create({
      sender: userA._id, circle: circle._id, status: 'active', locations: []
    });

    const socketB = await connectSocket(port, tokenB);
    try {
      const err = await new Promise((resolve, reject) => {
        socketB.emit('update_location', {
          alertId:   alert._id.toString(),
          latitude:  51.5,
          longitude: -0.1
        });
        socketB.on('error', resolve);
        setTimeout(() => reject(new Error('timeout')), 4000);
      });
      expect(err.message).toMatch(/only the sender/i);
    } finally {
      socketB.disconnect();
    }
  });

  it('update_location is rejected after resolve', async () => {
    const alert = await SosAlert.create({
      sender: userA._id, circle: circle._id, status: 'resolved',
      endedAt: new Date(), locations: []
    });

    const socketA = await connectSocket(port, tokenA);
    try {
      const err = await new Promise((resolve, reject) => {
        socketA.emit('update_location', {
          alertId:   alert._id.toString(),
          latitude:  51.5,
          longitude: -0.1
        });
        socketA.on('error', resolve);
        setTimeout(() => reject(new Error('timeout')), 4000);
      });
      expect(err.message).toMatch(/not active/i);
    } finally {
      socketA.disconnect();
    }
  });

  it('empty payload on leave_sos does not crash', async () => {
    const socket = await connectSocket(port, tokenA);
    try {
      // Should not throw and not emit an error event
      await new Promise((resolve, reject) => {
        socket.emit('leave_sos', null);
        // If the server crashes, the connection drops
        socket.on('disconnect', () => reject(new Error('server crashed')));
        setTimeout(resolve, 800); // no crash within 800ms = pass
      });
    } finally {
      socket.disconnect();
    }
  });
});
