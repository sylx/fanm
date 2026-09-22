# fantasy-msx API（bcf7219）

このファイルは `npm run prompts:api` で生成する。手で編集しない。

作品は `import { ... } from "fantasy-msx"` で読み込む。README の例にある `./src/index.js` は `fantasy-msx` と読み替える。

## README 抜粋

### How it works

In a real MSX - and in WebMSX - the VDP is the master clock. It walks 262
scanlines per frame and hands the CPU a few dozen cycles between each raster
event. We keep that structure intact and remove only the CPU:

```
VDP.videoClockPulse()          one frame = 262 scanlines
  -> lineEvents() x262
       cpuBusClockPulses(33)   -> a cycle counter, nothing executes
       audioClockPulse32()     -> PSG / OPLL sample generation
       renderLine()            -> pixels into the framebuffer
```

The cycle counter is not decorative: the V9938 command engine finishes a blit
when the elapsed VDP cycles pass the command's computed duration, so `HMMV`,
`LMMM` and `LINE` take the same time they take on hardware.

User code runs once per frame, before that frame's scanlines are rendered - the
same position an MSX program's VBlank handler occupies.

#### Drawing takes time, and you can see it

A real V9938 does not fill a screen between two frames. It grinds through the
rectangle while the raster keeps sweeping, so you watch the fill arrive. That
is half the character of the machine, and this console keeps it.

WebMSX's own command engine writes the whole result the instant a command is
issued and then merely holds its busy flag up - the slowness is real but
invisible. So `gfx` runs its own blitter instead: calls queue jobs, and the
queue is advanced from the CPU's time slices, about ten per scanline. Costs
per pixel are measured against the emulated chip and land close to the V9938's
published figures.

| what you draw | how long it takes |
|---------------|------------------|
| `fillRect` over the whole screen, even coordinates | 3 frames, 50ms |
| `fillRect` over the whole screen, odd coordinates | 17 frames, 283ms |
| `fillCircle` radius 100 | 10 frames, 167ms |
| `fillCircle` radius 36 | 2 frames |
| `fillCircle` radius 12, a line of text, a circle outline | 1 frame |

Even coordinates cost an eighth of odd ones, because the chip can move whole
bytes instead of reading, masking and writing each pixel. It is worth
arranging your rectangles to land on them.

Note the bottom of that table. Anything under about a quarter of the screen
finishes inside a single frame, and since `draw` queues before the frame runs,
it is complete before it is ever shown - true to the hardware, but it hides the
hardware working. Draw big if you want the machine's pace to read, or turn
`gfx.speed` down: it multiplies the chip's rate, 1 being authentic. That knob
is the one thing here that is not the V9938.

Jobs run in the order they were queued, and each one pins the page and clip it
was queued with, so a later page flip cannot make an unfinished fill paint over
the wrong buffer.

When something must land before the next frame - a HUD, a menu, the boot
screen - `gfx.now` is the same set of primitives written straight into VRAM at
no cost. It is the exception, not the default.

Three clocks, then, and they do not fight:

| | rate | cost |
|---|------|------|
| game logic | every frame | free |
| sprite movement | every frame | free, the VDP composites per scanline |
| blitter jobs | **spread across frames** | hardware speed |

Which is why the framebuffer is persistent state here rather than something
cleared every frame. Moving objects belong in the 32 hardware sprites.

### Using the BIOS

```ts
import { createBios } from "./src/bios/index.js";

const { screen, gfx, sprites } = createBios();   // SCREEN 5, sprites enabled

screen.useDoubleBuffer();                        // draw on page 1, show page 0

gfx.now.clear(1);                                // instant: the boot screen
gfx.fillCircle(128, 106, 40, 10);                // queued: arrives over a few frames
gfx.rect(8, 8, 240, 196, 15);
gfx.text(12, 12, "HELLO", 15);
// gfx.busy / gfx.pending / gfx.work report what is still owed

sprites.setPatternFromBitmap(0, [
    "..####..",
    ".######.",
    "########",
    "########",
    "########",
    "########",
    ".######.",
    "..####.."
]);
sprites.set(0, { x: 100, y: 60, pattern: 0, color: [15, 15, 11, 11, 9, 9, 6, 6] });
sprites.setActiveCount(1);

screen.flip();
screen.frame();
```

Sprite colours may be given per line, which is a V9938 feature with no
equivalent on an MSX1: one sprite, shaded, instead of two stacked.

Coordinates are whole pixels. Anything else is rounded to the nearest one on
the way in, so positions worked out with `sin` and `cos` can be passed straight
through - a fraction reaching the packing would otherwise pick its shift from
the fractional part and corrupt the pixel sharing the byte.

### Scrolling

A scroll on this machine moves nothing in VRAM. The picture stays where it
was drawn and the VDP is told where to start reading it: R23 for the line, and
- on the V9958, which is the VDP this console has - R26 and R27 for the
column. A few register writes a frame, against a blitter that needs three
frames to clear the screen once.

```ts
const { scroll } = ctx;                          // also bios.scroll, screen.scroll

scroll.set(camera.x, camera.y);                  // the whole screen
scroll.mask = true;                              // R25 MSK: hide the ragged left edge
scroll.wide = true;                              // R25 SP2: two pages side by side
```

What the display looks into is a **plane**, and it is bigger than the screen.
R23 wraps at 256 lines whatever the screen height, so there are 44 lines below
a 212-line screen that only a scroll ever shows. Across, one page is the
screen's own width; `wide` joins an even page to the odd one after it for a
plane twice that - `scroll.planeWidth` says which. Both axes wrap, so a plane
is a ring: move forever in one direction and it comes round again.

**Bands** are the part the registers alone do not give you. They are read as
each line is drawn, so changing them partway down gives the lines below
different values from the lines above - which is how a status bar holds still
over a playfield, and how hills move at half the speed of the road in front of
them.

```ts
scroll.split(0, { page: 0 });                    // the top band: a status bar on page 0
const field = scroll.split(24, { page: 2 });     // from line 24 down: the playfield

update() {
    field.x = camera.x;                          // bands are plain objects; move them
    field.y = camera.y - 24;                     // y is the plane line at the top of the *screen*
}
```

On the real machine this is a line interrupt and a handler that rewrites the
registers between two lines, and that is exactly what happens here. R19 is
armed for the last line of each band, the VDP raises its interrupt at the end
of that line, and the handler - `machine.onInterrupt`, in the CPU's seat -
acknowledges it by reading S#1 and writes the next band's registers before the
raster reaches it. A band can be one line tall. Nothing is being faked: turn
the interrupt off and the bands stop.

`y` means what R23 means, the plane line shown at the top of the screen, not
of the band. That keeps one number for one register, and it is also what
makes a band able to point a single line anywhere in the plane - see DRIFT's
lake, below.

**Sprites move with R23.** Their Y is a line of the page rather than of the
screen, so a vertical scroll carries every sprite along with the picture. On
real hardware that is a bug waiting in every scrolling game, and here it is
dealt with: `sprites.set` and `sprites.move` take screen lines, add the scroll
of the band they land in back on, and write the lot again at each vertical
sync. A sprite straddling two bands with different offsets is torn between
them, as it is on the chip. The horizontal scroll never moves sprites, so x
needs nothing.

The other half of that bug is the **ghost**. A sprite is drawn wherever its Y
meets the line being drawn plus R23, and a band with a different R23 is
looking at different page lines - so a sprite well down a scrolled playfield
can turn up in the status bar as well, whenever its page line comes round
into the bar's. A band can switch sprites off for its own lines, which the
line interrupt does with R8's SPD bit as it does the scroll:

```ts
scroll.split(0, { page: 0, sprites: false });    // no sprites, and so no ghosts, in the bar
const field = scroll.split(24, { page: 2 });
```

A sprite reaching up into such a band from the one below is written against
the band that shows it, so it slides out from under the bar in one piece.
`sprites.setEnabled` still turns them all off; a band can only take them
away.

Two things the hardware insists on:

- **The left edge.** R26 scrolls in whole groups of eight columns and R27
  then shifts the picture back right by up to seven pixels, leaving that many
  columns of backdrop at the left. `mask` blanks the leftmost eight all the
  time, so the edge is still rather than ragged.
- **Pages.** A band can show any page, and `wide` spends two on a plane. The
  sprite tables sit in the lines below the screen at the foot of page 0, so a
  plane that includes page 0 will scroll them into view. In SCREEN 5 there
  are pages 2 and 3 to use instead; in SCREEN 7 and 8 there are only two
  pages, and a plane that scrolls vertically has to live with them.

**Drawing where only a scroll looks.** Drawing stops at the screen's last line,
but a vertical scroll brings the rest of the page into view - lines 212 to
255 in a 212-line mode - and that is exactly where the line about to scroll
in has to be drawn while nobody can see it. `gfx.offscreen = true` lets
`gfx` and `gfx.now` reach them. On page 0 it stops short of the sprite
tables; `screen.pageLines(page)` says how far a page goes.

```ts
gfx.offscreen = true;
screen.setDrawPage(2);
gfx.now.hline(0, (255 - row) & 255, 256, color);  // the next line in, at the top
```

The scroll writes nothing until it is first used, so a program setting R23 or
R26 through `vdp` by hand keeps them. `screen.setScroll(lines)` is the same as
`scroll.y`. At the chip level there are `vdp.setVerticalOffset`,
`vdp.setHorizontalOffset` and `vdp.setScrollMode`.

### Text in a real typeface

`gfx.text` draws the machine's own 6x8 font - five pixels wide, seven rows, the
shapes an MSX had in ROM. `text` is the other kind: a real typeface, laid out
and rasterised by the browser on a canvas the machine never sees, then carried
into VRAM one byte per pixel like any other picture.

```ts
const { text, gfx } = createBios();

text.style = { font: "'Georgia', serif", size: 20 };   // chosen once

text.drawNow(12, 12, "CHAPTER ONE", { color: 15 });    // straight into VRAM
text.draw(12, 40, "and what\nbecame of it", {          // queued, like any drawing
    color: 10, align: "center", lineHeight: 22
});

const box = text.measure("CHAPTER ONE");               // width, height, baseline, lines
```

A face the page does not already have is fetched first, and one still loading
rasterises as the fallback - silently, and at the fallback's metrics - so an
`await` in `init` is worth it:

```ts
await text.load("Press Start 2P", "fonts/press-start.woff2");
text.style = { font: "'Press Start 2P', monospace", size: 8 };
await text.ready();                                    // faces named in CSS, too
```

What crosses the boundary is **coverage**: how much of each pixel the glyphs
cover, 0 to 255. The machine has no such quantity - a pixel is an index into
sixteen registers and nothing in between - so the coverage has to be spent on
indices that already exist, and `shades` is where you say which:

```ts
screen.setColor(8, 3, 3, 3);                           // a grey between the two

text.drawNow(12, 12, "CHAPTER ONE", { shades: [8, 15] });   // one soft step
text.drawNow(12, 40, "and what became of it", { color: 15 });  // a hard edge
```

The ramp runs palest to fullest, and the coverage is divided into as many bands
as it is long plus one: the bottom band is the background and the rest take the
ramp in order. A ramp of one is exactly a threshold - which is what `color` is -
so the antialiased path and the hard-edged one are the same arithmetic, and
`threshold` (128 by default) slides a ramp of any length towards the ink or
away from it. Lower it to fatten every stroke; raise it to thin them.

**The palette is an input, as it is for pictures.** Nothing here picks a
colour, searches for a near one, or repaints a register: every entry of the
ramp is one you set, and one the type has taken off whatever else is on screen.
Three shades is usually the most a sixteen-colour mode can afford, and small
text should stay at one - at ten pixels an em there is no flank to resolve,
only a blur where the stem was. `background` is the index behind the glyphs,
and leaving it out makes the box transparent so only the glyphs land.

The 512-wide modes are handled for you. A SCREEN 6 or 7 pixel is half as wide
as it is tall, so a line set the way SCREEN 5 sets it would come out condensed
to half its width; `text` draws the em twice as wide instead, and the same
style gives type of the same shape with twice the detail across it. `stretch`
overrides that - 1 to work in the mode's own pixels, anything else to condense
or extend deliberately.

**`snap` is for a face that is already a bitmap.** Such a face is only crisp
where its own grid lands on the machine's, and at the size it was drawn for two
things stop that. The face may hang its rows off the baseline - JF Dot K12x10
puts its dots 0.41 of a dot low, so at ten pixels an em every row of them
straddles two of ours. And the browser grid-fits: that face's `gasp` asks for
it above eight pixels, so the rasteriser rounds the straddle onto the pixels,
outwards, and one row of dots arrives as two. That is a bitmap face rendered
bold with its dense characters filled in solid, and no threshold downstream can
undo it - by then both rows are honestly covered. So `snap: true` cuts the face
at four times the size, where a rounding of that kind moves an edge a quarter
of one of our pixels, and folds it back four rows to one on the seam that lands
the face's grid on ours. Only a bitmap face wants it; an outline face is grey
by design.

Rendering is the expensive half, so the last hundred or so results are kept:
a caption redrawn every frame costs one layout and then nothing. `text.forget()`
drops them, which is what a late-arriving font needs (`load` and `ready` do it
for you).

In the browser the layout is the browser's own, so any font the page can see
works. Outside one there is nothing to ask, and `text.rasteriser` is the seam:
give it a function from a string to coverage and everything above it works
unchanged.

### Writing a game

```ts
import { BUTTON, run, type Context } from "./src/index.js";

run({
    init({ screen, gfx, sprites }: Context) {
        gfx.now.clear(1);                       // the boot screen cannot wait
        sprites.setPatternFromBitmap(0, [...]);
        sprites.setActiveCount(1);
    },

    update({ input, sprites }: Context) {
        const { x, y } = input.axis();          // arrows, WASD, or a gamepad
        sprites.move(0, ship.x += x * 3, ship.y += y * 3);
    },

    draw({ gfx }: Context) {
        gfx.fillCircle(120, 100, 30, 8);        // queued: arrives over a few frames
        gfx.now.text(2, 1, `QUEUE ${gfx.pending}`, 15);
    }
}, { canvas: document.querySelector("canvas") });
```

`draw` does not repaint the screen. It adds to the blitter's queue, which is
still working through what earlier frames asked for. Nothing drops work, so a
game that queues faster than the chip draws will fall behind - watch
`gfx.pending` and hold off, the way the example does.

The runtime steps at a fixed 60Hz whatever the display refreshes at, and will
run up to three frames to catch up before it gives up on the lost time.

`examples/game.ts` is the whole thing: a sprite moving at 60Hz for free, blooms
big enough that the blitter visibly grinds them out, a full-screen wipe on odd
coordinates that takes most of a third of a second, and a readout drawn
immediately so it never lags behind what it is reporting.

### Sound

Both chips are wired and clocked from the same scanline events the VDP hands
out, so audio advances with the picture rather than alongside it.

```ts
const { psg, opll } = createSystem();

psg.setTone(0, 440);                    // Hz, converted to the chip's period
psg.setVolume(0, 13);
psg.setMixer([true, false, false]);     // tone on channel A only

opll.play(0, 220, INSTRUMENT.ORGAN);    // instrument, pitch and key-on at once
opll.setRhythmMode(true);
opll.triggerRhythm(RHYTHM.BASS_DRUM | RHYTHM.HI_HAT);
```

The PSG generates at 112005 Hz and the OPLL at 49780, neither of which any
sound card wants, so `AudioMixer` pulls a frame from each, resamples by
averaging - picking one sample of two would alias the PSG's squares badly - and
sums them. In a browser `BrowserHost` opens an AudioWorklet and feeds it a
frame at a time; the worklet is only a sink, since the emulator has to stay on
the main thread.

The mixer also strips DC. A PSG channel with its mixer bit off still drives its
amplitude out as a steady level - that is how the chip was made to play
samples - and on a real MSX the capacitor on the output removes it.

```bash
npm run sound -- out.wav        # both chips put through their paces
```

#### Music

Tunes are written in MML, the notation MSX BASIC's `PLAY` used, and driven the
way an MSX music driver was: once per frame, on the vertical interrupt, writing
whatever registers changed. Nothing is scheduled ahead.

```ts
const theme = compile([
    { voice: psgVoice(0), mml: "t150 v12 q7 l8 o5 [eagaece4 fagafcf4]2" },
    { voice: psgVoice(1), mml: "t150 v10 q6 l4 o2 [aaaa ffff]2" },
    { voice: opllVoice(0), mml: "t150 @8 v11 l1 o3 [af]2" },
    { voice: rhythmVoice(), mml: "t150 v11 l8 [{cg}g{dg}g]4" }
]);

bgm.play(theme, { loop: true });
bgm.effect(psgVoice(2), "t150 v15 l32 o6 >c< bagfedc");   // borrows a channel
```

`cdefgab` with `+`/`#`/`-`, `r` rests, `o` `<` `>` octaves, `l` default length
and dots, `t` tempo, `v` volume, `q` gate in eighths, `@` instrument, `s`/`m`
the PSG envelope, `w` noise, `&` ties, `[ ... ]n` repeats. Rhythm tracks spell
drums as letters - c kick, d snare, e tom, f cymbal, g hi-hat - and brace the
ones that land together: `{cg}8`.

There are no spare channels on an MSX, so `bgm.effect` takes one away from the
music and gives it back when the effect ends, which is what games did.

Note lengths rarely fall on whole frames - an eighth at tempo 150 is 12.8 of
them - so the compiler rounds the running total rather than each note. Tracks
written in different subdivisions still come out exactly the same length, and a
loop stays a loop.

```bash
npm run music -- out.wav        # eight bars, five voices
```

### Machine profile

Fixed, and not configurable: **MSX2, V9958, NTSC 60Hz, 128KB VRAM**.

The VDP is the MSX2+'s V9958 rather than the MSX2's V9938: the same chip with
R25-R27 added, which is where the horizontal scroll lives. Nothing else of the
MSX2+ comes with it: no kanji ROM, and no YJK in the BIOS, although R25 will
select it if written by hand. A program that never touches R25-R27 cannot tell
the difference, except by the chip's ID in S#1.

## 型宣言

### 型の別名

```ts
export type ScreenModeName = "T1" | "T2" | "MC" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
export type PaletteColor = readonly [number, number, number];
```

### runtime/runtime

```ts
import type { Bios } from "../bios/index.js";
import type { Console, Graphics, Images, Ime, Screen, Scroll, SoundDriver, Sprites, Typesetter } from "../bios/index.js";
import type { Frame } from "../core/machine.js";
import type { Crt } from "../host/crt.js";
import { Input } from "./input.js";
import { Keyboard } from "./keyboard.js";
import { Pointer } from "./pointer.js";
/** What the game is handed every frame. */
export interface Context {
    readonly bios: Bios;
    readonly screen: Screen;
    /**
     * Hardware scrolling: R23 down, the V9958's R26/R27 across, and bands that
     * change them partway down the screen on the line interrupt.
     */
    readonly scroll: Scroll;
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    /** Loading pictures from URLs, reduced to what the screen mode can show. */
    readonly image: Images;
    /** Text in the host's own fonts, rasterised outside the machine and carried in. */
    readonly text: Typesetter;
    /** A character grid over the bitmap, repainted a changed cell at a time. */
    readonly console: Console;
    /**
     * Japanese input: keystrokes in, a preedit and candidates out, drawn by the
     * machine rather than by the browser. Inert until an engine is attached.
     */
    readonly ime: Ime;
    /** Music and effects. Already ticking on the vertical interrupt. */
    readonly bgm: SoundDriver;
    readonly input: Input;
    /**
     * Keys as things to type on rather than to play: a queue of keystrokes in
     * the order they arrived, drained once a frame. `capturing` is how an app
     * says it wants them.
     */
    readonly keyboard: Keyboard;
    /**
     * The mouse, in screen pixels. Hosts that have no pointing device simply
     * never move it, and `pointer.present` says which case you are in.
     */
    readonly pointer: Pointer;
    /**
     * The CRT the picture is arriving on, and its parameters - null where the
     * host is putting frames straight on a canvas, which is the default.
     *
     *     ctx.crt?.set({ curvature: 0.2, scanlineIntensity: 0.5 });
     */
    readonly crt: Crt | null;
    /** Frames since the runtime started. */
    readonly frame: number;
    /** Seconds since the runtime started, counted in frames rather than wall clock. */
    readonly time: number;
}
/**
 * A file handed to the machine from outside it - dropped on the screen, in the
 * browser host's case.
 *
 * `url` is the cheap way in: it is what `image.load` and anything else taking
 * a URL wants. It is only valid while the handler is running, though - the
 * host releases it as soon as the handler settles, so a handler that means to
 * keep the file must return the promise that reads it.
 */
export interface DroppedFile {
    readonly name: string;
    /** MIME type as the host reported it. Empty when it could not tell. */
    readonly type: string;
    readonly size: number;
    /** Valid until the drop handler settles. */
    readonly url: string;
    bytes(): Promise<Uint8Array>;
    text(): Promise<string>;
}
export interface App {
    /** Run once, before the first frame. Set the mode and boot screen here. */
    init?(ctx: Context): void;
    /** Game logic. Free - nothing here costs the machine anything. */
    update(ctx: Context): void;
    /** Queues drawing. What it queues may take several frames to appear. */
    draw?(ctx: Context): void;
    /**
     * Files dropped on the screen. Return a promise if the files are read
     * asynchronously: the host keeps them readable until it settles.
     */
    drop?(ctx: Context, files: readonly DroppedFile[]): void | Promise<void>;
}
/** Where frames go and what drives the clock. */
export interface Host {
    /**
     * The CRT this host shows frames through, where it has one. A host with no
     * such thing simply has not got the property, and `runtime.crt` is null.
     */
    readonly crt?: Crt | null;
    /**
     * Called once, with the runtime, so the host can reach the things it needs
     * - input to wire events to, and the machine to pull audio from.
     */
    attach?(runtime: Runtime): void;
    /**
     * Shows a finished frame. `pixelAspect` is the width of one of its pixels
     * against its height, relative to the 256-pixel modes: 1 for those, and
     * 0.5 for the 512-pixel ones, whose pixels are tall.
     */
    present(frame: Frame | null, pixelAspect: number): void;
    /** Begins calling `tick` at 60Hz. */
    start(tick: () => void): void;
    stop(): void;
}
export declare const FRAME_RATE = 60;
export declare class Runtime implements Context {
    readonly bios: Bios;
    readonly input: Input;
    readonly pointer: Pointer;
    readonly keyboard: Keyboard;
    constructor(bios: Bios, host: Host);
    get screen(): Screen;
    get scroll(): Scroll;
    get gfx(): Graphics;
    get sprites(): Sprites;
    get image(): Images;
    get text(): Typesetter;
    get console(): Console;
    get ime(): Ime;
    get bgm(): SoundDriver;
    get crt(): Crt | null;
    get frame(): number;
    get time(): number;
    /** Runs `app` until `stop()`. */
    run(app: App): void;
    stop(): void;
    get isRunning(): boolean;
    /**
     * Hands the app files from outside the machine. Hosts call this; so can a
     * test, with files of its own making.
     *
     * The returned promise settles when the app has finished with them, which
     * is a host's cue that it may stop keeping them readable.
     */
    drop(files: readonly DroppedFile[]): Promise<void>;
    /**
     * Advances a fixed number of frames without a host driving the clock.
     * Tests and screenshot tools use this; a running game does not.
     */
    step(frames?: number): void;
}
```

### bios/gfx

```ts
import { Blitter } from "./blitter.js";
import type { BlitOptions, Raster, Rect } from "./raster.js";
import type { Screen } from "./screen.js";
export declare class Graphics {
    /** Null means "the whole screen", which follows the mode when it changes. */
    constructor(screen: Screen, blitter: Blitter, immediate: Raster);
    /**
     * The same primitives, drawn immediately and for free. Everything it draws
     * is already on the page when it returns.
     */
    get now(): Raster;
    /**
     * Lets drawing reach below the screen, into the lines of the page that only
     * a scroll shows - 212 to 255 in a 212-line mode, since R23 wraps at 256.
     * That is where a vertical scroll's incoming line goes while nobody can see
     * it. On the page that holds the sprite tables it stops short of them.
     *
     * Off by default: the whole screen, and every clip, stops at the screen's
     * last line.
     */
    get offscreen(): boolean;
    set offscreen(on: boolean);
    /** True while the blitter still has work. */
    get busy(): boolean;
    /** Queued jobs, including the one in progress. */
    get pending(): number;
    /** Pixels left to draw across the whole queue. */
    get work(): number;
    /** Drops everything queued. Whatever was half-drawn stays half-drawn. */
    abandon(): void;
    /**
     * How fast the blitter works, as a multiple of the real V9938. 1 is
     * authentic; below 1 makes the machine's work easier to watch.
     */
    get speed(): number;
    set speed(value: number);
    /**
     * Restricts drawing to a rectangle. Jobs capture the clip as they are
     * queued, so changing it later does not disturb work already in flight.
     */
    setClip(x: number, y: number, width: number, height: number): void;
    /** Goes back to the whole screen, and keeps following it across mode changes. */
    resetClip(): void;
    /** The clip as it applies to the draw page now: never past the lines drawing may reach. */
    get clip(): Readonly<Rect>;
    clear(color?: number): void;
    pixel(x: number, y: number, color: number): void;
    /** Reads a pixel back. Reads are free and immediate; only drawing is not. */
    getPixel(x: number, y: number, page?: number): number;
    hline(x: number, y: number, width: number, color: number): void;
    vline(x: number, y: number, height: number, color: number): void;
    /**
     * A solid rectangle. Even `x` and `width` let the chip move whole bytes,
     * which is eight times faster - worth arranging when you can.
     */
    fillRect(x: number, y: number, width: number, height: number, color: number): void;
    rect(x: number, y: number, width: number, height: number, color: number): void;
    line(x0: number, y0: number, x1: number, y1: number, color: number): void;
    circle(cx: number, cy: number, radius: number, color: number): void;
    fillCircle(cx: number, cy: number, radius: number, color: number): void;
    /**
     * Moves a rectangle of VRAM. `fromPage` pulls from a page you are not
     * drawing on, which is how a background gets restored under something that
     * has moved.
     */
    blit(sx: number, sy: number, dx: number, dy: number, width: number, height: number, options?: BlitOptions): void;
    /** Draws an image given one byte per pixel - the format to author art in. */
    drawImage(x: number, y: number, width: number, height: number, pixels: ArrayLike<number>, transparent?: boolean): void;
    /**
     * Draws a string in the built-in 6x8 font. The glyphs are rasterised now
     * and pushed to VRAM by the blitter, so a long line arrives left to right.
     */
    text(x: number, y: number, text: string, color?: number, background?: number): void;
    /** Width in pixels a string will occupy, for centring and layout. */
    textWidth(text: string): number;
    /** Pixels to a byte in the current mode, which is what byte alignment means. */
    /** Snapshots the clip so a job is unaffected by later changes. */
}
```

### bios/raster

```ts
import type { Vdp } from "../api/index.js";
import type { Screen } from "./screen.js";
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface BlitOptions {
    /** Skip source pixels of colour 0 instead of copying them. */
    transparent?: boolean;
    /** Page to read from. Defaults to the page being drawn on. */
    fromPage?: number;
}
export declare class Raster {
    /** Whether the lines below the screen are drawable (Graphics' `offscreen`). */
    /** VRAM address of the page being written. Set by whoever owns this rasteriser. */
    base: number;
    /** Clipping is owned by Graphics; setTarget is the only way to change it. */
    get clip(): Readonly<Rect>;
    constructor(vdp: Vdp, screen: Screen);
    /** Points this rasteriser at a page and a clip rectangle in one go. */
    setTarget(base: number, clip: Rect, offscreen?: boolean): void;
    /** Lines of `page` this rasteriser may touch: the screen, or with `offscreen` the page's picture lines. */
    /** Pixels packed into one byte: 4 in GRAPHIC5, 2 in GRAPHIC4/6, 1 in GRAPHIC7. */
    /** Every bit of a colour the current mode can actually store. */
    /**
     * Fills the whole page, ignoring the clip rectangle: the screen's lines, or
     * with `offscreen` every picture line of the page.
     */
    clear(color?: number): void;
    pixel(x: number, y: number, color: number): void;
    getPixel(x: number, y: number, page?: number): number;
    /** Horizontal run. Whole bytes are filled at once; the ends go pixel by pixel. */
    hline(x: number, y: number, width: number, color: number): void;
    vline(x: number, y: number, height: number, color: number): void;
    fillRect(x: number, y: number, width: number, height: number, color: number): void;
    /** Outline only, one pixel thick, drawn inside the given rectangle. */
    rect(x: number, y: number, width: number, height: number, color: number): void;
    line(x0: number, y0: number, x1: number, y1: number, color: number): void;
    circle(cx: number, cy: number, radius: number, color: number): void;
    fillCircle(cx: number, cy: number, radius: number, color: number): void;
    /**
     * Copies a rectangle of VRAM. Source and destination may overlap, and
     * `fromPage` lets you pull from a page you are not drawing on - which is
     * how a background gets restored under a moving object.
     */
    blit(sx: number, sy: number, dx: number, dy: number, width: number, height: number, options?: BlitOptions): void;
    /**
     * Copies one horizontal run of pixels from `sourceBase`. Byte-aligned runs
     * move whole bytes; the rest go a pixel at a time. This is the unit the
     * blitter works in, which is why it is a run rather than a rectangle.
     */
    copyRun(sourceBase: number, sx: number, sy: number, dx: number, dy: number, width: number, transparent: boolean): void;
    /**
     * Draws an image given one byte per pixel. This is the format to author
     * sprites and tiles in - readable, and unpacked at draw time.
     */
    drawImage(x: number, y: number, width: number, height: number, pixels: ArrayLike<number>, transparent?: boolean): void;
    /**
     * Draws a string in the built-in 6x8 font. Passing `background` fills the
     * cell behind each character; leaving it out draws the glyphs only.
     */
    text(x: number, y: number, text: string, color?: number, background?: number): void;
    /** Width in pixels a string will occupy, for centring and layout. */
    textWidth(text: string): number;
    /** A byte holding `color` in each of the pixels it packs. */
    /** Midpoint circle, reporting one octant's worth of offsets mirrored eight ways. */
}
```

### bios/screen

```ts
import { type PaletteColor, type ScreenModeName, type Vdp } from "../api/index.js";
import type { FantasyMachine } from "../core/machine.js";
import { Scroll } from "./scroll.js";
export interface SpriteTables {
    /** In sprite mode 2 this holds the per-line colours; attributes follow it. */
    readonly colors: number;
    readonly attributes: number;
    readonly patterns: number;
}
export declare class Screen {
    /** Where the display looks into the plane, and the bands that split it. */
    readonly scroll: Scroll;
    constructor(vdp: Vdp, machine: FantasyMachine);
    /**
     * Where the sprite tables live. They stay put in page 0 while the
     * framebuffer pages flip beneath them, but they do move when the mode
     * changes - a SCREEN 7 page is twice as long as a SCREEN 5 one.
     */
    get spriteTables(): SpriteTables;
    /**
     * Sets up a bitmap screen. Geometry reaches the raster at the next vertical
     * sync, so the frame you call this in still renders with the old borders.
     */
    setMode(name?: ScreenModeName): void;
    get mode(): import("../index.js").ScreenMode;
    get width(): number;
    /**
     * How wide a pixel is against how tall, relative to the 256-pixel modes.
     *
     * The V9938 paints the same picture width whatever the mode, so SCREEN 6
     * and 7 get their 512 columns by halving the pixel rather than widening the
     * screen. Their pixels really are tall, and a host that draws them square
     * shows a picture stretched to twice its proper width.
     */
    get pixelAspect(): number;
    get height(): number;
    /** VRAM address where a page's framebuffer starts. */
    pageBase(page: number): number;
    /**
     * How many lines of a page hold picture: every line R23 can scroll into
     * view (256, whatever the screen height), except on the page that holds the
     * sprite tables, which stops at the line they start on. `gfx.offscreen`
     * draws down to here. Outside the bitmap modes, just the screen.
     */
    pageLines(page: number): number;
    get displayPage(): number;
    get drawPage(): number;
    /** Points the raster at a page. Only R2 moves; the sprite tables stay where they are. */
    setDisplayPage(page: number): void;
    /** Chooses which page drawing lands in. Independent of what is displayed. */
    setDrawPage(page: number): void;
    /**
     * Swaps the displayed and drawn pages. Call it after finishing a frame's
     * drawing to show it whole rather than half-built.
     */
    flip(): void;
    /** Enables double buffering: draw on page 1 while page 0 is shown. */
    useDoubleBuffer(): void;
    /**
     * Scrolls the display vertically. The page wraps at 256 lines, not 212.
     * The same as `scroll.y`, which is where the rest of scrolling lives.
     */
    setScroll(lines: number): void;
    setBackdrop(color: number): void;
    /**
     * The sixteen palette entries as they stand, in 3-bit components. The
     * registers are write-only on the chip, so this is a shadow of what was
     * written - which is what reducing a picture to them needs to know.
     */
    get palette(): ReadonlyArray<PaletteColor>;
    /** Palette entry as 3-bit components, giving the V9938's 512 colours. */
    setColor(index: number, r: number, g: number, b: number): void;
    setPalette(colors: ReadonlyArray<readonly [number, number, number]>): void;
    resetPalette(): void;
    /** Advances the machine one frame, rendering everything set up so far. */
    frame(): void;
}
```

### bios/scroll

```ts
import { type Vdp } from "../api/index.js";
import type { Screen } from "./screen.js";
/** Lines round the plane, whatever the screen height: R23 is eight bits. */
export declare const PLANE_HEIGHT = 256;
/** One horizontal strip of the screen, and where it looks into the plane. */
export interface ScrollBand {
    /** First screen line the band covers. It runs down to the next band. */
    readonly top: number;
    /** Plane column at the left edge. In the 512-wide modes it moves in steps of two. */
    x: number;
    /** Plane line at the top of the screen - not of the band. The same meaning R23 has. */
    y: number;
    /**
     * Page the band shows. Left out, it follows `screen.displayPage`. With
     * `wide` on, a page stands for the pair it belongs to: 0 and 1, 2 and 3.
     */
    page?: number;
    /**
     * False hides every sprite on the band's lines (R8's SPD, switched on the
     * line interrupt). A status bar over a scrolling field wants it: otherwise
     * a sprite whose page line comes round into the bar's lines shows up there
     * too. A sprite reaching into such a band from one that shows sprites is
     * placed against the band that shows it, so it slides in cleanly. Left out,
     * sprites show as `sprites.setEnabled` has them.
     */
    sprites?: boolean;
}
export interface BandOptions {
    x?: number;
    y?: number;
    page?: number;
    sprites?: boolean;
}
export declare class Scroll {
    /** Index of the band the next line interrupt brings in. */
    /** R23 as last written, which the line interrupt is compared against. */
    /**
     * Nothing is written until the scroll is first used, so a program setting
     * R23 or R26 by hand is not overwritten at every vertical sync.
     */
    /** What `sprites.setEnabled` last asked for. Bands can only take sprites away. */
    /** Whether the last band applied had R8's SPD in its charge. */
    constructor(vdp: Vdp, screen: Screen);
    /** Plane column at the left edge of the top band. */
    get x(): number;
    set x(value: number);
    /** Plane line at the top of the screen, in the top band. */
    get y(): number;
    set y(value: number);
    /** Moves the top band. Without splits that is the whole screen. */
    set(x: number, y: number): void;
    /**
     * R25's MSK: blanks the leftmost 8 pixels. A fine horizontal scroll shifts
     * the picture right by up to seven pixels and shows the backdrop in the gap,
     * so without this the left edge visibly flutters as the scroll moves.
     */
    get mask(): boolean;
    set mask(on: boolean);
    /**
     * R25's SP2: the horizontal scroll runs across two pages, an even one on
     * the left and the odd one after it on the right. The plane doubles to
     * `2 * screen.width`, and the display has to be pointed at the odd page of
     * the pair, which is done for you. A bitmap mode needs two pages for it, so
     * SCREEN 7 and 8 give up double buffering.
     */
    get wide(): boolean;
    set wide(on: boolean);
    /** How far x goes before it wraps. */
    get planeWidth(): number;
    /** How far y goes before it wraps: 256, whatever the screen height. */
    get planeHeight(): number;
    /** Top first. There is always at least the one starting at line 0. */
    get bands(): readonly ScrollBand[];
    /**
     * Starts a band at screen line `top`, running down to the next one, and
     * hands it back to be moved from then on. A band already starting on that
     * line is reused. Every split costs a line interrupt a frame, and nothing
     * stops you putting one on every line.
     *
     *     const hud = scroll.split(0, { page: 1 });     // held still
     *     const field = scroll.split(24);                // moved every frame
     *     field.x = camera.x;
     */
    split(top: number, options?: BandOptions): ScrollBand;
    /** Removes one band, or with no argument every band but the top one. */
    unsplit(band?: ScrollBand): void;
    /** The band covering a screen line. */
    at(line: number): ScrollBand;
    /**
     * The band a sprite `height` lines tall with its top on screen line `line`
     * is written against: the one covering its top line, unless that band hides
     * sprites - then the first band further down that shows them and begins
     * within the sprite, so its lower part is drawn in the right place there.
     * Null when the sprite lies wholly in bands that hide sprites: written
     * against one of those it would be a ghost in some other band, so it is
     * parked instead.
     */
    spriteBand(line: number, height: number): ScrollBand | null;
    /** Where a screen pixel is in the plane, through whichever band covers it. */
    toPlane(x: number, y: number): {
        x: number;
        y: number;
    };
    /**
     * The first of `height` page lines that no band shows sprites on -
     * somewhere a sprite can be parked without turning up in some other band.
     * Looks from just below the bottom band onwards, and skips 208 and 216,
     * which as a sprite's Y would end the sprite list.
     */
    unseenLine(height: number): number;
    /** Whether the scroll has been used, and so owns R23, R26, R27 and R19. */
    get active(): boolean;
    /**
     * Loads the top band and arms the interrupt for the next. The BIOS calls
     * this at the vertical sync, before the frame's first line.
     */
    vsync(): void;
    /** The line interrupt. The BIOS installs this as the machine's handler. */
    interrupt(): void;
}
```

### bios/sprites

```ts
import { type Vdp } from "../api/index.js";
import type { Screen } from "./screen.js";
export declare const SPRITE_COUNT = 32;
/** Per-line colour byte flags. */
export declare const SPRITE_FLAGS: {
    /** Shifts the sprite 32 pixels left, so it can slide in from off-screen. */
    readonly EARLY_CLOCK: 128;
    /** Draws this sprite merged with the higher-priority one above it. */
    readonly COMPOSITE: 64;
    /** Excludes this line from collision detection. */
    readonly NO_COLLISION: 32;
};
export interface SpriteState {
    x: number;
    y: number;
    /** Pattern slot. 16x16 sprites round it down to a multiple of four. */
    pattern: number;
    /** A single colour, or one per line (16 entries) for a shaded sprite. */
    color: number | ArrayLike<number>;
    /** Extra per-line flags, ORed into every colour byte. */
    flags?: number;
}
export declare class Sprites {
    /** Screen line of each shown sprite, before the scroll is added back. */
    constructor(vdp: Vdp, screen: Screen);
    /** Table addresses follow the screen mode, since page sizes differ. */
    /** 8x8 or 16x16, optionally with every pixel doubled. */
    setSize(size: 8 | 16, magnified?: boolean): void;
    /** All sprites on or off. A scroll band can still hide them on its own lines. */
    setEnabled(enabled: boolean): void;
    /**
     * Loads a pattern. Pass 8 rows of 8 bits for an 8x8 sprite, or 16 rows of
     * 16 bits for a 16x16 one - the four-quadrant order the chip actually wants
     * is worked out here.
     */
    setPattern(slot: number, rows: ArrayLike<number>): void;
    /**
     * Reads a pattern out of a string bitmap, which is how sprite art is worth
     * writing: one string per row, any character other than space or "." set.
     */
    setPatternFromBitmap(slot: number, bitmap: readonly string[]): void;
    /** Places a sprite. `y` is the screen line its top row appears on. */
    set(index: number, state: SpriteState): void;
    /** Moves a sprite without touching its pattern or colours. */
    move(index: number, x: number, y: number): void;
    /** Replaces the per-line colours of a sprite already placed. */
    setLineColors(index: number, colors: ArrayLike<number>, flags?: number): void;
    /** Parks one sprite off-screen. The rest keep being drawn. */
    hide(index: number): void;
    hideAll(): void;
    /**
     * Stops the VDP after `count` sprites. Cheaper than hiding them one by one,
     * and the only way to tell the chip not to look at the rest at all.
     */
    setActiveCount(count: number): void;
    /**
     * Rewrites every sprite's Y against the scroll as it stands. The BIOS does
     * this at each vertical sync, so a sprite stays on its screen line while
     * the picture moves under it.
     */
    follow(): void;
    /**
     * Where hidden sprites go: page lines no band shows. Below the screen when
     * nothing scrolls - but a band can point anywhere in the page, and a sprite
     * parked where one is looking would turn up in it.
     */
    /** Lines a sprite covers on screen. */
    /**
     * Whether any two sprites overlapped, clearing the flag as the hardware
     * does. Read it once per frame: reading also clears the VBlank flag.
     */
    collided(): boolean;
    /** Where the last collision happened. Only meaningful right after `collided()`. */
    collisionPoint(): {
        x: number;
        y: number;
    };
    /** True when more than eight sprites landed on one line and one was dropped. */
    overflowed(): boolean;
}
```

### bios/text

```ts
import type { Graphics } from "./gfx.js";
import type { Screen } from "./screen.js";
/** Where a short line sits inside a box the widest one decided. */
export type TextAlign = "left" | "center" | "right";
export interface TextStyle {
    /** A CSS family list - `"serif"`, `"'Press Start 2P', monospace"`. Default `"sans-serif"`. */
    font?: string;
    /** Em size in pixels of the machine, not of the page. Default 16. */
    size?: number;
    /** CSS weight: a number, or `"bold"`. Default normal. */
    weight?: number | string;
    italic?: boolean;
    /** Baseline to baseline, in pixels. Defaults to what the face asks for. */
    lineHeight?: number;
    /** Added between characters, in pixels. Negative tightens. Default 0. */
    letterSpacing?: number;
    /** Default `"left"`. */
    align?: TextAlign;
    /** The index the glyphs are drawn in. Default 15. A ramp of one, in the terms below. */
    color?: number;
    /**
     * The indices partly-covered pixels are drawn in, palest first and fullest
     * last, in place of `color`. This is the whole of the antialiasing here:
     * coverage is divided by the length of the ramp, and each pixel takes the
     * entry its share lands on - nothing is blended, searched for, or written
     * into a palette register.
     *
     * `[1]` is the plain hard edge. `[8, 15]` gives a stroke one soft step,
     * `[8, 7, 15]` two. Order matters and the machine cannot check it: a ramp
     * that does not run from nearest-the-background to nearest-the-ink comes
     * out looking outlined rather than smoothed - which is occasionally what
     * you want, and `[15, 8, 15]` is how you would ask for it.
     *
     * Every entry is a register the type has taken off whatever else is on
     * screen, so three shades is usually the most a sixteen-colour mode can
     * afford, and one is what small text should stay at: at ten pixels an em
     * there is no flank to resolve, only a blur where the stem was.
     */
    shades?: readonly number[];
    /** The index behind them. Left out, the box is transparent and only the glyphs land. */
    background?: number;
    /**
     * Where the ramp sits against the coverage, 0 to 255. Default 128, which
     * puts a one-shade ramp's edge at half cover - the usual meaning of a
     * threshold. Lower fattens every stroke and pulls the whole ramp towards
     * the ink, which is often what small text on a 256-pixel screen wants;
     * higher thins it.
     */
    threshold?: number;
    /**
     * How many pixels wide one pixel of the em is drawn, which is how type
     * keeps its proportions in the 512-wide modes: their pixels are half as
     * wide as they are tall, so a line set the same way as in SCREEN 5 would
     * come out condensed to half its width.
     *
     * Defaults to whatever the mode needs - 1 in SCREEN 5 and 8, 2 in SCREEN 6
     * and 7 - so the same style set in either gives type of the same shape,
     * with twice the detail across it in the 512-wide ones. Pass 1 to work in
     * the mode's own pixels instead, and anything else to condense or extend.
     */
    stretch?: number;
    /**
     * Whether this face is a bitmap, and is to be cut as one. No use to any
     * other kind, and worth understanding before it is turned on.
     *
     * A bitmap face is only a bitmap where its own grid lands on ours, and at
     * the size it was drawn for, two things stop that happening.
     *
     * The face may not hang its dots off the baseline. JF Dot K12x10 puts its
     * rows at 102.4 units apart starting 42 below the baseline, so at ten
     * pixels an em every row of dots straddles two of ours - 0.59 of one and
     * 0.41 of the next. Which of them lights is then a question about the
     * threshold rather than about the face.
     *
     * And the browser grid-fits. This face's `gasp` asks for it at anything
     * above eight pixels, so the rasteriser rounds those straddling edges onto
     * the pixels - outwards, which turns one row of dots into two. That is a
     * bitmap face arriving bold, with the dense characters filled in solid, and
     * no threshold or nudge downstream can undo it: by then the two rows are
     * equally and honestly covered.
     *
     * So the face is cut at four times the size instead, where a hint that
     * rounds an edge moves it a quarter of one of our pixels, and folded back
     * four rows to one. The fold has four places to put its seam and the one
     * with the least grey either side of it is the one that lands the face's
     * grid on ours. It costs one rasterisation of sixteen times the area, once
     * per glyph, which is what a cache is for.
     */
    snap?: boolean;
}
/** A style with every question answered, which is what the rasteriser is handed. */
export interface ResolvedStyle {
    /** Ready for `ctx.font`: the shorthand, already assembled. */
    readonly font: string;
    readonly size: number;
    /** Baseline to baseline, or undefined to let the face decide. */
    readonly lineHeight?: number;
    readonly letterSpacing: number;
    readonly align: TextAlign;
    /** Horizontal scale, for the modes whose pixels are not square. */
    readonly stretch: number;
    /** Whether to cut this face as the bitmap it is: oversized, then folded down. */
    readonly snap: boolean;
}
/** What the host hands back: coverage per pixel, and where the type sits in it. */
export interface Coverage {
    readonly width: number;
    readonly height: number;
    /** 0 to 255, row by row: how much of each pixel the glyphs cover. */
    readonly alpha: Uint8Array | Uint8ClampedArray;
    /** Rows from the top of the box down to the first line's baseline. */
    readonly baseline: number;
    /** Baseline to baseline, as the rasteriser actually spaced them. */
    readonly lineHeight: number;
}
/** What turns a string into coverage. Replaceable, for hosts with no browser in them. */
export type TextRasteriser = (text: string, style: ResolvedStyle) => Coverage;
/** The box a string occupies, and the landmarks inside it. */
export interface TextBox {
    readonly width: number;
    readonly height: number;
    /** Rows from the top of the box down to the first baseline. */
    readonly baseline: number;
    readonly lineHeight: number;
    readonly lines: number;
}
/** A string reduced to indices, ready for VRAM. */
export interface TextImage extends TextBox {
    /** One byte per pixel: the colour where there is ink, the background where there is not. */
    readonly pixels: Uint8Array;
    /** True when index 0 means "leave what is already there" - no background was asked for. */
    readonly transparent: boolean;
}
export declare class Typesetter {
    /**
     * How a string becomes coverage. The default asks the browser, which brings
     * with it every font the page can see. Under Node there is nothing to ask,
     * so assign a rasteriser of your own.
     */
    rasteriser: TextRasteriser;
    /**
     * What every call starts from, so an app can choose its face once and then
     * pass only what changes.
     */
    style: TextStyle;
    constructor(gfx: Graphics, screen: Screen);
    /** The box a string will occupy, for centring and layout, without drawing it. */
    measure(text: string, style?: TextStyle): TextBox;
    /**
     * Lays a string out and reduces it to indices. Rendering is the expensive
     * half of this module, so the last hundred or so results are kept - which
     * is what makes a caption redrawn every frame cost nothing after the first.
     */
    render(text: string, style?: TextStyle): TextImage;
    /**
     * Queues a string for the blitter, which lays it down at the chip's pace -
     * a long line arrives left to right. `x` and `y` are the top left of the
     * box, and what comes back is the picture that was drawn - its box, and
     * the indices, should the caller want them again.
     */
    draw(x: number, y: number, text: string, style?: TextStyle): TextImage;
    /** The same, written straight into VRAM. A menu should not arrive in instalments. */
    drawNow(x: number, y: number, text: string, style?: TextStyle): TextImage;
    /**
     * Fetches a font file and makes it available under `family`, which is then
     * a name `style.font` can use. `source` is a URL, or any CSS `src` value.
     */
    load(family: string, source: string, descriptors?: FontFaceDescriptors): Promise<void>;
    /**
     * Waits for the fonts a style names to be usable. Worth an `await` in
     * `init`: a face still loading rasterises as the fallback, silently, and
     * the layout that comes out is the fallback's.
     */
    ready(style?: TextStyle): Promise<void>;
    /** Drops everything rendered so far. Fonts arriving late is what this is for. */
    forget(): void;
    /** What the mode does to a pixel: 2 where they are half as wide as they are tall. */
}
/**
 * The default: lays the string out with the browser's own text engine and
 * reads the pixels back.
 *
 * Two passes over one canvas: measure, which decides how big the box is, then
 * draw, which needs the canvas at that size. Resizing a canvas resets its
 * context, so the font is set again in between.
 *
 * The measuring is the interesting half. A line is not as wide as its advance -
 * an italic f or a script tail hangs past both ends - so the box comes from the
 * bounding boxes the browser reports, and each line is drawn at its own origin
 * so that the overhang lands inside the picture rather than off the edge of it.
 *
 * All of that arithmetic happens in the font's own pixels and is scaled by
 * `stretch` on the way out, which is what puts type of the right shape on a
 * screen whose pixels are not square. The glyphs are drawn through the same
 * scale rather than measured again, so the browser hints and spaces the line
 * exactly as it would at any other size, and only the raster is wider.
 */
export declare function rasteriseWithCanvas(text: string, style: ResolvedStyle): Coverage;
```

### bios/sound

```ts
import type { Opll, Psg } from "../api/index.js";
import { type Song, type Voice } from "./mml.js";
export declare class SoundDriver {
    /** PSG mixer bits, mirrored so a track can change its own without disturbing others. */
    constructor(psg: Psg, opll: Opll);
    get playing(): boolean;
    /** True while any one-shot effect is still sounding. */
    get effectsPlaying(): boolean;
    /** Starts a song, replacing whatever was playing. */
    play(song: Song, options?: {
        loop?: boolean;
    }): void;
    /**
     * Plays a one-shot on one voice, taking it away from the music until it
     * finishes. This is what an MSX game did for sound effects: there were no
     * spare channels, so the music simply lost one for a moment.
     */
    effect(voice: Voice, mml: string): void;
    /** Silences everything and forgets where it was. */
    stop(): void;
    /** One frame. Call this on every vertical interrupt and nowhere else. */
    tick(): void;
    /** R7 is shared by every channel, so it is rebuilt from the driver's own mirror. */
}
```

### bios/mml

```ts
/** Which chip and voice a track drives. */
export type Voice = {
    readonly chip: "psg";
    readonly channel: 0 | 1 | 2;
} | {
    readonly chip: "opll";
    readonly channel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
} | {
    readonly chip: "rhythm";
};
export declare const psgVoice: (channel: 0 | 1 | 2) => Voice;
export declare const opllVoice: (channel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) => Voice;
export declare const rhythmVoice: () => Voice;
export type Event = 
/** `semitone` is absolute: 0 is C in octave 0, 48 is middle C. */
{
    readonly type: "note";
    readonly semitone: number;
    readonly frames: number;
    readonly gate: number;
} | {
    readonly type: "rest";
    readonly frames: number;
} | {
    readonly type: "volume";
    readonly value: number;
} | {
    readonly type: "instrument";
    readonly value: number;
} | {
    readonly type: "envelope";
    readonly shape: number;
    readonly period: number;
} | {
    readonly type: "noise";
    readonly period: number;
}
/** Rhythm voices trigger a mask of drums rather than a pitch. */
 | {
    readonly type: "drum";
    readonly mask: number;
    readonly frames: number;
};
export interface Track {
    readonly voice: Voice;
    readonly events: readonly Event[];
    /** Frames the track lasts, for lining tracks up and for looping. */
    readonly frames: number;
}
export interface Song {
    readonly tracks: readonly Track[];
}
export interface TrackSource {
    readonly voice: Voice;
    readonly mml: string;
}
export declare class MMLError extends Error {
    readonly source: string;
    readonly position: number;
    constructor(message: string, source: string, position: number);
}
/**
 * Compiles one MML string.
 *
 * Understood: `cdefgab` with `+`/`#`/`-`, `r` rests, `n` for a note by number,
 * `o` and `<` `>` for octave, `l` default length, `t` tempo, `v` volume,
 * `q` gate length in eighths, `@` instrument, `s`/`m` the PSG envelope,
 * `&` ties, and `[ ... ]n` repeats.
 *
 * Rhythm tracks spell drums as letters instead of pitches - c is the bass
 * drum, d the snare, e the tom, f the cymbal, g the hi-hat - and brace those
 * that land on the same beat: `{cg}8`.
 */
export declare function compileTrack(voice: Voice, mml: string): Track;
/** Compiles a whole song - one MML string per voice. */
export declare function compile(sources: readonly TrackSource[]): Song;
/** Concert pitch of a semitone, with 57 - A in octave 4 - at 440 Hz. */
export declare function semitoneToHz(semitone: number): number;
```

### runtime/input

```ts
export declare const BUTTON: {
    readonly UP: 0;
    readonly DOWN: 1;
    readonly LEFT: 2;
    readonly RIGHT: 3;
    /** The MSX joystick's trigger 1. */
    readonly A: 4;
    /** Trigger 2. */
    readonly B: 5;
};
export type Button = (typeof BUTTON)[keyof typeof BUTTON];
export type Player = 0 | 1;
/** Which keys stand in for each player's joystick when there is no gamepad. */
export declare const DEFAULT_KEY_MAP: ReadonlyArray<Readonly<Record<string, Button>>>;
export declare class Input {
    /** Replaces the keyboard bindings. One record per player. */
    setKeyMap(map: ReadonlyArray<Readonly<Record<string, Button>>>): void;
    /**
     * True while the keyboard is being typed on rather than played, which the
     * runtime sets from `Keyboard.capturing`. The keymap goes quiet - Z and X
     * are letters again - and raw keys go on being recorded, since `key()` is
     * about which keys are down and that does not change with the use they are
     * being put to.
     */
    get typing(): boolean;
    setTyping(on: boolean): void;
    /** Held right now. */
    btn(button: Button, player?: Player): boolean;
    /** Went down between the previous frame and this one. */
    btnp(button: Button, player?: Player): boolean;
    /** Came up between the previous frame and this one. */
    btnr(button: Button, player?: Player): boolean;
    /** -1, 0 or 1 along each axis, which is usually all a game wants. */
    axis(player?: Player): {
        x: number;
        y: number;
    };
    /** Raw key, by KeyboardEvent.code - "Escape", "Space", "KeyQ". */
    key(code: string): boolean;
    keyp(code: string): boolean;
    keyr(code: string): boolean;
    setButton(button: Button, down: boolean, player?: Player): void;
    /**
     * Records a raw key and, if it is bound, the joystick button it stands for.
     * Returns true when the key was bound, which is a host's cue to swallow it.
     */
    setKey(code: string, down: boolean): boolean;
    /** Forgets everything held. Hosts call this when the window loses focus. */
    releaseAll(): void;
    /**
     * Records the current state as the baseline the next frame compares
     * against. Called at the end of a frame, not the start: events arrive
     * between frames, and a key pressed in that gap has to still read as new
     * when the next update runs.
     */
    latch(): void;
}
```

### api/psg

```ts
import type { PsgChip } from "../core/types.js";
/**
 * Tone generator clock. The MSX feeds the PSG half the CPU clock and the chip
 * divides by 16, so a period of N produces 112005/N Hz.
 */
export declare const TONE_CLOCK = 112005;
/** Register numbers. */
export declare const PSG_R: {
    readonly TONE_A_LOW: 0;
    readonly TONE_A_HIGH: 1;
    readonly TONE_B_LOW: 2;
    readonly TONE_B_HIGH: 3;
    readonly TONE_C_LOW: 4;
    readonly TONE_C_HIGH: 5;
    readonly NOISE_PERIOD: 6;
    readonly MIXER: 7;
    readonly VOLUME_A: 8;
    readonly VOLUME_B: 9;
    readonly VOLUME_C: 10;
    readonly ENVELOPE_LOW: 11;
    readonly ENVELOPE_HIGH: 12;
    readonly ENVELOPE_SHAPE: 13;
    readonly IO_A: 14;
    readonly IO_B: 15;
};
/** R7 bits. Each bit *disables* its generator, so 0x3F is total silence. */
export declare const MIXER: {
    readonly TONE_A: 1;
    readonly TONE_B: 2;
    readonly TONE_C: 4;
    readonly NOISE_A: 8;
    readonly NOISE_B: 16;
    readonly NOISE_C: 32;
};
/** R8-R10 bit 4: take the level from the envelope generator instead of bits 0-3. */
export declare const USE_ENVELOPE = 16;
/** R13 envelope shapes. Only the low 4 bits matter. */
export declare const ENVELOPE: {
    /** \| falling once, then silence. */
    readonly DECAY: 0;
    /** /| rising once, then silence. */
    readonly ATTACK: 4;
    /** \|\|\ sawtooth down, repeating. */
    readonly SAW_DOWN: 8;
    /** \_ falling once, then hold at maximum. */
    readonly DECAY_HOLD: 11;
    /** /|/| sawtooth up, repeating. */
    readonly SAW_UP: 12;
    /** /‾ rising once, then hold at maximum. */
    readonly ATTACK_HOLD: 13;
    /** /\/\ triangle, repeating. */
    readonly TRIANGLE: 14;
};
export type Channel = 0 | 1 | 2;
export declare class Psg {
    constructor(chip: PsgChip);
    /** Writes a register, exactly as a write to ports 0xA0/0xA1 would. */
    write(reg: number, value: number): void;
    read(reg: number): number;
    /** Sets a channel's 12-bit tone period. Periods below 2 silence the tone. */
    setTonePeriod(channel: Channel, period: number): void;
    /** Sets a channel's pitch in Hz, rounded to the nearest period the chip can express. */
    setTone(channel: Channel, hz: number): void;
    /** 0-15. Pass `useEnvelope` to hand the level to the envelope generator instead. */
    setVolume(channel: Channel, level: number, useEnvelope?: boolean): void;
    /** 5-bit noise period, shared by every channel that has noise enabled. */
    setNoisePeriod(period: number): void;
    /** Enables tone and/or noise per channel. Everything not listed is switched off. */
    setMixer(tone: readonly boolean[], noise?: readonly boolean[]): void;
    /** Envelope period (16 bit) and shape. Shape writes always restart the envelope. */
    setEnvelope(period: number, shape: number): void;
    /** Silences every channel without disturbing the tone periods. */
    silence(): void;
    reset(): void;
}
```

### api/opll

```ts
import type { OpllChip } from "../core/types.js";
/** The rate the chip generates samples at: main clock / 72. */
export declare const SAMPLE_RATE = 49780;
export declare const OPLL_R: {
    /** R0-R7: parameters of the one user-definable instrument. */
    readonly CUSTOM: 0;
    /** R14: rhythm mode and the five drum triggers. */
    readonly RHYTHM: 14;
    /** R16-R24: F-number low 8 bits, one per channel. */
    readonly FNUM_LOW: 16;
    /** R32-R40: F-number bit 8, block, key-on, sustain. */
    readonly BLOCK: 32;
    /** R48-R56: instrument number and volume. */
    readonly INSTRUMENT: 48;
};
/** R32+ bits. */
export declare const BLOCK_BITS: {
    readonly FNUM_HIGH: 1;
    readonly BLOCK_MASK: 14;
    readonly KEY_ON: 16;
    readonly SUSTAIN: 32;
};
/** R14 bits. */
export declare const RHYTHM: {
    readonly ENABLE: 32;
    readonly BASS_DRUM: 16;
    readonly SNARE_DRUM: 8;
    readonly TOM_TOM: 4;
    readonly CYMBAL: 2;
    readonly HI_HAT: 1;
};
/** The chip's built-in instruments. 0 selects the custom patch in R0-R7. */
export declare const INSTRUMENT: {
    readonly CUSTOM: 0;
    readonly VIOLIN: 1;
    readonly GUITAR: 2;
    readonly PIANO: 3;
    readonly FLUTE: 4;
    readonly CLARINET: 5;
    readonly OBOE: 6;
    readonly TRUMPET: 7;
    readonly ORGAN: 8;
    readonly HORN: 9;
    readonly SYNTHESIZER: 10;
    readonly HARPSICHORD: 11;
    readonly VIBRAPHONE: 12;
    readonly SYNTHESIZER_BASS: 13;
    readonly ACOUSTIC_BASS: 14;
    readonly ELECTRIC_GUITAR: 15;
};
/** Melody channels. In rhythm mode only 0-5 are available. */
export type OpllChannel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export declare class Opll {
    constructor(chip: OpllChip);
    /** Writes a register, exactly as a write to ports 0x7C/0x7D would. */
    write(reg: number, value: number): void;
    read(reg: number): number;
    /** Instrument 0-15 and attenuation 0-15, where 0 is loudest. */
    setInstrument(channel: OpllChannel, instrument: number, volume: number): void;
    setVolume(channel: OpllChannel, volume: number): void;
    /** Sets pitch as a raw F-number (9 bits) and block (octave, 0-7). */
    setFrequency(channel: OpllChannel, fnum: number, block: number): void;
    /** Sets pitch in Hz, choosing the block that keeps the F-number in its precise range. */
    setPitch(channel: OpllChannel, hz: number): void;
    /** Starts (or releases) a note. Pitch and instrument must already be set. */
    setKeyOn(channel: OpllChannel, on: boolean): void;
    /** Sustain holds the note at its sustain level after key-off instead of releasing. */
    setSustain(channel: OpllChannel, on: boolean): void;
    /** Convenience: set instrument, pitch and volume, then key on. */
    play(channel: OpllChannel, hz: number, instrument: number, volume?: number): void;
    /**
     * Turns rhythm mode on, which converts channels 6-8 into five percussion
     * voices. Their volumes live in R54-R56.
     */
    setRhythmMode(on: boolean): void;
    /** Triggers drums. Pass a mask of RHYTHM bits; retriggering needs an off write first. */
    triggerRhythm(mask: number): void;
    /** Loads the 8 bytes of the user-definable instrument. */
    setCustomInstrument(parameters: ArrayLike<number>): void;
    silence(): void;
    reset(): void;
}
/**
 * Converts a frequency to the chip's (F-number, block) pair.
 *
 * fnum = hz * 2^19 / (sampleRate * 2^block), and the F-number is 9 bits, so we
 * take the lowest block that keeps it in range - that is the one with the most
 * precision left.
 */
export declare function pitchToFrequency(hz: number): {
    fnum: number;
    block: number;
};
```
