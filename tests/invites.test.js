'use strict';

require('./setup');
const { createUser, tokenFor, createCircleWithMember } = require('./helpers');

// Firebase is not needed here (leaving a circle can send a push, which we do not test)
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: () => ({ sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0, responses: [] }) })
}));

// ── Fake mail server: capture what would be sent ────────────────────────────
const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: (...a) => mockSendMail(...a) }))
}));

process.env.SMTP_HOST      = 'smtp.test';
process.env.MAIL_FROM      = 'Amber SOS <no-reply@amber.test>';
process.env.APP_LINK_BASE_URL = 'https://amber.test';

const request  = require('supertest');
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const { authenticateSocket } = require('../middleware/auth');
const { setupSOSHandlers }   = require('../sockets/sosSocket');
const inviteRoutes     = require('../routes/inviteRoutes');
const circleRoutes     = require('../routes/circleRoutes');
const inviteLinkRoutes = require('../routes/inviteLinkRoutes');
const inviteService    = require('../services/inviteService');
const emailService     = require('../services/emailService');
const Invite = require('../models/Invite');
const Circle = require('../models/Circle');

let seq = 0;
const uniq = (p) => `${p}${Date.now()}x${++seq}@example.com`;
const auth = (u) => ({ Authorization: `Bearer ${tokenFor(u._id)}` });

function buildApp() {
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { transports: ['websocket'] });
  io.use(authenticateSocket);
  setupSOSHandlers(io);
  app.set('io', io);
  app.use(express.json());
  app.use('/api/circles', inviteRoutes);
  app.use('/api/circles', circleRoutes);
  app.use('/', inviteLinkRoutes);
  return { app, server, io };
}

/** Pull the invite link out of the plain-text part of a captured email */
const linkIn = (mail) => {
  const m = mail.text.match(/https:\/\/amber\.test\/invite\?c=([0-9a-f]{24})&t=([A-Za-z0-9_-]{43})/);
  return m ? { url: m[0], circleId: m[1], token: m[2] } : null;
};
const sentMails = () => mockSendMail.mock.calls.map(c => c[0]);

let app, server;
beforeAll(async () => { await Invite.init(); });
beforeEach(() => {
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ accepted: ['x'] });
  process.env.SMTP_HOST = 'smtp.test';
  process.env.MAIL_FROM = 'Amber SOS <no-reply@amber.test>';
  delete process.env.INVITE_REQUIRE_EMAIL_MATCH;
  emailService.resetTransport();
  ({ app, server } = buildApp());
});
afterEach(() => new Promise(r => server.close(r)));

// ── Tokens ──────────────────────────────────────────────────────────────────

describe('tokens', () => {
  it('are 256-bit, URL-safe, 43 characters, and never repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const t = inviteService.generateToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
  });

  it('are stored as a keyed hash, never in plain text', async () => {
    const alice = await createUser({ email: uniq('a') });
    const circle = await createCircleWithMember(alice._id);
    const res = await request(app).post(`/api/circles/${circle._id}/invites/qr`).set(auth(alice));
    const all = JSON.stringify(await Invite.find().lean());
    expect(all).not.toContain(res.body.token);
    const doc = await Invite.findOne({ circle: circle._id });
    expect(doc.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.tokenHash).toBe(inviteService.hashToken(res.body.token));
  });

  it('the database has a TTL index that deletes invites after expiresAt', async () => {
    const idx = await Invite.collection.indexes();
    const ttl = idx.find(i => i.key && i.key.expiresAt === 1);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(0);
  });
});

// ── POST /api/circles/invite-email ──────────────────────────────────────────

describe('POST /api/circles/invite-email', () => {
  let alice, circle;
  beforeEach(async () => {
    alice  = await createUser({ name: 'Alice', email: uniq('alice') });
    circle = await createCircleWithMember(alice._id);
  });
  const send = (user, body) => request(app).post('/api/circles/invite-email').set(auth(user)).send(body);

  it('401 without a login', async () => {
    const res = await request(app).post('/api/circles/invite-email').send({ circleId: String(circle._id), emails: ['a@b.co'] });
    expect(res.status).toBe(401);
  });

  it('sends one email per address with a working single-use link, and stores only the hash', async () => {
    const res = await send(alice, { circleId: String(circle._id), emails: ['Mum@Example.com', 'dad@example.com'] });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(res.body.results.map(r => r.status)).toEqual(['sent', 'sent']);
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);   // no token in the API response

    const mails = sentMails();
    expect(mails.map(m => m.to)).toEqual(['mum@example.com', 'dad@example.com']);
    const l1 = linkIn(mails[0]), l2 = linkIn(mails[1]);
    expect(l1.circleId).toBe(String(circle._id));
    expect(l1.token).not.toBe(l2.token);                                     // each recipient has their own token
    expect(mails[0].html).toContain(l1.url.replace(/&/g, '&amp;'));          // button link present (HTML-escaped)

    const docs = await Invite.find({ circle: circle._id }).lean();
    expect(docs).toHaveLength(2);
    expect(JSON.stringify(docs)).not.toContain(l1.token);
    const hours = (docs[0].expiresAt - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47); expect(hours).toBeLessThanOrEqual(48);
  });

  it('403 for a non-member, 404 for an unknown circle, 400 for bad input', async () => {
    const eve = await createUser({ email: uniq('eve') });
    expect((await send(eve, { circleId: String(circle._id), emails: ['a@b.co'] })).status).toBe(403);
    expect((await send(alice, { circleId: '64b64b64b64b64b64b64b64b', emails: ['a@b.co'] })).status).toBe(404);
    expect((await send(alice, { circleId: 'nope', emails: ['a@b.co'] })).status).toBe(400);
    expect((await send(alice, { circleId: String(circle._id), emails: [] })).status).toBe(400);
    expect((await send(alice, { circleId: String(circle._id), emails: 'a@b.co' })).status).toBe(400);
    expect((await send(alice, { circleId: String(circle._id), emails: ['a@b.co','b@b.co','c@b.co','d@b.co','e@b.co','f@b.co'] })).status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('rejects malformed addresses and header-injection attempts; sends nothing', async () => {
    for (const bad of ['not-an-email', 'a@b', 'x@y.com\r\nBcc: evil@x.com', 'a b@c.com', '"q"@c.com', 'a@b.com,c@d.com', ' ']) {
      const res = await send(alice, { circleId: String(circle._id), emails: [bad] });
      expect(res.status).toBe(400);
    }
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(await Invite.countDocuments()).toBe(0);
  });

  it('503 when email is not set up (and nothing is stored)', async () => {
    delete process.env.SMTP_HOST; emailService.resetTransport();
    const res = await send(alice, { circleId: String(circle._id), emails: ['a@b.co'] });
    expect(res.status).toBe(503);
    expect(await Invite.countDocuments()).toBe(0);
  });

  it('skips yourself, existing members, and duplicates', async () => {
    const bob = await createUser({ email: uniq('bob') });
    await Circle.updateOne({ _id: circle._id }, { $push: { members: bob._id } });
    const res = await send(alice, {
      circleId: String(circle._id),
      emails: [alice.email.toUpperCase(), bob.email, 'new@example.com', 'NEW@example.com']
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { email: alice.email, status: 'skipped', reason: 'self' },
      { email: bob.email,   status: 'skipped', reason: 'already_member' },
      { email: 'new@example.com', status: 'sent' }
    ]);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('removes the stored invite when the mail server fails (502 if nothing was sent)', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP down'));
    const res = await send(alice, { circleId: String(circle._id), emails: ['a@b.co'] });
    expect(res.status).toBe(502);
    expect(res.body.results[0].status).toBe('failed');
    expect(await Invite.countDocuments()).toBe(0);
  });

  it('sending again replaces the old link: the old one stops working', async () => {
    await send(alice, { circleId: String(circle._id), emails: ['fam@example.com'] });
    await send(alice, { circleId: String(circle._id), emails: ['fam@example.com'] });
    const [first, second] = sentMails().map(linkIn);
    expect(await Invite.countDocuments({ circle: circle._id, revokedAt: null })).toBe(1);   // the first one is revoked, not live

    const fam = await createUser({ email: 'fam@example.com' });
    const old = await request(app).post('/api/circles/join-invite').set(auth(fam)).send({ circleId: first.circleId, token: first.token });
    expect(old.status).toBe(404);
    const fresh = await request(app).post('/api/circles/join-invite').set(auth(fam)).send({ circleId: second.circleId, token: second.token });
    expect(fresh.status).toBe(200);
  });

  it('limits how often one address can be invited (3 per day)', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await send(alice, { circleId: String(circle._id), emails: ['victim@example.com'] });
      expect(r.body.results[0].status).toBe('sent');
    }
    const r4 = await send(alice, { circleId: String(circle._id), emails: ['victim@example.com'] });
    expect(r4.body.results[0]).toEqual({ email: 'victim@example.com', status: 'skipped', reason: 'recipient_limit' });
    expect(sentMails()).toHaveLength(3);
  });

  it('limits one user to 10 emails per hour', async () => {
    const mk = (n, o) => Array.from({ length: n }, (_, i) => `p${o + i}@example.com`);
    await send(alice, { circleId: String(circle._id), emails: mk(5, 0) });
    await send(alice, { circleId: String(circle._id), emails: mk(5, 5) });
    const r = await send(alice, { circleId: String(circle._id), emails: ['extra@example.com'] });
    expect(r.body.results[0]).toEqual({ email: 'extra@example.com', status: 'skipped', reason: 'rate_limited' });
    expect(sentMails()).toHaveLength(10);
  });

  it('limits pending email invitations per circle (10), across members', async () => {
    const bob = await createUser({ email: uniq('bob') });
    await Circle.updateOne({ _id: circle._id }, { $push: { members: bob._id } });
    const mk = (n, o) => Array.from({ length: n }, (_, i) => `q${o + i}@example.com`);
    await send(alice, { circleId: String(circle._id), emails: mk(5, 0) });
    await send(alice, { circleId: String(circle._id), emails: mk(5, 5) });
    const r = await send(bob, { circleId: String(circle._id), emails: ['one-more@example.com'] });
    expect(r.body.results[0].reason).toBe('too_many_pending');
  });

  it('409 when the circle is already full', async () => {
    const extra = await Promise.all([1, 2, 3, 4].map(i => createUser({ email: uniq(`m${i}`) })));
    await Circle.updateOne({ _id: circle._id }, { $push: { members: { $each: extra.map(u => u._id) } } });
    const res = await send(alice, { circleId: String(circle._id), emails: ['a@b.co'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CIRCLE_FULL');
  });

  it('429 after 20 requests in an hour (per user)', async () => {
    const spammer = await createUser({ email: uniq('spam') });
    let last;
    for (let i = 0; i < 21; i++) last = await send(spammer, {});
    expect(last.status).toBe(429);
  });

  it('the email is safe: user-controlled names cannot inject HTML or headers', async () => {
    const evil = await createUser({ name: 'Eve <img src=x onerror=alert(1)>\r\nBcc: evil@x.com', email: uniq('evil') });
    const evilCircle = await Circle.create({ name: '<script>alert(1)</script>', members: [evil._id], createdBy: evil._id });
    const res = await send(evil, { circleId: String(evilCircle._id), emails: ['target@example.com'] });
    expect(res.status).toBe(200);
    const mail = sentMails()[0];
    expect(mail.html).not.toContain('<script>alert');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).not.toContain('Bcc:\n');
  });
});

// ── POST /api/circles/:id/invites/qr ────────────────────────────────────────

describe('POST /api/circles/:id/invites/qr', () => {
  let alice, circle;
  beforeEach(async () => {
    alice  = await createUser({ name: 'Alice', email: uniq('alice') });
    circle = await createCircleWithMember(alice._id);
  });
  const qr = (user, id = circle._id) => request(app).post(`/api/circles/${id}/invites/qr`).set(auth(user));

  it('returns a link with circleId and token, valid for ~10 minutes', async () => {
    const res = await qr(alice);
    expect(res.status).toBe(201);
    expect(res.body.circleId).toBe(String(circle._id));
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.link).toBe(`https://amber.test/invite?c=${circle._id}&t=${res.body.token}`);
    expect(res.body.ttlSeconds).toBe(600);
    const secs = (new Date(res.body.expiresAt) - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(590); expect(secs).toBeLessThanOrEqual(600);
  });

  it('members only; bad id → 400; unknown circle → 404; full circle → 409', async () => {
    const eve = await createUser({ email: uniq('eve') });
    expect((await qr(eve)).status).toBe(403);
    expect((await qr(alice, 'bad')).status).toBe(400);
    expect((await qr(alice, '64b64b64b64b64b64b64b64b')).status).toBe(404);
    const extra = await Promise.all([1, 2, 3, 4].map(i => createUser({ email: uniq(`m${i}`) })));
    await Circle.updateOne({ _id: circle._id }, { $push: { members: { $each: extra.map(u => u._id) } } });
    expect((await qr(alice)).status).toBe(409);
  });

  it('showing a new QR retires your previous one', async () => {
    const first  = (await qr(alice)).body;
    const second = (await qr(alice)).body;
    const bob = await createUser({ email: uniq('bob') });
    const body = (b) => ({ circleId: b.circleId, token: b.token });
    expect((await request(app).post('/api/circles/join-invite').set(auth(bob)).send(body(first))).status).toBe(404);
    expect((await request(app).post('/api/circles/join-invite').set(auth(bob)).send(body(second))).status).toBe(200);
  });
});

// ── Preview and join ────────────────────────────────────────────────────────

describe('preview and join', () => {
  let alice, bob, circle, qrInvite;
  const preview = (user, b) => request(app).post('/api/circles/invite-preview').set(auth(user)).send(b);
  const join    = (user, b) => request(app).post('/api/circles/join-invite').set(auth(user)).send(b);
  const body    = (i = qrInvite) => ({ circleId: i.circleId, token: i.token });

  beforeEach(async () => {
    alice  = await createUser({ name: 'Alice', email: uniq('alice') });
    bob    = await createUser({ name: 'Bob',   email: uniq('bob') });
    circle = await Circle.create({ name: 'Family', members: [alice._id], createdBy: alice._id });
    qrInvite = (await request(app).post(`/api/circles/${circle._id}/invites/qr`).set(auth(alice))).body;
  });

  it('401 without a login; 400 for a malformed token or circle id', async () => {
    expect((await request(app).post('/api/circles/join-invite').send(body())).status).toBe(401);
    expect((await join(bob, { circleId: qrInvite.circleId, token: 'short' })).status).toBe(400);
    expect((await join(bob, { circleId: 'nope', token: qrInvite.token })).status).toBe(400);
    expect((await join(bob, {})).status).toBe(400);
  });

  it('preview shows circle and inviter and does NOT use up the invite', async () => {
    const p1 = await preview(bob, body());
    expect(p1.status).toBe(200);
    expect(p1.body.invite).toMatchObject({ circleName: 'Family', inviterName: 'Alice', memberCount: 1, maxMembers: 5 });
    expect((await preview(bob, body())).status).toBe(200);
    expect((await join(bob, body())).status).toBe(200);
  });

  it('join adds the member, and the invite works only once', async () => {
    const carol = await createUser({ email: uniq('carol') });
    const ok = await join(bob, body());
    expect(ok.status).toBe(200);
    expect((await Circle.findById(circle._id)).isMember(bob._id)).toBe(true);
    const again = await join(carol, body());
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('INVITE_INVALID');
    expect((await Circle.findById(circle._id)).isMember(carol._id)).toBe(false);
  });

  it('two people using the same QR at the same instant: exactly one gets in', async () => {
    const [u1, u2, u3] = await Promise.all([1, 2, 3].map(i => createUser({ email: uniq(`r${i}`) })));
    const results = await Promise.all([join(u1, body()), join(u2, body()), join(u3, body())]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 404)).toHaveLength(2);
    expect((await Circle.findById(circle._id)).members).toHaveLength(2);
  });

  it('an expired invitation is refused even before MongoDB has cleaned it up', async () => {
    await Invite.updateOne({ circle: circle._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await preview(bob, body())).status).toBe(404);
    expect((await join(bob, body())).status).toBe(404);
    expect((await Circle.findById(circle._id)).members).toHaveLength(1);
  });

  it('wrong circle + right token, and unknown circle, look exactly like a bad token', async () => {
    const other = await Circle.create({ name: 'Other', members: [alice._id], createdBy: alice._id });
    const a = await join(bob, { circleId: String(other._id), token: qrInvite.token });
    const b = await join(bob, { circleId: '64b64b64b64b64b64b64b64b', token: qrInvite.token });
    const c = await join(bob, { circleId: qrInvite.circleId, token: inviteService.generateToken() });
    for (const r of [a, b, c]) { expect(r.status).toBe(404); expect(r.body.code).toBe('INVITE_INVALID'); }
    expect(a.body).toEqual(b.body); expect(b.body).toEqual(c.body);
  });

  it('a member scanning their own circle\'s QR gets "already a member" and the invite is NOT used up', async () => {
    const r = await join(alice, body());
    expect(r.status).toBe(409); expect(r.body.code).toBe('ALREADY_MEMBER');
    expect((await join(bob, body())).status).toBe(200);
  });

  it('a full circle refuses, gives the invite back, and works again once there is room', async () => {
    const fillers = await Promise.all([1, 2, 3, 4].map(i => createUser({ email: uniq(`f${i}`) })));
    await Circle.updateOne({ _id: circle._id }, { $push: { members: { $each: fillers.map(u => u._id) } } });
    const full = await join(bob, body());
    expect(full.status).toBe(409); expect(full.body.code).toBe('CIRCLE_FULL');
    expect((await preview(bob, body())).body.code).toBe('CIRCLE_FULL');
    expect((await Invite.findOne({ circle: circle._id })).usedAt).toBeNull();     // not wasted

    await Circle.updateOne({ _id: circle._id }, { $pull: { members: fillers[0]._id } });
    expect((await join(bob, body())).status).toBe(200);
  });

  it('the new member\'s open sockets join the circle room', async () => {
    const { io: ioSrv } = { io: app.get('io') };
    const spy = jest.spyOn(ioSrv, 'in');
    await join(bob, body());
    expect(spy).toHaveBeenCalledWith(`user:${bob._id}`);
    spy.mockRestore();
  });

  describe('invitations sent by email are bound to that address', () => {
    let target, invite;
    beforeEach(async () => {
      target = await createUser({ name: 'Dana', email: 'Dana@Example.com' });   // stored lower-case
      await request(app).post('/api/circles/invite-email').set(auth(alice))
        .send({ circleId: String(circle._id), emails: ['dana@example.com'] });
      invite = linkIn(sentMails().pop());
    });

    it('another account is refused (with a masked hint) and the invite stays usable', async () => {
      const r = await join(bob, { circleId: invite.circleId, token: invite.token });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('EMAIL_MISMATCH');
      expect(r.body.maskedEmail).toBe('d***@example.com');
      expect(JSON.stringify(r.body)).not.toContain('dana@example.com');
      expect((await Circle.findById(circle._id)).isMember(bob._id)).toBe(false);
      expect((await join(target, { circleId: invite.circleId, token: invite.token })).status).toBe(200);
    });

    it('can be switched off with INVITE_REQUIRE_EMAIL_MATCH=false', async () => {
      process.env.INVITE_REQUIRE_EMAIL_MATCH = 'false';
      expect((await join(bob, { circleId: invite.circleId, token: invite.token })).status).toBe(200);
    });
  });
});

// ── Landing page and app-link files ─────────────────────────────────────────

describe('GET /invite (landing page)', () => {
  const C = 'a'.repeat(24);
  const T = 'B'.repeat(43);

  it('shows an "Open in Amber" button pointing at the app link, with strict headers', async () => {
    const res = await request(app).get(`/invite?c=${C}&t=${T}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="amber://invite?c=${C}&amp;t=${T}"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    const csp = res.headers['content-security-policy'];
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
    expect(csp).toContain("default-src 'none'");
    expect(res.text).toContain(`<script nonce="${nonce}">`);
  });

  it('cannot be used to inject markup: bad values show a plain "not valid" page', async () => {
    for (const q of [
      `c="><script>alert(1)</script>&t=${T}`,
      `c=${C}&t=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`,
      `c=${C}`, '', `c=${C}&t=short`, `c[]=x&t=${T}`
    ]) {
      const res = await request(app).get(`/invite?${q}`);
      expect(res.status).toBe(400);
      expect(res.text).toContain('not valid');
      expect(res.text).not.toMatch(/<script>alert|<img src=x|amber:\/\/invite/);
    }
  });

  it('uses a different nonce on every request', async () => {
    const a = await request(app).get(`/invite?c=${C}&t=${T}`);
    const b = await request(app).get(`/invite?c=${C}&t=${T}`);
    expect(a.headers['content-security-policy']).not.toBe(b.headers['content-security-policy']);
  });
});

describe('app-link verification files', () => {
  afterEach(() => { delete process.env.ANDROID_SHA256_CERT_FINGERPRINTS; delete process.env.APPLE_TEAM_ID; });

  it('assetlinks.json: 404 until configured, then lists the package and fingerprints', async () => {
    expect((await request(app).get('/.well-known/assetlinks.json')).status).toBe(404);
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = 'AA:BB, CC:DD';
    const res = await request(app).get('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.body[0].target).toEqual({
      namespace: 'android_app', package_name: 'com.amber.sos', sha256_cert_fingerprints: ['AA:BB', 'CC:DD']
    });
  });

  it('apple-app-site-association: 404 until configured, then JSON for /invite', async () => {
    expect((await request(app).get('/.well-known/apple-app-site-association')).status).toBe(404);
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    const res = await request(app).get('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const j = JSON.parse(res.text);
    expect(j.applinks.details[0].appIDs).toEqual(['TEAM123456.com.amber.sos']);
    expect(j.applinks.details[0].paths).toEqual(['/invite']);
  });
});
