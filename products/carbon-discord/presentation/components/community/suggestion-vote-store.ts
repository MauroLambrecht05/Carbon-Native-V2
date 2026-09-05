// Tracks community suggestion votes per message to ensure 1 vote per user,
// support vote toggling, and live counter updates.

export type VoteType = "up" | "down";

interface SuggestionVoteState {
  userVotes: Map<string, VoteType>;
}

export class SuggestionVoteStore {
  private static instance: SuggestionVoteStore;
  private readonly store = new Map<string, SuggestionVoteState>();

  static getInstance(): SuggestionVoteStore {
    if (!SuggestionVoteStore.instance) {
      SuggestionVoteStore.instance = new SuggestionVoteStore();
    }
    return SuggestionVoteStore.instance;
  }

  recordVote(
    messageId: string,
    userId: string,
    type: VoteType,
  ): { upVotes: number; downVotes: number; userVote: VoteType | null } {
    let state = this.store.get(messageId);
    if (!state) {
      state = { userVotes: new Map() };
      this.store.set(messageId, state);
    }

    const currentVote = state.userVotes.get(userId);
    let newVote: VoteType | null = null;

    if (currentVote === type) {
      // Toggle off existing vote
      state.userVotes.delete(userId);
      newVote = null;
    } else {
      // Cast new vote or switch vote
      state.userVotes.set(userId, type);
      newVote = type;
    }

    let upVotes = 0;
    let downVotes = 0;
    for (const v of state.userVotes.values()) {
      if (v === "up") upVotes++;
      else if (v === "down") downVotes++;
    }

    return { upVotes, downVotes, userVote: newVote };
  }

  getCounts(messageId: string): { upVotes: number; downVotes: number } {
    const state = this.store.get(messageId);
    if (!state) return { upVotes: 0, downVotes: 0 };

    let upVotes = 0;
    let downVotes = 0;
    for (const v of state.userVotes.values()) {
      if (v === "up") upVotes++;
      else if (v === "down") downVotes++;
    }
    return { upVotes, downVotes };
  }

  clear(): void {
    this.store.clear();
  }
}
