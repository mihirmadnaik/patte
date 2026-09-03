import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRICS as M,
  DESKTOP_CARD_W,
  FAN_PIVOT,
  PLAY_BUTTON_GAP,
  cardCentre,
  cardPoint,
  playButtonY,
  TRICK_WIDTH,
  handTop,
  rowsTop,
  trickBandMargin,
  metricsFor,
  fanPlacement,
  pairedStackPlacement,
  rowBand,
  rowPlacement,
  seatLayout,
  stackPlacement,
  stackRowPosition,
  stackTableRows,
  topStripSeat,
} from '../src/geometry.js';

/**
 * A pin in the desktop layout.
 *
 * Card sizes are about to stop being constants and start being solved for, so
 * that the table can shrink to fit a phone. Nothing about a laptop should
 * change in the process. These snapshots were taken from the layout as it
 * stood before that work: if any of them move, the refactor has altered
 * something it was only supposed to make adjustable.
 */
const DESKTOP = { width: 1280, height: 745 };

const round = (n: number): number => Math.round(n * 100) / 100;
const place = (p: { x: number; y: number; rotate: number; z: number }) => ({
  x: round(p.x),
  y: round(p.y),
  rotate: round(p.rotate),
  z: p.z,
});

describe('desktop layout is unchanged', () => {
  it('places the 7-8 rows', () => {
    const rows = stackTableRows(M, DESKTOP.height - 68);
    expect({
      opponentName: round(rows.opponentName),
      opponentStacks: round(rows.opponentStacks),
      trick: round(rows.trick),
      ownStacks: round(rows.ownStacks),
      hand: round(rows.hand),
    }).toMatchSnapshot();
  });

  it('spreads a row of five stacks', () => {
    const centre = { x: DESKTOP.width / 2, y: 300 };
    expect([0, 1, 2, 3, 4].map((i) => {
      const p = stackRowPosition(M, i, 5, centre);
      return { x: round(p.x), y: round(p.y) };
    })).toMatchSnapshot();
  });

  it('slides a buried card out from under its cover', () => {
    const origin = { x: 400, y: 300 };
    expect([
      place(pairedStackPlacement(M, 0, 2, origin)),
      place(pairedStackPlacement(M, 1, 2, origin)),
      place(pairedStackPlacement(M, 0, 1, origin)),
    ]).toMatchSnapshot();
  });

  it('fans a hand', () => {
    const origin = { x: 640, y: 600 };
    const width = DESKTOP.width * 0.7;
    for (const count of [1, 5, 15, 26]) {
      expect(
        Array.from({ length: count }, (_, i) => place(fanPlacement(M, i, count, origin, width))),
      ).toMatchSnapshot(`fan of ${count}`);
    }
  });

  /**
   * Deliberately re-baselined once.
   *
   * `rowBand` used to position rows by the centre of their band, which pushed
   * the first row's cards above where the rows were meant to start whenever
   * the rows sat closer together than a card is tall -- by a hair on a laptop
   * and enough to matter on a phone. Positioning by the card's top edge moved
   * the desktop rows down by about fifteen pixels and let the last row reach
   * the hand instead of stopping short of it.
   */
  // The one number in this group that has legitimately moved: with the
  // opponents' hands no longer drawn, the rows start a card's height higher.
  it('bands the Sevens rows', () => {
    expect([0, 1, 2, 3].map((i) => round(rowBand(M, i, 4, DESKTOP.height - 68)))).toMatchSnapshot();
  });

  it('slots a Sevens card by rank', () => {
    const origin = { x: 640, y: 300 };
    expect(['A', '7', 'K'].map((r) => place(rowPlacement(M, r, origin, DESKTOP.width * 0.62)))).toMatchSnapshot();
  });

  it('stacks a deck', () => {
    const origin = { x: 400, y: 300 };
    expect([0, 5, 20].map((i) => place(stackPlacement(M, i, 52, origin)))).toMatchSnapshot();
  });

  it('seats players around the ellipse and along the top', () => {
    expect({
      ellipse: [90, 210, 270].map((a) => {
        const s = seatLayout(M, a, DESKTOP.width, DESKTOP.height);
        return { badge: { x: round(s.badge.x), y: round(s.badge.y) }, hand: { x: round(s.hand.x), y: round(s.hand.y) } };
      }),
      topStrip: [0, 1].map((i) => {
        const s = topStripSeat(M, i, 2, DESKTOP.width);
        return { badge: { x: round(s.badge.x), y: round(s.badge.y) }, hand: { x: round(s.hand.x), y: round(s.hand.y) } };
      }),
    }).toMatchSnapshot();
  });
});

describe('sizing the table to the screen', () => {
  const IPHONE = { width: 393, height: 852 };
  /** What the surface gets once a compact toolbar has taken its row. */
  const IPHONE_SURFACE = IPHONE.height - 48;

  it('leaves a roomy screen at full size', () => {
    for (const family of ['stacks', 'rows', 'free'] as const) {
      const m = metricsFor(1280, 745, family);
      expect(m.cardW, family).toBe(DESKTOP_CARD_W);
      expect(m.cardH, family).toBe(106);
      expect(m.peek, family).toBe(14);
      expect(m.fanLift, family).toBe(26);
      expect(m.nameBand, family).toBe(44);
      expect(m.compact, family).toBe(false);
    }
  });

  it('shrinks the card until a 7-8 stack row fits a phone', () => {
    const m = metricsFor(IPHONE.width, IPHONE_SURFACE, 'stacks');
    // The row is five stacks at a 1.12 pitch -- the constraint that made the
    // phone a non-starter at the fixed size.
    const rowWidth = 4 * m.cardW * 1.12 + m.cardW;
    expect(rowWidth).toBeLessThanOrEqual(IPHONE.width - 24);
    expect(m.cardW).toBeLessThan(DESKTOP_CARD_W);
    expect(m.compact).toBe(true);
  });

  it('keeps the 7-8 bands inside a phone screen', () => {
    const m = metricsFor(IPHONE.width, IPHONE_SURFACE, 'stacks');
    const rows = stackTableRows(m, IPHONE_SURFACE - m.statusBand);

    // Nothing may start above the top edge or finish below the reserved band.
    expect(rows.opponentName - m.nameBand / 2).toBeGreaterThanOrEqual(0);
    expect(rows.hand + m.cardH / 2 + m.fanLift).toBeLessThanOrEqual(IPHONE_SURFACE - m.statusBand);

    // And the bands must not run into one another.
    const bands: [number, number][] = [
      [rows.opponentName - m.nameBand / 2, rows.opponentName + m.nameBand / 2],
      [rows.opponentStacks - m.cardH / 2, rows.opponentStacks + m.cardH / 2 + m.peek],
      [rows.trick - m.cardH / 2, rows.trick + m.cardH / 2],
      [rows.ownStacks - m.cardH / 2, rows.ownStacks + m.cardH / 2 + m.peek],
      [rows.hand - m.cardH / 2, rows.hand + m.cardH / 2 + m.fanLift],
    ];
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]![0], `band ${i} overlaps the one above`).toBeGreaterThanOrEqual(bands[i - 1]![1]);
    }
  });

  it('never shrinks a card below something worth tapping', () => {
    // A viewport far narrower than any phone still yields a usable card.
    const m = metricsFor(200, 400, 'stacks');
    expect(m.cardW).toBeGreaterThanOrEqual(46);
  });

  it('scales every dimension together, so the table shrinks as one piece', () => {
    const phone = metricsFor(IPHONE.width, IPHONE_SURFACE, 'stacks');
    const ratio = phone.cardW / DESKTOP_CARD_W;
    expect(phone.cardH / phone.cardW).toBeCloseTo(106 / 76, 1);
    expect(phone.peek).toBeCloseTo(14 * ratio, 0);
    expect(phone.fanLift).toBeCloseTo(26 * ratio, 0);
  });

  it('marks a phone compact and a laptop not', () => {
    expect(metricsFor(393, 800, 'stacks').compact).toBe(true);
    expect(metricsFor(479, 800, 'stacks').compact).toBe(true);
    expect(metricsFor(480, 800, 'stacks').compact).toBe(false);
    expect(metricsFor(1280, 745, 'stacks').compact).toBe(false);
  });
});

/**
 * The check that was missing.
 *
 * The old assertions were "no card off-screen" and "nothing over the status
 * pill". Both faults found on a real phone passed those: the trick piles were
 * on-screen, and they collided with *other cards* rather than with chrome.
 * Nothing asserted that two things belonging to different zones stay apart.
 *
 * These build every band's extent from the same functions the view uses, at
 * the sizes a phone actually offers — a browser gets roughly 660px of a 852px
 * iPhone once Safari has taken its share, and testing at 852 is what let this
 * through.
 */
describe('nothing collides, at any size', () => {
  interface Band {
    name: string;
    top: number;
    bottom: number;
    left?: number;
    right?: number;
  }

  const SIZES = [
    { label: 'iPhone in Safari', width: 393, height: 612 },
    { label: 'iPhone SE in Safari', width: 375, height: 552 },
    { label: 'iPhone, no browser chrome', width: 393, height: 804 },
    { label: 'laptop', width: 1280, height: 745 },
  ];

  function overlap(a: Band, b: Band): number {
    const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (vertical <= 0) return 0;
    // Bands without a horizontal extent span the table, so a vertical clash is
    // a real one.
    if (a.left === undefined || b.left === undefined) return vertical;
    const horizontal = Math.min(a.right!, b.right!) - Math.max(a.left!, b.left!);
    return horizontal > 0 ? Math.min(vertical, horizontal) : 0;
  }

  describe('7-8', () => {
    for (const { label, width, height } of SIZES) {
      it(`fits a ${label}`, () => {
        const m = metricsFor(width, height, 'stacks');
        const usable = height - m.statusBand;
        const rows = stackTableRows(m, usable);
        const margin = trickBandMargin(m, width);

        const stackRow = (centre: number): Band => {
          const ends = [0, 4].map((i) => stackRowPosition(m, i, 5, { x: width / 2, y: centre }));
          return {
            name: 'stacks',
            top: centre - m.cardH / 2,
            bottom: centre + m.cardH / 2 + m.peek,
            left: ends[0]!.x - m.cardW / 2,
            right: ends[1]!.x + m.cardW / 2,
          };
        };

        const bands: Band[] = [
          { name: 'name plate', top: rows.opponentName - m.nameBand / 2, bottom: rows.opponentName + m.nameBand / 2 },
          { ...stackRow(rows.opponentStacks), name: 'their stacks' },
          { name: 'trick', top: rows.trick - m.cardH / 2, bottom: rows.trick + m.cardH / 2,
            left: width / 2 - (TRICK_WIDTH * m.cardW) / 2, right: width / 2 + (TRICK_WIDTH * m.cardW) / 2 },
          { ...stackRow(rows.ownStacks), name: 'your stacks' },
          { name: 'hand', top: rows.hand - m.cardH / 2, bottom: rows.hand + m.cardH / 2 + m.fanLift },
          { name: 'status band', top: usable, bottom: height },
        ];

        for (let i = 0; i < bands.length; i++) {
          for (let j = i + 1; j < bands.length; j++) {
            expect(
              overlap(bands[i]!, bands[j]!),
              `${bands[i]!.name} overlaps ${bands[j]!.name} on a ${label}`,
            ).toBe(0);
          }
        }

        // Everything stays on the table.
        expect(bands[0]!.top).toBeGreaterThanOrEqual(0);
        expect(Math.max(...bands.map((b) => b.right ?? 0))).toBeLessThanOrEqual(width);
        expect(Math.min(...bands.map((b) => b.left ?? width))).toBeGreaterThanOrEqual(0);
      });

      it(`keeps the trick chips clear of everything on a ${label}`, () => {
        const m = metricsFor(width, height, 'stacks');
        const margin = trickBandMargin(m, width);
        // The chips live in the margin beside the trick, which is empty by
        // construction: the drop area is a fixed number of cards wide.
        expect(margin, `no room beside the trick on a ${label}`).toBeGreaterThan(40);
      });
    }
  });

  describe('Sevens', () => {
    for (const { label, width, height } of SIZES) {
      it(`keeps every row identifiable on a ${label}`, () => {
        const m = metricsFor(width, height, 'rows');
        const usable = height - m.statusBand;
        const centres = [0, 1, 2, 3].map((i) => rowBand(m, i, 4, usable));

        for (let i = 1; i < centres.length; i++) {
          const step = centres[i]! - centres[i - 1]!;
          // Rows may overlap -- four rows of thirteen ranks will not fit a
          // phone otherwise -- but only by an amount that leaves the rank and
          // suit showing.
          expect(step / m.cardH, `rows too tight on a ${label}`).toBeGreaterThanOrEqual(m.rowExposure - 0.001);
        }

        // The top row clears the opponents' name plates -- which is all they
        // have now that their hands are not drawn -- and the bottom row stops
        // before
        // the hand starts -- not "within a card of it", which is what the
        // first version of this assertion allowed and why a 26px overlap of
        // the hand went unnoticed.
        expect(centres[0]! - m.cardH / 2, `first row rides up on a ${label}`).toBeGreaterThanOrEqual(
          rowsTop(m) - 0.001,
        );
        expect(centres[3]! + m.cardH / 2, `last row runs into the hand on a ${label}`).toBeLessThanOrEqual(
          handTop(m, usable) + 0.001,
        );
      });

    }
  });
});

/**
 * The one-tap play button sits on the card it plays, and hand cards are fanned,
 * so "where is the middle of that card" is a question with a rotation in it.
 * Getting it wrong puts the button beside the card rather than on it.
 */
describe('finding the middle of a card that has been turned', () => {
  it('is the plain middle when the card is square on', () => {
    const centre = cardCentre(M, { x: 100, y: 200, rotate: 0, z: 0 });
    expect(centre.x).toBeCloseTo(100 + M.cardW / 2, 6);
    expect(centre.y).toBeCloseTo(200 + M.cardH / 2, 6);
  });

  it('turns the middle about the fan pivot, not about the middle itself', () => {
    const turned = cardCentre(M, { x: 100, y: 200, rotate: -15, z: 0 });
    const square = cardCentre(M, { x: 100, y: 200, rotate: 0, z: 0 });
    // A pivot low on the card swings the middle sideways as it tips.
    expect(turned.x).toBeLessThan(square.x - 5);
    // The middle stays the same distance from the pivot, whatever the angle.
    const pivot = { x: 100 + M.cardW * FAN_PIVOT.x, y: 200 + M.cardH * FAN_PIVOT.y };
    const reach = (p: { x: number; y: number }): number => Math.hypot(p.x - pivot.x, p.y - pivot.y);
    expect(reach(turned)).toBeCloseTo(reach(square), 6);
  });

  it('mirrors, for a card turned the other way', () => {
    const left = cardCentre(M, { x: 0, y: 0, rotate: -12, z: 0 });
    const right = cardCentre(M, { x: 0, y: 0, rotate: 12, z: 0 });
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(left.x - M.cardW * FAN_PIVOT.x).toBeCloseTo(-(right.x - M.cardW * FAN_PIVOT.x), 6);
  });
});

describe('where the play button sits on a card', () => {
  const SIZE = 40;
  const where = (rotate: number) =>
    cardPoint(M, { x: 0, y: 0, rotate, z: 0 }, 0.5, playButtonY(M, SIZE));

  it('floats clear above the card rather than covering its face', () => {
    // The button's lower edge sits exactly the gap above the card's top edge.
    const at = where(0);
    expect(at.y + SIZE / 2).toBeCloseTo(-PLAY_BUTTON_GAP, 6);
    expect(at.x).toBeCloseTo(M.cardW / 2, 6);
  });

  it('rides above the card in the card\'s own frame, not the screen\'s', () => {
    // On a fanned card the button leans with it, so it stays over the card it
    // belongs to instead of drifting across its neighbour.
    const straight = where(0);
    const tilted = where(-15);
    expect(tilted.x).toBeLessThan(straight.x - 5);
    // Its distance from the card's middle does not change with the angle.
    const reach = (p: { x: number; y: number }, rotate: number): number => {
      const centre = cardCentre(M, { x: 0, y: 0, rotate, z: 0 });
      return Math.hypot(p.x - centre.x, p.y - centre.y);
    };
    expect(reach(tilted, -15)).toBeCloseTo(reach(straight, 0), 6);
  });
});
