'use strict';

/**
 * emailService — sends invitation emails with Nodemailer.
 *
 * Configuration (environment variables):
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS
 *   MAIL_FROM          e.g.  Amber SOS <no-reply@yourdomain.com>
 *   SMTP_REQUIRE_TLS   default true: refuse to send if the connection cannot be encrypted
 *   EMAIL_DRY_RUN=true development only: builds the email but sends nothing
 *
 * Everything that comes from a user (names) is HTML-escaped before it goes
 * into the email, and stripped of control characters before it goes into the
 * subject (header injection).
 */

const nodemailer = require('nodemailer');

let transport = null;

function dryRun() {
  return process.env.EMAIL_DRY_RUN === 'true' && process.env.NODE_ENV !== 'production';
}

function isConfigured() {
  return dryRun() || Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function getTransport() {
  if (transport) return transport;

  if (dryRun()) {
    transport = nodemailer.createTransport({ jsonTransport: true });
    return transport;
  }

  const port   = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    // Port 587 starts plain and upgrades. Never allow it to stay unencrypted.
    requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000
  });
  return transport;
}

/** For tests: forget the cached transport so changed env vars are picked up. */
function resetTransport() { transport = null; }

// ── Text safety helpers ──────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line, no control characters, limited length. */
function oneLine(value, max = 60) {
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

// ── The invitation email ─────────────────────────────────────────────────────

function buildInviteEmail({ inviterName, circleName, link, expiresAt }) {
  const inviter = oneLine(inviterName, 50) || 'Someone';
  const circle  = oneLine(circleName, 50)  || 'a Safety Circle';
  const hours   = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000));

  const subject = `${inviter} invited you to join "${circle}" on Amber`;

  const text = [
    `${inviter} invited you to join the Safety Circle "${circle}" on Amber.`,
    '',
    'Amber lets a small group of trusted people alert each other in an emergency.',
    'If a member presses SOS, the others get an alarm and can see that person\'s live',
    'location, only while the SOS is active.',
    '',
    'To accept, open this link on your phone:',
    link,
    '',
    `The link works once and expires in about ${hours} hours.`,
    `If you don't know ${inviter}, just ignore this email. Nothing happens unless you accept.`
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;">
    <tr><td style="background:#15803D;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:700;">Amber</td></tr>
    <tr><td style="padding:24px;">
      <p style="font-size:17px;line-height:24px;margin:0 0 12px;"><strong>${escapeHtml(inviter)}</strong> invited you to join the Safety Circle <strong>&ldquo;${escapeHtml(circle)}&rdquo;</strong>.</p>
      <p style="font-size:14px;line-height:21px;margin:0 0 20px;color:#3f3f46;">Amber lets a small group of trusted people alert each other in an emergency. If a member presses SOS, the others get an alarm and can see that person&rsquo;s live location, <strong>only while the SOS is active</strong>.</p>
      <p style="margin:0 0 20px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#15803D;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:8px;">Review invitation</a></p>
      <p style="font-size:12px;line-height:18px;margin:0 0 6px;color:#71717a;">Button not working? Copy this link into your phone&rsquo;s browser:</p>
      <p style="font-size:12px;line-height:18px;margin:0 0 20px;word-break:break-all;color:#71717a;">${escapeHtml(link)}</p>
      <p style="font-size:12px;line-height:18px;margin:0;color:#71717a;">The link works once and expires in about ${hours} hours. If you don&rsquo;t know ${escapeHtml(inviter)}, just ignore this email. Nothing happens unless you accept.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

/**
 * Send one invitation. Throws if the mail server refuses or is unreachable, so
 * the caller can delete the invite it just stored.
 */
async function sendInviteEmail({ to, inviterName, circleName, link, expiresAt }) {
  if (!isConfigured()) throw new Error('Email is not configured');

  const { subject, text, html } = buildInviteEmail({ inviterName, circleName, link, expiresAt });

  await getTransport().sendMail({
    from: process.env.MAIL_FROM || 'Amber SOS <no-reply@localhost>',
    to,
    subject,
    text,
    html
  });

  // Development only (EMAIL_DRY_RUN): nothing was sent, so show the email here.
  if (dryRun()) console.log(`[email dry-run] to ${maskEmail(to)}\n${subject}\n\n${text}\n`);
}

module.exports = {
  isConfigured,
  sendInviteEmail,
  buildInviteEmail,
  maskEmail,
  escapeHtml,
  resetTransport
};
