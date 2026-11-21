const { RESEND_API_KEY, RESEND_FROM_EMAIL } = require('../config');

function makeResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendPasswordResetEmail(toEmail, code) {
  if (!RESEND_API_KEY) {
    const err = new Error(
      'RESEND_API_KEY is not configured on the server',
    );
    err.code = 'NO_RESEND_KEY';
    throw err;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [toEmail],
      subject: 'Joshikai password reset code',
      html: `
        <div style="font-family: Georgia, serif; color: #3E2723; line-height: 1.5;">
          <h2 style="margin: 0 0 12px;">Reset your Joshikai password</h2>
          <p>Use this 6-digit code in the app to set a new password. It expires in 15 minutes.</p>
          <p style="font-size: 28px; letter-spacing: 6px; font-weight: 700;">${code}</p>
          <p style="color: #8C6860; font-size: 13px;">If you did not request this, you can ignore this email.</p>
        </div>
      `,
      text: `Your Joshikai password reset code is ${code}. It expires in 15 minutes.`,
    }),
  });
  if (!response.ok) {
    let detail;
    try {
      const body = await response.json();
      detail = body?.message || body?.error || JSON.stringify(body);
    } catch (_) {
      detail = await response.text();
    }
    const err = new Error(
      `Resend failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
    err.code = 'RESEND_FAILED';
    throw err;
  }
}

module.exports = { makeResetCode, sendPasswordResetEmail };
