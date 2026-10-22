import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { PROVIDER_IDENTITY } from '../tokens';
import type { ProviderIdentityPort } from './provider-identity.port';

/** Aplicado aos endpoints de negócio; nunca aos de health. Hoje delega para o adaptador no-op. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { provider?: unknown }>();
    const provider = await this.identity.authenticate(request.headers);
    if (!provider) throw new UnauthorizedException();
    request.provider = provider;
    return true;
  }
}
