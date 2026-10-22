import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { Database } from '../database/database';
import type { CorrelatedRequest } from '../shared/correlation';
import { NotFoundError } from '../shared/errors';
import { assertUuid } from '../shared/validation';
import { parseWagerCommand } from './wager-command';
import { WagerTransactionStatus, type WagerTransaction } from './wager-transaction';
import { WagerTransactionRepository } from './wager-transaction.repository';
import { ProcessWagerUseCase } from './process-wager.use-case';

/** Status HTTP pelo resultado: o provedor decide reenviar sem interpretar texto. */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerUseCase) private readonly processWager: ProcessWagerUseCase,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(Database) private readonly db: Database,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: CorrelatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseWagerCommand(body, idempotencyKey);
    const result = await this.processWager.execute(command, { source: 'http', correlationId: req.correlationId });
    res.status(STATUS_CODE[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    const id = assertUuid(transactionId, 'transactionId');
    const tx = await this.db.read((em) => this.transactions.findById(em, id));
    if (!tx) throw new NotFoundError('Transaction', id);
    return toView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    const tx = await this.db.read((em) => this.transactions.findByExternalId(em, providerId, externalId));
    if (!tx) throw new NotFoundError('Transaction', `${providerId}:${externalId}`);
    return toView(tx);
  }
}

function toView(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
