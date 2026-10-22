import type { JsonLogger } from './json-logger';

/**
 * Executa `tick` em intervalo fixo, sem sobreposição, e para de forma limpa (espera o tick em andamento).
 * Se o tick devolver um número > 0 (havia trabalho), roda de novo na hora em vez de esperar o intervalo.
 */
export class PollingLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<unknown>;
  private stopped = true;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<unknown>,
    private readonly logger: JsonLogger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      let busy = false;
      this.current = this.tick()
        .then((result) => {
          busy = typeof result === 'number' && result > 0;
        })
        .catch((error) => this.logger.error(`${this.name} tick failed`, { error }))
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) this.schedule(busy ? 0 : this.intervalMs);
        });
    }, delay);
  }
}
