// RealtimeEngine's pub/sub is pure, in-process state (no Postgres, no S3)
// — the one engine in this product with no real backing store to wire up
// for a test, so it's still exercised directly here rather than only
// through the docker end-to-end pass. DatabaseEngine calling
// notifyDatabaseChange after a real write is verified there instead (see
// this product's README "Verifying the real backend" section) — that
// part now needs a live Postgres connection this file doesn't have.

import { describe, expect, mock, test } from "bun:test";
import { RealtimeEngine, type ClientSocket } from "../infrastructure/services/RealtimeEngine.ts";

describe("RealtimeEngine", () => {
  test("subscribes a client socket to a topic and receives a broadcast on that topic", () => {
    const realtime = new RealtimeEngine();
    const socket: ClientSocket = { id: "socket-1", send: mock(() => {}) };

    realtime.handleConnect(socket);
    realtime.subscribe(socket, "realtime:proj-1:public:messages");
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"subscribed"'));

    realtime.notifyDatabaseChange("proj-1", "messages", "INSERT", { id: "m1", content: "hi" }, null);
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"event":"INSERT"'));
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"content":"hi"'));
  });

  test("a socket subscribed to a DIFFERENT topic does not receive the broadcast", () => {
    const realtime = new RealtimeEngine();
    const socket: ClientSocket = { id: "socket-2", send: mock(() => {}) };

    realtime.handleConnect(socket);
    realtime.subscribe(socket, "realtime:proj-1:public:other_table");
    (socket.send as any).mockClear(); // drop the "subscribed" ack

    realtime.notifyDatabaseChange("proj-1", "messages", "INSERT", { id: "m1" }, null);
    expect(socket.send).not.toHaveBeenCalled();
  });

  test("UPDATE and DELETE broadcasts carry both old and new payloads", () => {
    const realtime = new RealtimeEngine();
    const socket: ClientSocket = { id: "socket-3", send: mock(() => {}) };
    realtime.handleConnect(socket);
    realtime.subscribe(socket, "realtime:proj-1:public:todos");

    realtime.notifyDatabaseChange("proj-1", "todos", "UPDATE", { id: "t1", done: true }, { id: "t1", done: false });
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"event":"UPDATE"'));
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"done":true'));

    realtime.notifyDatabaseChange("proj-1", "todos", "DELETE", null, { id: "t1", done: true });
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"event":"DELETE"'));
  });

  test("unsubscribe stops delivery; disconnect stops delivery for every topic the socket had", () => {
    const realtime = new RealtimeEngine();
    const a: ClientSocket = { id: "a", send: mock(() => {}) };
    const b: ClientSocket = { id: "b", send: mock(() => {}) };
    realtime.handleConnect(a);
    realtime.handleConnect(b);
    realtime.subscribe(a, "realtime:proj-1:public:logs");
    realtime.subscribe(b, "realtime:proj-1:public:logs");

    realtime.unsubscribe(a, "realtime:proj-1:public:logs");
    (a.send as any).mockClear();
    (b.send as any).mockClear();
    realtime.notifyDatabaseChange("proj-1", "logs", "INSERT", { id: "l1" }, null);
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).toHaveBeenCalled();

    realtime.handleDisconnect(b);
    (b.send as any).mockClear();
    realtime.notifyDatabaseChange("proj-1", "logs", "INSERT", { id: "l2" }, null);
    expect(b.send).not.toHaveBeenCalled();
  });

  test("a wildcard project subscription (realtime:proj:*) receives every table's broadcasts", () => {
    const realtime = new RealtimeEngine();
    const socket: ClientSocket = { id: "wild", send: mock(() => {}) };
    realtime.handleConnect(socket);
    realtime.subscribe(socket, "realtime:proj-1:*");
    (socket.send as any).mockClear();

    realtime.notifyDatabaseChange("proj-1", "any_table_at_all", "INSERT", { id: "x" }, null);
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"table":"any_table_at_all"'));
  });
});
