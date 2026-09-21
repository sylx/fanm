#!/usr/bin/env bash
#
# 本番（chevron の Coolify が動かすバッチのコンテナ）の中へ、一息で入る。
#
#     scripts/fanm-shell.sh                 # コンテナの中で bash を開く
#     scripts/fanm-shell.sh fanm status     # 中で一つだけ動かして戻る
#     scripts/fanm-shell.sh tail -f /data/run.log
#     scripts/fanm-shell.sh --root          # root で入る（既定はイメージと同じ node）
#
# 中では `fanm status` のように打てる（イメージに fanm のリンクは無いので、関数として用意する）。
# コンテナは conf-push.sh と同じやり方で探す（末尾が fanm-var のボリュームを繋いだもの）。
# Coolify は再デプロイのたびにコンテナ名を変えるので、名前は覚えておかなくてよい。

set -euo pipefail

REMOTE=${FANM_REMOTE:-chevron}
VOLUME=${FANM_VOLUME:-}
CONTAINER=${FANM_CONTAINER:-}
AS_USER=
CMD=()

die() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

usage() {
    cat <<'USAGE'
本番のバッチのコンテナの中へ入る。

  scripts/fanm-shell.sh [選択肢] [コマンド…]

コマンドを渡せばそれだけを動かして戻る。無ければ bash を開く。

選択肢
      --root          root で入る（既定: イメージと同じ node）
      --remote HOST   ssh の接続先（既定: chevron、環境変数 FANM_REMOTE）
      --volume NAME   本番のボリューム名（既定: 名前に fanm-var を持つもの）
      --container ID  入るコンテナ（既定: 自動で探す）
  -h, --help          これ
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --root) AS_USER=root; shift ;;
        --remote) [ $# -ge 2 ] || die "--remote に接続先がない"; REMOTE=$2; shift 2 ;;
        --volume) [ $# -ge 2 ] || die "--volume に名前がない"; VOLUME=$2; shift 2 ;;
        --container) [ $# -ge 2 ] || die "--container に名前がない"; CONTAINER=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; CMD=("$@"); break ;;
        -*) die "知らない選択肢: $1（--help を見る）" ;;
        *) CMD=("$@"); break ;;
    esac
done

command -v ssh >/dev/null || die "ssh が要る"

ssh_run() { ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "$@"; }

ssh_run true 2>/dev/null || die "$REMOTE に ssh で入れない（~/.ssh/config と鍵を確かめる）"

# ボリュームを探す。Coolify が名前の頭に一意の文字列を足すので、末尾で見分ける。
if [ -z "$CONTAINER" ]; then
    if [ -z "$VOLUME" ]; then
        mapfile -t found < <(ssh_run "docker volume ls -q | grep -E 'fanm-var$' || true")
        case ${#found[@]} in
            0) die "fanm-var のボリュームが $REMOTE に無い（--volume か --container で指定する）" ;;
            1) VOLUME=${found[0]} ;;
            *) die "fanm-var のボリュームが複数ある。--volume で選ぶ: ${found[*]}" ;;
        esac
    fi
    # 入れるのは動いているものだけ。止まったものしか無ければ、そう言って止める。
    CONTAINER=$(ssh_run "docker ps --filter volume='$VOLUME' --format '{{.Names}}' | head -1")
    if [ -z "$CONTAINER" ]; then
        stopped=$(ssh_run "docker ps -a --filter volume='$VOLUME' --format '{{.Names}}（{{.Status}}）' | head -1")
        die "$VOLUME を繋いだ動いているコンテナが無い${stopped:+。止まっているもの: $stopped}"
    fi
fi

# 端末から打っているときだけ -t を付ける。パイプで流すときに端末を要求すると崩れる。
tty_flags=(-i)
ssh_tty=(-T)
if [ -t 0 ] && [ -t 1 ]; then
    tty_flags=(-it)
    ssh_tty=(-t)
fi

exec_args=("${tty_flags[@]}" -w /app -e "PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
[ -n "$AS_USER" ] && exec_args+=(-u "$AS_USER")

[ ${#CMD[@]} -eq 0 ] && note "$REMOTE → $CONTAINER（抜けるには exit）"

# fanm を関数として export し、開いた bash にも渡す。コマンドがあればそれだけ動かす。
PRELUDE='fanm() { tsx /app/packages/batch/src/cli.ts "$@"; }; export -f fanm; [ $# -eq 0 ] && exec bash; "$@"'

# ssh は引数を一本の文字列にして向こうのシェルに渡すので、一つずつ引用しておく。
remote_cmd=$(printf '%q ' docker exec "${exec_args[@]}" "$CONTAINER" bash -c "$PRELUDE" fanm-shell "${CMD[@]}")
exec ssh -o ConnectTimeout=10 "${ssh_tty[@]}" -o LogLevel=ERROR "$REMOTE" "$remote_cmd"
