/**
 * The table surface.
 *
 * Every card on the table lives in this one container, positioned absolutely,
 * regardless of which zone it belongs to. That is what makes movement between
 * zones animate: a card dealt from the deck to a hand is the same DOM node
 * with a new transform, so the browser tweens it and the card visibly travels
 * the way it would across a real table.
 */

import { canSeeFace, getRuleset, type GameState, type PlayerId } from '@patte/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Connection } from '../net.js';
import {
  cardPoint,
  playButtonY,
  metricsFor,
  placementsFor,
  rowBand,
  seatAngle,
  stackRowPosition,
  stackTableRows,
  trickBand,
  trickBandMargin,
  seatLayout,
  topStripSeat,
  trickSize,
  type LayoutFamily,
  type Metrics,
  type Placement,
} from '../geometry.js';
import { handOrderFor, sortHand } from '../handsort.js';
import { cardColour, seatColour } from '../players.js';
import { sounds } from '../sound.js';
import { useStore } from '../store.js';
import { isTouchOnly } from '../useCompact.js';
import { useElementSize } from '../useElementSize.js';
import { CardView } from './CardView.js';
import { HandDrawer } from './HandDrawer.js';
import { Cursors } from './Cursors.js';

const SUIT_GLYPH: Record<string, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
const TRICK_ZONE_ID = 'trick';
/**
 * The narrowest sliver of a card still worth aiming a thumb at.
 *
 * Below this the fan stops being something you pick from and becomes
 * something you open.
 */
const MIN_TAP = 30;


/** How far a selected card lifts off the table, so you can see it is chosen. */
const SELECT_LIFT = 12;
/** Movement beyond this cancels a hold-to-peek; below it, a click is a click. */
const DRAG_THRESHOLD = 6;
const PEEK_HOLD_MS = 420;

interface DragState {
  cardIds: string[];
  /**
   * Whether the card was already selected when the press began.
   *
   * Pressing a card selects it immediately, so by the time the tap completes
   * it is always selected -- and a toggle that read the current selection
   * would cancel itself every time.
   */
  wasSelected: boolean;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
}

export function TableView({ state, you, net }: { state: GameState; you: PlayerId; net: Connection }): React.JSX.Element {
  // The status bar below the table comes and goes with the phase of the game,
  // which changes how much room the table has.
  // Re-measure whenever something above or below the table appears: the phase
  // brings in the status band, and the trump strip takes a row of its own on a
  // phone once trump has been called.
  const [surface, measured] = useElementSize<HTMLDivElement>([
    state.phase,
    state.rulesetId,
    state.gameData['stage'],
  ]);
  const ruleset = getRuleset(state.rulesetId);
  const refereed = ruleset.legalCards !== undefined;
  const [drag, setDrag] = useState<DragState | null>(null);
  /**
   * Which card opened the hand, if it is open.
   *
   * Null means it was opened some other way. The strip is as wide as the hand
   * is long -- twenty-six cards on a phone is several screens of scrolling --
   * so opening it at the beginning every time asks the player to go and find
   * the card they had their thumb on a moment ago.
   */
  const [handOpen, setHandOpen] = useState<{ from: string | null } | null>(null);
  const peekTimer = useRef<number | null>(null);
  // Everything below positions against the real size of the table. Until it
  // has been measured there is nothing sensible to draw.
  const bounds = measured ?? { width: 0, height: 0 };

  const selection = useStore((s) => s.selection);
  const peeked = useStore((s) => s.peeked);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  const handSorted = useStore((s) => s.handSorted);
  const toggleHandSorted = useStore((s) => s.toggleHandSorted);

  // --- where each zone sits -------------------------------------------------

  // A table with rows down the middle seats its opponents differently from one
  // with a deck in the centre. The rows need the full width.
  const rowZones = Object.values(state.zones)
    .filter((zone) => zone.kind === 'row')
    .sort((a, b) => a.id.localeCompare(b.id));
  const hasRows = rowZones.length > 0;
  const hasStacks = Object.values(state.zones).some((zone) => zone.kind === 'stack');
  // A trick in the middle and nothing else on the table: three players around
  // one pile of cards, which is neither the stacks table nor the rows one.
  const hasTrick = Object.values(state.zones).some((zone) => zone.kind === 'trick');

  // The status pill sits under the hand, so the table stops short of it. The
  // band is reserved for the whole round rather than only while the pill
  // happens to be showing, or the cards would shuffle up and down as it comes
  // and goes.
  // Card sizes are solved for the box actually available rather than fixed, so
  // the same layout serves a laptop and a phone.
  const family: LayoutFamily =
    hasStacks ? 'stacks' : hasRows ? 'rows' : hasTrick ? 'trick' : 'free';
  const m = metricsFor(bounds.width || 1, bounds.height || 1, family);
  const statusBand = refereed && state.phase === 'playing' ? m.statusBand : 0;
  const usable = Math.max(bounds.height - statusBand, m.cardH * 2);
  const rows = stackTableRows(m, usable);
  const others = state.seatOrder.filter((id) => id !== you);

  const seatOf = useCallback(
    (playerId: string) => {
      if (!hasRows && !hasTrick) {
        return seatLayout(m, seatAngle(state, playerId, you), bounds.width, bounds.height);
      }
      const index = others.indexOf(playerId);
      return topStripSeat(m, Math.max(index, 0), others.length, bounds.width);
    },
    [hasRows, hasTrick, state, you, bounds, others, m],
  );

  const zoneOrigin = useCallback(
    (zoneId: string): { x: number; y: number } => {
      const zone = state.zones[zoneId];
      if (!zone) return { x: bounds.width / 2, y: bounds.height / 2 };

      if (zone.kind === 'hand') {
        if (zone.owner === you) {
          return { x: bounds.width / 2, y: hasStacks ? rows.hand : usable - m.cardH * 0.95 };
        }
        // With stacks on the table the middle is spoken for, so an opponent's
        // hand goes off to the side rather than on top of their own row.
        if (hasStacks) return { x: m.cardW * 1.1, y: rows.opponentStacks };
        return seatOf(zone.owner ?? '').hand;
      }

      if (zone.kind === 'trick') {
        return { x: bounds.width / 2, y: hasStacks ? rows.trick : trickBand(m, usable) };
      }
      if (zone.kind === 'row') {
        const index = rowZones.findIndex((candidate) => candidate.id === zone.id);
        return { x: bounds.width / 2, y: rowBand(m, Math.max(index, 0), rowZones.length, usable) };
      }

      // Your stacks sit just above your hand; the opponent's just below their
      // name, mirroring how the two of you face each other.
      if (zone.kind === 'stack') {
        const index = Number(zone.id.split(':').at(-1) ?? 0);
        const mine = zone.owner === you;
        const centre = {
          x: bounds.width / 2,
          y: mine ? rows.ownStacks : rows.opponentStacks,
        };
        return stackRowPosition(m, index, 5, centre);
      }

      // Won tricks stack up out of the way at the side.
      if (zone.kind === 'pile') {
        const mine = zone.owner === you;
        return { x: bounds.width - m.cardW * 0.9, y: mine ? usable - m.cardH : m.cardH * 0.75 };
      }
      if (zone.pos) return { x: zone.pos.x * bounds.width, y: zone.pos.y * bounds.height };
      return { x: bounds.width / 2, y: bounds.height / 2 };
    },
    [state, you, bounds, seatOf, rowZones, hasStacks, rows, usable, m],
  );

  // Your own hand, in whatever order you are reading it in. Only ever applied
  // to your own: sorting is a view, and one you could not be given of a hand
  // whose faces you cannot see.
  const myHandCards = state.zones[`hand:${you}`]?.cards ?? [];
  const myHand = handSorted
    ? sortHand(state, handOrderFor(ruleset), myHandCards)
    : [...myHandCards];

  const placements = new Map<string, Placement>();
  const zoneBands: { zone: string; layer: number }[] = [];

  for (const zone of Object.values(state.zones)) {
    const isMine = zone.owner === you;
    // A pile of won tricks is face down and sealed, so it carries no
    // information a count does not. On a phone there is nowhere to put it that
    // is not already spoken for, so it becomes a chip instead.
    if (zone.kind === 'pile' && m.compact) continue;
    // An opponent's hand, when you cannot read it, is the same trade: a fan of
    // identical backs tells you only how many cards they hold, and their name
    // plate already says that in a form you can read at a glance. Drawing it
    // costs a band of table on every screen and buys nothing, so it goes --
    // and the rows and stacks spread into the room it was using.
    //
    // A hand you *can* read is a different thing entirely: in a sandbox with
    // open hands those faces are the whole point, so they stay and fan
    // normally.
    //
    // Every card, not any card. लॅडीस turns one card of the caller's hand face
    // up -- the trump, once somebody has asked for it -- and on "any" that one
    // known card brought the whole fan of backs back onto the table, eating a
    // band of it to show four cards nobody can read.
    if (
      zone.kind === 'hand' &&
      !isMine &&
      !(zone.cards.length > 0 && zone.cards.every((id) => state.cards[id]?.face))
    ) {
      continue;
    }
    const origin = zoneOrigin(zone.id);

    const forZone = placementsFor(
      m,
      zone.kind === 'hand' && isMine ? { ...zone, cards: myHand } : zone,
      { width: bounds.width, height: bounds.height },
      origin,
      (cardId) => state.cards[cardId]?.pos,
      (cardId) => state.cards[cardId]?.face?.rank,
    );

    // A player's own hand sits above everything; other hands sit behind the
    // shared middle of the table, as they do physically.
    const layer =
      zone.kind === 'hand' ? (isMine ? 6000 : 200) : zone.kind === 'table' ? 1000 : 800;
    zoneBands.push({ zone: zone.id, layer });
    for (const [cardId, placement] of forZone) {
      placements.set(cardId, { ...placement, z: layer + placement.z });
    }
  }

  // Which of my cards may actually be played right now. Asked of the ruleset
  // rather than worked out here -- a rule the player cannot see is a rule that
  // feels like a bug, but a rule reimplemented in the UI is worse.
  const playable = new Set(ruleset.legalCards?.(state, you) ?? []);
  const justPlayed = new Set(state.lastPlay?.cardIds ?? []);

  // How much of each card in your own hand is actually exposed. Below a
  // thumb's width there is no picking a particular one, and the fan becomes a
  // button that opens the drawer instead.
  const handSize = myHand.length;
  const handPitch =
    handSize > 1
      ? Math.min(m.cardW * 0.62, (bounds.width * 0.7 - m.cardW) / (handSize - 1))
      : m.cardW;
  // Crowded means *the count* has squeezed the fan, not that the cards are
  // small. On a narrow phone a full-width fan pitch can itself be under a
  // thumb's width, and demanding more than the fan could ever offer would send
  // you to the sheet to pick between your last two cards.
  const handCrowded = handPitch < Math.min(MIN_TAP, m.cardW * 0.62);
  // While the game is waiting on a decision -- naming trump, picking up a
  // trick -- nothing is playable because it is not time to play, which is not
  // the same as holding nothing you are allowed to play. Dimming the hand
  // then makes it harder to read at exactly the moment it matters most.
  const paused = ruleset.awaitingChoice?.(state) != null;
  const myTurn = state.turn === you && !paused;

  // --- one-tap play ---------------------------------------------------------
  //
  // Picking a card is the easy half of select-then-place. The hard half, on a
  // phone, is the placing: finding a strip of table between other cards and
  // hitting it with a thumb, having already committed to the card. So when the
  // ruleset says the card has exactly one home, the whole play is offered as a
  // button sitting on the card itself -- one tap to choose, one to commit.
  //
  // Deliberately not a shortcut past a decision: more than one destination
  // means there is a real choice to make, and the player still makes it by
  // placing the card. Which is why this asks the ruleset rather than assuming
  // that "the trick" or "the matching row" is always the answer.
  const chosen = selection.length === 1 ? selection[0] : undefined;
  const chosenPlacement = chosen ? placements.get(chosen) : undefined;
  const destinations = useCallback(
    (cardId: string): string[] => (myTurn ? ruleset.destinationsFor?.(state, you, cardId) ?? [] : []),
    [ruleset, state, you, myTurn],
  );
  /** Whether tapping this card can offer the whole play as one button. */
  const oneTap = useCallback((cardId: string): boolean => destinations(cardId).length === 1, [destinations]);
  const playOneTap = useCallback(
    (cardId: string) => {
      const [toZone] = destinations(cardId);
      if (!toZone) return;
      net.submit({ type: 'move', cardIds: [cardId], toZone });
      sounds.slide();
      clearSelection();
      setHandOpen(null);
    },
    [destinations, net, clearSelection],
  );
  const confirmSize = Math.max(38, Math.round(m.cardW * 0.62));
  // While the strip is open the button belongs *in* the strip, on the card the
  // player just tapped. Two of them, one behind the sheet, would be one too
  // many.
  const confirm =
    chosen && chosenPlacement && oneTap(chosen) && !drag && !handOpen
      ? {
          cardId: chosen,
          // The lift is part of where the card is drawn, so the button has to
          // account for it or it sits a finger's width below the card.
          at: cardPoint(
            m,
            { ...chosenPlacement, y: chosenPlacement.y - SELECT_LIFT },
            0.5,
            playButtonY(m, confirmSize),
          ),
        }
      : null;

  // --- interaction ----------------------------------------------------------

  const mayTouch = useCallback(
    (cardId: string): boolean => {
      const card = state.cards[cardId];
      if (!card) return false;
      if (card.heldBy !== null && card.heldBy !== you) return false;
      const zone = state.zones[card.zone];
      if (!zone) return false;
      return zone.owner === null || zone.owner === you || zone.openToOthers;
    },
    [state, you],
  );

  const onCardPointerDown = useCallback(
    (event: React.PointerEvent, cardId: string) => {
      if (event.button !== 0 || !mayTouch(cardId)) return;
      event.preventDefault();
      // Capture keeps the drag alive if the pointer leaves the card, but it
      // throws for a pointer the browser no longer considers active. Losing
      // capture is survivable; losing the rest of this handler is not.
      try {
        (event.target as Element).setPointerCapture?.(event.pointerId);
      } catch {
        // Carry on without capture.
      }

      if (event.shiftKey) {
        toggleSelected(cardId);
        return;
      }

      // Too tight to aim at: open the hand rather than pretending the tap
      // picked the card the player meant.
      if (handCrowded && state.cards[cardId]?.zone === `hand:${you}`) {
        setHandOpen({ from: cardId });
        return;
      }

      // Dragging one card out of a multi-selection takes the whole selection,
      // the way sliding a fanned group across a table does.
      const already = selection.includes(cardId);
      const cardIds = already && selection.length > 1 ? selection : [cardId];
      if (!already) select([cardId]);

      net.submit({ type: 'grab', cardIds });
      sounds.pickup();
      setDrag({
        cardIds,
        wasSelected: already,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        moved: false,
      });

      // Holding still over a card is how you sneak a look at it. The whole
      // table is told that you looked -- the tell survives, the card does not.
      peekTimer.current = window.setTimeout(() => {
        peekTimer.current = null;
        net.submit({ type: 'peek', cardIds });
      }, PEEK_HOLD_MS);
    },
    [mayTouch, selection, toggleSelected, select, net, handCrowded, state, you],
  );

  const cancelPeek = (): void => {
    if (peekTimer.current !== null) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  };

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const rect = surface.current?.getBoundingClientRect();
      // Nothing to share on a touch screen: there is no pointer hovering
      // anywhere, and a cursor left behind by the last tap is just wrong.
      if (rect && !isTouchOnly()) {
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        // Anchor the cursor to whatever it is over. Sending raw coordinates
        // would place an opponent's pointer over *your* hand, because both of
        // you draw your own hand along the bottom edge.
        const zone = zoneUnderPointer(event.clientX, event.clientY, state);
        const origin = zone ? zoneOrigin(zone) : null;
        net.moveCursor({
          x: point.x / rect.width,
          y: point.y / rect.height,
          ...(zone && origin
            ? {
                zone,
                dx: (point.x - origin.x) / rect.width,
                dy: (point.y - origin.y) / rect.height,
              }
            : {}),
        });
      }
      if (!drag || event.pointerId !== drag.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const moved = drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD;
      if (moved) cancelPeek();
      setDrag({ ...drag, dx, dy, moved });
    },
    [drag, net, state, zoneOrigin],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      cancelPeek();
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.moved) {
        // A tap, not a drag. Select the card and wait to be told where it
        // goes -- dragging a card out of a fan is fine with a mouse and close
        // to impossible with a thumb, so tapping has to lead somewhere.
        net.submit({ type: 'release', cardIds: drag.cardIds });
        // Pressing already selected it. Tapping one that was *previously*
        // selected means putting it back down.
        if (drag.wasSelected) clearSelection();
        setDrag(null);
        return;
      }

      const target = dropTargetAt(event.clientX, event.clientY);
      const rect = surface.current?.getBoundingClientRect();

      if (!target || !rect) {
        net.submit({ type: 'release', cardIds: drag.cardIds });
      } else if (target.zoneId === 'table') {
        // Free placement: remember where on the felt it was actually put down.
        net.submit({
          type: 'move',
          cardIds: drag.cardIds,
          toZone: 'table',
          pos: {
            x: (event.clientX - rect.left) / rect.width,
            y: (event.clientY - rect.top) / rect.height,
          },
        });
        sounds.slide();
      } else {
        net.submit({ type: 'move', cardIds: drag.cardIds, toZone: target.zoneId, ...(target.index !== undefined ? { toIndex: target.index } : {}) });
        sounds.slide();
      }

      setDrag(null);
    },
    [drag, net, clearSelection],
  );

  /**
   * The second half of select-then-place: a tap on the table.
   *
   * Somewhere the cards can actually go plays them there. Anywhere else
   * cancels -- one gesture backs out of a half-finished action, and in a
   * refereed game the felt is not a real zone, so tapping it always means
   * "never mind".
   */
  const placeSelection = useCallback(
    (zoneId: string, clientX: number, clientY: number) => {
      setHandOpen(null);
      if (selection.length === 0) return;
      if (!state.zones[zoneId]) {
        clearSelection();
        return;
      }

      const rect = surface.current?.getBoundingClientRect();
      const free = state.zones[zoneId]?.layout === 'free';
      net.submit({
        type: 'move',
        cardIds: selection,
        toZone: zoneId,
        ...(free && rect
          ? { pos: { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height } }
          : {}),
      });
      sounds.slide();
      clearSelection();
    },
    [selection, state, net, clearSelection, surface],
  );

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') return clearSelection();
      if ((event.key === 'f' || event.key === 'F') && selection.length > 0) {
        net.submit({ type: 'flip', cardIds: selection.filter(mayTouch) });
        sounds.flip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, mayTouch, clearSelection, net]);

  // --- render ---------------------------------------------------------------

  return (
    <div
      ref={surface}
      className="surface"
      data-zone="table"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerDown={(event) => {
        const zoneId = (event.target as HTMLElement).dataset['zone'];
        if (!zoneId) return;
        placeSelection(zoneId, event.clientX, event.clientY);
      }}
    >
      <div className="felt" />

      {/* Drop targets. Rendered beneath the cards, which go pointer-inert
          while dragging so a drop lands on the zone, not on a sibling card. */}
      {measured && rowZones.map((zone) => {
        const origin = zoneOrigin(zone.id);
        const width = bounds.width * 0.62 + m.cardW;
        return (
          <div
            key={zone.id}
            className={`row-slot${zone.cards.length === 0 ? ' is-empty' : ''}`}
            data-zone={zone.id}
            style={{
              left: origin.x - width / 2,
              // Exactly a card tall. Padding it out made adjacent boxes
              // overlap once the rows sat close together, so two empty rows
              // read as one merged band.
              top: origin.y - m.cardH / 2,
              width,
              height: m.cardH,
            }}
          >
            <span className="row-slot__suit" data-suit={zone.label}>
              {SUIT_GLYPH[zone.label ?? ''] ?? zone.label}
            </span>
          </div>
        );
      })}

      {/* Where the trick lies, and the drop target for a dragged card. Sized
          from the same helper the cards are placed by, so the box is always
          the room the trick was actually given. */}
      {measured && state.zones[TRICK_ZONE_ID] && (
        <div
          className="trick-slot"
          data-zone={TRICK_ZONE_ID}
          style={{
            left: zoneOrigin(TRICK_ZONE_ID).x - trickSize(m).width / 2,
            top: zoneOrigin(TRICK_ZONE_ID).y - trickSize(m).height * 0.75,
            width: trickSize(m).width,
            height: trickSize(m).height * 1.5,
          }}
        />
      )}

      {/* The face-down trump earns a box of its own: a single card back
          sitting beside the table means nothing without a word on it. The box
          follows the zone's own scale, so a half-size marker does not sit in a
          full-size frame. */}
      {measured && ['deck', 'discard', 'trump'].map((zoneId) => {
        const zone = state.zones[zoneId];
        if (!zone) return null;
        const origin = zoneOrigin(zoneId);
        const slotW = m.cardW * (zone.scale ?? 1);
        const slotH = m.cardH * (zone.scale ?? 1);
        return (
          <div
            key={zoneId}
            className="slot"
            data-zone={zoneId}
            style={{ left: origin.x - slotW / 2 - 8, top: origin.y - slotH / 2 - 8, width: slotW + 16, height: slotH + 16 }}
          >
            <span className="slot__label">
              {zone.label} · {zone.cards.length}
            </span>
          </div>
        );
      })}

      {measured && others.map((playerId) => {
        const player = state.players[playerId];
        if (!player) return null;
        const { badge } = hasStacks
          ? { badge: { x: bounds.width / 2, y: rows.opponentName } }
          : seatOf(playerId);
        // In a game with sides, which of three opponents is actually your
        // partner is the first thing you need to know and the one thing the
        // table cannot show -- everybody is drawn along the same strip.
        const partner = state.teams.some((team) => team.includes(you) && team.includes(playerId));
        const colour = seatColour(state, playerId);
        return (
          <div
            key={playerId}
            className={`seat${state.turn === playerId ? ' is-turn' : ''}${player.connected ? '' : ' is-away'}${
              partner ? ' is-partner' : ''
            }`}
            style={{ left: badge.x, top: badge.y }}
          >
            <span className="seat__name">
              {/* The key to the marks on the table. Beside the name rather
                  than anywhere else, because the name is what you are reading
                  when you want to know whose a card was. */}
              {colour && <i className="seat__dot" style={{ background: colour }} />}
              {player.name}
              {partner && <em className="seat__partner">partner</em>}
            </span>
            <span className="seat__count">{state.zones[`hand:${playerId}`]?.cards.length ?? 0} cards</span>
          </div>
        );
      })}

      <div className="hand-strip" data-zone={`hand:${you}`} />

      {measured && Object.values(state.cards).map((card) => {
        const placement = placements.get(card.id);
        if (!placement) return null;
        const isDragging = drag?.cardIds.includes(card.id) ?? false;
        const offset = isDragging && drag ? { x: drag.dx, y: drag.dy } : { x: 0, y: 0 };

        return (
          <CardView
            key={card.id}
            m={m}
            cardId={card.id}
            face={card.face ?? peeked[card.id] ?? null}
            // "Public" is exactly "a spectator could see it", so ask the
            // engine rather than reimplementing the visibility rules here.
            isPublic={canSeeFace(state, card, null)}
            peeking={peeked[card.id] !== undefined}
            placement={{
              ...placement,
              x: placement.x + offset.x,
              y: placement.y + offset.y - (isDragging ? 14 : 0) - (selection.includes(card.id) && !isDragging ? SELECT_LIFT : 0),
              z: isDragging ? 9000 : placement.z,
            }}
            heldByOther={card.heldBy !== null && card.heldBy !== you}
            selected={selection.includes(card.id)}
            dragging={isDragging}
            // In a refereed game, light up what can be played and dim what
            // cannot, but only in your own hand and only on your turn.
            lastPlay={justPlayed.has(card.id)}
            // Whose card this is. The engine recorded who put it there, so
            // the question survives the cards being shuffled about on screen.
            {...(cardColour(state, card.id) ? { marker: cardColour(state, card.id) } : {})}
            playable={refereed && myTurn && playable.has(card.id)}
            blocked={refereed && myTurn && card.zone === `hand:${you}` && !playable.has(card.id)}
            interactive={mayTouch(card.id)}
            onPointerDown={onCardPointerDown}
            onDoubleClick={(cardId) => {
              cancelPeek();
              net.submit({ type: 'flip', cardIds: [cardId] });
              sounds.flip();
            }}
          />
        );
      })}

      {measured && confirm && (
        <button
          className="playcheck"
          style={{ left: confirm.at.x, top: confirm.at.y, width: confirmSize, height: confirmSize }}
          aria-label="play this card"
          title="Play this card"
          onClick={() => playOneTap(confirm.cardId)}
        >
          <span className="playcheck__tick" />
        </button>
      )}

      {/* The chips sit in the margins either side of the trick, so there are
          two places for them. Past two players the trump strip along the top
          carries everyone's count instead. */}
      {measured &&
        m.compact &&
        state.inPlay.length <= 2 &&
        Object.values(state.zones)
          .filter((zone) => zone.kind === 'pile')
          .map((zone) => {
            const mine = zone.owner === you;
            const margin = trickBandMargin(m, bounds.width);
            // One card per player to a trick. Two was right when the only
            // game with piles seated two, and wrong the moment a third did.
            const perTrick = Math.max(state.inPlay.length, 1);
            const tricks = Math.floor(zone.cards.length / perTrick);
            return (
              <div
                key={zone.id}
                className={`pilechip${mine ? ' is-mine' : ''}`}
                style={{
                  left: mine ? bounds.width - margin / 2 : margin / 2,
                  top: rows.trick,
                }}
                title={`${mine ? 'You have' : 'They have'} taken ${tricks} trick${tricks === 1 ? '' : 's'}`}
              >
                <span className="pilechip__back" />
                <span className="pilechip__count">{tricks}</span>
              </div>
            );
          })}

      {/*
        * Sorting your hand.
        *
        * Bottom right, level with the status pill rather than above it. The
        * pill is centred and short, so the strip beside it is free; the band
        * above it is not -- a fanned hand is wider than its 70% spread by a
        * card, and its outer cards droop, so a button up there sat on them.
        *
        * It is a toggle rather than a one-shot shuffle of the cards, so a hand
        * you have sorted stays sorted as you play out of it. Turning it off
        * gives you the hand back exactly as it was dealt.
        */}
      {measured && handSize > 1 && (
        <button
          className={`handsort${handSorted ? ' is-on' : ''}`}
          style={{ top: bounds.height - 8, right: 10 }}
          title={handSorted ? 'Show your hand as it was dealt' : 'Sort your hand by suit and rank'}
          aria-pressed={handSorted}
          onClick={() => {
            toggleHandSorted();
            sounds.slide();
          }}
        >
          Sort
        </button>
      )}

      <Cursors state={state} bounds={bounds} originOf={zoneOrigin} />

      {handOpen && (
        <HandDrawer
          state={state}
          you={you}
          m={m}
          hand={myHand}
          openedFrom={handOpen.from}
          playable={playable}
          refereed={refereed}
          selected={chosen ?? null}
          confirmSize={confirmSize}
          canPlay={oneTap}
          onPlay={playOneTap}
          onPick={(cardId) => {
            select([cardId]);
            // Choosing a card used to close the sheet, because the next tap
            // had to land on the table. It no longer does when the card can be
            // played from here: the check appears on the card you just tapped,
            // in the view you are already looking at.
            if (!oneTap(cardId)) setHandOpen(null);
          }}
          onClose={() => setHandOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * Which zone the pointer is over.
 *
 * Cards sit on top of their zone's drop area, so a hit on a card counts as a
 * hit on the zone that holds it -- otherwise hovering a fanned hand would
 * report nothing.
 */
function zoneUnderPointer(clientX: number, clientY: number, state: GameState): string | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const dataset = (element as HTMLElement).dataset;
    if (!dataset) continue;
    if (dataset['zone']) return dataset['zone'];
    const cardId = dataset['card'];
    if (cardId) return state.cards[cardId]?.zone ?? null;
  }
  return null;
}

/** What is under the pointer, ignoring the cards being dragged. */
function dropTargetAt(clientX: number, clientY: number): { zoneId: string; index?: number } | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const zoneId = (element as HTMLElement).dataset?.['zone'];
    if (zoneId) return { zoneId };
  }
  return null;
}
