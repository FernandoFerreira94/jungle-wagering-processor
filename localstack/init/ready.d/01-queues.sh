#!/bin/sh
# Cria as filas da aplicação ("") e as filas isoladas dos testes ("test-").
set -e
for prefix in "" "test-"; do
  dlq="${prefix}wager-transactions-dlq.fifo"
  awslocal sqs create-queue --queue-name "$dlq" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/$dlq" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  awslocal sqs create-queue --queue-name "${prefix}wager-transactions.fifo" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null
  awslocal sqs create-queue --queue-name "${prefix}wager-events.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
done
echo "queues ready"
