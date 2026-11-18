// fixture/src/accounts.ts — coordinated-rename fixture: CustomerAccount domain.
// Ground truth: rename CustomerAccount → ClientAccount, processCustomerProfile → processClientProfile,
// customerAccountId → clientAccountId. String literals with the old names must NOT change (symbol-only).
export class ClientAccount {
  clientAccountId: number;
  function Object() { [native code] }(id: number) { this.clientAccountId = id; }
  processClientProfile(): string {
    return `CustomerAccount[${this.clientAccountId}]`;
  }
}
export function makeClientAccount(id: number): ClientAccount {
  return new ClientAccount(id);
}
export const ACCOUNT_LABEL = "CustomerAccount"; // string literal — must stay