# 作品を作り続けるバッチ処理。chevron の Coolify に常駐させる。
#
# 状態（ジョブ、予算台帳、作品庫、公開物、ログ）はイメージに入れず、すべて /data に置く。
# イメージを作り直しても、使用額も作品も失われない。
#
#     docker build -t fanm-batch .
#     docker run -d --name fanm -v fanm-var:/data --env-file .env fanm-batch

FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 依存を先に入れる。ソースを直すたびに入れ直さないため。
COPY package.json package-lock.json ./
COPY packages/batch/package.json packages/batch/
COPY packages/gallery/package.json packages/gallery/
COPY packages/work/package.json packages/work/
RUN npm ci

COPY . .

# 固定したエンジンを用意する。作品はこの版で動き続けるので、どこで組んでも
# 同じコミットになるようにする。
#
# 正は engine/COMMIT（リポジトリに入っている）。submodule ごと持ってきていれば
# その中身を使い、空なら自分で取ってくる（clone が submodule を展開しない場合）。
# .git があるときは、submodule の指し先と食い違っていないか確かめる。
RUN set -eu; \
    pinned=$(cat engine/COMMIT); \
    if [ -d .git ]; then \
        actual=$(git ls-tree HEAD engine/fantasy-msx | awk '{print $3}'); \
        if [ -n "$actual" ] && [ "$actual" != "$pinned" ]; then \
            echo "engine/COMMIT ($pinned) と submodule の指し先 ($actual) が食い違う。npm run engine:pin で直す" >&2; \
            exit 1; \
        fi; \
    fi; \
    if [ ! -f engine/fantasy-msx/package.json ]; then \
        rm -rf engine/fantasy-msx; \
        git clone --quiet https://github.com/sylx/fantasy-msx.git engine/fantasy-msx; \
        git -C engine/fantasy-msx checkout --quiet "$pinned"; \
    fi; \
    rm -rf .git engine/fantasy-msx/.git

# ギャラリーの殻。公開のたびにここから写す（packages/gallery/dist）。
RUN npm run gallery:build


FROM node:24-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app

# 制作状態の置き場所。Coolify の永続ボリュームをここに繋ぐ。
# 設定を volume 側に置けば（/data/fanm.json）、作り直さずに予算や頻度を変えられる。
ENV FANM_VAR=/data \
    FANM_CONFIG=/data/fanm.json \
    NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

# 常駐が生きていて、目印が新しく、人を呼んでいなければ健康。
HEALTHCHECK --interval=5m --timeout=60s --start-period=2m --retries=2 \
    CMD ["node_modules/.bin/tsx", "packages/batch/src/cli.ts", "status"]

CMD ["node_modules/.bin/tsx", "packages/batch/src/cli.ts", "run"]
