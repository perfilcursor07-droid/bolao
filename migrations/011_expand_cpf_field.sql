-- Expandir campo cpf para aceitar chaves PIX de qualquer tipo (email, telefone, aleatória)
ALTER TABLE users MODIFY COLUMN cpf VARCHAR(255) NULL;
