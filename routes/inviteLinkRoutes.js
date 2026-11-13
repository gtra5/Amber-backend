'use strict';

/**
 * Public routes that make invitation links work (mounted at "/", not /api):
 *
 *   GET /invite                           small landing page behind the emailed link / QR code
 *   GET /.well-known/assetlinks.json      lets Android open the link directly in the app
 *   GET /.well-known/apple-app-site-association   the same for iPhone
 *
 * When the app is installed and "app links" are verified, the phone opens the
 * app straight from the link and this page is never shown. Otherwise (app not
 * installed, link opened on a computer, ...) this page offers to open the app
 * or to install it.
 *
 * The invite token is in the link's query string. To keep it out of other
 * places: the page is never cached, sends no referrer, is not indexed, and
 * the values are validated against strict patterns BEFORE they are placed in
 * the page, so nothing a visitor types into the URL can inject markup.
 */

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const { ID_RE, TOKEN_RE } = require('../services/inviteService');

const APP_SCHEME = process.env.APP_URL_SCHEME || 'amber';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page({ nonce, deepLink }) {
  const iosUrl     = process.env.IOS_APP_STORE_URL || '';
  const androidUrl = process.env.ANDROID_PLAY_URL  || '';
  const httpsOnly  = (u) => /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';

  const valid = Boolean(deepLink);
  const store = [httpsOnly(iosUrl) && `<a class="btn secondary" href="${esc(httpsOnly(iosUrl))}">Get Amber for iPhone</a>`,
                 httpsOnly(androidUrl) && `<a class="btn secondary" href="${esc(httpsOnly(androidUrl))}">Get Amber for Android</a>`]
                .filter(Boolean).join('\n    ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Amber invitation</title>
<style nonce="${nonce}">
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f4f5;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{background:#fff;max-width:420px;margin:16px;padding:28px;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
  h1{font-size:22px;margin:0 0 8px;color:#15803D} p{font-size:15px;line-height:22px;color:#3f3f46;margin:8px 0}
  .btn{display:block;margin:12px 0 0;padding:14px;border-radius:8px;background:#15803D;color:#fff;text-decoration:none;font-weight:700}
  .btn.secondary{background:#fff;color:#15803D;border:2px solid #15803D}
  small{display:block;margin-top:18px;color:#71717a;font-size:12px;line-height:18px}
</style></head>
<body><main>
  <h1>Amber</h1>
${valid ? `  <p>You have been invited to join a Safety Circle.</p>
  <p>Open the invitation in the Amber app on your phone to review and accept it.</p>
  <a class="btn" id="open" href="${esc(deepLink)}">Open in Amber</a>
  ${store}
  <small>Amber does not replace calling your local emergency number. If you don&rsquo;t know who sent this, ignore it. Nothing happens unless you accept in the app.</small>
  <script nonce="${nonce}">setTimeout(function(){ window.location.href = document.getElementById('open').href; }, 400);</script>` :
`  <p>This invitation link is not valid. Ask the person who invited you to send a new one.</p>`}
</main></body></html>`;
}

router.get('/invite', (req, res) => {
  const c = typeof req.query.c === 'string' ? req.query.c : '';
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  const ok = ID_RE.test(c) && TOKEN_RE.test(t);

  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Type':           'text/html; charset=utf-8',
    'Cache-Control':          'no-store',
    'Referrer-Policy':        'no-referrer',
    'X-Robots-Tag':           'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
      `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  });

  // Both values passed the strict patterns above, so they are safe to place in a link
  res.status(ok ? 200 : 400).send(page({
    nonce,
    deepLink: ok ? `${APP_SCHEME}://invite?c=${c}&t=${t}` : null
  }));
});

// ── Android App Links verification ───────────────────────────────────────────
router.get('/.well-known/assetlinks.json', (_req, res) => {
  const fingerprints = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!fingerprints.length) return res.status(404).json({ error: 'Not configured' });

  res.set('Cache-Control', 'public, max-age=3600').json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace:    'android_app',
      package_name: process.env.ANDROID_PACKAGE || 'com.amber.sos',
      sha256_cert_fingerprints: fingerprints
    }
  }]);
});

// ── iPhone Universal Links verification ──────────────────────────────────────
router.get('/.well-known/apple-app-site-association', (_req, res) => {
  const team = process.env.APPLE_TEAM_ID;
  if (!team) return res.status(404).json({ error: 'Not configured' });

  const appID = `${team}.${process.env.APPLE_BUNDLE_ID || 'com.amber.sos'}`;
  res.set('Cache-Control', 'public, max-age=3600').type('application/json').send(JSON.stringify({
    applinks: {
      apps: [],
      details: [{
        appID,
        appIDs: [appID],
        components: [{ '/': '/invite' }],
        paths: ['/invite']
      }]
    }
  }));
});

module.exports = router;
