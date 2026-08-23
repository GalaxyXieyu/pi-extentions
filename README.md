# Pi Extensions

这是个人 Pi 插件与 harness 的汇总仓库。每个插件保持独立 Git 历史，通过 Git submodule 组合到这里，便于分别开发、发布和升级。

## 子项目

| 路径 | 项目 | 用途 |
| --- | --- | --- |
| [`extensions/pi-agents-flow`](./extensions/pi-agents-flow) | [pi-agents-flow](https://github.com/GalaxyXieyu/pi-agents-flow) | Supervisor-led 多 Agent 编排、持久工作流与质量门禁 |

## 初始化

首次克隆后初始化所有子项目：

```bash
git clone --recurse-submodules https://github.com/GalaxyXieyu/pi-extentions.git
```

已有 checkout 则执行：

```bash
git submodule update --init --recursive
```

## 日常维护

在子项目目录内开发和提交，子项目的提交由它自己的远端管理：

```bash
cd extensions/pi-agents-flow
# 开发、测试并提交子项目改动
npm test
git pull --ff-only origin main
```

回到汇总仓库后，更新并提交 submodule 指针：

```bash
cd ../..
git add extensions/pi-agents-flow
git commit -m "chore: update pi-agents-flow"
```

查看子项目当前指针：

```bash
git submodule status
```

## Pi 安装

`pi-agents-flow` 自带 Pi extension、skills 和 prompts 配置。开发时可直接从子项目 checkout 安装：

```bash
pi install ./extensions/pi-agents-flow
```

具体使用方式、测试命令和发布说明见 [`extensions/pi-agents-flow/README.md`](./extensions/pi-agents-flow/README.md)。
