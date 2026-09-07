# Patte

A virtual card table. One deck, a link, and whoever you send it to.

The goal is the feel of sitting around a table: pick cards up, put them down,
hide them, show them, deal, argue, start again. Rules for specific games come
later and sit on top; they are not what the table is made of.

## Running it

```bash
npm install
npm run build
```

Then, in two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

`dev:server` runs a compile watcher and a server watcher under a small
supervisor (`packages/server/dev.mjs`). The server is not run straight from
source: Node's type stripping does not rewrite the `.js` import specifiers that
NodeNext requires, so the TypeScript is compiled and the emitted output runs.
Editing anything in `core` or `server` rebuilds and restarts; stopping the
script takes both watchers with it.

Open http://localhost:5173, start a table, and send the URL to someone. The
room code is in the link.

> One browser is one player. Identity lives in `localStorage`, which is what
> lets a refresh put you back in your seat with your hand intact — but it also
> means two tabs on the same origin are the same person. To test with two
> players locally, use `localhost` in one tab and `127.0.0.1` in the other, or
> open one in a private window.

To play from a phone on the same Wi-Fi, use the machine's LAN address —
`http://192.168.x.x:5173/?t=CODE`. The dev server is bound to all interfaces
for this.

> Anything served from a bare IP over HTTP is **not a secure context**, so
> `crypto.randomUUID` and `navigator.clipboard` do not exist there. Nothing in
> the app depends on either: ids come from `randomUuid()` in core, which uses
> `crypto.getRandomValues`, and copying the invite falls back to showing the
> table code. Worth remembering when adding anything new — the failure only
> ever shows up on a real device, never on localhost.

```bash
npm test
```

## How it is put together

```
packages/core     the engine: state, events, visibility, rulesets
packages/server   rooms, sockets, authority
packages/client   the table itself
```

**The server is the only thing that decides anything.** Clients send *intents*
("I would like to move this card"); the server validates, appends an event to
an append-only log, and broadcasts a **per-player filtered** view of what
happened. A client is never sent the face of a card it may not see — not
hidden with CSS, not sent-and-flagged, but absent from the payload. Face data
that never leaves the server cannot be read out of the network tab.

**Zones are the whole abstraction.** The deck, the discard, a player's hand, a
trick, a meld pile and the middle of the table are one type, differing only in
visibility, layout and owner. Nearly every action is a `move` between them —
dealing, drawing, playing, discarding and passing are all the same verb. Add
`flip`, `shuffle` and `reveal` and you have almost every classic card game.

**Sandbox is the null ruleset.** `Ruleset` answers two questions: is this legal
right now, and what follows from what just happened. Free play is the ruleset
that allows everything, so the sandbox and a future enforced Hearts run on one
code path rather than two. Structural rules that hold for *every* game — you
may only move a card you are holding, you may not reach into a private hand —
live in the engine, where a buggy ruleset cannot open a hole in them.

**Randomness is resolved before it is recorded.** Intents may be ambiguous or
depend on chance; events never are. "Shuffle" becomes a concrete permutation
before it is written down. That keeps the reducer pure and means live state can
always be reproduced by replaying the log from empty — which is asserted in the
tests.

**The client predicts only what it can already see.** A drag applies instantly
and reconciles when the server answers. Shuffling and drawing from a face-down
pile depend on information the client does not have, so those wait. What is on
screen is always `confirmed + replay(pending)`, which makes rolling back a
denied action nothing more than leaving it out of the replay.

## What it does today

Pick a game when you start a table.

**Free play is built but not currently offered.** It is the *null* ruleset —
the one that permits everything, which the refereed games are defined as
restrictions of — so the engine is built on it and much of the engine's test
suite is written against it. It is left out of `OFFERED_RULESETS` rather than
out of `RULESETS`: one line to put back, and the base case stays where the
architecture needs it. The sandbox verbs (deal, shuffle, gather, free
placement on the felt, hand-to-hand passing, manual turn order) are all still
there behind it.

**बदाम सात** (Badam Saat — elsewhere Sevens, Fan Tan, Card Dominoes,
Parliament) — refereed. The whole deck
is dealt out; four rows are built on the table, one per suit, each growing
outward from its seven. First player out of cards wins, and the rest are ranked
by what they were left holding.

Two house rules are pinned down, since both vary in the wild:

- **Ace is low.** Rows run A-2-…-7-…-K.
- **The holder of the seven of hearts opens** and must play it. The
  alternative — the player left of the dealer begins — can open with a forced
  pass, which is a poor first move in a game people are learning.

The rule worth having a computer for is the one a physical table cannot check:
**you must play if you can.** Knocking is refused while you hold anything
playable, and the client lights up exactly the cards the engine would accept —
asked of the ruleset, not reimplemented in the UI, so the highlight and the
verdict can never disagree.

**Dealing again needs agreement.** The Redeal button asks rather than acts:
everyone still in the game has to say yes, and one refusal ends it. Whoever
asks has already seen their cards, so an unchecked redeal is a way to keep
dealing until the hand suits you — which is a thing a physical table prevents
by everyone watching, and a thing this one has to prevent explicitly. The same
applies to *Start a new match* while a hand is in progress. A `startGame` that
would interrupt a hand is refused outright; every path that deals goes through
one shared builder, so a deal that arrived by consent is indistinguishable
from any other.

**सात-आठ** (Saat-Aath, 7-8) — two players, thirty cards, fifteen tricks. Each stack shows the
back of its buried card peeking out from under the face-up one, so you can see
at a glance which stacks still hold something and which are down to their last
card. A decided trick stays face up in the middle until its winner presses
**Take**, and only
then does it go face down into their pile, where nobody — including them — can
look through it again. The non-dealer
names trump and must take eight; the dealer must take seven. Each player holds
five cards and has five two-card stacks in front of them — a face-up card with
an unknown one beneath, uncovered when its cover is played. Because the quotas
add up to exactly the number of tricks, the whole result is one number: the
dealer taking exactly seven is a draw, and anything else means one player beat
their quota by exactly the margin the other missed by. You score that margin,
so here the *highest* total leads.

One deliberate departure from the published rules: **there are no
super-trumps.** 7♥ and 7♠ are ordinary low cards of their suits rather than big
and small jokers, which makes the ace of the called trump the highest card in
the game and card comparison a plain two-key sort with no special cases.

**Scoring and matches.** A table plays a match of however many rounds you set
when you create it, adjustable later from the Match menu. Each round, whoever
goes out scores nothing and everyone else scores what they were caught
holding — ace 1, pip cards their own number, jack 11, queen 12, king 13. The
scoreboard shows every round and a running total; lowest leads. The owner can
extend the match or end it early, in which case a round in progress is
abandoned rather than scored.

## Playing on a phone

The table sizes itself. Card dimensions are not constants — `metricsFor` in
`geometry.ts` solves for the largest card that fits both axes of the box it is
given, and every other dimension derives from it, so the table shrinks as one
piece. A laptop gets 76×106 exactly as before; a base iPhone gets 67×93 for
7-8 and 64×89 for Sevens, which is what makes a 7-8 stack row fit 393px when
it needs 416 at full size.

The lobby is the one screen that scrolls. Everywhere else `body` is pinned —
a card game that slides under your thumb is unplayable — but the lobby is a
form that grows when you pick a game, and on a short phone the join-by-code
row went off the bottom with no way to reach it. It opts back in to panning,
and centres its card with an auto margin rather than by centring the grid: a
centred item taller than its container overflows in *both* directions, and the
top goes out of the scroller's reach.

Below 480px the chrome compacts: the sandbox verbs fold into a menu, the trump
strip takes a row of its own instead of floating, and safe-area insets keep
everything clear of the notch and home indicator. Portrait only — landscape
has the width but nowhere near the height.

**Select, then place.** Tap a card to select it, tap where it goes. Dragging
still works with a mouse, but it is no longer the only way in: dragging a card
out of a fanned hand is fine with a pointer and close to impossible with a
thumb. Tapping bare felt cancels — one gesture backs out of anything
half-finished.

**Crowded hands open.** A Sevens hand of twenty-seven cards leaves under ten
pixels of each one showing, so below a thumb's width the fan stops being
something you pick from and becomes something you open: a scrolling strip at
full card width. Nothing there is decided on the press — a drag that starts on
a card has to be able to become a scroll, so the tap is settled on release and
the browser's pan is never cancelled.

Crowded means *the count* has squeezed the fan, not that the cards are small:
the threshold is a thumb's width or the fan's own natural pitch, whichever is
less, since demanding more than a full fan could ever offer would send you to
the sheet to choose between your last two cards. On a base iPhone that comes
out at **eight cards** for Sevens and **seven** for 7-8 — so 7-8, which deals
five to the hand, is played straight from the fan almost throughout, and
Sevens opens the sheet until the endgame. A laptop reaches twenty-eight, which
is more than a two-handed deal, so the sheet effectively never appears there.

The strip finishes the play itself where it can: tap a card and the check
appears on it *in the strip*, rather than closing the sheet and asking you to
find the same card again in the fan. It closes on the play. Where the card has
a real choice of destination the sheet still hands back to the table, because
that choice cannot be made from inside a row of cards.

**One tap plays a card.** Pick a card and a green check floats just clear of
its top edge — off the card, not on it, so it covers neither the rank you are
committing nor the neighbouring card in the fan — and tapping it sends the
card where it is allowed to go. It rides above the card in the *card's* frame,
so on a fanned hand it leans with the card it belongs to. The destination comes from
the ruleset, not from the client — `destinationsFor` answers "where may this
card go, right now", and the button only appears when the answer is exactly
one place. More than one is a real choice and stays the player's to make by
placing the card, which is the fallback the button never overrides. So the
shortcut skips a step that had one answer; it never picks on your behalf.
(This is also why the button has to know where a *turned* card actually is:
hand cards are fanned, and a button at the unrotated middle misses by nine
pixels. `FAN_PIVOT` is shared by the card's `transform-origin` and by
`cardCentre`, so the two cannot drift.)

**Sort** in the bottom right corner puts your own hand in reading order:
spades, hearts, clubs, diamonds, and within a suit whichever direction the
game itself runs — ace to king in Sevens, matching the rows you are building
on, and strongest first in 7-8, matching the order that decides tricks. The
order is `handOrder` on the ruleset, so it is a fact about the game rather
than a rule in the UI. It is a toggle, so a sorted hand stays sorted as you
play out of it, and turning it off gives the hand back as dealt.

Sorting is deliberately **local to your screen and never sent**. Everyone can
already see the card ids in your hand and which position you play from; if the
server held a sorted order, an opponent could watch those positions and work
out how your cards rank against each other. A view costs nothing and leaks
nothing.

**Opponents' hands are not drawn at all.** A fan of identical backs tells you
one thing — how many cards they hold — and their name plate already says that
in a form you can read at a glance. It cost a band of table on every screen,
so it is gone, and the rows and stacks spread into the room it was using. A
hand you *can* read is a different matter: in a sandbox with open hands those
faces are the point, and they still fan normally.

**Rows never overlap on a phone.** On a roomy screen suit rows may tuck under
one another a little; there is space and the cards are large. On a phone they
may not — two small cards stacked at the same rank read as a jumbled pile
rather than two rows — so the requirement is full separation and the solver
pays for it by shrinking the card. Sevens lands at 64×89 on a base iPhone,
where 65×91 with a 37% tuck was unreadable. A smaller card you can read beats
a larger one behind another card — though in the end the card barely shrank at
all, because dropping the opponents' hands gave the rows back the height they
needed.

**Card text scales with the card.** Everything printed on a card is sized in
`em` against a font size derived from its width, so the rank, suit and pip
shrink with it. A fixed 13px index crowds a 54px card.

**Trick piles become a chip.** A pile of won tricks is face down and sealed,
so a count says everything the cards could. On a phone there is nowhere to put
a real pile that is not already spoken for, so each player gets a chip in the
margin beside the trick — space that is empty by construction, because the drop
area is a fixed number of cards wide and centred.

One rule earned the hard way: **the fit model must be derived from the
placement, never restated alongside it.** Three separate faults came from the
two drifting apart — Sevens rows that never shrank, rows that rode up over the
opponents, and rows that ran into the hand. `rowsTop` and `handTop` are now
shared by both.

## A note on stacking

Two rules, both learned by getting them wrong:

**The toolbar sits above the table.** It used to be at `z-index: 10`, which put
it *under* every card — cards layer up to 9500 and `.surface` opens no stacking
context of its own, so they compete with the toolbar directly. The Match menu
hangs off the toolbar, so it inherited the problem and opened behind the felt:
present, and entirely invisible.

**An overlay covers the table, not the room.** Panels start below the toolbar
rather than at the top of the window, so the code, the menu and the way out
stay reachable while a question is on screen. The toolbar publishes its own
height as `--toolbar-h`, because it wraps onto a second row on a narrow screen
and any hardcoded guess would cover the room code — measured, it comes out at
48px on a phone and 170px in a very narrow window.

## A note on the status readout

Whose turn it is, and the one button that is yours to press, sit in a pill
centred just beneath your own cards, where you are already looking. The table
reserves a band for it rather than letting it float, so a fanned hand can
never come down over the top of it. It brightens and picks up a gold border
when something is actually being asked of you, and recedes while it is
somebody else's move.

Name plates get a reserved band too. Anything drawn near the cards needs one:
the plate is about forty pixels tall, and reserving less than it occupies puts
the cards straight back over it.

It says as little as it can. "No valid plays" beside a **Skip turn** button
replaced a sentence explaining what knocking is: the pill is a phone-width
strip under your cards, and a full explanation there wraps to two lines and
pushes the cards up. The traditional word for the move is *knock*, which the
button no longer uses — it describes what pressing it does instead, since it
is only ever pressable when there is nothing else you can do.

This is still being settled. `PLACEMENT` in `GamePanel.tsx` switches between
`hand`, `corner` (bottom-left) and `bar` (its own full-width row below the
table). Free play shows no readout at all.

Card positions follow from the measured size of the table, so anything that
changes that size has to trigger a fresh measurement — `useElementSize` takes
a dependency list for exactly that, since `ResizeObserver`'s first callback
cannot be relied upon.

## Hosting it

One process serves everything: the built client, `/api`, and `/ws`, on a single
origin. That is what lets the client ask for `/api/rooms` relatively and work
`wss:` out from the page's own protocol — it needs no build-time configuration
and no CORS, wherever it is hosted. No history fallback is needed either: a
table's code is a query parameter, so every URL this app produces is `/`.

```bash
npm run build && CLIENT_DIR=packages/client/dist HOST=0.0.0.0 npm start
```

The `Dockerfile` does exactly that and sets `HOST`, `CLIENT_DIR` and
`TRUST_PROXY`. `render.yaml` and `fly.toml` are two ways to run that image;
the image is the same either way.

| Variable | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `HOST` | 127.0.0.1 | `0.0.0.0` in a container |
| `CLIENT_DIR` | unset | where the built client is; unset in development, where Vite serves it |
| `MAX_ROOMS` | 2000 | tables that may exist at once |
| `CREATE_LIMIT` | 30 | tables one address may open per hour |
| `TRUST_PROXY` | false | believe `X-Forwarded-For`; only true behind a proxy that sets it |

**Rooms live in memory, so a restart ends every table.** Deploys, crashes and
free tiers that stop when idle all have the same effect. This is fine for
"we are all playing now" and no use for "join whenever you like" — the fix is
persistence, not a bigger instance. Two consequences worth knowing:

- The reaper deletes an *empty* room thirty minutes after its last activity,
  on any host, paid or free. Paying for an always-on instance does not by
  itself let anyone come back to a table tomorrow.
- Joining a code with no room behind it now says **"That table has closed"**
  rather than silently opening a new empty one under the same code. A typo, a
  reaped table and a restarted server used to be indistinguishable from your
  game being replaced by a sandbox.

The client sends a ping every thirty seconds. The socket is otherwise silent
whenever nobody is doing anything — four people thinking about their hands
send nothing at all — and silence is indistinguishable from a dead connection
to a proxy, and from an idle process to a host that stops them. It gives up
reconnecting after twenty attempts rather than retrying for ever, and picks
back up when the tab is shown again or the network returns: a tab left open on
a dead table used to poke the server every eight seconds for as long as it
existed, which is enough on its own to keep a sleeping instance awake.

## Leaving, and coming back

**Leave** in the toolbar returns to the home screen: it drops the code from
the URL and closes the socket. Mid-game the button asks a second time, since a
stray thumb on a phone should not drop you out of a hand.

Nothing is given up by leaving. The server has always treated a closed socket
as a player who has stepped away rather than one who has gone: `Room.leave`
marks them disconnected and keeps the seat, the hand and the turn, dropping
only their grab locks so nobody is left unable to touch a card. `Room.join`
with the same player id takes the seat straight back. So *leaving is a
disconnect you meant*, and rejoining is a reconnect — the same path a phone
going to sleep already used. The lobby fills the code back in and says so.

Two details make that work in practice:

- **Identity lives in `localStorage`** (`patte:playerId`), so it survives a
  reload and a browser restart. Clearing site data, or coming back in a
  different browser or a private window, makes you a *new* player who takes a
  new seat — the old one stays behind, holding its cards.
- **The room outlives everybody in it, but not forever.** An empty room is
  reaped `ROOM_TTL_MS` (30 minutes) after its last activity. Rejoining after
  that does not fail: `getOrCreate` opens a *fresh* room under the same code,
  and the table you left is gone. Silently, which is the sharpest edge here.

There is a second, harder notion of leaving that nothing calls yet:
`Room.evict` commits `playerLeft`, which vacates the seat, drops the player
from the turn order so the table stops waiting on a chair that is not coming
back — and leaves their hand on the table as an ownerless zone. That is what a
real "I am done with this game" needs, and it is not the same action as this
one.

## A note on cursors

Everybody's pointer is shared, but raw coordinates do not survive the trip:
every client draws its *own* hand along the bottom edge and puts everyone
else's at their seat along the top. "The middle of the bottom" therefore means
one player's cards to the sender and a different player's cards to the
receiver.

So a cursor is sent as an offset from whichever zone it is over, and each
client re-anchors it against its own layout. Hover your hand and the others
see your pointer over *your* seat, where it belongs. Over the shared middle
of the table the two layouts agree and the raw position is used directly.

## Adding a game

A ruleset answers three questions and never touches a card itself:

```ts
setup({ players, rng, match })       // lay out the table and deal
validate(state, intent, actor)       // is this allowed right now?
after(state, event)                  // what follows from what just happened?
legalCards?(state, playerId)         // optional: what the UI should light up
destinationsFor?(s, playerId, card)  // optional: where that card may go
handOrder?                           // optional: how a hand reads best
awaitingChoice?(state)               // optional: play is paused for a decision
scoreDirection, scoreNote            // which way the scoreboard reads
passLabel?                           // omit when the game has no passing
```

Zones can be marked `sealed`: cards go in and never come out. Won tricks and
cards already played to a layout are settled facts, and without it a zone's
owner could reach back into their own winnings.

A ruleset that needs state it cannot read off the zones — which suit is trump,
whose deal it is — keeps it in `state.gameData`, a scratchpad the engine
carries and never inspects. Anything that *can* be derived should be: 7-8
counts tricks as the size of a pile rather than recording a tally.

Structural guards — grab locks, zone access, ownership — are enforced by the
engine *before* `validate` is called, so a buggy ruleset cannot open a hole in
them. Register it in `packages/core/src/rulesets/registry.ts` and it appears in
the lobby; nothing else needs to change. Adding Sevens required no change to the reducer. 7-8 needed rather more —
a decision partway through the deal, a scratchpad, stacked zones — but all of
it additive, and all of it the kind of thing the next trick-taking game will
reuse.

## What is next

**7-8's carry-over advantage** is the nearest gap: for every trick over quota,
the winner blindly pulls a card from the opponent's dealt five and gives one
back. It needs a second interactive pause in the deal, and the margin it
consumes is already being recorded.

Beyond that, more games by family: set collection (Rummy, Go Fish) needs a
meld that scores, and multi-player trick-taking (Hearts, Spades) mostly reuses
what 7-8 established.

Undo is designed but not built: an append-only log with compensating events, a
short self-undo window, and a vote beyond it. Reveals and peeks are already
flagged irreversible, because once someone has seen a card there is no making
them un-see it.
