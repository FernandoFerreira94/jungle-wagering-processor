import type { NextFunction, Request, Response } from 'express';
import { newId } from './ids';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE = /^[\w.:-]{1,128}$/;

/** Propaga (ou cria) o correlationId de cada requisição. */
export function correlationMiddleware(req: Request & { correlationId?: string }, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  req.correlationId = incoming && SAFE.test(incoming) ? incoming : newId();
  res.setHeader(CORRELATION_HEADER, req.correlationId);
  next();
}

export type CorrelatedRequest = Request & { correlationId: string };
