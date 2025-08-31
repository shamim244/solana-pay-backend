// ============================================
// Rate Limiting Middleware
// ============================================

const config = require('../config');

function getClientIp(req) {
  return req.ip || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         'unknown';
}

// In-memory rate limit store
const rateLimitStore = new Map();

function rateLimitMiddleware(req, res, next) {
  if (!config?.rateLimiting?.maxRequests) {
    return next();
  }

  const key = req.apiKeyId || getClientIp(req);
  const now = Date.now();
  const windowMs = config.rateLimiting.windowMs;
  const maxRequests = config.rateLimiting.maxRequests;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs
    });
    return next();
  }

  const store = rateLimitStore.get(key);
  
  if (now > store.resetTime) {
    store.count = 1;
    store.resetTime = now + windowMs;
    return next();
  }

  if (store.count >= maxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit: maxRequests,
      reset_time: new Date(store.resetTime).toISOString(),
      retry_after: Math.ceil((store.resetTime - now) / 1000)
    });
  }

  store.count++;
  next();
}

module.exports = rateLimitMiddleware;
