#!/usr/bin/env bash
# 把某个 tag 的 GitHub Release 附件同步到 Gitee 同名 Release。
# 用法:GITEE_TOKEN=<私人令牌> bash scripts/sync-gitee-release.sh v1.3.1
# 令牌需要 projects 权限;只在本地使用,不要提交到任何仓库或 CI。
set -euo pipefail

TAG="${1:?用法: GITEE_TOKEN=<私人令牌> bash scripts/sync-gitee-release.sh <tag>}"
GITEE_REPO="${GITEE_REPO:-princess-zp/dataBasePro}"
GH_REPO="${GH_REPO:-cherish-zp/dataBasePro}"
: "${GITEE_TOKEN:?请设置 GITEE_TOKEN 环境变量(私人令牌,projects 权限)}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. 下载该 tag 的 GitHub Release 全部附件(公开仓库,无需 GitHub 令牌)。
echo "== 拉取 GitHub Release ${TAG} 附件 =="
ASSETS=$(curl -sSfL --retry 3 "https://api.github.com/repos/${GH_REPO}/releases/tags/${TAG}" \
  | python3 -c 'import sys,json; [print(a["browser_download_url"]) for a in json.load(sys.stdin).get("assets", [])]')
[ -n "${ASSETS}" ] || { echo "GitHub Release ${TAG} 没有附件"; exit 1; }
while IFS= read -r url; do
  echo "  下载 $(basename "$url")"
  curl -sSfL --retry 3 -o "${TMP}/$(basename "$url")" "$url"
done <<< "${ASSETS}"

# 2. 创建或复用 Gitee Release。
RID=$(curl -sSfL "https://gitee.com/api/v5/repos/${GITEE_REPO}/releases/tags/${TAG}?access_token=${GITEE_TOKEN}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin) or {}; print(d.get("id",""))' || true)
if [ -z "${RID}" ]; then
  echo "== 创建 Gitee Release ${TAG} =="
  curl -sSfL -X POST "https://gitee.com/api/v5/repos/${GITEE_REPO}/releases?access_token=${GITEE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"${TAG}\",\"target_commitish\":\"${TAG}\",\"name\":\"${TAG}\",\"body\":\"自动构建产物,详见 GitHub Release。\",\"prerelease\":false}" > "${TMP}/created.json"
  RID=$(python3 -c "import json; d=json.load(open('${TMP}/created.json')) or {}; print(d.get('id',''))")
fi
[ -n "${RID}" ] || { echo "Gitee Release 创建失败"; exit 1; }

# 3. 上传全部附件(已存在的同名附件会重复上传,可到 Gitee 页面手工清理)。
echo "== 上传附件到 Gitee =="
for f in "${TMP}"/*; do
  case "$f" in *.zip|*.tar.gz|*.exe) ;; *) continue ;; esac
  echo "  上传 $(basename "$f")"
  curl -sSfL --retry 2 -X POST "https://gitee.com/api/v5/repos/${GITEE_REPO}/releases/${RID}/attach_files" \
    -F "access_token=${GITEE_TOKEN}" -F "file=@$f" > /dev/null
  echo "  完成 $(basename "$f")"
done

echo "== 同步完成:https://gitee.com/${GITEE_REPO}/releases/tag/${TAG} =="
