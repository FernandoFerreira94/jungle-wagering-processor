// Ambiente isolado dos testes: banco e filas próprios, nunca os da aplicação.
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering_test';
process.env.QUEUE_PREFIX ??= 'test-';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
