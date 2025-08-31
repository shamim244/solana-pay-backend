const crypto = require('crypto');

function generateApiKey() {
  // Generate 32 random bytes (256 bits)
  const buffer = crypto.randomBytes(32);
  // Convert to URL-safe base64 string
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Generate multiple keys
console.log('API Key 1:', generateApiKey());
console.log('API Key 2:', generateApiKey());
console.log('API Key 3:', generateApiKey());

module.exports = { generateApiKey };
