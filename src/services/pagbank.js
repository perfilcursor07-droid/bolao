const axios = require('axios');
const { normalizeBrazilPhone } = require('./whatsapp/phone');

const BASE_URL =
  process.env.PIX_ENVIRONMENT === 'production'
    ? 'https://api.pagseguro.com'
    : 'https://sandbox.api.pagseguro.com';

const DEFAULT_TAX_ID = '52984376137';

function digitsOnly(value) {
  return (value || '').replace(/\D/g, '');
}

function isValidCpf(cpf) {
  if (!cpf || cpf.length !== 11) return false;
  // Rejeitar CPFs com todos os dígitos iguais (ex: 00000000000, 11111111111)
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  // Validação dos dígitos verificadores
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (parseInt(cpf[9]) !== d1) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  if (parseInt(cpf[10]) !== d2) return false;

  return true;
}

function resolveTaxId(user) {
  const digits = digitsOnly(user.cpf);
  if (isValidCpf(digits)) return digits;
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

function parsePhoneForPagBank(phone) {
  const normalized = normalizeBrazilPhone(phone);
  let local = normalized ? normalized.slice(2) : digitsOnly(phone);
  if (local.startsWith('55') && local.length > 11) {
    local = local.slice(2);
  }
  if (local.length < 10 || local.length > 11) return null;

  return {
    country: '55',
    area: local.slice(0, 2),
    number: local.slice(2),
    type: 'MOBILE',
  };
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

  const parsed = parsePhoneForPagBank(user.phone);
  if (parsed) {
    customer.phones = [parsed];
  }

  return customer;
}

function getHeaders() {
  const token = (process.env.PAGBANK_TOKEN || '').trim();
  return {
    Authorization: `Bearer ${token}`,
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
        expiration_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    notification_urls: [webhookUrl],
  };

  try {
    console.log('[PagBank createPixOrder] Request:', JSON.stringify(body, null, 2));
    const response = await axios.post(`${BASE_URL}/orders`, body, { headers: getHeaders() });
    console.log('[PagBank createPixOrder] Response:', JSON.stringify(response.data, null, 2));

    const order = response.data;

    // Se qr_codes[0].text não veio na resposta inicial, buscar via GET
    if (order.qr_codes && order.qr_codes[0] && !order.qr_codes[0].text) {
      console.log('[PagBank] QR code text não retornado na criação, tentando buscar via GET...');
      try {
        // Aguardar um momento para o QR code ser gerado
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const orderDetail = await axios.get(`${BASE_URL}/orders/${order.id}`, { headers: getHeaders() });
        console.log('[PagBank] GET order response:', JSON.stringify(orderDetail.data, null, 2));
        if (orderDetail.data.qr_codes && orderDetail.data.qr_codes[0] && orderDetail.data.qr_codes[0].text) {
          order.qr_codes = orderDetail.data.qr_codes;
        }
      } catch (retryErr) {
        console.error('[PagBank] Erro ao buscar QR code via GET:', retryErr.message);
      }
    }

    return order;
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
