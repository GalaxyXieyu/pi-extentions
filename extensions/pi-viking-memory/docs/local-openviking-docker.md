# Local OpenViking Docker

本仓库提供 `docker-compose.openviking.yml`，用于本地启动 OpenViking 和 Ollama embedding 服务。

## 启动

```bash
# 当前 shell 需要已有 OpenAI-compatible 环境变量，仅用于 VLM 配置占位或后续扩展
# OpenViking embedding 使用本地 Ollama，不依赖该 relay

docker compose -f docker-compose.openviking.yml up -d

docker run -d --name pi-extentions-ollama \
  -p 11434:11434 \
  -v "$PWD/.runtime/ollama:/root/.ollama" \
  ollama/ollama:latest

docker exec pi-extentions-ollama ollama pull nomic-embed-text
```

实际初始化由维护脚本准备 `.runtime/openviking/ov.conf`，其中：

- OpenViking 使用本地存储
- `trusted` 模式只绑定本机端口
- embedding 使用 `host.docker.internal:11434`
- root key 和 ovcli 配置只放在被 `.gitignore` 忽略、权限 `0600` 的 `.runtime/openviking`
- Ollama 模型数据放在被忽略的 `.runtime/ollama`

## 验证

```bash
curl http://127.0.0.1:1933/health
curl http://127.0.0.1:1933/ready
node --experimental-strip-types verification/openviking-readonly-probe.mjs
```

只读 probe 只执行 context-aware search，不执行 session/add、commit、resource ingest 或删除。

## Pi

加载本地环境：

```bash
. .runtime/openviking/pi.env
pi install ./extensions/pi-viking-memory
PI_OFFLINE=1 pi --offline -e ./extensions/pi-viking-memory --help
```

停止服务：

```bash
docker compose -f docker-compose.openviking.yml down
docker rm -f pi-extentions-ollama
```
