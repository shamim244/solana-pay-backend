// ============================================
// Authentication Middleware
// ============================================

const config = require('../config');

// Remove the logger import for now to avoid circular dependency
// const { logApiRequest } = require('./logger');

async function authenticate(req, res, next) {
  const startTime = Date.now();
  
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authorization header required. Format: Bearer YOUR_API_KEY' 
      });
    }

    const apiKey = authHeader.split('Bearer ')[1];
    
    if (!apiKey || apiKey !== config.api.universalApiKey) {
      return res.status(401).json({ 
        error: 'Invalid API key' 
      });
    }

    // Attach API key info to request
    req.apiKeyId = 1; // Universal API key always has ID 1
    next();
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Authentication failed',
      details: error.message 
    });
  }
}

module.exports = authenticate;
