# 公共新知识空间 · P0 原型

真实可跑的P0骨架，用来验证《Development Baseline v1.0》里定义的核心机制是否成立。这不是完整产品，范围见下方"明确不包含"。

## 已经真实实现并验证过的部分

- **前端页面**（`frontend/index.html`，单文件原生JS，无框架无构建步骤）：登录/注册、创建探索、公开（署名/匿名）、探索树展示、Understanding Map展示、提交追问并轮询直到处理完成、撤回、COLLABORATED治理提示。已用两种方式验证：
  1. `test-frontend.js`：用jsdom真实加载页面、真实点击/输入、真实向本机server发起fetch请求，自动断言页面渲染结果，覆盖了注册→创建→公开→第三方追问→自动刷新为COLLABORATED→错误登录提示的完整闭环，6项测试全部通过。
  2. 用Playwright驱动这个环境里现成的真实Chromium二进制做了端到端截图（见`shots/`目录），两个完全独立的浏览器会话（Alice、Bob）互相协作，截图记录了从登录到COLLABORATED的每一步真实渲染效果。
- **真实LLM接入**（`lib/ai.js` + `lib/llm-client.js`）：Answer、Gate、Duplicate Judge三个AI角色会在设置了`ANTHROPIC_API_KEY`环境变量时调用真实的Anthropic API，没设置则自动降级到占位逻辑，调用失败（网络错误、key无效、返回格式不对）也会自动降级并打印清晰日志，不会让请求整体失败。已用一个**刻意无效的key**做过真实网络请求测试：请求确实发到了`api.anthropic.com`，收到了`401 authentication_error`，代码正确捕获并回退，最终请求仍然成功返回，Collaborated等状态机逻辑不受影响。
  - Duplicate Judge做了两段式设计（对应蓝图§20成本控制原则）：trgm相似度≥0.6直接判重复（不调用模型，省成本）；0.15~0.6之间才调用真实模型做语义确认；<0.15不算候选。
- **真实密码认证**（`lib/auth.js`）：bcrypt哈希密码（不存明文）、高熵随机session token、token过期与登出立即失效。已验证：
  - 未登录访问受保护接口返回401。
  - **登录用户无法在请求体里伪造别人的account_id**——`initiator_id`/`submitted_by`现在只能来自服务端解析的登录会话，即使请求体里明写了别人的id也会被服务端忽略（已用curl实测：Alice在body里声称`initiator_id`是Bob，数据库里记录的仍然是Alice的真实id）。
  - 跨用户操作被正确拒绝：Bob无法公开/撤回Alice的探索(403)，看不到Alice的PRIVATE探索(404，不暴露存在性)。
  - 伪造/篡改token被拒绝(401)，登出后旧token立即失效。
- Exploration三态状态机（PRIVATE/PUBLISHED/COLLABORATED），状态转换有服务端硬校验（COLLABORATED禁止撤回）。
- 身份独立维度（NAMED/ANONYMOUS），与内容状态分离存储。
- **Pending Question异步状态机**（约束#12）：追问先落`pending_questions`表，只有Gate判定有效且AI生成回答后，才在同一数据库事务里原子性提交`nodes`+`question_meta`，绝不会出现"先写节点再删除"的情况。
- **第三方判断基于account_id**（约束#11），且这个account_id现在有真实认证背书，不再是可被伪造的自报字段。
- **真正的异步任务队列**（`worker.js`）：用`SELECT ... FOR UPDATE SKIP LOCKED`领取任务，可以同时起多个worker进程并发消费，已验证：
  - 并发提交多个追问时，多个worker各自领到不同任务，没有任何任务被重复处理。
  - Understanding Map版本号用行锁序列化分配，并发写入时版本号依然连续无重复。
  - 失败任务会按指数退避重试，达到`max_attempts`后转入`DEAD`终态并保留`last_error`。
- Understanding Map版本化存储（`understanding_maps`表），每次有效提交后异步生成新版本。
- 真实的Postgres事务与约束：`question_meta.classification`有CHECK约束，物理上禁止把DUPLICATE等拒绝类分类写入正式知识树的元数据表。
- 用pg_trgm做的真实（非模拟）文本相似度去重。

## 前端说明

`frontend/index.html`是单文件原生JS应用（无框架、无构建步骤），设计上刻意避开了"暖米色+赤陶配色"、"圆角卡片网格"这类AI生成页面的常见套路，改用纸面质感+森林绿强调色+缩进线条表现探索树的层级，呼应"探问笔记本"这个主题。

它不是Claude Artifact，是一个会被下载到你本地、由你自己的浏览器直接访问的静态文件，所以用了`localStorage`保存登录token（Artifact环境禁用localStorage，但这里不适用这条限制）。

`lib/ai.js`目前的降级策略是"调用失败就退回占位逻辑，让流程继续走完"，这是为了P0演示时不因为AI故障而卡死整条流水线。但这个策略本身需要在正式产品里重新权衡：
- Gate分类失败时退回占位规则，可能让本该被人工审核的内容被占位规则误判通过或误判拒绝——生产环境更合理的做法可能是失败时把pending_question标记为需要人工介入，而不是静默用规则兜底。
- Answer失败时退回占位文案会让用户看到明显是假回答的内容——生产环境应该让pending_question进入FAILED状态、允许用户重试，而不是提交一个"假回答"进知识树。

这个取舍在P0阶段是合理的（保证演示流程不中断），但**接入真实模型之后、进入更高阶段之前应该重新设计失败时的产品行为**，不应该原样带入生产。

## 明确不包含（P0之后的阶段要做）

- 真实鉴权（这里的"users"任何人都能创建，没有登录）
- 真实LLM调用——`lib/ai-stub.js`里的Answer/Gate/Duplicate Judge都是占位逻辑，接入真实模型只需替换这个文件
- 真实的pgvector语义检索（用pg_trgm字符串相似度代替，schema里HNSW索引已经建好，等接入真实embedding服务）
- 异步任务队列（这里是同步处理，日志会打印每个阶段，模拟真实的状态流转）
- Understanding Map、Human Question Delta、限流、治理后台、前端页面

## 部署到云端（不需要在自己电脑上跑任何东西）

见 **部署清单.md**——全程点鼠标、粘贴几次文字，不需要打开终端。大致架构：
Supabase（数据库，含pgvector）+ Render（跑`server.js`和`worker.js`两个服务，配置见`render.yaml`）。

代码里做了两件事专门为了支持这种"零终端"部署：
- `lib/db.js`：优先读`DATABASE_URL`环境变量连接数据库（云托管平台的标准做法），没设置则退回本地开发默认值。
- 开机自动建表：首次启动时如果检测不到核心表，会自动执行`schema.sql`+`migration_002_auth.sql`，不需要手动跑`psql`。用了pg advisory lock防止`server.js`和`worker.js`同时启动时抢着建表撞车（已在本地测试中验证：两个进程同时对空数据库启动，只有一个真正执行了建表）。

## 本地开发/测试（可选，如果你想在自己电脑上跑）

```bash
# 1. 确保本机有 PostgreSQL 16+ 并已装 pgvector 和 pg_trgm 扩展
createdb protodb
psql -d protodb -f schema.sql
psql -d protodb -f migration_002_auth.sql

# 2. 安装依赖
npm install

# 3. 修改 server.js / worker.js 顶部的数据库连接信息（host/user/password/database）

# 4. 启动API服务
node server.js
# 服务运行在 http://localhost:4000

# 5. 另开终端，启动一个或多个worker（可以起多个验证并发安全）
node worker.js worker-A
node worker.js worker-B   # 再开一个终端

# 6. 注册并登录
curl -X POST localhost:4000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-6-chars","display_name":"你的名字"}'
# 拿到响应里的token，后续请求都带上 -H "Authorization: Bearer <token>"

# 7.（可选）接入真实Claude：设置环境变量后重启server.js和worker.js即可，
# 不需要改任何代码。没设置这个变量时，AI逻辑会自动使用占位实现。
export ANTHROPIC_API_KEY=sk-ant-你的真实key
# 可选：export ANTHROPIC_MODEL=claude-sonnet-5   # 默认就是这个

# 8. 打开浏览器访问前端页面（和API同源，不需要处理CORS）
open http://localhost:4000/app/

# 9.（可选）跑自动化前端功能测试，验证注册→创建→公开→追问→Collaborated全流程
node test-frontend.js
```

提交追问后，接口会立即返回`{pending_id, status: "SUBMITTED"}`（不等待AI处理），
真正的分类/回答/提交/地图更新全部由worker异步完成。
用 `GET /pending-questions/:id` 轮询查看处理进度，
或用 `GET /debug/ai-runs` 直接看任务队列里每个任务被哪个worker领取、状态如何。

## 关于认证的重要说明

`lib/auth.js`是P0演示专用的最小化密码+会话方案，**不是生产级认证系统**：
没有密码强度策略、没有邮箱验证、没有登录限流防暴力破解、没有刷新token机制。
技术蓝图推荐生产环境用Auth.js/Clerk/Supabase Auth，接入其中任何一个之后，
只需要把`requireAuth`中间件换成对应服务的会话校验逻辑，
`req.user.id`这个约定不用变——业务代码不需要重写。

## API速查

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/signup | 注册 `{email, password, display_name?}`，返回token |
| POST | /auth/login | 登录 `{email, password}`，返回token |
| POST | /auth/logout | 登出（需Bearer token），使当前token立即失效 |
| GET | /me | 查看当前登录身份（需Bearer token） |
| POST | /explorations | 提交Q0创建私享探索 `{question}`（需登录，initiator来自会话） |
| POST | /explorations/:id/publish | 公开 `{identity_mode}`（仅发起者本人） |
| POST | /explorations/:id/retract | 撤回（仅发起者本人，COLLABORATED会被拒绝） |
| POST | /explorations/:id/questions | 提交追问 `{content, parent_node_id?}`（需登录，submitted_by来自会话），立即返回SUBMITTED |
| GET | /pending-questions/:id | 查询追问处理阶段（仅提交者或探索发起者可查看） |
| GET | /explorations/:id | 探索详情+节点+最新Understanding Map（PRIVATE仅发起者可见） |
| GET | /explorations/:id/understanding-map/versions | 查看认识地图全部历史版本 |
| GET | /debug/ai-runs | （演示用）查看任务队列全貌 |

## 接入真实AI的位置

打开 `lib/ai-stub.js`，五个函数分别对应五个AI角色（Answer/Gate/Duplicate Judge/Map Updater/Prediction），每个函数上方都有注释说明真实实现该做什么。`server.js`的状态机和事务逻辑不需要改动，只需要把这五个函数换成真实的模型调用。
