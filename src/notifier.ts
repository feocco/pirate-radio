import type { ArticleNotification } from "./notifications.js";

const NOTIFY_POST_TIMEOUT_MS = 10_000;

export interface Notifier {
  send(notification: ArticleNotification): Promise<void>;
}

export interface HomelabFunctionsNotifierOptions {
  serviceUrl?: string;
  token?: string;
}

export class HomelabFunctionsNotifier implements Notifier {
  constructor(private readonly options: HomelabFunctionsNotifierOptions) {}

  async send(notification: ArticleNotification): Promise<void> {
    if (!this.options.serviceUrl || !this.options.token) {
      console.log(`[pirate-radio] notification dry-run: ${notification.message}`);
      return;
    }

    const response = await fetch(new URL("/v1/notify/joe", this.options.serviceUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(NOTIFY_POST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`homelab-functions notify failed: ${response.status} ${await response.text()}`);
    }
  }
}
