-- PULL  PARA GIT LOCAL
git pull origin main
npm run migrate

-- SUBIR PARA GIT
git add .
git commit -m "Implementação de questionários dinâmicos e override de competência"
git push -u origin main

-- PULL  PARA GIT PRODUÇÃO
cd ~/htdocs/bolaopix.site
git pull origin main
npm run migrate
git log --oneline -5
pm2 flush bolaopix
pm2 restart bolaopix
pm2 logs bolaopix --lines 80