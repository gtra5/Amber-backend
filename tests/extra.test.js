'use strict';

require('./setup');

// Keep a handle on the Firebase send function so tests can inspect pushes
const mockSend = jest.fn();
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: () => ({ sendEachForMulticast: (...args) => mockSend(...args) })
}));

// helpers sets the env vars (JWT secret, fake Firebase key) — must load BEFORE the app code
const { createUser, tokenFor, createCircleWithMember, JWT_SECRET } = require('./helpers');

const request  = require('supertest');
const express  = require('express');
const http     = require('http');
const jwt      = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

const { authenticateSocket } = require('../middleware/auth');
const authRoutes   = require('../routes/authRoutes');
const circleRoutes = require('../routes/circleRoutes');
const sosRoutes    = require('../routes/sosRoutes');
const { setupSOSHandlers } = require('../sockets/sosSocket');
const { buildMessage }     = require('../services/pushService');
const SosAlert = require('../models/SosAlert');
const Circle   = require('../models/Circle');
const User     = require('../models/User');

let seq = 0;
const uniq = (p) => `${p}_${Date.now()}_${++seq}@test.com`;

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
const startServer = (server) => new Promise(r => server.listen(0, () => r(server.address().port)));
const stopServer  = (server) => new Promise(r => server.close(r));

/** Wait until fn() returns something truthy (pushes are fire-and-forget) */
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  return fn();
}

// ── Push payloads (pure function, no Firebase needed) ───────────────────────

describe('buildMessage', () => {
  it('SOS alert rings: alarm channel, max priority, expires in 10 minutes', () => {
    const m = buildMessage(['t1'], { type: 'sos_triggered', alertId: 'a1', senderName: 'Amy' }, {}, { criticalAlertsEnabled: false });
    expect(m.android.notification.channelId).toBe('sos_alarm_v1');
    expect(m.android.notification.priority).toBe('max');
    expect(m.android.ttl).toBe(10 * 60 * 1000);
    expect(m.apns.payload.aps['interruption-level']).toBe('time-sensitive');
    expect(m.apns.headers['apns-priority']).toBe('10');
  });

  it('critical flag only changes the iPhone payload', () => {
    const on  = buildMessage(['t'], { type: 'sos_triggered', alertId: 'a', senderName: 'A' }, {}, { criticalAlertsEnabled: true });
    const off = buildMessage(['t'], { type: 'sos_triggered', alertId: 'a', senderName: 'A' }, {}, { criticalAlertsEnabled: false });
    expect(on.apns.payload.aps['interruption-level']).toBe('critical');
    expect(on.apns.payload.aps.sound.critical).toBe(1);
    expect(on.android).toEqual(off.android); // Android never depends on the flag
  });

  it('"alert ended" and "responding" are quiet (no alarm channel, no alarm sound)', () => {
    for (const type of ['sos_ended', 'member_responding']) {
      const m = buildMessage(['t'], { type, alertId: 'a', senderName: 'A' });
      expect(m.android.notification.channelId).toBe('sos_updates_v1');
      expect(m.android.notification.sound).toBeUndefined();
      expect(m.apns.payload.aps['interruption-level']).toBe('active');
      expect(m.apns.payload.aps.sound).toBe('default');
      expect(m.apns.headers['apns-priority']).toBe('5');
    }
  });

  it('every data value is a string (FCM rejects anything else)', () => {
    const m = buildMessage(['t'], { type: 'sos_triggered', alertId: 123, senderName: undefined });
    for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
  });
});

// ── Who receives which push ─────────────────────────────────────────────────

describe('push recipients', () => {
  let app, server, alice, bob, carol, circle;

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
    ({ app, server } = buildApp());
    await startServer(server);
    alice = await createUser({ name: 'Alice', email: uniq('alice'), fcmTokens: ['tok-alice'] });
    bob   = await createUser({ name: 'Bob',   email: uniq('bob'),   fcmTokens: ['tok-bob'] });
    carol = await createUser({ name: 'Carol', email: uniq('carol'), fcmTokens: ['tok-carol'] });
    circle = await createCircleWithMember(alice._id, bob._id, carol._id);
  });
  afterEach(() => stopServer(server));

  const sentTokens = () => mockSend.mock.calls.flatMap(c => c[0].tokens);
  const sentTypes  = () => mockSend.mock.calls.map(c => c[0].data.type);

  it('SOS goes to the other members, never the sender', async () => {
    await request(app).post('/api/sos/trigger')
      .set('Authorization', `Bearer ${tokenFor(alice._id)}`)
      .send({ circleId: circle._id.toString(), latitude: 6.5, longitude: 3.3 });
    await waitFor(() => mockSend.mock.calls.length > 0);
    expect(sentTokens().sort()).toEqual(['tok-bob', 'tok-carol']);
    expect(sentTypes()).toEqual(['sos_triggered']);
  });

  it('"alert ended" is not sent to the person who ended it', async () => {
    const alert = await SosAlert.create({ sender: alice._id, circle: circle._id, locations: [] });
    await request(app).patch(`/api/sos/${alert._id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor(alice._id)}`).send({});
    await waitFor(() => mockSend.mock.calls.length > 0);
    expect(sentTokens().sort()).toEqual(['tok-bob', 'tok-carol']);
    expect(sentTypes()).toEqual(['sos_ended']);
  });

  it('"responding" is not sent to the responder', async () => {
    const alert = await SosAlert.create({ sender: alice._id, circle: circle._id, locations: [] });
    await request(app).post(`/api/sos/${alert._id}/respond`)
      .set('Authorization', `Bearer ${tokenFor(bob._id)}`).send({});
    await waitFor(() => mockSend.mock.calls.length > 0);
    expect(sentTokens().sort()).toEqual(['tok-alice', 'tok-carol']);
    expect(sentTypes()).toEqual(['member_responding']);
  });
});

// ── GET /api/sos/:id ────────────────────────────────────────────────────────

describe('GET /api/sos/:id', () => {
  let app, server, alice, bob, outsider, circle, alert;

  beforeEach(async () => {
    ({ app, server } = buildApp());
    await startServer(server);
    alice    = await createUser({ name: 'Alice', email: uniq('alice') });
    bob      = await createUser({ name: 'Bob',   email: uniq('bob') });
    outsider = await createUser({ name: 'Eve',   email: uniq('eve') });
    circle   = await createCircleWithMember(alice._id, bob._id);
    alert    = await SosAlert.create({
      sender: alice._id, circle: circle._id,
      locations: [{ lat: 6.5, lng: 3.3 }]
    });
  });
  afterEach(() => stopServer(server));

  it('a circle member sees that alert (sender, circle, last location)', async () => {
    const res = await request(app).get(`/api/sos/${alert._id}`)
      .set('Authorization', `Bearer ${tokenFor(bob._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.alert.senderName).toBe('Alice');
    expect(res.body.alert.status).toBe('active');
    expect(res.body.alert.lastLocation.lat).toBe(6.5);
  });

  it('shows the alert asked for even when the user has their own alert too', async () => {
    await SosAlert.create({ sender: bob._id, circle: circle._id, locations: [] });
    const res = await request(app).get(`/api/sos/${alert._id}`)
      .set('Authorization', `Bearer ${tokenFor(bob._id)}`);
    expect(res.body.alert.senderName).toBe('Alice');
  });

  it('an ended alert is returned with its status', async () => {
    await alert.endAlert('resolved');
    const res = await request(app).get(`/api/sos/${alert._id}`)
      .set('Authorization', `Bearer ${tokenFor(bob._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.alert.status).toBe('resolved');
  });

  it('403 for someone outside the circle, 400 for a bad id, 404 for a missing alert', async () => {
    const a = await request(app).get(`/api/sos/${alert._id}`).set('Authorization', `Bearer ${tokenFor(outsider._id)}`);
    const b = await request(app).get('/api/sos/not-an-id').set('Authorization', `Bearer ${tokenFor(bob._id)}`);
    const c = await request(app).get('/api/sos/64b64b64b64b64b64b64b64b').set('Authorization', `Bearer ${tokenFor(bob._id)}`);
    expect([a.status, b.status, c.status]).toEqual([403, 400, 404]);
  });
});

// ── Account deletion ────────────────────────────────────────────────────────

describe('DELETE /api/auth/me', () => {
  let app, server, alice, bob, circle, tokenA;

  beforeEach(async () => {
    ({ app, server } = buildApp());
    await startServer(server);
    alice  = await createUser({ name: 'Alice', email: uniq('alice'), password: 'Password1!' });
    bob    = await createUser({ name: 'Bob',   email: uniq('bob') });
    circle = await createCircleWithMember(alice._id, bob._id);
    tokenA = tokenFor(alice._id);
  });
  afterEach(() => stopServer(server));

  it('wrong password → 403 (not 401) and nothing is deleted', async () => {
    const res = await request(app).delete('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`).send({ password: 'nope-nope-nope' });
    expect(res.status).toBe(403);
    expect(await User.findById(alice._id)).not.toBeNull();
  });

  it('missing password → 400', async () => {
    const res = await request(app).delete('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`).send({});
    expect(res.status).toBe(400);
  });

  it('deletes the user, their alerts and location history, and leaves the circle', async () => {
    const alert = await SosAlert.create({
      sender: alice._id, circle: circle._id, locations: [{ lat: 6.5, lng: 3.3 }]
    });
    const res = await request(app).delete('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`).send({ password: 'Password1!' });
    expect(res.status).toBe(200);

    expect(await User.findById(alice._id)).toBeNull();
    expect(await SosAlert.findById(alert._id)).toBeNull();
    const after = await Circle.findById(circle._id);
    expect(after.memberIds()).toEqual([bob._id.toString()]);
    expect(after.createdBy.toString()).toBe(bob._id.toString()); // creator role passed on
  });

  it('a circle with only this user is deleted with them', async () => {
    const solo = await createCircleWithMember(alice._id);
    await request(app).delete('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`).send({ password: 'Password1!' });
    expect(await Circle.findById(solo._id)).toBeNull();
  });

  it('the deleted user is removed from other alerts\' responder lists', async () => {
    const bobAlert = await SosAlert.create({
      sender: bob._id, circle: circle._id, locations: [], respondingMembers: [alice._id]
    });
    await request(app).delete('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`).send({ password: 'Password1!' });
    const after = await SosAlert.findById(bobAlert._id);
    expect(after.respondingMembers).toHaveLength(0);
  });
});

// ── Tokens ──────────────────────────────────────────────────────────────────

describe('token handling', () => {
  let app, server, port;
  beforeEach(async () => {
    ({ app, server } = buildApp());
    port = await startServer(server);
  });
  afterEach(() => stopServer(server));

  it('a validly signed token with a malformed user id is 401, not 500', async () => {
    const bad = jwt.sign({ userId: 'not-an-object-id' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('a connected socket is closed when its token expires', async () => {
    const u = await createUser({ email: uniq('exp') });
    const short = jwt.sign({ userId: u._id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: 2 });
    const socket = ioClient(`http://localhost:${port}`, {
      auth: { token: short }, transports: ['websocket'], forceNew: true, reconnection: false
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    const reason = await new Promise((resolve, reject) => {
      socket.on('disconnect', resolve);
      setTimeout(() => reject(new Error('socket was not closed after expiry')), 5000);
    });
    expect(reason).toBe('io server disconnect');
  });
});
