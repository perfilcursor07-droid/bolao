/**
 * Gera payload PIX (copia e cola / QR) estático com valor fixo — padrão BACEN EMV.
 */

function tlv(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function sanitizePixName(name) {
  return String(name || 'Recebedor')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .toUpperCase() || 'RECEBEDOR';
}

function sanitizeCity(city) {
  return String(city || 'SAO PAULO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 15)
    .toUpperCase() || 'SAO PAULO';
}

/** Formata chave PIX para o payload (telefone com +55, e-mail minúsculo, etc.). */
function formatPixKeyForPayload(pixKey) {
  const trimmed = String(pixKey || '').trim();
  if (!trimmed) return '';

  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 11) {
    return digits;
  }

  if (digits.length === 14) {
    return digits;
  }

  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  if (digits.startsWith('55') && digits.length >= 12) {
    return `+${digits}`;
  }

  return trimmed;
}

/**
 * @param {object} opts
 * @param {string} opts.pixKey — chave PIX do recebedor (cadastro)
 * @param {string} opts.receiverName — nome exibido no PIX
 * @param {number} opts.amountCents — valor em centavos
 * @param {string} [opts.txid] — identificador (máx. 25)
 * @param {string} [opts.city]
 */
function buildPixPayload({ pixKey, receiverName, amountCents, txid, city }) {
  const key = formatPixKeyForPayload(pixKey);
  if (!key) {
    throw new Error('Chave PIX inválida');
  }

  const amount = (Math.max(0, amountCents) / 100).toFixed(2);
  const reference = String(txid || `BOL${Date.now()}`)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 25);

  const merchantAccount = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  const additionalData = tlv('05', reference);

  const payloadWithoutCrc =
    tlv('00', '01') +
    tlv('26', merchantAccount) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('54', amount) +
    tlv('58', 'BR') +
    tlv('59', sanitizePixName(receiverName)) +
    tlv('60', sanitizeCity(city)) +
    tlv('62', additionalData);

  return `${payloadWithoutCrc}6304${crc16(payloadWithoutCrc + '6304')}`;
}

module.exports = {
  buildPixPayload,
  formatPixKeyForPayload,
  sanitizePixName,
};
