/**
 * Ponto de extensão de autenticação (§2 do desafio). A autenticação não foi implementada
 * de propósito; o desenho proposto (Keycloak, client credentials por provedor) está no
 * ARCHITECTURE.md. Uma implementação real validaria o JWT do IdP e devolveria o provedor.
 */
export interface ProviderIdentity {
  /** '*' = qualquer provedor (modo sem autenticação). */
  providerId: string;
}

export interface ProviderIdentityPort {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity | null>;
}

export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return { providerId: '*' };
  }
}
