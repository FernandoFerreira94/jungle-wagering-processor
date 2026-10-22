import { ValidationError } from './errors';
import { Money, type MoneyProps } from './money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Coleta erros de um payload desconhecido e só devolve valores já validados. */
export class Fields {
  readonly errors: string[] = [];

  constructor(private readonly body: unknown) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) this.errors.push('body must be a JSON object');
  }

  private raw(name: string): unknown {
    return (this.body as Record<string, unknown> | null)?.[name];
  }

  text(name: string, { optional = false, max = 200 } = {}): string {
    const value = this.raw(name);
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || value.length > max) {
      this.errors.push(`${name} must be a non-empty string without surrounding spaces (max ${max})`);
      return '';
    }
    return value;
  }

  uuid(name: string): string {
    const value = this.raw(name);
    if (typeof value !== 'string' || !UUID.test(value)) {
      this.errors.push(`${name} must be a UUID`);
      return '';
    }
    return value.toLowerCase();
  }

  money(name: string): Money | undefined {
    try {
      return Money.from(this.raw(name) as MoneyProps);
    } catch (error) {
      this.errors.push(`${name}: ${(error as Error).message}`);
      return undefined;
    }
  }

  oneOf<T extends string>(name: string, allowed: readonly T[]): T {
    const value = this.raw(name);
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.errors.push(`${name} must be one of ${allowed.join(', ')}`);
      return allowed[0] as T;
    }
    return value as T;
  }

  assertValid(): void {
    if (this.errors.length > 0) throw new ValidationError(this.errors);
  }
}

export function assertUuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new ValidationError([`${name} must be a UUID`]);
  return value.toLowerCase();
}
