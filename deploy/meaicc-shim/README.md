# meaicc-shim

`api.meaicc.com` 前面的整形代理。**只为一件事**：上游对整包体积有上限（实测 5.8 MB 通过 /
8.5 MB 返回 `FAILED: 请求格式错误2`），而画布给的参考图是三张 2.1 MB 的 PNG，
内联成 `data:` URL 后出站 8.5 MB 必被拒。

它把 `input.media[].url` 里的**图片 data URL** 按预算重编码（默认 4 MiB，
`1280px q82 → 1280 q72 → 960 q72 → 720 q65 → 640 q60` 逐级降），其余（外链 URL、
音频/视频、轮询请求）原样透传。没超预算就完全不动，因此小请求无画质损失。

## 运行

```bash
# 依赖 Pillow（用号池镜像 vn:2.3.34 现成有 PIL，或 python:3.12-slim + pip install pillow）
docker run -d --name meaicc-shim --restart unless-stopped \
  --network new-api_new-api-network --entrypoint python3 \
  -v /root:/root vn:2.3.34 /root/meaicc_shim.py 18889
```

可选环境变量：`SHIM_BUDGET_BYTES`（默认 4194304）、`SHIM_MAX_SIDE`（1280）、
`SHIM_QUALITY`（82）、`SHIM_OUT_DIR`（默认 `/root/meaicc_shim`）、`SHIM_UPSTREAM`。

## 接到渠道上

只改数据库不够——New API 有渠道内存缓存，必须走管理接口触发 `InitChannelCache`：

```bash
curl -s -X PUT http://127.0.0.1:3000/api/channel/ \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "New-Api-User: 1" \
  -H 'Content-Type: application/json' \
  -d '{"id":10,"base_url":"http://meaicc-shim:18889"}'
```

回滚：`{"id":10,"base_url":"https://api.meaicc.com"}`（直连，参考图继续受体积上限影响）。

## 日志

`/root/meaicc_shim/meaicc_shim.log` 每笔一行，含是否压缩与压缩比，例如：

```
20261009-124301 POST /v1/videos clen=452026 shrunk 3 imgs 6.37MB -> 0.45MB @1280px q82
20261009-124422 POST /v1/videos clen=150057 unchanged 1 imgs 0.11MB
```

原始请求/响应另存为同名 `.req` / `.resp`（含上游响应头，便于复核）。
