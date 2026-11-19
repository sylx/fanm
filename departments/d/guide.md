この作品には、画像生成の AI に描かせた絵を同梱する。型は上の手引きのとおりで、
型の作法も見せどころも変わらない。そのうえで、描かせた絵に **型の中での役** を持たせる。

- アドベンチャーなら場面の一枚、詩なら挿絵、ゲームや対戦なら背景や盤、楽曲なら
  曲に合わせて色の変わる一枚、環境デモなら移り変わる光景、おもちゃなら触ると反応する絵。
- 絵を一枚出して終わりにしない。絵の上で、あるいは絵と一緒に、時間とともに何かが起きること。
- 絵を飾りに置いただけで、型の作品としては前と同じ、にもしない。絵が無ければ成り立たない段取りにする。

#### 絵を頼む（企画）

企画の JSON に `pictures` を足し、描かせる絵を **1〜2枚** 書く。こちらが描き手に
描かせ、縮めて作品に同梱する。

```json
"pictures": [
  { "name": "castle", "aspect": "4:3", "prompt": "Pixel art of ..." }
]
```

- `name` は英小文字で始まる英小文字・数字・`_`。作品では `env.images.<name>` で受け取る。
- `aspect` は `4:3`（横長、既定）、`1:1`、`3:4`、`16:9` のどれか。画面は 256x212 なので、ふつうは `4:3`。
- `prompt` は **英語** で書く。描き手は絵しか見ない。企画の他の欄は読まない。
  - 何が画面の **どこ** にあるかを具体的に書く（"a full moon in the upper left, a castle on a hill on the right"）。作品のコードは絵を見られない。どこが光り、どこが動くかは、この文から知る。
  - 画風を書く。"pixel art, retro 8-bit home computer style, limited 16-colour palette" のように、色の少ない、輪郭のはっきりした絵にする。写真風や細かいグラデーションは、16色に落とすと崩れる。
  - 作品の中で動かしたい所は、絵の中で **一つの色** にまとまるように頼む（"the windows glow in one flat yellow"）。一色にまとまっていれば、パレットを一つ書き換えるだけで、そこが一斉に光る。
  - **スプライトで動かすものは、絵に描かせない。** 絵に描かせると、止まった凧と飛ぶ凧が二つ並ぶ。代わりに、動くものの通り道を空けておくよう頼む（"leave the upper sky empty; a kite will fly there"）。
  - 字を描かせない。崩れる。字は作品の側で `ctx.text` や `gfx.text` で出す。
  - 実在の作品、キャラクタ、ロゴ、人物を描かせない。
- 二枚頼むなら、二枚の関係を決めておく（同じ場所の昼と夜、近景と遠景、前と後）。
- 題や説明で主役にするものを、絵の中で止めたままにしない。主役は、スプライトとして動かすか（そのときは絵に描かせない）、絵の中でその色だけを動かせるよう一色にまとめて描かせる。

#### 絵を使う（作品）

絵は `env.images.<name>` に、色を減らしていない RGBA（`{ width, height, data }`）で
届いている。**自分では読みに行かない**（`fetch`、`image.load`、`image.show` は使えない）。
`ctx.image` で画面のモードに合わせて色を減らし、VRAM に置く。

```ts
init({ screen, image }) {
    screen.setMode("G4");
    const source = env.images.castle;
    // この絵のための16色。先頭の n 色は今の色のまま残る（reserve）。0番は黒のまま残しておく。
    const colors = image.palette(source, { reserve: 1 });
    screen.setPalette(colors);
    // 256x212 に落とす。cover は画面を埋めてはみ出しを切る。contain は全部入れて余白を残す。
    const picture = image.reduce(source, { width: 256, height: 212, fit: "cover", palette: colors, exclude: [0], dither: "ordered" });
    image.drawNow(picture, 0, 0);
}
```

使えるのは次の四つ（`ctx.image`）。

```ts
palette(source: RgbaImage, options?: { colors?: number; reserve?: number; mode?: ScreenModeName }): PaletteColor[];
reduce(source: RgbaImage, options?: ReduceOptions): IndexedImage;
draw(image: IndexedImage, x?: number, y?: number, options?: { transparent?: boolean }): void;     // blitter に積む（数フレームかかる）
drawNow(image: IndexedImage, x?: number, y?: number, options?: { transparent?: boolean }): void;  // すぐ VRAM に書く

interface ReduceOptions {
    width?: number; height?: number;          // 落とした先の大きさ（画素）。片方だけなら比を保つ
    fit?: "contain" | "cover" | "stretch";    // 両方渡したときの収め方。既定 contain
    dither?: "none" | "ordered" | "floyd-steinberg";  // 既定 floyd-steinberg。ordered が一番 MSX らしい
    ditherAmount?: number;                     // 0〜1
    palette?: ReadonlyArray<PaletteColor>;     // 落とす先の色。省くと今の画面のパレット
    exclude?: readonly number[];               // 使わせない色番号
    mode?: ScreenModeName;                     // 今と違うモード向けに落とす
}
interface IndexedImage { readonly width: number; readonly height: number; readonly pixels: Uint8Array; readonly mode: ScreenModeName }
```

- `palette` が返すのは16色ぶんの `[r, g, b]`（各 0〜7）。選び方は決まっているので、同じ絵なら毎回同じ色が同じ番号に並ぶ。**どの番号がどの色になるかは、生成の頼みの「同梱の画像」に書いてある**。光らせる色、回す色は、そこから番号で選ぶ。
- 落とす作業は重い（一枚 20〜50ms）。**`init` か場面の切り替えで数回だけ**。毎フレーム `reduce` や `drawNow` をしない。検査の時間切れで落ちる。
- `reduce` の `pixels` は 1 画素 1 バイトの色番号。升目ごとに切り出して `gfx.now.drawImage(x, y, w, h, pixels)` に渡せば、絵を部分ごとに置ける。
- モードごとの違い。
  - G4（256x212、16色）が基本。`palette` で絵の色を選ぶと一番よく映る。
  - G7（256x212、256色固定）は `palette` も `setPalette` も要らない。`reduce` だけ。色の変化は描き足しで作る。
  - G5（512x212、4色）と G6（512x212、16色）は横に 512 画素。`width: 512, height: 212` で落とす（縦横比は自動で直る）。G5 は `palette(source, { colors: 4 })`。
- **置いた絵の上に `fillRect` や線を塗り重ねない。** 絵が壊れる（光の帯を黄色と灰色の縞で塗った作品があった）。光、波、影、時刻の変化は、絵の色番号をパレットで書き換えて作る。絵の外（窓の周りの枠、文章の帯）に描くのはよい。周の終わりに絵を片づけて次へ移るのもよい。
- 絵を置いたあとの動きは、いつもの得意技で作る。
  - パレット：絵の中の一色を明滅させる、何色かを回す、全体を暗くして浮かばせる（選んだ色に係数を掛けて `setColor` し直す）。
  - スプライト：絵の前を動くもの。色は絵のために選んだ16色の中から、表の色の言葉（「明るい赤」など）を見て、その物の色に近い番号を選ぶ。表に無い色が要るなら、`reserve` で先頭に自分の色を残しておく。
  - ページ：二枚目の絵を見えないページに置いておき（`screen.setDrawPage(1)` で描く先を替えてから `drawNow`、終わったら戻す）、`gfx.blit` で写す・`screen.setDisplayPage` で差し替える。
- 文字を足すなら、`palette` の `reserve` で文字用の色を先頭に残しておく。絵の色と取り合わない。
- 音は必ず付ける。絵の雰囲気に合わせる。

過去の D部門の作品と、次のどれかは大きく変える。

- 絵の題材（風景、室内、生きもの、機械、食べもの、乗りもの、天気、遠い場所）
- 絵の中で動く所（光、水、空、群れ、時刻）
- 絵の役（背景、場面、挿絵、盤、窓）

夜の城に月、のような暗い地に光るものを置く絵は、多くなりがち。昼、室内、明るい地も選べる。
