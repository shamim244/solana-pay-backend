const axios = require('axios');

const API_KEY = '6vt1-AZSbd3tLPtTOb0mdeYbekMvM49q3OF763HYVZ4';
const BASE_URL = 'http://localhost:3000';

// Test payment creation
async function testPaymentCreation() {
  try {
    const response = await axios.post(`${BASE_URL}/api/payment-request`, {
      recipient: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      amount: 1.0,
      label: 'JavaScript Test',
      message: 'Testing from JavaScript'
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Payment created:', response.data);
    return response.data.reference;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Test payment status
async function testPaymentStatus(reference) {
  try {
    const response = await axios.get(`${BASE_URL}/api/payment-status/${reference}`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });

    console.log('Payment status:', response.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Run tests
(async () => {
  const reference = await testPaymentCreation();
  if (reference) {
    await testPaymentStatus(reference);
  }
})();
