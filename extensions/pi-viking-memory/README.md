# pi-viking-memory

Pi 的统一记忆插件入口，同时支持两个后端：

- `viking-memory`：火山引擎 Viking Memory API
- `openviking`：本地或远程 OpenViking REST API

安装一次：

```bash
pi install ./extensions/pi-viking-memory
```

通过环境变量选择唯一主动后端：

```bash
export PI_MEMORY_BACKEND=viking-memory
# 或
export PI_MEMORY_BACKEND=openviking
```

两个后端不会同时自动召回或写入。

## 文档

- [记忆架构调研](./docs/memory-architecture-research.md)
- [企业多用户检索](./docs/enterprise-memory-retrieval.md)
- [生命周期与可观测性](./docs/memory-lifecycle-and-observability.md)
- [企业 Memory 产品策略](./docs/memory-product-policy.md)
- [本地 Docker OpenViking](./docs/local-openviking-docker.md)
- [抽取模板](./core/templates.md)
- [机器可读策略](./core/memory-policy.json)
- [统一 Provider 契约](./core/README.md)

## 后端配置

Viking Memory 使用 `MEMORY_API_KEY`、`VIKING_MEMORY_COLLECTION`、`VIKING_MEMORY_PROJECT`、`VIKING_MEMORY_USER_ID`、`VIKING_MEMORY_ASSISTANT_ID`。

OpenViking 使用 `OPENVIKING_URL`、`OPENVIKING_API_KEY` 或本地安全 `ovcli.conf`，本地 Docker 启动方式见 [Docker 文档](./docs/local-openviking-docker.md)。

## 验证

```bash
node ./extensions/pi-viking-memory/tests/run-tests.mjs
node ./tests/run-all.mjs
```

远端测试数据和本地 runtime 配置不由插件自动删除；测试 marker 和清理边界见 `verification/`。
