import type { EventConsumerStateStore } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

export class InMemoryEventConsumerStateStore implements EventConsumerStateStore {
  private readonly cursors = new Map<string, number>();
  readonly deadLetters: Array<{ consumer: string; eventId: string; seq: number; error: string; createdAt: string }> =
    [];

  async getCursor(consumer: string): Promise<number> {
    return this.cursors.get(consumer) ?? 0;
  }

  async setCursor(consumer: string, seq: number): Promise<void> {
    this.cursors.set(consumer, seq);
  }

  async recordDeadLetter(input: {
    consumer: string;
    eventId: string;
    seq: number;
    error: string;
    createdAt: string;
  }): Promise<void> {
    this.deadLetters.push(input);
  }
}

// Postgres-backed consumer state (mig 0097) — one upsert per cursor move; dead letters append-only.
export class PgEventConsumerStateStore implements EventConsumerStateStore {
  constructor(private readonly client: SqlClient) {}

  async getCursor(consumer: string): Promise<number> {
    const res = await this.client.query<{ seq: number | string }>(
      "SELECT seq FROM everdict_event_cursors WHERE consumer = $1",
      [consumer],
    );
    return res.rows[0] ? Number(res.rows[0].seq) : 0;
  }

  async setCursor(consumer: string, seq: number): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_event_cursors (consumer, seq, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (consumer) DO UPDATE SET seq = $2, updated_at = now()`,
      [consumer, seq],
    );
  }

  async recordDeadLetter(input: {
    consumer: string;
    eventId: string;
    seq: number;
    error: string;
    createdAt: string;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_event_dead_letters (consumer, event_id, seq, error, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.consumer, input.eventId, input.seq, input.error, input.createdAt],
    );
  }
}
