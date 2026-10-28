# AGY Commit

在 Antigravity 里生成提交信息。

## 支持范围

仅支持 Antigravity，使用其自带的服务生成提交信息。

## 前置要求

- Antigravity 已登录，且语言服务器正常启动
- 当前工作区是 git 仓库
- 至少暂存一个文件（未暂存时会提示先暂存）

## 入口

- Source Control 面板标题栏的 ✨ `生成提交信息`
- 快捷键 `Cmd+Alt+G`
- 命令面板：`AGY Commit: 生成提交信息`

## 设置

| 设置 | 取值 | 默认 |
| --- | --- | --- |
| `agyCommit.commitMessageLanguage` | `zh_CN` / `en` | `zh_CN` |

## 安装

在 Antigravity IDE 中打开 Extensions → `...` → **Install from VSIX...**

## 许可

MIT
