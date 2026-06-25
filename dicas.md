-- PULL  PARA GIT LOCAL
git pull origin main
npm run migrate

-- SUBIR PARA GIT
git add .
git commit -m "Implementação de questionários dinâmicos e override de competência"
git push -u origin main

-- PULL PARA GIT PRODUÇÃO (CloudPanel)
-- IMPORTANTE: use o usuário do site, NÃO root
su - bolaopix
cd /home/bolaopix/htdocs/bolaopix.site
git pull origin main
npm run migrate
git log --oneline -5
pm2 list
pm2 restart bolaopix
pm2 logs bolaopix --lines 80

-- Se "bolaopix not found" na primeira vez:
cd /home/bolaopix/htdocs/bolaopix.site
npm run pm2:start
pm2 save

-- Se git der "dubious ownership" como root:
-- Opção correta: su - bolaopix e rodar git de novo
-- Opção alternativa (só se insistir em root):
-- git config --global --add safe.directory /home/bolaopix/htdocs/bolaopix.site
