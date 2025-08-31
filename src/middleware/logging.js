// ============================================
// Request Logger Middleware
// ============================================

const config = require('../config');

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
    
    // Log to database (async, don't block response)
    if (config?.logging?.enableApiLogging) {
      logApiRequest(req, this, res.statusCode, responseTime).catch(err => 
        console.error('Failed to log to database:', err.message)
      );
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

// Log API request to database
async function logApiRequest(req, res, statusCode, responseTime, error = null) {
  if (!config?.logging?.enableApiLogging) return;
  
  try {
    const { pool } = require('../utils/database');
    const dbConn = await pool.getConnection();
    
    try {
      await dbConn.query(`
        INSERT INTO api_logs (
          endpoint, http_method, client_ip, user_agent,
          status_code, response_time_ms, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        req.path,
        req.method,
        getClientIp(req),
        req.get('User-Agent') || 'unknown',
        statusCode,
        responseTime,
        error ? error.message : null
      ]);
    } finally {
      dbConn.release();
    }
  } catch (logError) {
    console.error('Failed to log API request:', logError.message);
  }
}

module.exports = {
  requestTiming,
  responseLogging,
  logApiRequest
};
