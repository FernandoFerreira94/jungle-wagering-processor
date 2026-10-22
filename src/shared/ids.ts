/** UUID v7: único e ordenável pelo tempo, bom para chaves primárias. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
