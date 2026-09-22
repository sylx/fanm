// 作り手の性格。ジョブのたびに引き、企画と生成の頼みに書き込む。
//
// 相手（モデル）が同じでも、性格が違えば作風が違う。札束（providers/deck.ts）が
// 頭を替えて散らすのに対して、こちらは同じ頭に別の人柄を着せて散らす。
//
// 性格はいくつかの軸の組で、軸の値は数段に刻む。連続値のままだと同じ性格が二度と
// 現れず、同じ作り手の作品が並ぶことがない。刻んでおけば、同じモデルで同じ性格の
// 作り手は同じペンネームで何度も出てくる（persona/pen-name.ts）。
//
// ## 軸を足すとき
//
// ペンネームは性格の鍵（personaKey）から決まる。軸を足しても前からいる作り手の
// 名前が変わらないように、次を守る。
//
// - 足す軸には必ず neutral（その軸が無かったころの振る舞い）を書く。鍵は neutral の
//   軸を含めないので、新しい軸が neutral の作り手は前と同じ鍵、同じ名前になる。
// - 軸と選択肢の id は変えない、消さない。刻みも変えない。変えると鍵が変わる。
//   頼みに入れる文（brief）はいつ書き替えてもよい。
//
// 最初からある三軸には neutral が無い。どの値でも鍵に入る。

export type TraitValue = number | string;

/** 性格の値。軸の id → 値。軸が増える前の記録には、新しい軸の値が無い。 */
export type Traits = Readonly<Record<string, TraitValue>>;

interface ScaleAxis {
    readonly kind: "scale";
    /** 鍵と記録に使う名前。変えない。 */
    readonly id: string;
    /** 0 と 1 の端の呼び名。 */
    readonly low: string;
    readonly high: string;
    /** 軸が無かったころの値。後から足す軸にだけ書く。 */
    readonly neutral?: number;
    /** 刻みごとの、頼みに入れる文。STEPS と同じ数。 */
    readonly briefs: readonly string[];
}

interface ChoiceAxis {
    readonly kind: "choice";
    readonly id: string;
    readonly label: string;
    readonly neutral?: string;
    readonly options: readonly { readonly id: string; readonly label: string; readonly brief: string }[];
}

export type Axis = ScaleAxis | ChoiceAxis;

/** 連続の軸の刻み。変えると鍵が変わり、作り手の名前が変わる。 */
export const STEPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

export const AXES: readonly Axis[] = [
    {
        kind: "scale",
        id: "precision",
        low: "緻密",
        high: "大雑把",
        briefs: [
            "とても緻密。点の一つ、音の一つまで置き場所を決め、小さな仕掛けを幾重にも重ねる",
            "丁寧。見せ場の細部はきちんと作り込む",
            "詰めるところと流すところを選ぶ",
            "大きな筆で描く。細部より勢い、数より大きさ",
            "豪快。細かい飾りは捨て、大きな形と大胆な動きひとつで押し切る"
        ]
    },
    {
        kind: "choice",
        id: "focus",
        label: "こだわり",
        options: [
            { id: "graphics", label: "グラフィック", brief: "絵。色、構図、画面の美しさに一番手間をかける" },
            { id: "music", label: "音楽", brief: "音。旋律、和音、音色、音と画面の合い方に一番手間をかける" },
            { id: "gameplay", label: "ゲーム性", brief: "遊び。手応え、駆け引き、仕組みの面白さに一番手間をかける。操作の無い型でも、仕組みが見て分かる面白さで見せる" }
        ]
    },
    {
        kind: "scale",
        id: "intuition",
        low: "感性に従う",
        high: "理性的",
        briefs: [
            "感性に従う。筋道より、その場で美しいと感じたもの、気持ちいい手触りを信じる",
            "感覚が先。理屈は後から合わせる",
            "感覚と理屈を行き来する",
            "筋道を立てる。なぜそうするかを決めてから手を動かす",
            "理詰め。規則、数、仕組みから組み立て、構造そのものを見せる"
        ]
    }
];

/** 引いた作り手。ジョブに残し、採用したら作品の meta に書く。 */
export interface Persona {
    readonly penName: string;
    readonly traits: Traits;
}

/** 軸の値。記録に無ければ neutral（軸が増える前の記録）。 */
function valueOf(axis: Axis, traits: Traits): TraitValue | undefined {
    return traits[axis.id] ?? axis.neutral;
}

/** 今回の性格を引く。軸ごとに同じ確からしさで。 */
export function drawTraits(random: () => number): Traits {
    const traits: Record<string, TraitValue> = {};
    for (const axis of AXES) {
        const values = axis.kind === "scale" ? STEPS : axis.options.map(o => o.id);
        traits[axis.id] = values[Math.floor(random() * values.length)];
    }
    return traits;
}

/**
 * 作り手の同一性の鍵。モデルと、neutral でない軸の値を id 順に並べたもの。
 * 同じ鍵なら同じ作り手で、同じペンネームになる。
 */
export function personaKey(model: string, traits: Traits): string {
    // 並べる順は軸の並びではなく id 順。軸をどこに足しても鍵が変わらないように。
    const parts = AXES
        .filter(axis => valueOf(axis, traits) !== undefined && valueOf(axis, traits) !== axis.neutral)
        .map(axis => `${axis.id}=${valueOf(axis, traits)}`)
        .sort();
    return `${model}|${parts.join(",")}`;
}

/** 連続の軸の値に一番近い刻み。 */
function stepIndex(value: number): number {
    let best = 0;
    for (let i = 1; i < STEPS.length; ++i) if (Math.abs(STEPS[i] - value) < Math.abs(STEPS[best] - value)) best = i;
    return best;
}

/** ログに出す短い形。 */
export function personaBrief(persona: Persona): string {
    const parts = AXES.map(axis => {
        const value = valueOf(axis, persona.traits);
        if (axis.kind === "scale") return `${axis.low}↔${axis.high}=${value ?? "-"}`;
        return `${axis.label}=${axis.options.find(o => o.id === value)?.label ?? "-"}`;
    });
    return `${persona.penName}（${parts.join(" / ")}）`;
}

/** 企画と生成の頼みに入れる文。 */
export function personaPrompt(persona: Persona | undefined): string {
    if (!persona) return "（指定なし）";
    const lines = AXES.flatMap(axis => {
        const value = valueOf(axis, persona.traits);
        if (value === undefined) return [];
        if (axis.kind === "scale") {
            return [`- **${axis.low}↔${axis.high}**: ${axis.briefs[stepIndex(Number(value))]}`];
        }
        const option = axis.options.find(o => o.id === value);
        return option ? [`- **${axis.label}**: ${option.brief}`] : [];
    });
    return [`あなたは「${persona.penName}」という作り手です。性格は次のとおりです。`, "", ...lines].join("\n");
}
