import { describe, expect, test, beforeEach } from "bun:test";
import { SuggestionVoteStore } from "../../../presentation/components/community/suggestion-vote-store.ts";

describe("SuggestionVoteStore", () => {
  const store = SuggestionVoteStore.getInstance();

  beforeEach(() => {
    store.clear();
  });

  test("records an upvote and calculates count", () => {
    const result = store.recordVote("msg-1", "user-1", "up");
    expect(result.upVotes).toBe(1);
    expect(result.downVotes).toBe(0);
    expect(result.userVote).toBe("up");
  });

  test("toggles off an existing upvote on second click", () => {
    store.recordVote("msg-1", "user-1", "up");
    const toggled = store.recordVote("msg-1", "user-1", "up");

    expect(toggled.upVotes).toBe(0);
    expect(toggled.downVotes).toBe(0);
    expect(toggled.userVote).toBeNull();
  });

  test("switches from downvote to upvote", () => {
    store.recordVote("msg-1", "user-1", "down");
    const switched = store.recordVote("msg-1", "user-1", "up");

    expect(switched.upVotes).toBe(1);
    expect(switched.downVotes).toBe(0);
    expect(switched.userVote).toBe("up");
  });

  test("handles multiple users voting on the same message", () => {
    store.recordVote("msg-1", "user-1", "up");
    store.recordVote("msg-1", "user-2", "up");
    store.recordVote("msg-1", "user-3", "down");

    const counts = store.getCounts("msg-1");
    expect(counts.upVotes).toBe(2);
    expect(counts.downVotes).toBe(1);
  });
});
