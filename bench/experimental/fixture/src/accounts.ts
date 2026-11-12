// fixture/src/accounts.ts — coordinated-rename fixture: CustomerAccount domain.
// Ground truth: rename CustomerAccount → ClientAccount, processCustomerProfile → processClientProfile,
// customerAccountId → clientAccountId. String literals with the old names must NOT change (symbol-only).
export class CustomerAccount {
  customerAccountId: number;
  constructor(id: number) { this.customerAccountId = id; }
  processCustomerProfile(): string {
    return `CustomerAccount[${this.customerAccountId}]`;
  }
}
export function makeCustomerAccount(id: number): CustomerAccount {
  return new CustomerAccount(id);
}
export const ACCOUNT_LABEL = "CustomerAccount"; // string literal — must stay