require('dotenv').config();
const { fetchWorldCup26Games } = require('../src/services/worldcup26Api');
const { formatGameDateBR } = require('../src/utils/dateTime');

const expected = [
  { id: '78', want: '30 de jun., 14:00' },
  { id: '77', want: '30 de jun., 14:00' },
  { id: '79', want: '30 de jun., 16:00' },
  { id: '80', want: '01 de jul., 09:00' },
  { id: '82', want: '01 de jul., 10:00' },
  { id: '81', want: '01 de jul., 14:00' },
  { id: '84', want: '02 de jul., 09:00' },
  { id: '83', want: '02 de jul., 16:00' },
  { id: '85', want: '02 de jul., 17:00' },
  { id: '88', want: '03 de jul., 10:00' },
  { id: '86', want: '03 de jul., 15:00' },
  { id: '87', want: '03 de jul., 17:30' },
  { id: '90', want: '04 de jul., 09:00' },
];

(async () => {
  const { matches } = await fetchWorldCup26Games({ forceRefresh: true });
  let ok = 0;
  for (const exp of expected) {
    const m = matches.find((x) => x.id === exp.id);
    const got = formatGameDateBR(m.date, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(' BRT', '');
    const pass = got === exp.want;
    if (pass) ok++;
  console.log(`${pass ? '✓' : '✗'} ${m.homeTeam} × ${m.awayTeam}: ${got} (esperado ${exp.want})`);
  }
  console.log(`\n${ok}/${expected.length} horários corretos em BRT`);
})();
