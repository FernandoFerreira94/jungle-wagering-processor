import { CurrencyMismatchError, DomainError, InsufficientFundsError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Aggregate root: toda mudança de saldo devolve o lançamento correspondente. */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('INVALID_WALLET', 'Initial balance cannot be negative');
    if (props.initialBalance.minor > Money.MAX_MINOR) throw new DomainError('BALANCE_LIMIT_EXCEEDED', 'Initial balance exceeds the supported limit');
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lançamento de abertura: registra no ledger o saldo inicial que a wallet já nasce tendo. */
  openingEntry(transactionId: string): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) throw new InsufficientFundsError();
    return this.move(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canCredit(money)) throw new DomainError('BALANCE_LIMIT_EXCEEDED', 'Balance exceeds the supported limit');
    return this.move(LedgerDirection.Credit, money, transactionId, at);
  }

  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.add(money).minor <= Money.MAX_MINOR;
  }

  apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, transactionId, at)
      : this.credit(money, transactionId, at);
  }

  private move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
