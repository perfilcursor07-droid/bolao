/**
 * Nomes de seleções em português (Brasil).
 * Chaves em minúsculas; aceita variações comuns da football-data.org e api-sports.
 */
const TEAMS_PT = {
  'scotland': 'Escócia',
  'brazil': 'Brasil',
  'switzerland': 'Suíça',
  'canada': 'Canadá',
  'bosnia-herzegovina': 'Bósnia e Herzegovina',
  'bosnia and herzegovina': 'Bósnia e Herzegovina',
  'qatar': 'Catar',
  'morocco': 'Marrocos',
  'haiti': 'Haiti',
  'czechia': 'Tchéquia',
  'czech republic': 'Tchéquia',
  'mexico': 'México',
  'south africa': 'África do Sul',
  'south korea': 'Coreia do Sul',
  'korea republic': 'Coreia do Sul',
  'ecuador': 'Equador',
  'germany': 'Alemanha',
  'curaçao': 'Curaçao',
  'curacao': 'Curaçao',
  'ivory coast': 'Costa do Marfim',
  "côte d'ivoire": 'Costa do Marfim',
  "cote d'ivoire": 'Costa do Marfim',
  'tunisia': 'Tunísia',
  'netherlands': 'Holanda',
  'japan': 'Japão',
  'sweden': 'Suécia',
  'turkey': 'Turquia',
  'türkiye': 'Turquia',
  'united states': 'Estados Unidos',
  'usa': 'Estados Unidos',
  'paraguay': 'Paraguai',
  'australia': 'Austrália',
  'norway': 'Noruega',
  'france': 'França',
  'senegal': 'Senegal',
  'iraq': 'Iraque',
  'uruguay': 'Uruguai',
  'spain': 'Espanha',
  'cape verde islands': 'Cabo Verde',
  'cape verde': 'Cabo Verde',
  'saudi arabia': 'Arábia Saudita',
  'new zealand': 'Nova Zelândia',
  'belgium': 'Bélgica',
  'egypt': 'Egito',
  'iran': 'Irã',
  'ir iran': 'Irã',
  'panama': 'Panamá',
  'england': 'Inglaterra',
  'croatia': 'Croácia',
  'ghana': 'Gana',
  'colombia': 'Colômbia',
  'portugal': 'Portugal',
  'congo dr': 'RD Congo',
  'dr congo': 'RD Congo',
  'democratic republic of the congo': 'RD Congo',
  'uzbekistan': 'Uzbequistão',
  'jordan': 'Jordânia',
  'argentina': 'Argentina',
  'algeria': 'Argélia',
  'austria': 'Áustria',
};

function translateTeamName(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  return TEAMS_PT[key] || trimmed;
}

module.exports = { translateTeamName, TEAMS_PT };
