// fixture/src/usage.ts — cross-file consumers of the CustomerAccount domain.
import { CustomerAccount, makeCustomerAccount } from "./accounts";

export function render(acc: CustomerAccount): string {
  return acc.processCustomerProfile() + ":" + acc.customerAccountId;
}

export function build(seed: number): CustomerAccount {
  const a = makeCustomerAccount(seed);
  return a;
}

// Local shadow with the same shape — must be renamed too (same symbol semantics).
export class CustomerAccountView {
  customerAccountId: string;
  constructor(id: string) { this.customerAccountId = id; }
  processCustomerProfile(): string { return `view:${this.customerAccountId}`; }
}

// A DIFFERENT class with overlapping prefix — must NOT be renamed.
export class CustomerAccountant {
  processCustomerProfile(): number { return 42; }
}