function getAppUrl() {
  return String(process.env.APP_URL || 'https://bolaopix.site').replace(/\/$/, '');
}

const SUPPORT_PHONE_E164 = String(process.env.SUPPORT_WHATSAPP || '551153044979').replace(/\D/g, '');
const SUPPORT_PHONE_DISPLAY = process.env.SUPPORT_PHONE_DISPLAY || '+55 11 5304-4979';
const PRIZE_TRANSFER_HOURS = Number.parseInt(process.env.PRIZE_TRANSFER_HOURS || '12', 10) || 12;

function getConsultarUrl() {
  return `${getAppUrl()}/consultar`;
}

function getSupportWhatsAppUrl(text) {
  const base = `https://wa.me/${SUPPORT_PHONE_E164}`;
  if (!text) return base;
  return `${base}?text=${encodeURIComponent(text)}`;
}

module.exports = {
  getAppUrl,
  getConsultarUrl,
  getSupportWhatsAppUrl,
  SUPPORT_PHONE_E164,
  SUPPORT_PHONE_DISPLAY,
  PRIZE_TRANSFER_HOURS,
};
