/** Client state: what the server confirmed, what we have predicted, and UI. */

import {
  predict,
  type CardId,
  type CursorPosition,
  type Face,
  type GameState,
  type PendingIntent,
  type PlayerId,
} from '@patte/core';
import { create } from 'zustand';

export type Status = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** How long a peeked face stays on screen before it slides back down. */
const PEEK_MS = 2_500;
const TOAST_MS = 2_600;
/** Long enough to read a short line without breaking the rhythm of a deal. */
const FLASH_MS = 2_800;

export interface Toast {
  id: number;
  text: string;
  kind: 'denied' | 'info';
}

interface Store {
  status: Status;
  statusMessage: string | null;
  you: PlayerId | null;

  /** The last state the server confirmed. */
  confirmed: GameState | null;
  /** Our own intents, sent but not yet acknowledged. */
  pending: PendingIntent[];
  /** What is on screen: `confirmed` with `pending` replayed on top. */
  view: GameState | null;

  cursors: CursorPosition[];
  /** Faces from a peek. Ephemeral by design -- never part of any state. */
  peeked: Record<CardId, Face>;
  selection: CardId[];
  /** Whether your own hand is shown in reading order rather than as dealt. */
  handSorted: boolean;
  /**
   * One thing the table is saying right now, large and briefly.
   *
   * Not a toast: a toast is a note in the corner for something that has
   * happened elsewhere, and trump being named is the fact the rest of the hand
   * is played against. It gets the middle of the screen for a moment.
   */
  flash: string | null;
  toasts: Toast[];

  setStatus(status: Status, message?: string): void;
  onWelcome(you: PlayerId, snapshot: GameState): void;
  onConfirmed(state: GameState, ack?: number): void;
  onDenied(id: number, reason: string): void;
  onPeeked(faces: { cardId: CardId; face: Face }[]): void;
  addPending(intent: PendingIntent): void;
  setCursors(cursors: CursorPosition[]): void;
  select(cardIds: CardId[]): void;
  toggleSelected(cardId: CardId): void;
  clearSelection(): void;
  toggleHandSorted(): void;
  declare(text: string): void;
  /** Forget this table entirely, on the way back to the lobby. */
  reset(): void;
  toast(text: string, kind?: Toast['kind']): void;
}

let toastSeq = 0;

export const useStore = create<Store>((set, get) => ({
  status: 'connecting',
  statusMessage: null,
  you: null,
  confirmed: null,
  pending: [],
  view: null,
  cursors: [],
  peeked: {},
  selection: [],
  handSorted: false,
  flash: null,
  toasts: [],

  setStatus(status, message) {
    set({ status, statusMessage: message ?? null });
  },

  onWelcome(you, snapshot) {
    // A fresh snapshot supersedes everything we had guessed.
    set({ you, confirmed: snapshot, pending: [], view: snapshot, status: 'connected' });
  },

  onConfirmed(state, ack) {
    const { pending, you } = get();
    // Everything up to the acknowledged id is now part of `confirmed`.
    const stillPending = ack === undefined ? pending : pending.filter((p) => p.id > ack);
    set({
      confirmed: state,
      pending: stillPending,
      view: you ? predict(state, stillPending, you) : state,
    });
  },

  onDenied(id, reason) {
    const { confirmed, pending, you } = get();
    // Rolling back is just replaying without the intent that failed.
    const stillPending = pending.filter((p) => p.id !== id);
    set({
      pending: stillPending,
      view: confirmed && you ? predict(confirmed, stillPending, you) : confirmed,
    });
    get().toast(reason, 'denied');
  },

  addPending(intent) {
    const { confirmed, pending, you } = get();
    if (!confirmed || !you) return;
    const stillPending = [...pending, intent];
    set({ pending: stillPending, view: predict(confirmed, stillPending, you) });
  },

  onPeeked(faces) {
    const peeked = { ...get().peeked };
    for (const patch of faces) peeked[patch.cardId] = patch.face;
    set({ peeked });

    setTimeout(() => {
      const next = { ...get().peeked };
      for (const patch of faces) delete next[patch.cardId];
      set({ peeked: next });
    }, PEEK_MS);
  },

  setCursors(cursors) {
    set({ cursors });
  },

  select(cardIds) {
    set({ selection: cardIds });
  },

  toggleSelected(cardId) {
    const selection = get().selection;
    set({
      selection: selection.includes(cardId)
        ? selection.filter((id) => id !== cardId)
        : [...selection, cardId],
    });
  },

  clearSelection() {
    if (get().selection.length > 0) set({ selection: [] });
  },

  toggleHandSorted() {
    set({ handSorted: !get().handSorted });
  },

  declare(text) {
    set({ flash: text });
    setTimeout(() => {
      // Only clear our own announcement: a second one arriving in the meantime
      // is the current one, and cancelling it would blank the screen early.
      if (get().flash === text) set({ flash: null });
    }, FLASH_MS);
  },

  /*
   * Leaving has to empty this, not just stop listening.
   *
   * `view` and `you` are what the app renders a table from, and they outlive
   * a closed socket. Left in place, joining a second table shows the *first*
   * one -- fully interactive, against a room nobody is connected to -- for as
   * long as the new welcome takes to arrive.
   */
  reset() {
    set({
      status: 'connecting',
      statusMessage: null,
      you: null,
      confirmed: null,
      pending: [],
      view: null,
      cursors: [],
      peeked: {},
      selection: [],
      flash: null,
    });
  },

  toast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), TOAST_MS);
  },
}));
