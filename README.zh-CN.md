# Haro

[English](README.md) · **简体中文**

自托管的番剧订阅管理器。搜索并浏览番剧，从 Bangumi 读取详情，订阅一部作品，新剧集就会通过
qBittorrent 自动下载、带上正确的元数据整理入库——全程不需要手动碰任何一个磁力链接。然后直接观看，
用 Haro 自带的播放器，或者交给 Jellyfin。

以单个 Docker 容器运行，Docker 能跑的地方它都能跑：NAS、家庭服务器、VPS、闲置的笔记本、树莓派。
amd64 与 arm64 镜像均有发布。

## 快速开始

```bash
git clone https://github.com/lvyin1122/haro-anime-bot.git && cd haro-anime-bot
./scripts/bootstrap.sh
```

就这一步。脚本会在缺少 Docker 时装好它，写出一份可用的 `.env`，连同 Haro 自己的 qBittorrent 一起
启动，并生成几个示例剧集，好让你立刻有东西可以点「播放」。然后打开 **<http://localhost:7803>**。

| | |
| --- | --- |
| `./scripts/bootstrap.sh` | Haro + qBittorrent，使用内置播放器观看 |
| `./scripts/bootstrap.sh --with-jellyfin` | 同时启动 Jellyfin，并用它来播放 |
| `./scripts/bootstrap.sh --no-start` | 只准备环境，不启动任何服务 |

重复运行是安全的：它会报告已经存在的东西，而不是覆盖它们。它永远不会覆盖你手动改过的 `.env`——
只会告诉你哪些键与预期不同，然后原样保留文件。

部署到长期运行的机器上是另一条路径，见[部署](#部署)。

## 在自己的电脑上运行

不需要是开发者也能跑起 Haro，但确实需要敲几行命令。下面是完整步骤，假设你从没用过终端。

**你需要的东西：** 一台在下载期间可以一直开着的电脑、大约 2GB 空闲内存，以及存放视频的空间。
没别的了。

### 1. 安装 Docker Desktop

真正运行 Haro 的是 Docker。到
[docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
下载安装，和装普通软件一样。

- **Windows** —— 安装过程中它会提示安装 WSL2，请选择同意，这是必需的。
- **macOS** —— 选择与你的芯片匹配的版本（Apple Silicon 或 Intel）。
- **Linux** —— 可以跳过这一步，第 3 步的脚本会帮你装好 Docker。

安装完先打开一次 Docker Desktop，等它显示已在运行，然后保持它开着。

### 2. 获取代码

在浏览器里打开 <https://github.com/lvyin1122/haro-anime-bot>，点绿色的 **Code** 按钮，选 **Download ZIP**。
解压到一个你记得住的位置，放在「下载」文件夹里就行。

（如果你会用 `git`，直接 `git clone https://github.com/lvyin1122/haro-anime-bot.git` 也一样。）

### 3. 在那个文件夹里打开终端

- **Windows** —— 从开始菜单打开 **Ubuntu**（Docker Desktop 已经装好了它）。输入
  `cd /mnt/c/Users/你的用户名/Downloads/haro-anime-bot` 后回车。
- **macOS** —— 从「应用程序 → 实用工具」打开**终端**。先输入 `cd ` （注意后面有个空格），
  然后把解压出来的文件夹拖到终端窗口里，回车。
- **Linux** —— 如果桌面环境支持，右键点击文件夹选择**在终端中打开**。

### 4. 运行一条命令

```bash
bash scripts/bootstrap.sh
```

它会一边执行一边打印一串绿色的 ✓。在 Linux 上它可能会要求输入一次密码来安装 Docker ——
这是正常的，之后它会告诉你再运行一遍这条命令。

第一次运行需要几分钟，因为要下载 Docker 镜像。完成后它会打印出可以打开的地址。

### 5. 打开它

在浏览器里访问 **<http://localhost:7803>** 并加入书签。这就是 Haro。

先看一眼**设置**页 —— 服务列表里的每一项都应该是绿色的。如果有红色的，旁边的文字会说明哪里出了问题。

### 日常使用

- **视频存在哪？** 存在 Docker 自己的存储空间里，具体路径在**设置**页可以看到。如果你希望它们放到
  某个指定文件夹或外接硬盘，那是[配置](#配置)里的 `LIBRARY_ROOT` 设置 ——
  值得请懂技术的人帮忙设置一次。
- **必须一直开着吗？** 浏览器标签页不用，但电脑和 Docker Desktop 需要。电脑睡眠时下载会暂停，
  唤醒后继续。
- **启动和停止。** Docker Desktop 的 **Containers** 标签页里能看到 `haro-dev` 和
  `haro-qbittorrent`，带有启动/停止按钮。或者重新运行 `bash scripts/bootstrap.sh` 把一切拉起来。
- **重启电脑之后。** 打开 Docker Desktop，容器会自动恢复。
- **看起来卡住了。** **设置**页底部有活动日志。**下载**页有「与 qBittorrent 同步」按钮，
  可以强制刷新。
- **语言。** 首次打开时 Haro 会根据浏览器语言自动选择中文或英文。可以在**设置 → 语言**里更改。

有一点需要说清楚：Haro 通过 BitTorrent 下载，这意味着在种子处于活动状态时，你同时也在向其他人上传。
你可以下载和分享什么内容，是你自己的责任，并且取决于你所在的地区。


## 功能

- **浏览与搜索** —— Bangumi 每周放送日历、Bangumi 番剧搜索，以及对
  [AnimeGarden](https://animes.garden) 发布资源的全文搜索。
- **番剧详情** —— 封面、简介、评分、标签和完整剧集列表，旁边是按字幕组分组的所有可用发布。
- **订阅** —— 选定字幕组与关键词过滤条件，实时预览会告诉你哪些发布会被匹配、解析出的集数是多少，
  确认无误再保存。
- **追踪与下载** —— 轮询新剧集，把磁力链接交给 qBittorrent（使用独立分类和按订阅区分的标签），
  并跟进到下载完成。
- **整理入库** —— 把完成的视频硬链接为
  `剧名 (年份)/Season 01/剧名 S01E27.mkv`，并写入 Kodi 格式的 NFO 元数据和 Bangumi 封面，
  Jellyfin、Kodi、Plex 都能直接读取。qBittorrent 继续做种原文件；硬链接不占用额外空间。
- **观看** —— **媒体库**页面列出所有已入库的内容，并标记未观看数量。点击播放会在 Haro 自己的
  播放器中打开，或者跳转到 Jellyfin，随你选择。无论哪种方式，看完的剧集都会自动从「新」列表中消失。

任何东西都不会被自动删除。

## 观看

Haro 可以自己播放剧集，也可以交给 Jellyfin。由 `PLAYER_MODE` 决定，默认是 `auto` —— 配置了
Jellyfin 凭据就用 Jellyfin，否则用内置播放器。

### 内置播放器

除 Haro 本身外不需要安装任何东西。支持字幕与音轨切换、0.5× 到 3× 倍速、断点续播、画中画，
以及常用的键盘快捷键。

真正麻烦的地方在于怎么让一个字幕组发布的文件能在浏览器里播放。它们几乎都是 Matroska 封装，
浏览器打不开；其中很多是 10-bit HEVC，浏览器解不了。所以 ffmpeg 会走三条路径之一，播放器会告诉你
当前是哪一条：

| | |
| --- | --- |
| **直接播放** | 已经是浏览器能处理的 MP4。原样发送，ffmpeg 完全不启动。 |
| **重新封装** | 编码没问题，容器格式不行。`-c copy` 转成 fMP4 —— 基本不耗资源。 |
| **转码** | 有内容必须重新编码。开销大，在低性能硬件上会很慢。 |

走哪条路径既取决于文件，也取决于你的浏览器：Haro 会询问浏览器能解码哪些格式
（`MediaSource.isTypeSupported`）并把答案随请求发送。所以 Mac 上的 Safari 可能直接播放一个
HEVC 发布，而 Linux 上的 Firefox 就必须转码。

字幕由编译成 WebAssembly 的 [libass](https://github.com/libass/libass) 渲染，并使用 Matroska
文件内附带的字体。这一点对番剧尤其重要：ASS 字幕携带了定位、淡入淡出和特效字幕排版，
而 `<track>` 和 WebVTT 会把这些全部丢掉。

观看状态和播放进度保存在 Haro 自己的数据库中。

### Jellyfin

设置 `PLAYER_MODE=jellyfin`（或者填好凭据、保持 `auto` 即可）。播放按钮会变成指向 Jellyfin
网页端的深层链接，观看状态从 Jellyfin 读取，每次入库后 Haro 会触发一次媒体库扫描。

Jellyfin 需要一个指向你番剧目录的 **Shows** 媒体库，并为它启用 **NFO** 作为元数据读取器。
如果本地 NFO 读取器是关闭的，Jellyfin 会忽略 Haro 写入的元数据并回退到 TMDB，而 TMDB 对中文
番剧标题的匹配很差。设置页会检查这一项并提示你。

无论 `PLAYER_MODE` 是什么，Haro 都会写入 NFO 元数据和封面，所以让 Jellyfin、Kodi 或 Plex 指向
`LIBRARY_ROOT` 总是可行的。

## 端口

全部位于 78xx 段，刻意避开了 3000 段。

| 端口 | |
| --- | --- |
| **7803** | 开发模式下的界面（Vite，热更新）—— **打开这个** |
| **7802** | 开发模式下的 API；生产模式下的整个应用 |
| **7808** | qBittorrent 的 Web UI（开发栈；`admin` / `haro-dev`） |
| 8096 | Jellyfin，如果你启动了它 |

都可配置：Haro 的端口在 `.env` 的 `PORT`，其余在 compose 文件的端口映射里。

开发模式下这是两个独立的服务，因为 Vite 无法透过 Hono 做热更新：7803 从源码提供界面，并把
`/api` 代理到 7802。用浏览器打开 7802 会被重定向到 7803，而不是给你上一次的构建产物——那种产物
看起来一切正常，却会悄悄忽略你所有的修改。生产模式下没有 Vite 也没有重定向：7802 同时提供构建好的
界面和 API，也是 `docker-compose.yml` 唯一发布的端口。

## 部署

`bootstrap.sh` 面向开发机器。真正的部署使用 `docker-compose.yml`，它假定 qBittorrent 和
Jellyfin 已经在宿主机上存在，并挂载真实的宿主目录：

```bash
cp .env.example .env
$EDITOR .env                     # qBittorrent 凭据，以及（如果使用）Jellyfin 的凭据
$EDITOR docker-compose.yml       # 宿主路径和 user: PUID:PGID

./scripts/preflight.sh           # 检查架构、内存、硬链接、属主、服务连通性
docker compose up -d --build
```

`preflight.sh` 是只读的，按照「出问题的先后顺序」检查：64 位架构、可用内存、Docker、两个媒体路径
是否在同一文件系统（会做一次真实的硬链接测试）、`user:` 是否与 qBittorrent 的 PUID/PGID 一致，
以及各服务是否可达。先修好它标记为 ✗ 的项。

然后打开 `http://<主机>:7802` 检查**设置**页 —— 在订阅任何东西之前，所有服务都应该是绿色的，
硬链接探测也应该通过。

### 环境要求

- 任意 **amd64 或 arm64** 主机，运行 64 位系统，装有 Docker 与 Docker Compose
- 启用了 Web UI 的 qBittorrent
- 下载目录与媒体库位于**同一文件系统** —— 硬链接无法跨设备

构建镜像大约需要 1.5GB 空闲内存；如果直接拉取预构建镜像则不需要。运行时 Haro 很轻：容器限制在
768MB，Node 堆限制 512MB，都远高于实际用量。转码是唯一的例外，见[观看](#观看)。

如果想跳过构建、直接拉取预构建镜像，把 `docker-compose.yml` 里的 `build:` 注释掉，取消注释
`image: ghcr.io/...` 那一行，然后：

```bash
docker compose pull && docker compose up -d
```

镜像是公开的，不需要登录。它由 `.github/workflows/docker.yml` 在每次推送到 `main` 时构建，
并发布 `linux/amd64` 与 `linux/arm64` 两个架构。

### 在树莓派上运行

Pi 4B 可以运行，Haro 最初也正是为它而写，但有三点需要注意。

**64 位不是可选项。** `uname -m` 必须输出 `aarch64`。Node 26 基础镜像没有 32 位 ARM 构建。
Pi 4B 支持 64 位；但较早安装的系统往往仍在跑 32 位镜像。

**在设备上构建大约需要 4 分钟**（4GB 的 Pi 4B），并需要约 1.5GB 空闲内存。4GB 和 8GB 的板子没问题；
1GB 或 2GB 的 Pi 请直接拉取预构建的 `linux/arm64` 镜像。

**转码它扛不住。** 在 Pi 4B 上用软件重新编码 1080p 达不到实时。请优先选择浏览器能直接解码的发布
版本，或者使用 Jellyfin —— 它能以容器内 ffmpeg 做不到的方式调用 Pi 的硬件解码器。

有几项是专门为 SD 卡调优的，在别处也不会有额外代价：SQLite 使用 WAL 模式并设置
`synchronous=NORMAL`，活动日志会自动截断，Docker 日志按 10MB × 3 轮转。

### 最容易让首次部署失败的四件事

1. **`extra_hosts: host.docker.internal:host-gateway`** —— 已经写在 `docker-compose.yml` 里。
   在 Linux 上没有这一行该主机名无法解析，所有 qBittorrent / Jellyfin 调用都会失败。
   （开发栈不需要它：各服务在 compose 网络里靠服务名互相发现。）
2. **同一文件系统。** 用 `stat -c %d /srv/downloads/complete /srv/media/anime` 验证 ——
   两个数字必须相同，否则入库会以 `EXDEV` 失败。
3. **属主一致。** 把 `docker-compose.yml` 里的 `user:` 设为 qBittorrent 的 `PUID:PGID`
   （`docker exec qbittorrent id`），否则创建硬链接会以 `EACCES` 失败。
4. **在 Jellyfin 中启用 NFO**（如果你使用 Jellyfin）。见上文 [Jellyfin](#jellyfin)。

## 配置

所有配置都是环境变量 —— 见 [`.env.example`](.env.example)。其中值得解释的几项：

| 变量 | 含义 |
| --- | --- |
| `PLAYER_MODE` | `builtin`、`jellyfin` 或 `auto`（默认） |
| `DOWNLOAD_ROOT` | 完成的下载，**以本容器的视角** |
| `QB_DOWNLOAD_ROOT` | 同一个目录，**以 qBittorrent 的视角** |
| `LIBRARY_ROOT` | 剧集整理入库的位置。必须与 `DOWNLOAD_ROOT` 在同一文件系统 |
| `JELLYFIN_URL` | **本容器**如何访问 Jellyfin |
| `JELLYFIN_PUBLIC_URL` | **浏览器**如何访问 Jellyfin，用于生成播放链接 |

qBittorrent 报告的路径位于它自己容器的命名空间中。让 `DOWNLOAD_ROOT` 和 `QB_DOWNLOAD_ROOT`
保持一致会让这个映射变成空操作，这也是推荐的做法；把它们分开只是为了覆盖两个容器把同一目录挂载到
不同路径的情况。

Jellyfin 那一对变量分开也是同样的原因：`host.docker.internal:8096` 在容器内有意义，但在浏览器里
解析不到，因此不能出现在链接中。把 `JELLYFIN_PUBLIC_URL` 留空，界面会假定 Jellyfin 就在你打开
Haro 的那台主机的 8096 端口上 —— 两者跑在同一台机器时这是对的。当 Jellyfin 在别处或位于某个域名
之后时，再设置它。

### 语言

界面提供英文、简体中文和繁体中文。首次打开时会根据浏览器语言自动选择，之后可以在**设置**页更改，
选择结果保存在该浏览器本地。

## 开发

```bash
./scripts/bootstrap.sh                                             # 启动全部服务
docker compose -f docker-compose.dev.yml logs -f haro-dev          # 查看日志
docker compose -f docker-compose.dev.yml run --rm haro-dev pnpm test
docker compose -f docker-compose.dev.yml run --rm haro-dev pnpm -r typecheck
docker compose -f docker-compose.dev.yml down                      # 停止
```

在容器中开发是官方支持的方式，因为**需要 Node ≥ 26** —— `anipar` 在 Node 22 上导入时就会抛出
`SyntaxError`。在宿主机上开发的话需要先 `nvm install 26`。

```
server/   Hono API、通过内置 node:sqlite 的 SQLite、后台轮询器、入库器、ffmpeg 播放器
web/      Vite + React 19 + TanStack Router/Query + Tailwind
AnimeGarden/  只读的上游参考检出 —— 不参与构建
```

`pnpm test` 覆盖那些在生产中会静默失败的部分：infohash 归一化、针对真实字幕组标题的发布名解析、
NFO 生成与转义、路径映射与硬链接、播放器的格式判定与 MP4 分片改写，以及界面侧的文件大小格式化与
语言检测。

`bootstrap.sh` 生成的示例剧集刻意做成每条播放路径各一个 —— 一个会被重新封装的 H.264 MKV、
一个带两条音轨和内嵌 ASS 字幕、会被转码的 10-bit MKV，以及一个可以直接播放的 MP4。
随时可以重新生成：

```bash
docker compose -f docker-compose.dev.yml exec haro-dev \
  node --experimental-strip-types server/scripts/seed-dev.ts
```

## 工作原理

```
Bangumi ──元数据──┐
                  ├─→ 订阅 ──轮询──→ AnimeGarden /resources?subject=&after=
qBittorrent ←磁力─┘                          │
      │                                anipar 解析季/集
      └─ 下载到 DOWNLOAD_ROOT                 │
                  └──硬链接 + NFO + 封面──→ LIBRARY_ROOT ──→ 内置播放器
                                                        └──→ Jellyfin 扫描
```

订阅轮询 `GET /resources?subject=<bangumiId>&after=<cursor>` —— 与 AnimeGarden 的 `feed.xml`
同源的数据，但是结构化的，因此游标返回的正好是新增内容，而不是一个固定长度的窗口。

有四个细节很容易做错，这里都处理了：

- **Infohash 编码。** `torrents/add` 不返回哈希，只能从磁力链接推导 —— 但 AnimeGarden 大约三分之二
  的磁力链接使用 base32 编码的 infohash，而 qBittorrent 只报告十六进制。所有值在存储或查询前都会
  归一化为小写十六进制。
- **完成判定。** qBittorrent 4.x 把已完成的种子报告为 `pausedUP`，5.x 报告为 `stoppedUP`，
  还有其他若干种。完成与否根据 `progress` 和 `completion_on` 判断，而不是状态字符串。
- **分片边界。** 重新封装的流只能在关键帧处切分，所以分片计划来自对源文件关键帧的一次扫描（会缓存），
  而不是固定间隔。重新编码的流自己产生关键帧，因此使用均匀分片并跳过这次扫描。
- **分片时间戳。** ffmpeg 产生的每个输出都从零开始编号，`-copyts`、`-output_ts_offset`、
  `-avoid_negative_ts` 都改变不了 MP4 封装器写入的内容 —— 于是从第十分钟切出的分片仍然声称自己
  从零开始，播放器会把所有分片叠在一起。Haro 改为直接改写每个分片中的 `tfdt`。同一分片内的数值本
  就是正确的相对值，因此这只是一次原地加法，不会移动任何偏移。

## 许可与致谢

**AGPL-3.0** —— 见 [LICENSE](./LICENSE)。服务端打包了
[`@animegarden/client`](https://www.npmjs.com/package/@animegarden/client)，它是 AGPL-3.0，
因此整个作品也继承该许可。[NOTICE.md](./NOTICE.md) 有完整的依赖说明。

发布数据来自 [Anime Garden](https://animes.garden)，标题解析由
[anipar](https://www.npmjs.com/package/anipar) 完成，元数据与封面来自
[Bangumi 番组计划](https://bgm.tv)。Haro 只是这些服务的客户端，并不运营它们。

Haro 是《机动战士高达》中的角色，版权归 Sotsu 与 Sunrise 所有。本项目与他们没有任何关联。
