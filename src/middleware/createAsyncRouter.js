const express = require('express');
const { asyncHandler } = require('./asyncHandler');

function wrapHandler(handler) {
  if (typeof handler !== 'function') return handler;
  if (handler.length >= 4) return handler; // error middleware
  // Only wrap async functions — leave sync middleware (e.g. express.raw) alone
  if (handler.constructor && handler.constructor.name === 'AsyncFunction') {
    return asyncHandler(handler);
  }
  return handler;
}

/** Express router that auto-wraps async route handlers. */
function createAsyncRouter() {
  const router = express.Router({ mergeParams: true });
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) =>
      original(path, ...handlers.map(wrapHandler));
  }
  return router;
}

module.exports = { createAsyncRouter };
