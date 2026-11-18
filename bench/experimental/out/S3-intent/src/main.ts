// fixture/src/main.ts — entrypoint, JSON serialization of the domain.
import { ClientAccount } from "./accounts";
import { render, build, ClientAccountView, CustomerAccountant } from "./usage";

const acc = build(7);
const view = new ClientAccountView("v1");
const accountant = new CustomerAccountant();

export function dump(): string {
  return JSON.stringify({
    rendered: render(acc),
    view: view.processClientProfile(),
    accountant: accountant.processClientProfile(),
    label: "CustomerAccount", // string literal — must stay
    type: ClientAccount.name,
  });
}