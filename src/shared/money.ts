import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 100n;

/**
 * Valor monetário exato e imutável. Internamente guarda centavos em `bigint`;
 * nos contratos é sempre uma string decimal com 2 casas.
 */
export class Money {
  /** Limite por valor/saldo, compatível com NUMERIC(20,2). Totais internos podem ser maiores. */
  static readonly MAX_MINOR = 10n ** 20n - 1n;
  private constructor(
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  /** Entrada de contrato: rejeita negativos, mais de 2 casas e formatos ambíguos. Nunca arredonda. */
  static from(props: MoneyProps): Money {
    const money = Money.parse(props);
    if (money.minor > Money.MAX_MINOR) throw new InvalidMoneyError('amount exceeds the supported limit');
    return money;
  }

  private static parse(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string') throw new InvalidMoneyError('amount must be a decimal string');
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match || match[0] !== props.amount) throw new InvalidMoneyError('Invalid decimal amount');
    const units = BigInt(match[1] as string);
    const cents = BigInt((match[2] ?? '').padEnd(2, '0'));
    return new Money(units * SCALE + cents, Money.currencyOf(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.currencyOf(currency));
  }

  static fromMinor(minor: bigint, currency: string): Money {
    return new Money(minor, Money.currencyOf(currency));
  }

  /** Reidrata o valor gravado no banco (NUMERIC como string, pode ser negativo só em diferenças). */
  static fromDecimal(amount: string, currency: string): Money {
    const negative = amount.startsWith('-');
    const money = Money.parse({ amount: negative ? amount.slice(1) : amount, currency });
    return negative ? money.negate() : money;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toDecimal(), currency: this.currency };
  }

  /** Valor decimal com 2 casas, pronto para coluna NUMERIC(20,2). */
  toDecimal(): string {
    const sign = this.minor < 0n ? '-' : '';
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const cents = (abs % SCALE).toString().padStart(2, '0');
    return `${sign}${abs / SCALE}.${cents}`;
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static currencyOf(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency: "${currency}"`);
    }
    return currency;
  }
}
