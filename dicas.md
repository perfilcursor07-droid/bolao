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
pm2 restart bolaopix --update-env
pm2 logs bolaopix --lines 80

-- Erro 429 football-data.org (limite 10 req/min):
-- O cron agora sincroniza no máximo 4 jogos a cada 10min, só jogos "closed" na janela de horário.
-- Evite abrir a home/admin em loop; após deploy os erros 429 devem parar.

-- Se "bolaopix not found" na primeira vez:
cd /home/bolaopix/htdocs/bolaopix.site
npm run pm2:start
pm2 save

-- Se git der "dubious ownership" como root:
-- Opção correta: su - bolaopix e rodar git de novo
-- Opção alternativa (só se insistir em root):
-- git config --global --add safe.directory /home/bolaopix/htdocs/bolaopix.site
