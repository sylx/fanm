#!/usr/bin/env bash
#
# 手元の config/fanm.json を本番（chevron の Coolify が持つ永続ボリューム）へ送る。
#
# fanm-pull.sh と対になる道具だが、向きが逆で、運ぶのは設定ひとつだけ。作品や台帳は
# 本番のものが正しいので、こちらからは決して押し込まない。
#
#     scripts/conf-push.sh            # 差分を見せて、承諾してから送る
#     scripts/conf-push.sh -n         # 見るだけ
#     scripts/conf-push.sh -y         # 確認を求めずに送る
#     scripts/conf-push.sh 別の.json  # 送るファイルを指定する
#
# 送る前に、その設定を fanm 自身に読ませて確かめる（壊れた JSON、空の札束、単価表に
# 無いモデルは、ここで止まる）。常駐は30秒ごとに設定を読み直すので、送ったあとに
# 入れ替えは要らない。送り先（publish）を変えたときだけは再デプロイが要る。

set -euo pipefail

REMOTE=${FANM_REMOTE:-chevron}
VOLUME=${FANM_VOLUME:-}
CONTAINER=${FANM_CONTAINER:-}
REMOTE_VAR=${FANM_REMOTE_VAR:-/data}
DRY_RUN=0
ASSUME_YES=0
WAIT=1
SOURCE=

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# 送ったあと、常駐が読み直すのを待つ上限（秒）。目を覚ますのは30秒ごと。
WAIT_SECONDS=45

die() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
    cat <<'USAGE'
手元の設定を本番の永続ボリュームへ送る（push のみ）。

  scripts/conf-push.sh [選択肢] [送るファイル]

送るファイル（既定: config/fanm.json）

選択肢
  -n, --dry-run       送らずに差分だけ見せる
  -y, --yes           確認を求めずに送る
      --no-wait       送ったあと、常駐が読み直すのを待たない
      --remote HOST   ssh の接続先（既定: chevron、環境変数 FANM_REMOTE）
      --volume NAME   本番のボリューム名（既定: 名前に fanm-var を持つもの）
      --container ID  ボリュームを繋いでいるコンテナ（既定: 自動で探す）
  -h, --help          これ
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -n|--dry-run) DRY_RUN=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        --no-wait) WAIT=0; shift ;;
        --remote) [ $# -ge 2 ] || die "--remote に接続先がない"; REMOTE=$2; shift 2 ;;
        --volume) [ $# -ge 2 ] || die "--volume に名前がない"; VOLUME=$2; shift 2 ;;
        --container) [ $# -ge 2 ] || die "--container に名前がない"; CONTAINER=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; [ $# -ge 1 ] && SOURCE=$1; break ;;
        -*) die "知らない選択肢: $1（--help を見る）" ;;
        *) [ -z "$SOURCE" ] || die "送れるファイルは一つだけ"; SOURCE=$1; shift ;;
    esac
done

SOURCE=${SOURCE:-$ROOT/config/fanm.json}
[ -f "$SOURCE" ] || die "$SOURCE が無い（config/fanm.example.json を写して作る）"

command -v ssh >/dev/null || die "ssh が要る"

# 送る前に、fanm 自身に読ませる。本番で初めて弾かれるより、ここで止まる方がいい。
# 読めても、鍵の無い相手が混じっていれば常駐は前の設定のまま続ける（それは本番側の話）。
if command -v npx >/dev/null; then
    note "確かめる: $SOURCE"
    # 理由だけを一行で出す。積み上げ（stack）はここでは邪魔なので見せない。
    (cd "$ROOT" && npx --no-install tsx -e '
        import { loadConfig } from "./packages/batch/src/config.js";
        import { deckBrief, unknownModels } from "./packages/batch/src/providers/deck.js";
        try {
            const config = loadConfig(process.argv[1]);
            const unknown = unknownModels(config.providers);
            if (unknown.length) throw new Error(`単価表に無い相手がいる: ${unknown.join("、")}`);
            console.log(`  札束: ${deckBrief(config.providers)}`);
            console.log(`  予算: 月 $${config.budget.monthlyUsd} / 一作品 $${config.budget.perWorkUsd}`);
            console.log(`  制作: 一日 ${config.production.attemptsPerDay} 回まで、修正 ${config.production.maxRepairs} 回まで`);
        } catch (e) {
            console.error(`  ${(e as Error).message}`);
            process.exit(1);
        }
    ' "$SOURCE") || die "この設定は fanm が読めない。直してから送る"
else
    note "npx が無いので中身は確かめない（JSON としてだけ見る）"
    python3 -m json.tool "$SOURCE" >/dev/null 2>&1 || die "$SOURCE は JSON として読めない"
fi

ssh_run() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "$@"; }

note "本番: $REMOTE"
ssh_run true 2>/dev/null || die "$REMOTE に ssh で入れない（~/.ssh/config と鍵を確かめる）"

# ボリュームを探す。Coolify が名前の頭に一意の文字列を足すので、末尾で見分ける。
if [ -z "$VOLUME" ]; then
    mapfile -t found < <(ssh_run "docker volume ls -q | grep -E 'fanm-var$' || true")
    case ${#found[@]} in
        0) die "fanm-var のボリュームが $REMOTE に無い（--volume で指定する）" ;;
        1) VOLUME=${found[0]} ;;
        *) die "fanm-var のボリュームが複数ある。--volume で選ぶ: ${found[*]}" ;;
    esac
fi
note "ボリューム: $VOLUME"

if [ -z "$CONTAINER" ]; then
    CONTAINER=$(ssh_run "docker ps -a --filter volume='$VOLUME' --format '{{.Names}}' | head -1")
    [ -n "$CONTAINER" ] || die "$VOLUME を繋いだコンテナが無い（--container で指定する）"
fi

STATE=$(ssh_run "docker inspect -f '{{.State.Status}}' '$CONTAINER'" 2>/dev/null || echo unknown)
note "コンテナ: $CONTAINER（$STATE）"
[ "$STATE" = running ] || die "コンテナが動いていない。docker exec で書き込めないので、先に起動する"

TARGET=$REMOTE_VAR/fanm.json
CURRENT=$(mktemp "${TMPDIR:-/tmp}/conf-push.XXXXXX")
trap 'rm -f "$CURRENT"' EXIT

# いま置かれているもの。無ければ空（初回）。
ssh_run "docker exec '$CONTAINER' cat '$TARGET' 2>/dev/null || true" >"$CURRENT"

note ""
if [ ! -s "$CURRENT" ]; then
    note "本番にはまだ設定が無い（既定値で動いている）。まるごと置く:"
    sed 's/^/  + /' "$SOURCE"
elif diff -q "$CURRENT" "$SOURCE" >/dev/null; then
    note "差分なし。本番はすでに同じ設定。"
    exit 0
else
    note "差分（左が本番、右が手元）:"
    diff -u --label "$REMOTE:$TARGET" --label "$SOURCE" "$CURRENT" "$SOURCE" | sed 's/^/  /' || true
fi

if [ "$DRY_RUN" = 1 ]; then
    note ""
    note "見るだけ（-n）なので、何も送っていない。"
    exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
    note ""
    if [ ! -t 0 ]; then
        die "確認を取れない（端末でないなら -y を付ける）"
    fi
    read -r -p "$REMOTE の $TARGET を手元の中身にする。よいか？ [y/N] " answer
    case "$answer" in
        y|Y|yes|YES) ;;
        *) note "やめた。"; exit 1 ;;
    esac
fi

# 一つ前を残してから、一息で置き換える。読んでいる最中の常駐が半端な設定を掴まない。
ssh_run "docker exec '$CONTAINER' sh -c 'test -f $TARGET && cp $TARGET $TARGET.bak || true'"
ssh_run "docker exec -i '$CONTAINER' sh -c 'cat > $TARGET.tmp && mv $TARGET.tmp $TARGET'" <"$SOURCE"

# 届いたものが手元と同じか、読み返して確かめる。
ssh_run "docker exec '$CONTAINER' cat '$TARGET'" >"$CURRENT"
diff -q "$CURRENT" "$SOURCE" >/dev/null || die "送ったが中身が違う。$TARGET.bak に前のものが残っている"
note "送った: $REMOTE:$TARGET（前のものは $TARGET.bak）"

if [ "$WAIT" != 1 ]; then
    note "常駐は次に目を覚ましたとき（30秒以内）に読み直す。"
    exit 0
fi

# 常駐が読み直したか、ログで見届ける。読み直しの入っていない版が動いていることも
# あるので、待つのは一度きりで、出なくても失敗にはしない。
note ""
note "常駐が読み直すのを待つ（最大 ${WAIT_SECONDS}秒）…"
SINCE=$(ssh_run "docker exec '$CONTAINER' sh -c 'wc -l < $REMOTE_VAR/run.log 2>/dev/null || echo 0'")
for _ in $(seq 1 $((WAIT_SECONDS / 5))); do
    sleep 5
    line=$(ssh_run "docker exec '$CONTAINER' sh -c 'tail -n +$((SINCE + 1)) $REMOTE_VAR/run.log 2>/dev/null | grep -E \"設定を読|札束を使えない\" | tail -1 || true'")
    if [ -n "$line" ]; then
        note "  $line"
        case "$line" in
            *読み直した*) note "入った。" ;;
            *) note "本番は前の設定のまま続けている。上の理由を直してもう一度送る。"; exit 1 ;;
        esac
        exit 0
    fi
done
note "  ログに何も出なかった。設定を読み直さない版が動いているかもしれない（その場合は再デプロイが要る）。"
