// ============================================
// Logger Middleware - src/middleware/logger.js
// ============================================

function getClientIp(req) {
  return req.ip || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         'unknown';
}

// Request timing middleware
const requestTiming = (req, res, next) => {
  req.startTime = Date.now();
  next();
};

// Response logging middleware
const responseLogging = (req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(data) {
    const responseTime = Date.now() - req.startTime;
    
    // Log to console
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} - ${responseTime}ms`);
    
    return originalSend.call(this, data);
  };
  
  next();
};

module.exports = {
  requestTiming,
  responseLogging
};
