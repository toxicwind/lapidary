// fixture/src/main.ts — entrypoint, JSON serialization of the domain.
import { CustomerAccount } from "./accounts";
import { render, build, CustomerAccountView, CustomerAccountant } from "./usage";

const acc = build(7);
const view = new CustomerAccountView("v1");
const accountant = new CustomerAccountant();

export function dump(): string {
  return JSON.stringify({
    rendered: render(acc),
    view: view.processCustomerProfile(),
    accountant: accountant.processCustomerProfile(),
    label: "CustomerAccount", // string literal — must stay
    type: CustomerAccount.name,
  });
}