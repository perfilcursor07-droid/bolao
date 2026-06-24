const axios = require('axios');

const BASE_URL =
  process.env.PIX_ENVIRONMENT === 'production'
    ? 'https://api.pagseguro.com'
    : 'https://sandbox.api.pagseguro.com';

const DEFAULT_TAX_ID = '12345678909';

function digitsOnly(value) {
  return (value || '').replace(/\D/g, '');
}

function resolveTaxId(user) {
  const digits = digitsOnly(user.cpf);
  if (digits.length === 11) return digits;
  return process.env.PAGBANK_DEFAULT_TAX_ID || DEFAULT_TAX_ID;
}

function resolveCustomerEmail(user) {
  const vendorEmail = (process.env.PAGBANK_EMAIL || '').trim().toLowerCase();
  let email = (user.email || '').trim().toLowerCase();

  if (!email || email.endsWith('@bolao.local') || (vendorEmail && email === vendorEmail)) {
    const host = (process.env.APP_URL || 'https://bolaopix.site').replace(/^https?:\/\//, '').split('/')[0];
    return `cliente.${user.id}@${host}`;
  }

  return email;
}

/**
 * Monta customer para a API PagBank.
 * tax_id = CPF do comprador (11 dígitos). Chave PIX fica só no cadastro do usuário (prêmio).
 */
function buildPagBankCustomer(user) {
  const customer = {
    name: (user.name || 'Cliente').slice(0, 100),
    email: resolveCustomerEmail(user),
    tax_id: resolveTaxId(user),
  };

  const phone = digitsOnly(user.phone);
  if (phone.length >= 10) {
    customer.phones = [
      {
        country: '55',
        area: phone.slice(0, 2),
        number: phone.slice(2),
        type: 'MOBILE',
      },
    ];
  }

  return customer;
}

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAGBANK_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function logPagBankError(action, err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const env = process.env.PIX_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  console.error(`[PagBank ${action}] HTTP ${status || '?'} (${env})`, data || err.message);
}

async function createPixOrder({ referenceId, customer, amountCents, description }) {
  const webhookUrl = process.env.WEBHOOK_URL || `${process.env.APP_URL}/api/payment/webhook/pagbank`;

  const body = {
    reference_id: referenceId,
    customer: {
      name: customer.name,
      email: customer.email,
      tax_id: customer.tax_id,
      ...(customer.phones ? { phones: customer.phones } : {}),
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

  try {
    const response = await axios.post(`${BASE_URL}/orders`, body, { headers: getHeaders() });
    return response.data;
  } catch (err) {
    logPagBankError('createPixOrder', err);
    throw err;
  }
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

module.exports = { createPixOrder, getOrderStatus, cancelOrder, extractChargeStatus, buildPagBankCustomer };
