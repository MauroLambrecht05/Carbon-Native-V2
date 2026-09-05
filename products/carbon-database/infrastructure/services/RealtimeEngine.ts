// Realtime Engine: Manages WebSocket client connections, topic channels,
// and broadcasts Change Data Capture (CDC) events across table mutations.

export type DatabaseChangeEvent = "INSERT" | "UPDATE" | "DELETE";

export interface ChangeDataCapturePayload {
  readonly event: DatabaseChangeEvent;
  readonly schema: string;
  readonly table: string;
  readonly new: Record<string, unknown> | null;
  readonly old: Record<string, unknown> | null;
  readonly commitTimestamp: string;
}

export interface ClientSocket {
  readonly id: string;
  send(data: string): void;
}

export class RealtimeEngine {
  // Map<channelTopic, Set<ClientSocket>>
  private readonly subscriptions = new Map<string, Set<ClientSocket>>();
  // Map<socketId, Set<channelTopic>>
  private readonly socketSubscriptions = new Map<string, Set<string>>();

  // One instance, constructed once in composition and shared between
  // DatabaseEngine (which calls notifyDatabaseChange after every real
  // write) and the WebSocket server (which routes subscribe/unsubscribe
  // through it) — no singleton needed once both sides are wired
  // explicitly rather than reaching for a hidden global.

  handleConnect(socket: ClientSocket): void {
    this.socketSubscriptions.set(socket.id, new Set());
  }

  handleDisconnect(socket: ClientSocket): void {
    const subs = this.socketSubscriptions.get(socket.id);
    if (subs) {
      for (const topic of subs) {
        this.subscriptions.get(topic)?.delete(socket);
      }
    }
    this.socketSubscriptions.delete(socket.id);
  }

  subscribe(socket: ClientSocket, topic: string): void {
    let clients = this.subscriptions.get(topic);
    if (!clients) {
      clients = new Set();
      this.subscriptions.set(topic, clients);
    }
    clients.add(socket);

    let socketTopics = this.socketSubscriptions.get(socket.id);
    if (!socketTopics) {
      socketTopics = new Set();
      this.socketSubscriptions.set(socket.id, socketTopics);
    }
    socketTopics.add(topic);

    socket.send(
      JSON.stringify({
        type: "subscribed",
        topic,
        status: "ok",
      }),
    );
  }

  unsubscribe(socket: ClientSocket, topic: string): void {
    this.subscriptions.get(topic)?.delete(socket);
    this.socketSubscriptions.get(socket.id)?.delete(topic);
  }

  broadcast(topic: string, payload: ChangeDataCapturePayload): number {
    let notifiedCount = 0;
    const targets = new Set<ClientSocket>();

    // 1. Direct topic match: realtime:projectId:public:tableName
    const direct = this.subscriptions.get(topic);
    if (direct) {
      for (const s of direct) targets.add(s);
    }

    // 2. Wildcard project match: realtime:projectId:*
    const parts = topic.split(":");
    if (parts.length >= 2) {
      const wildcardProject = `${parts[0]}:${parts[1]}:*`;
      const wildcardSubscribers = this.subscriptions.get(wildcardProject);
      if (wildcardSubscribers) {
        for (const s of wildcardSubscribers) targets.add(s);
      }
    }

    // 3. Global wildcard match: *
    const globalWildcard = this.subscriptions.get("*");
    if (globalWildcard) {
      for (const s of globalWildcard) targets.add(s);
    }

    const message = JSON.stringify({
      type: "broadcast",
      topic,
      payload,
    });

    for (const client of targets) {
      try {
        client.send(message);
        notifiedCount++;
      } catch {
        // Socket may have disconnected abruptly
      }
    }

    return notifiedCount;
  }

  notifyDatabaseChange(
    projectId: string,
    table: string,
    event: DatabaseChangeEvent,
    newData: Record<string, unknown> | null,
    oldData: Record<string, unknown> | null = null,
  ): number {
    const topic = `realtime:${projectId}:public:${table}`;
    const payload: ChangeDataCapturePayload = {
      event,
      schema: "public",
      table,
      new: newData,
      old: oldData,
      commitTimestamp: new Date().toISOString(),
    };
    return this.broadcast(topic, payload);
  }

  clear(): void {
    this.subscriptions.clear();
    this.socketSubscriptions.clear();
  }
}
