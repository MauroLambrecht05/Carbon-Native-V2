import { database } from "./database.ts";

export interface SupportTicket {
  readonly threadId: string;
  readonly guildId: string;
  readonly openerId: string;
  readonly subject: string;
  readonly category: string;
  readonly status: "open" | "closed";
  readonly claimedBy?: string;
  readonly createdAt: Date;
  readonly closedAt?: Date;
}

interface TicketRow {
  thread_id: string;
  guild_id: string;
  opener_id: string;
  subject: string;
  category: string;
  status: "open" | "closed";
  claimed_by: string | null;
  created_at: string;
  closed_at: string | null;
}

function mapTicket(row: TicketRow): SupportTicket {
  return {
    threadId: row.thread_id,
    guildId: row.guild_id,
    openerId: row.opener_id,
    subject: row.subject,
    category: row.category,
    status: row.status,
    claimedBy: row.claimed_by ?? undefined,
    createdAt: new Date(row.created_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
  };
}

export class TicketStore {
  private static instance: TicketStore | undefined;

  static getInstance(): TicketStore {
    this.instance ??= new TicketStore();
    return this.instance;
  }

  findOpenForMember(guildId: string, openerId: string): SupportTicket | undefined {
    const row = database().query(`
      SELECT * FROM support_tickets WHERE guild_id = $guildId AND opener_id = $openerId AND status = 'open'
    `).get({ guildId, openerId }) as TicketRow | null;
    return row ? mapTicket(row) : undefined;
  }

  get(threadId: string): SupportTicket | undefined {
    const row = database().query("SELECT * FROM support_tickets WHERE thread_id = $threadId")
      .get({ threadId }) as TicketRow | null;
    return row ? mapTicket(row) : undefined;
  }

  create(ticket: Omit<SupportTicket, "status" | "createdAt">): SupportTicket {
    const createdAt = new Date();
    database().query(`
      INSERT INTO support_tickets(thread_id, guild_id, opener_id, subject, category, status, claimed_by, created_at)
      VALUES ($threadId, $guildId, $openerId, $subject, $category, 'open', $claimedBy, $createdAt)
    `).run({
      threadId: ticket.threadId,
      guildId: ticket.guildId,
      openerId: ticket.openerId,
      subject: ticket.subject,
      category: ticket.category,
      claimedBy: ticket.claimedBy ?? null,
      createdAt: createdAt.toISOString(),
    });
    return { ...ticket, status: "open", createdAt };
  }

  claim(threadId: string, staffId: string): "claimed" | "already-claimed" | "missing" {
    const ticket = this.get(threadId);
    if (!ticket) return "missing";
    if (ticket.claimedBy) return "already-claimed";
    database().query("UPDATE support_tickets SET claimed_by = $staffId WHERE thread_id = $threadId AND claimed_by IS NULL")
      .run({ threadId, staffId });
    return "claimed";
  }

  close(threadId: string): boolean {
    const result = database().query(`
      UPDATE support_tickets SET status = 'closed', closed_at = $closedAt WHERE thread_id = $threadId AND status = 'open'
    `).run({ threadId, closedAt: new Date().toISOString() });
    return result.changes > 0;
  }

  clear(): void {
    database().exec("DELETE FROM support_tickets");
  }
}
