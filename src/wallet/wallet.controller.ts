import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import type { CorrelatedRequest } from '../shared/correlation';
import { ValidationError } from '../shared/errors';
import { Fields, assertUuid } from '../shared/validation';
import { WalletService } from './wallet.service';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: CorrelatedRequest) {
    const fields = new Fields(body);
    const playerId = fields.uuid('playerId');
    const initialBalance = fields.money('initialBalance');
    fields.assertValid();
    return this.wallets.create({ playerId, initialBalance: initialBalance! }, req.correlationId);
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wallets.get(assertUuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.wallets.ledger(assertUuid(walletId, 'walletId'), cursor, parseLimit(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Req() req: CorrelatedRequest) {
    return this.wallets.reconcile(assertUuid(walletId, 'walletId'), req.correlationId);
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError(['limit must be an integer between 1 and 200']);
  return limit;
}
