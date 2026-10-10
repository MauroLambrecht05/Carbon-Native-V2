import type {
  Page,
  PageRequest,
} from "../../../presentation/framework/services/contracts";
import { Refusal } from "./access";

export function paginate<T extends { id: string; name?: string }>(
  items: readonly T[],
  request: PageRequest = {},
  visibility: string,
): Page<T> {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Refusal(
      "validation",
      "Page size must be an integer from 1 to 100.",
    );
  if (request.sort && !["id", "name"].includes(request.sort))
    throw new Refusal("validation", "Unsupported sort.");
  const name = request.filter?.name?.toLowerCase() ?? "";
  const sorted = items
    .filter((item) => !name || item.name?.toLowerCase().includes(name))
    .sort((a, b) => {
      const first = request.sort === "name" ? (a.name ?? a.id) : a.id;
      const second = request.sort === "name" ? (b.name ?? b.id) : b.id;
      return first < second
        ? -1
        : first > second
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0;
    });
  // A cursor is opaque to consumers and bound to principal, scope, sort and filters.
  const query = JSON.stringify([visibility, request.sort ?? "id", name, limit]);
  let start = 0;
  if (request.cursor) {
    try {
      const cursor = JSON.parse(decodeURIComponent(request.cursor));
      if (cursor.query !== query || typeof cursor.after !== "string")
        throw new Error();
      const index = sorted.findIndex((item) => item.id === cursor.after);
      if (index < 0) throw new Error();
      start = index + 1;
    } catch {
      throw new Refusal(
        "validation",
        "Invalid or stale cursor. Return to the first page.",
      );
    }
  }
  const page = sorted.slice(start, start + limit);
  return {
    items: page,
    total: sorted.length,
    nextCursor:
      start + limit < sorted.length
        ? encodeURIComponent(JSON.stringify({ query, after: page.at(-1)!.id }))
        : null,
  };
}
