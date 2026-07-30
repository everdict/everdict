// Durable consumer state (event-plumbing.md E1): the cursor is the correctness path (push is only a latency
// nudge), so it persists per consumer; a dead letter parks a poison event visibly and lets the cursor move on.
export interface EventConsumerStateStore {
  getCursor(consumer: string): Promise<number>;
  setCursor(consumer: string, seq: number): Promise<void>;
  recordDeadLetter(input: {
    consumer: string;
    eventId: string;
    seq: number;
    error: string;
    createdAt: string;
  }): Promise<void>;
}
