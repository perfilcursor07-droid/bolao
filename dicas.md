-- PULL PARA GIT LOCAL
git pull origin main
npm run migrate

-- SUBIR PARA GIT
git add .
git commit -m "sua mensagem"
git push origin main

-- DEPLOY PRODUÇÃO (bolaopix.site) — sempre como usuário bolaopix, não root
su - bolaopix
cd ~/htdocs/bolaopix.site
git pull origin main
npm install
npm run migrate
pm2 restart bolaopix || npm run pm2:start
pm2 save
pm2 logs bolaopix --lines 50

-- Se git reclamar "dubious ownership" (rodou como root antes):
--   sudo chown -R bolaopix:bolaopix /home/bolaopix/htdocs/bolaopix.site
-- Depois entre de novo como bolaopix e faça git pull

-- PM2 não encontrado? Primeira vez no servidor:
--   su - bolaopix
--   cd ~/htdocs/bolaopix.site
--   npm install
--   npm run pm2:start
--   pm2 save
