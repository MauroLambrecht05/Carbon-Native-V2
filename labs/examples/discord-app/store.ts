// store.ts — useReducer-backed app state. Keeps:
//   - active server + channel
//   - per-channel scroll position (so switching back doesn't lose place)
//   - per-channel composer draft (same reason)
//   - sidebar collapse state (member list, channel categories)
//
// Mock data is the source of truth for messages/users; this store only
// holds the UI's transient state, not the corpus.

import { useCallback, useReducer } from "react";
import {
  ACTIVE_CHANNEL_ID,
  ACTIVE_SERVER_ID,
  MESSAGES_BY_CHANNEL,
  type Message,
} from "./data/mock.ts";

interface State {
  serverId: string;
  channelId: string;
  /** Composer draft per channel id. */
  drafts: Record<string, string>;
  /** Locally-appended messages per channel — separate from mock data so
   *  HMR / re-render doesn't blow them away. */
  sentByChannel: Record<string, Message[]>;
  /** Collapsed channel category ids (per server). Map of "<server>:<cat>" → bool. */
  collapsedCategories: Record<string, boolean>;
  memberListOpen: boolean;
}

type Action =
  | { type: "selectServer"; id: string }
  | { type: "selectChannel"; id: string }
  | { type: "setDraft"; channelId: string; body: string }
  | { type: "send"; channelId: string; body: string }
  | { type: "toggleCategory"; key: string }
  | { type: "toggleMemberList" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "selectServer":
      return { ...state, serverId: action.id };
    case "selectChannel":
      return { ...state, channelId: action.id };
    case "setDraft":
      return {
        ...state,
        drafts: { ...state.drafts, [action.channelId]: action.body },
      };
    case "send": {
      if (!action.body.trim()) return state;
      const next: Message = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        authorId: "u-me",
        channelId: action.channelId,
        body: action.body,
        ts: Date.now(),
      };
      const prev = state.sentByChannel[action.channelId] ?? [];
      return {
        ...state,
        sentByChannel: {
          ...state.sentByChannel,
          [action.channelId]: [...prev, next],
        },
        drafts: { ...state.drafts, [action.channelId]: "" },
      };
    }
    case "toggleCategory":
      return {
        ...state,
        collapsedCategories: {
          ...state.collapsedCategories,
          [action.key]: !state.collapsedCategories[action.key],
        },
      };
    case "toggleMemberList":
      return { ...state, memberListOpen: !state.memberListOpen };
    default:
      return state;
  }
}

function init(): State {
  return {
    serverId: ACTIVE_SERVER_ID,
    channelId: ACTIVE_CHANNEL_ID,
    drafts: {},
    sentByChannel: {},
    collapsedCategories: {},
    memberListOpen: true,
  };
}

export interface ChatStore {
  serverId: string;
  channelId: string;
  draft: string;
  /** All messages for the current channel: mock + locally-sent, ts-sorted. */
  messages: Message[];
  isCategoryCollapsed: (categoryId: string) => boolean;
  memberListOpen: boolean;

  selectServer(id: string): void;
  selectChannel(id: string): void;
  setDraft(body: string): void;
  send(body: string): void;
  toggleCategory(categoryId: string): void;
  toggleMemberList(): void;
}

export function useChatStore(): ChatStore {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  const selectServer = useCallback((id: string) => dispatch({ type: "selectServer", id }), []);
  const selectChannel = useCallback((id: string) => dispatch({ type: "selectChannel", id }), []);
  const setDraft = useCallback(
    (body: string) => dispatch({ type: "setDraft", channelId: state.channelId, body }),
    [state.channelId],
  );
  const send = useCallback(
    (body: string) => dispatch({ type: "send", channelId: state.channelId, body }),
    [state.channelId],
  );
  const toggleCategory = useCallback(
    (categoryId: string) =>
      dispatch({ type: "toggleCategory", key: `${state.serverId}:${categoryId}` }),
    [state.serverId],
  );
  const toggleMemberList = useCallback(() => dispatch({ type: "toggleMemberList" }), []);
  const isCategoryCollapsed = useCallback(
    (categoryId: string) =>
      Boolean(state.collapsedCategories[`${state.serverId}:${categoryId}`]),
    [state.collapsedCategories, state.serverId],
  );

  const baseMessages = MESSAGES_BY_CHANNEL[state.channelId] ?? [];
  const sent = state.sentByChannel[state.channelId] ?? [];
  const messages = sent.length === 0
    ? baseMessages
    : [...baseMessages, ...sent].sort((a, b) => a.ts - b.ts);

  return {
    serverId: state.serverId,
    channelId: state.channelId,
    draft: state.drafts[state.channelId] ?? "",
    messages,
    isCategoryCollapsed,
    memberListOpen: state.memberListOpen,
    selectServer,
    selectChannel,
    setDraft,
    send,
    toggleCategory,
    toggleMemberList,
  };
}
