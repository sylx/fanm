#!/usr/bin/env bash
#
# 本番（chevron の Coolify が持つ永続ボリューム）から手元の var/ へ引き取る。
#
# 引き取るのは works / ledger / site の三つだけ。jobs も run.log も run.json も
# 触らない。本番へ書き戻すことはしない（この道具は一方通行）。
#
#     scripts/fanm-pull.sh            # 差分を見せて、承諾してから写す
#     scripts/fanm-pull.sh -n         # 見るだけ
#     scripts/fanm-pull.sh -y works   # works だけを黙って写す
#
# 完全ミラーなので、本番に無いものは手元から消える。手元でしか作っていない作品が
# あるなら、先に -n で確かめること。

set -euo pipefail

REMOTE=${FANM_REMOTE:-chevron}
VOLUME=${FANM_VOLUME:-}
CONTAINER=${FANM_CONTAINER:-}
REMOTE_VAR=${FANM_REMOTE_VAR:-/data}
DRY_RUN=0
ASSUME_YES=0
VERBOSE=0
TARGETS=()

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
LOCAL_VAR=${FANM_VAR:-$ROOT/var}

DEFAULT_TARGETS=(works ledger site)

# 差分をそのまま出すと長い。既定ではこの行数で切る（-v で全部）。
PLAN_LINES=30

die() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
    cat <<'USAGE'
本番の制作状態を手元の var/ へ引き取る（完全ミラー、pull のみ）。

  scripts/fanm-pull.sh [選択肢] [引き取るもの...]

引き取るもの（既定: works ledger site）
  works    採用作そのもの
  ledger   今月の使用額
  site     組み立て済みの公開物

選択肢
  -n, --dry-run       写さずに差分だけ見せる
  -y, --yes           確認を求めずに写す
  -v, --verbose       差分を省略せず全部出す
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
        -v|--verbose) VERBOSE=1; shift ;;
        --remote) [ $# -ge 2 ] || die "--remote に接続先がない"; REMOTE=$2; shift 2 ;;
        --volume) [ $# -ge 2 ] || die "--volume に名前がない"; VOLUME=$2; shift 2 ;;
        --container) [ $# -ge 2 ] || die "--container に名前がない"; CONTAINER=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; TARGETS+=("$@"); break ;;
        -*) die "知らない選択肢: $1（--help を見る）" ;;
        *) TARGETS+=("$1"); shift ;;
    esac
done

[ ${#TARGETS[@]} -gt 0 ] || TARGETS=("${DEFAULT_TARGETS[@]}")

# 引き取る先は var/ の直下に限る。上へ抜ける名前は受け取らない。
for t in "${TARGETS[@]}"; do
    case "$t" in
        ''|.|..|*/*|-*) die "引き取れない名前: $t" ;;
    esac
done

command -v rsync >/dev/null || die "rsync が要る"
command -v ssh >/dev/null || die "ssh が要る"

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

# docker cp はコンテナ越しにしか使えないので、そのボリュームを繋いでいるものを探す。
# 止まっていてもよい（cp は止まったコンテナからも読める）。
if [ -z "$CONTAINER" ]; then
    CONTAINER=$(ssh_run "docker ps -a --filter volume='$VOLUME' --format '{{.Names}}' | head -1")
    [ -n "$CONTAINER" ] || die "$VOLUME を繋いだコンテナが無い（--container で指定する）"
fi

STATE=$(ssh_run "docker inspect -f '{{.State.Status}}' '$CONTAINER'" 2>/dev/null || echo unknown)
note "コンテナ: $CONTAINER（$STATE）"
if [ "$STATE" = running ]; then
    note "  ※ 常駐が動いている。写している最中に台帳が書き換わることがある"
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/fanm-pull.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

# いったん手元の仮置き場へ全部降ろしてから見比べる。降ろす途中で失敗しても、
# var/ はまだ触っていない。
for t in "${TARGETS[@]}"; do
    note "取り寄せ: $t"
    if ! ssh_run "docker cp '$CONTAINER:$REMOTE_VAR/$t' -" | tar -C "$STAGE" -xf -; then
        die "$t を取り寄せられなかった（本番に $REMOTE_VAR/$t はあるか）"
    fi
    [ -d "$STAGE/$t" ] || die "$t が届かなかった"
done

mkdir -p "$LOCAL_VAR"

# 見比べる。--delete なので、本番に無いものは消える側に出る。
changes=0
plan=$(mktemp "${TMPDIR:-/tmp}/fanm-pull-plan.XXXXXX")
trap 'rm -rf "$STAGE" "$plan"' EXIT

for t in "${TARGETS[@]}"; do
    mkdir -p "$LOCAL_VAR/$t"
    rsync -a --delete --itemize-changes --dry-run \
        "$STAGE/$t/" "$LOCAL_VAR/$t/" | sed "s|^|  $t: |" >>"$plan"
done

if [ -s "$plan" ]; then
    changes=$(wc -l <"$plan")
    deleted=$(grep -c '\*deleting' "$plan" || true)
    added=$(grep -cE ': [>c][fd]\+{9}' "$plan" || true)
    updated=$(( changes - deleted - added ))
    note ""
    note "差分: 手元から消す $deleted 件 / 増える $added 件 / 直る $updated 件"
    if [ "$VERBOSE" != 1 ] && [ "$changes" -gt "$PLAN_LINES" ]; then
        head -n "$PLAN_LINES" "$plan"
        note "  …ほか $(( changes - PLAN_LINES )) 行（全部見るなら -v）"
    else
        cat "$plan"
    fi
    note ""
    note "  先頭が *deleting のものは、本番に無いので手元から消える。"
else
    note ""
    note "差分なし。手元はすでに本番と同じ。"
    exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
    note ""
    note "見るだけ（-n）なので、何も写していない。"
    exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
    note ""
    if [ ! -t 0 ]; then
        die "確認を取れない（端末でないなら -y を付ける）"
    fi
    read -r -p "$LOCAL_VAR を本番に合わせる。よいか？ [y/N] " answer
    case "$answer" in
        y|Y|yes|YES) ;;
        *) note "やめた。"; exit 1 ;;
    esac
fi

for t in "${TARGETS[@]}"; do
    rsync -a --delete "$STAGE/$t/" "$LOCAL_VAR/$t/"
    note "写した: $LOCAL_VAR/$t"
done

note ""
note "済んだ。npm run status で手元の見え方を確かめられる。"
