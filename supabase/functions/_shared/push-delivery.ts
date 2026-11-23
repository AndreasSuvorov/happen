export type PushOutcome = "accepted" | "expired" | "failed";

export interface SubscriptionState {
  id: string;
  failed_count: number;
}

export async function recordPushOutcome(
  subscription: SubscriptionState,
  outcome: PushOutcome,
  stamp: string,
  store: {
    remove: (id: string) => Promise<void>;
    update: (id: string, values: { failed_count: number; last_success_at?: string }) => Promise<void>;
  },
): Promise<void> {
  if (outcome === "expired") {
    await store.remove(subscription.id);
  } else if (outcome === "accepted") {
    await store.update(subscription.id, { failed_count: 0, last_success_at: stamp });
  } else {
    await store.update(subscription.id, { failed_count: subscription.failed_count + 1 });
  }
}

export function pushFailure(status: number | undefined): PushOutcome {
  return status === 404 || status === 410 ? "expired" : "failed";
}
