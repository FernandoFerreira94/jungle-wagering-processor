import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isTransient } from '../database/pg-errors';
import {
  DomainError,
  IdempotencyConflictError,
  NotFoundError,
  TransientFailureError,
  ValidationError,
  WalletAlreadyExistsError,
} from './errors';
import type { JsonLogger } from './json-logger';

/**
 * Mapeamento único de erros → HTTP para todos os endpoints:
 * 400 payload inválido · 404 não encontrado · 409 conflito · 503 falha transitória · 500 inesperado.
 * (422 rejeição de negócio e 202 pendente são respostas normais do controller, não exceções.)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { correlationId?: string }>();
    const { status, body } = this.map(error);
    if (status === 503) response.setHeader('Retry-After', '1');
    if (status >= 500) {
      this.logger.error('request failed', { correlationId: request.correlationId, path: request.path, status, error });
    }
    response.status(status).json(body);
  }

  private map(error: unknown): { status: number; body: Record<string, unknown> } {
    if (error instanceof ValidationError) {
      return { status: 400, body: { error: 'VALIDATION_ERROR', message: error.message, details: error.details } };
    }
    if (error instanceof DomainError) {
      return { status: 400, body: { error: 'VALIDATION_ERROR', code: error.code, message: error.message } };
    }
    if (error instanceof NotFoundError) return { status: 404, body: { error: 'NOT_FOUND', message: error.message } };
    if (error instanceof WalletAlreadyExistsError) {
      return { status: 409, body: { error: 'WALLET_ALREADY_EXISTS', message: error.message } };
    }
    if (error instanceof IdempotencyConflictError) {
      return { status: 409, body: { error: 'IDEMPOTENCY_CONFLICT', message: error.message } };
    }
    if (error instanceof TransientFailureError || isTransient(error)) {
      return { status: 503, body: { error: 'TRANSIENT_FAILURE', message: 'Temporary failure, retry with the same Idempotency-Key' } };
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR';
      const details = error.getResponse();
      return { status, body: { error: code, message: error.message, ...(typeof details === 'object' ? details : {}) } };
    }
    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Unexpected error' } };
  }
}
