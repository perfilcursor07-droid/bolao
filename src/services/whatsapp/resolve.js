const { normalizeBrazilPhone } = require('./phone');

/**
 * Resolve o JID correto para envio (Baileys v7 — LID ou PN via onWhatsApp).
 */
async function resolveRecipientJid(sock, phone) {
  const normalized = normalizeBrazilPhone(phone);
  if (!normalized) {
    throw new Error('Telefone inválido');
  }

  const results = await sock.onWhatsApp(normalized);
  const hit = Array.isArray(results) ? results.find((r) => r.exists) : null;

  if (!hit?.jid) {
    throw new Error(`Número ${normalized} não está registrado no WhatsApp`);
  }

  let jid = hit.jid;

  if (String(jid).endsWith('@s.whatsapp.net')) {
    try {
      const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(jid);
      if (lid) {
        jid = String(lid).includes('@') ? lid : `${lid}@lid`;
      }
    } catch {
      /* mantém PN retornado pelo onWhatsApp */
    }
  }

  return { jid, normalized, pnJid: `${normalized}@s.whatsapp.net` };
}

module.exports = { resolveRecipientJid };
