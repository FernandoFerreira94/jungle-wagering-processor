import './test-env';
import type { Subprocess } from 'bun';

export interface Instance {
  url: string;
  proc: Subprocess;
  /** SIGKILL por padrão: simula queda abrupta. */
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

/** Todo processo iniciado pelos testes; mortos na saída, mesmo se um teste falhar no meio. */
const spawned = new Set<Subprocess>();
process.on('exit', () => {
  for (const proc of spawned) if (proc.exitCode === null) proc.kill('SIGKILL');
});

/** Sobe N processos reais do serviço (`bun src/main.ts`) apontando para o banco e as filas de teste. */
export async function startInstances(count: number, env: Record<string, string> = {}): Promise<Instance[]> {
  const instances = Array.from({ length: count }, () => spawnInstance(env));
  try {
    await Promise.all(instances.map((instance) => waitReady(instance)));
  } catch (error) {
    // Uma instância que não subiu não pode deixar as outras órfãs consumindo as filas de teste.
    await Promise.all(instances.map((instance) => instance.kill()));
    throw error;
  }
  return instances;
}

/** Porta livre escolhida pelo sistema operacional. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function spawnInstance(env: Record<string, string>): Instance {
  const port = freePort();
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: process.env.TEST_LOG ? 'info' : 'error', ...env },
    stdout: process.env.TEST_LOG ? 'inherit' : 'ignore',
    stderr: 'inherit',
  });
  spawned.add(proc);
  void proc.exited.then(() => spawned.delete(proc));
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
