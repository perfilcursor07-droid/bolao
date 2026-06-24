# Bolão Online ⚽

Sistema de bolão online com pagamento PIX via PagBank, perfis de administrador e usuário, e busca automática de resultados de jogos.

## Funcionalidades

- **Administrador**: cadastra jogos, define valor da aposta, informa resultado manualmente ou via API
- **Usuário**: registra-se, aposta no placar exato, paga via PIX (QR Code)
- **Pagamento PIX**: integração completa com PagBank (criar pedido, webhook, polling)
- **Resultados automáticos**: busca via API-Football a cada 5 minutos
- **Divisão de prêmio**: se houver mais de um ganhador, divide automaticamente

## Requisitos

- Node.js 18+
- MySQL (WAMP)
- Conta PagBank com token de API
- (Opcional) Chave API-Football para resultados automáticos

## Instalação

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
copy .env.example .env
# Edite o .env com suas credenciais

# 3. Rodar migrations (cria banco + tabelas + admin)
npm run migrate

# 4. Iniciar servidor
npm start
# ou em modo desenvolvimento:
npm run dev
```

Acesse: **http://localhost:3000**

### Credenciais padrão do Admin
- **E-mail:** admin@bolao.com
- **Senha:** admin123

## Configuração (.env)

```env
PORT=3000
APP_URL=http://localhost:3000
SESSION_SECRET=sua-chave-secreta

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=bolao_online

PAGBANK_TOKEN=seu-token-bearer
PAGBANK_EMAIL=seu-email@pagbank.com
PIX_ENVIRONMENT=sandbox
WEBHOOK_URL=https://seudominio.com.br/api/payment/webhook/pagbank

FOOTBALL_API_KEY=sua-chave
FOOTBALL_API_URL=https://v3.football.api-sports.io
```

## Fluxo do Sistema

1. Admin cadastra jogo com times, data, valor e (opcional) ID da API-Football
2. Usuário escolhe o placar e gera cobrança PIX
3. PagBank confirma pagamento via webhook ou polling (a cada 2 min)
4. Aposta é registrada e valor vai para o prêmio acumulado
5. Após o jogo, sistema busca resultado automaticamente
6. Ganhadores com placar exato dividem o prêmio igualmente

## Estrutura

```
├── migrations/          # SQL migrations + runner
├── src/
│   ├── config/          # Conexão MySQL
│   ├── middleware/       # Autenticação
│   ├── routes/          # Rotas (auth, admin, games, payment)
│   └── services/        # PagBank, API futebol, prêmios, cron
├── views/               # Templates EJS
├── public/css/          # Estilos
└── server.js            # Entry point
```

## Webhook PagBank

Para produção, configure `WEBHOOK_URL` com HTTPS público. O endpoint é:

```
POST /api/payment/webhook/pagbank
```

## API de Futebol

Cadastre-se em [api-football.com](https://www.api-football.com) para obter a chave. Ao cadastrar um jogo, informe o `api_match_id` (fixture ID) para busca automática de resultados.
