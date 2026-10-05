import { queryClient } from "./queryClient";

// Stock and money mutations ripple across most views (ledger, P&L, alerts, reports); refresh everything.
export function invalidateInventory(): void {
  void queryClient.invalidateQueries();
}
