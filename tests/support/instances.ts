import './test-env';
import type { Subprocess } from 'bun';

export interface Instance {
  url: string;
  proc: Subprocess;
  /** SIGKILL por padrão: simula queda abrupta. */
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

let nextPort = 20_000 + Math.floor(Math.random() * 20_000);

/** Sobe N processos reais do serviço (`bun src/main.ts`) apontando para o banco e as filas de teste. */
export async function startInstances(count: number, env: Record<string, string> = {}): Promise<Instance[]> {
  const instances = Array.from({ length: count }, () => spawnInstance(env));
  await Promise.all(instances.map((instance) => waitReady(instance)));
  return instances;
}

function spawnInstance(env: Record<string, string>): Instance {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: process.env.TEST_LOG ? 'info' : 'error', ...env },
    stdout: process.env.TEST_LOG ? 'inherit' : 'ignore',
    stderr: 'inherit',
  });
  return {
    url: `http://127.0.0.1:${port}`,
    proc,
    async kill(signal = 'SIGKILL') {
      if (proc.exitCode === null) proc.kill(signal);
      return proc.exited;
    },
  };
}

async function waitReady(instance: Instance, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.proc.exitCode !== null) throw new Error(`instance ${instance.url} exited early`);
    try {
      if ((await fetch(`${instance.url}/health/ready`)).ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance ${instance.url} not ready`);
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.map((instance) => instance.kill('SIGTERM')));
}

/** Espera uma condição assíncrona ficar verdadeira. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 30_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}
