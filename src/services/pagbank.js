const axios = require('axios');

const BASE_URL =
  process.env.PIX_ENVIRONMENT === 'production'
    ? 'https://api.pagseguro.com'
    : 'https://sandbox.api.pagseguro.com';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAGBANK_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function createPixOrder({ referenceId, customer, amountCents, description }) {
  const webhookUrl = process.env.WEBHOOK_URL || `${process.env.APP_URL}/api/payment/webhook/pagbank`;

  const body = {
    reference_id: referenceId,
    customer: {
      name: customer.name,
      email: customer.email,
      tax_id: customer.cpf.replace(/\D/g, ''),
    },
    items: [
      {
        name: description,
        quantity: 1,
        unit_amount: amountCents,
      },
    ],
    qr_codes: [
      {
        amount: { value: amountCents },
      },
    ],
    notification_urls: [webhookUrl],
  };

  const response = await axios.post(`${BASE_URL}/orders`, body, { headers: getHeaders() });
  return response.data;
}

async function getOrderStatus(orderId) {
  const response = await axios.get(`${BASE_URL}/orders/${orderId}`, { headers: getHeaders() });
  return response.data;
}

async function cancelOrder(orderId) {
  const response = await axios.post(`${BASE_URL}/orders/${orderId}/cancel`, {}, { headers: getHeaders() });
  return response.data;
}

function extractChargeStatus(order) {
  if (!order.charges || order.charges.length === 0) return 'WAITING';
  const lastCharge = order.charges[order.charges.length - 1];
  return lastCharge.status;
}

module.exports = { createPixOrder, getOrderStatus, cancelOrder, extractChargeStatus };
