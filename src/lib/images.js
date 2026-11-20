const { PUBLIC_API_BASE } = require('../config');
const { Verification } = require('../models');
const { str } = require('./util');

function normalizeImageUrl(raw) {
  let s = str(raw);
  if (!s) return '';
  s = s.replace(/^['"]+|['"]+$/g, '');
  if (s.startsWith('data:image')) return s;
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}/i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

function isUsableSelfieUrl(raw) {
  const s = normalizeImageUrl(raw);
  return s.startsWith('data:image') || /^https?:\/\//i.test(s);
}

async function latestVerificationForUser(user) {
  if (!user) return null;
  const email = String(user.email || '').toLowerCase();
  const query = {
    $or: [
      ...(email ? [{ email }] : []),
      ...(user.id != null ? [{ userId: user.id }] : []),
    ],
  };
  if (!query.$or.length) return null;
  return Verification.findOne(query).sort({ submittedAt: -1, id: -1 });
}

function selfieMediaUrl(userId) {
  return `${PUBLIC_API_BASE}/media/selfie/${userId}`;
}

async function hasApprovedSelfie(user) {
  if (!user) return false;
  if (String(user.verificationStatus || '').toLowerCase() !== 'approved') {
    return false;
  }
  const linked = await latestVerificationForUser(user);
  return isUsableSelfieUrl(linked?.selfieUrl);
}

function applyApprovedSelfieToProfile(user, selfieUrl) {
  if (!user || !isUsableSelfieUrl(selfieUrl)) return false;
  user.profileImageUrl = selfieMediaUrl(user.id);
  return true;
}

async function effectiveProfileImageUrl(user) {
  if (!user) return '';
  if (await hasApprovedSelfie(user)) {
    return selfieMediaUrl(user.id);
  }
  return normalizeImageUrl(user.profileImageUrl);
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

module.exports = {
  normalizeImageUrl,
  isUsableSelfieUrl,
  latestVerificationForUser,
  selfieMediaUrl,
  hasApprovedSelfie,
  applyApprovedSelfieToProfile,
  effectiveProfileImageUrl,
  isPrivateHostname,
};
