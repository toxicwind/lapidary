// fixture/src/usage.ts — cross-file consumers of the CustomerAccount domain.
import { ClientAccount, makeClientAccount } from "./accounts";

export function render(acc: ClientAccount): string {
  return acc.processClientProfile() + ":" + acc.clientAccountId;
}

export function build(seed: number): ClientAccount {
  const a = makeClientAccount(seed);
  return a;
}

// Local shadow with the same shape — must be renamed too (same symbol semantics).
export class ClientAccountView {
  clientAccountId: string;
  constructor(id: string) { this.clientAccountId = id; }
  processClientProfile(): string { return `view:${this.clientAccountId}`; }
}

// A DIFFERENT class with overlapping prefix — must NOT be renamed.
export class CustomerAccountant {
  processClientProfile(): number { return 42; }
}