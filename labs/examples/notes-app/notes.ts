// notes.ts — domain types + reducer-backed custom hook for managing the
// list of notes. Exercises useReducer, useCallback (for stable action
// dispatchers), useEffect (for one-shot logging on mount), nanoid for
// fresh ids, and pure-immutable updates with spread.

import { useCallback, useEffect, useReducer } from "react";
import { nanoid } from "nanoid";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

type Action =
  | { type: "select"; id: string | null }
  | { type: "add" }
  | { type: "delete"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "appendBody"; id: string; chunk: string }
  | { type: "setBody"; id: string; body: string }
  | { type: "addTag"; id: string; tag: string }
  | { type: "removeTag"; id: string; tag: string };

interface State {
  notes: Note[];
  selectedId: string | null;
}

const SAMPLE_TAGS = ["idea", "todo", "draft", "ref", "personal", "work"];
const TITLE_FRAGMENTS = [
  "Untitled note", "Project kickoff", "Reading list", "Daily standup",
  "Brainstorm", "Travel plans", "Budget review", "Workout routine",
];

function seed(): State {
  const now = Date.now();
  const notes: Note[] = [
    {
      id: nanoid(8),
      title: "Welcome to Notes",
      body:
        "This is a notes app built with React, running on carbon-mini — " +
        "no Electron, no WebView. The whole runtime is ~1.5 MB and the " +
        "binary boots in under 300 ms.\n\n" +
        "Click any note in the sidebar to open it. Use the toolbar buttons " +
        "to simulate editing — the scene graph doesn't have text inputs " +
        "yet, so 'edit' here means 'mutate state via a button'.",
      tags: ["welcome", "ref"],
      createdAt: now - 1000 * 60 * 60 * 24 * 3,
      updatedAt: now - 1000 * 60 * 60 * 2,
    },
    {
      id: nanoid(8),
      title: "Things to try",
      body:
        "1. Click 'New note' — useReducer adds an item.\n" +
        "2. Click 'Cycle title' — re-renders update the heading.\n" +
        "3. Click 'Add tag' — list-with-keys reconciliation.\n" +
        "4. Click 'Delete' — removes from the list.\n" +
        "5. Toggle the theme — context-driven re-render.\n",
      tags: ["todo"],
      createdAt: now - 1000 * 60 * 60 * 24,
      updatedAt: now - 1000 * 60 * 30,
    },
    {
      id: nanoid(8),
      title: "How it works",
      body:
        "@carbon/mini-react is a ~360 LOC adapter on top of " +
        "react-reconciler. Each fiber commits to a CmNode, which calls " +
        "carbon-mini's __cm_create_node / __cm_set_prop / __cm_insert_node " +
        "host imports.\n\n" +
        "@carbon/compat-dom provides Tier 1+2 DOM types (Element, Text, " +
        "Event) so npm packages that touch document/window don't crash " +
        "at module-init.",
      tags: ["ref", "draft"],
      createdAt: now - 1000 * 60 * 60 * 24 * 2,
      updatedAt: now - 1000 * 60 * 5,
    },
  ];
  return { notes, selectedId: notes[0].id };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "select":
      return { ...state, selectedId: action.id };
    case "add": {
      const now = Date.now();
      const note: Note = {
        id: nanoid(8),
        title: TITLE_FRAGMENTS[state.notes.length % TITLE_FRAGMENTS.length],
        body: "Start writing here.",
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      return { notes: [note, ...state.notes], selectedId: note.id };
    }
    case "delete": {
      const remaining = state.notes.filter((n) => n.id !== action.id);
      const wasSelected = state.selectedId === action.id;
      return {
        notes: remaining,
        selectedId: wasSelected ? remaining[0]?.id ?? null : state.selectedId,
      };
    }
    case "rename":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.id ? { ...n, title: action.title, updatedAt: Date.now() } : n,
        ),
      };
    case "appendBody":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.id
            ? { ...n, body: n.body + action.chunk, updatedAt: Date.now() }
            : n,
        ),
      };
    case "setBody":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.id
            ? { ...n, body: action.body, updatedAt: Date.now() }
            : n,
        ),
      };
    case "addTag":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.id && !n.tags.includes(action.tag)
            ? { ...n, tags: [...n.tags, action.tag], updatedAt: Date.now() }
            : n,
        ),
      };
    case "removeTag":
      return {
        ...state,
        notes: state.notes.map((n) =>
          n.id === action.id
            ? { ...n, tags: n.tags.filter((t) => t !== action.tag), updatedAt: Date.now() }
            : n,
        ),
      };
    default:
      return state;
  }
}

export interface NotesApi {
  notes: Note[];
  selectedId: string | null;
  selected: Note | null;
  select(id: string | null): void;
  addNote(): void;
  deleteNote(id: string): void;
  rename(id: string, title: string): void;
  appendBody(id: string, chunk: string): void;
  setBody(id: string, body: string): void;
  addTag(id: string, tag: string): void;
  removeTag(id: string, tag: string): void;
  randomTag(): string;
}

export function useNotes(): NotesApi {
  const [state, dispatch] = useReducer(reducer, undefined, seed);

  // useEffect: one-shot mount log. Validates that effects run after the
  // initial commit (rather than during render).
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("[notes-app] mounted with", state.notes.length, "notes");
  }, []);

  // useCallback wraps every dispatch so child components that take these
  // as props get stable references (matters for React.memo'd children).
  const select = useCallback((id: string | null) => dispatch({ type: "select", id }), []);
  const addNote = useCallback(() => dispatch({ type: "add" }), []);
  const deleteNote = useCallback((id: string) => dispatch({ type: "delete", id }), []);
  const rename = useCallback((id: string, title: string) => dispatch({ type: "rename", id, title }), []);
  const appendBody = useCallback((id: string, chunk: string) => dispatch({ type: "appendBody", id, chunk }), []);
  const setBody = useCallback((id: string, body: string) => dispatch({ type: "setBody", id, body }), []);
  const addTag = useCallback((id: string, tag: string) => dispatch({ type: "addTag", id, tag }), []);
  const removeTag = useCallback((id: string, tag: string) => dispatch({ type: "removeTag", id, tag }), []);
  const randomTag = useCallback(() => SAMPLE_TAGS[Math.floor(Math.random() * SAMPLE_TAGS.length)], []);

  const selected = state.notes.find((n) => n.id === state.selectedId) ?? null;

  return {
    notes: state.notes,
    selectedId: state.selectedId,
    selected,
    select,
    addNote,
    deleteNote,
    rename,
    appendBody,
    setBody,
    addTag,
    removeTag,
    randomTag,
  };
}
