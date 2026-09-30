# Ride Along

SDK **v0.1.4**. A first-person bicycle ride along a river. Your selected Friend rides
in the front basket, facing you and reacting to the ride.

**Prototype status.** This build covers one course (a riverside start, a braking descent
with two hairpins, a bridge over the river, the climb to the summit and a long fast descent
to the finish), the riding controls, the basket Friend and a little sound. Coins, session
upgrades and a bonus stage are not implemented.

The sunset appears only at the top.

When the game opens, your Friend (shown on the title card with its family) walks up the
path and hops into the basket; the first stroke skips this. After a few seconds above
20 km/h, the Friend turns to look down the road ahead for a while (and keeps looking even
if you slow down), then turns back to you. Each time you pass 32 km/h it turns to you and
hops twice with a little note above its head, and it flaps about while you are that fast. It shows a "!" when you are close
to falling, and is thrown out (wide-eyed) of the basket when you fall, climbing back in when you restart.
It blinks now and then, shows a "?" when you stop and it looks around, and a heart when you
ring the bell while stopped or when it cheers at the finish. After a fall into the water it
shakes itself dry, and from the third fall on it wears a small white cross-shaped plaster on its head. Balance-type Friends lean
against the bicycle's lean to help; Power-type Friends brace themselves on climbs (and sweat on
the steep one). From your second ride, each new section shows
how far ahead (green) or behind you are against your best ride this session.

## Goal

Ride to the finish line partway down the long descent, marked by a floating coin (a
$RAREFRIENDS-style token with your own Friend on it) and a dotted line across the path.
Ride through the middle to collect the coin.
Crossing it slows time for a moment, pops up **GOAL** and slowly closes in on your Friend,
who jumps for joy in slow motion under a name plate (family, type and Friend number), while
the edges of the screen soften and glow. Then time runs
normally again and the bicycle rolls on by itself into the valley while your Friend turns
round to look at the view and a flock of birds takes off, then turns back and hops. With
reduced motion there is no slow motion and no close-up. A card then shows your time (from the
first stroke), how many times you fell, your top speed, your best time this session and the
builder's best, with **Ride again**. The session best lives only in the page and is gone on
reload.

Times earn a rank: **Bronze** within 3:10, **Silver** within 2:40, **Gold** within 2:25, and a
**Builder coin** for beating the builder's best. The card also names the next rank to aim for.

**Copy for X** copies a one-line result (time, rank, Friend number) so you can paste it into a
post yourself. The game cannot open X: the sandbox has no popup or navigation permission, and
the SDK rules forbid both. If the copy is refused, the text appears in a box to copy by hand.

With reduced motion on, the Friend's entrance, flight, turn and cheering, its reactions and
marks, the close-up, the birds and the speed lines are skipped and the Friend simply stays seated.

From the SDK checkout:

```sh
npm run dev:game -- games/ride-along
```

Connect your wallet on Robinhood and select an owned hardwired Generations NFT.
The ordinary SDK runtime verifies ownership before play. This component contains no
alternative identity flow and no preview bypass. The component calls `client.read()`
on mount to initialize runtime state, even though it has no economy actions.

## Controls

| | Keyboard | Touch |
| --- | --- | --- |
| Pedal | `A` and `D`, **alternating** | The **A** and **D** pads, bottom left |
| Steer | `←` `→` (held) | The arrow pads, bottom right, held |
| Brake | `↓` or `Space` (held) | The **BRAKE** lever below the arrow pads, held |

You start standing with a foot down. The first stroke, with either pedal, pushes off,
and the bicycle stays steady until you pass about 10 km/h.
Pressing the same pedal twice does nothing; the stroke only counts when it alternates.
Below 20 km/h a stroke takes about a third of a second to deliver its power. A single tap
starts it and it finishes on its own; the pad shrinks as it pushes. When the stroke is done
the other pad glows, which is the moment to tap it. Tapping the other pad too early cuts
the stroke short, so mashing gets you almost nowhere. Above 20 km/h each tap delivers its
power at once. The yellow-green bar under the speed is your stamina: steady pedalling (up to
about three and a half strokes a second) never empties it, but mashing drains it in a few seconds and
your strokes lose power until you ease off. When it runs low the bar blinks and your Friend
bounces in the basket, cheering you on.

A short control hint is shown for the first 40 m.
Settings (the gear, top right) has **Restart from the start**.
The brake is a plain deceleration and is not coupled to lean, so it will not throw you
on its own -- but braking down to a crawl makes the bicycle unstable, so you cannot
simply hold it through a corner.

## How it rides

Speed is the whole game.

- **Faster is steadier but wider.** The bicycle straightens itself more strongly the
  faster it goes, so at speed you cannot lean far enough to make a tight corner.
- **Slower is twitchier.** Below a critical speed the machine starts to fall away from
  upright on its own and wanders. Let it get too slow and you go down.
- **Turning costs speed.** Leaning bleeds momentum, so every corner is a decision.
- **Your legs have a limit.** Each stroke adds less speed the faster you already go, and
  pedalling adds almost nothing above about 30 km/h on the flat and about 17 km/h on a steep
  climb. Anything faster comes from gravity on a
  descent, up to about 44 km/h.
- **Hills do the rest.** Climbs drain speed, descents build it. On the hairpin descent you
  will be too fast to turn unless you brake; the last descent has no tight corners.
- **The brake is the blunt option.** It scrubs speed faster than a corner does, but it
  costs you the stability that speed was buying.

You fall by leaning past the limit, by leaving the path, by riding off the edge of the
bridge or by riding into the river. Falling restarts you a short
way back, standing with a foot down again. The basket rocks with speed and lean, so the Friend tells you how close to the
edge you are before the fall happens.

## Friend

The selected Friend is drawn from the canonical SDK sprite reader at integer scale with
the usual clipped white halo. The artwork itself is unchanged except for two small touches:
the eyes (the small enclosed holes nearest the top of the sprite) close for a blink or grow
by one pixel while the Friend is thrown out, and a small white cross-shaped plaster is drawn at
the top corner of its head after three falls. Friends whose sprite has no such holes (Hollow) keep their eyes as drawn. It mostly uses the `down` frame so it faces the
rider, and the side and `up` frames when it turns to look around or down the road.
Friends without `up`/`down` frames fall back to the SDK's side-facing frames.

Each Friend rides a little differently. Its family sets a type, shown on the title card:
**Power type** (Skeleton, Colossus, Mask) pedals about 8% harder but is about 8% less steady,
**Balance type** (Hoverer, Sparkling, Hollow) is the reverse, and **All-round type** (Family,
Cellular, Asymmetry) is even. The Friend's id shifts that split by up to 3%, and older
generations get a small bonus to both (Gen-1 +4%, Gen-2 +2%), read from the Generations
contract's public `generation(tokenId)` over the same public RPC the SDK uses for artwork.
If that read fails, the game simply starts without the bonus. The same Friend always rides
the same way.

## Accessibility and motion

Settings include a reduced-motion toggle, which also follows
`prefers-reduced-motion`. It stops the basket sway, the sprite animation, the Friend's
entrance, flight, turn and cheering, its blinking and wide eyes, the close-up after the finish, the speed lines and the birds. It does
**not** stop the bicycle's low-speed wobble, because that is part of the controls rather
than decoration. The bottom of the scene is kept clear for the runtime toolbar; the
clearance is measured in device pixels and recomputed from the canvas's displayed height,
so the handlebars stay above the toolbar on narrow screens as well as at 960px. The
control pads move up and shrink at phone sizes.

## Sound

There are five sounds: the brake hiss, the bicycle bell (when you push off and when you
cross the finish line), a short high beep when you are about to fall, a softer blip when
your Friend hops for joy and a little wooden knock when you fall. Instead of background music,
your Friend hums: once you are riding smoothly above about 12 km/h it now and then hums a
short phrase, with long pauses in between (small white notes rise beside its head while it does), a livelier,
higher tune above 30 km/h, and a slow, broken hum on the steep final climb. It falls silent
after the finish and when you stop, slow right down, run out of stamina, are about to fall or fall, and each
Friend's voice is pitched slightly differently. All are synthesized in
the browser with Web Audio; there are no recordings or third-party audio assets.
Audio starts only after your first key press or tap. The speaker button at
the top right and the **Sound** box in Settings mute everything. The game plays normally
if audio is unavailable.

## Progress and economy

Progress is local to the session and resets on reload; nothing is written to the Friend.

Riding costs **0 RF** and has no purchases, consumables or rewards. The v0.1.4 runtime
still requires a chance-game `game.json`, so this game includes **unused schema-only
terms**: a 1 RF token with a single 100% (10,000 basis points) 1 RF reward, each encoded
as `1000000000000000000` RF base units. The component never calls `buy`, `play`, `settle`
or `redeem`. Those terms do not charge for riding and do not describe an implemented
activity.

## Artwork

The scene is drawn into a 192x128 buffer and scaled to 960x640 with image smoothing
disabled, so everything shares one pixel grid. The Friend sprite is placed in that
buffer at 2x (each Friend pixel is 2x2 buffer pixels), which puts it on screen at 160x160.
The river, path, trees, handlebars and basket are drawn by the included canvas source;
there are no external scenery assets. The basket, Friend and handlebars are drawn upright
into a separate buffer and then rotated with smoothing off, so they stay on the pixel grid
when the bicycle leans. Every frame is then snapped to a fixed 27-colour palette.

Headings, numbers, the HUD and buttons use **Silkscreen** by The Silkscreen Project Authors
(<https://github.com/googlefonts/silkscreen>), bundled in `assets/` as WOFF2 converted from the
Google Fonts TTF, under the SIL Open Font License 1.1 (`assets/silkscreen-OFL.txt`). Longer text
stays in the system monospace font for readability. The medals and the placeholder builder coin
are pixel art drawn in the component source. Friend
pixels remain canonical SDK artwork, drawn between the back and front of the basket so the
Friend sits inside it.
