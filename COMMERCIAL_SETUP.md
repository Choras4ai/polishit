# 商业版本地调试

## 1. 启动商业后端

```bash
PATH=/Users/choras/local/node/bin:$PATH npm run server:start
```

默认监听：

- `http://127.0.0.1:8787`

默认行为：

- 短信通道：`mock`
- 测试验证码：`123456`
- 免费试用：`10 次`
- 默认积分包：`9.9 / 300 积分`
- 基础计费：约 `800 字 / 1 基础积分`
- AI 上游：默认回退到内置 `Together AI` 预设

如需生产配置，复制 `.env.example` 并设置：

- `RUNSHI_UPSTREAM_API_URL`
- `RUNSHI_UPSTREAM_API_KEY`
- `RUNSHI_UPSTREAM_MODEL`
- `RUNSHI_PUBLIC_BASE_URL`
- `RUNSHI_PAYMENT_MODE`
- `RUNSHI_TRIAL_FREE_USES`
- `RUNSHI_MEMBERSHIP_PRICE_CENTS`
- `RUNSHI_CREDITS_PER_PACK`
- `RUNSHI_PAYMENT_PROVIDERS`
- `RUNSHI_WECHATPAY_*`
- `RUNSHI_ALIPAY_*`

如需发布开源版，直接关闭商业模块即可：

```bash
RUNSHI_COMMERCIAL_AVAILABLE=0
```

## 2. 桌面端登录

打开应用后进入 `账户` 页：

1. 输入手机号
2. 点击 `发送验证码`
3. 使用 mock 验证码 `123456`
4. 点击 `登录`

登录后默认先用 10 次免费试用；试用用完后可开通会员。高级用户也可以切到 `API 配置` 自行填写模型。

## 3. 微信 / 支付宝回调接入

代码已经支持两条正式回调：

- 微信支付回调：`/api/pay/callback/wechat`
- 支付宝异步回调：`/api/pay/callback/alipay`
- 支付宝同步返回：`/pay/alipay/return`

要真正联通商户，至少要满足这几项：

1. `RUNSHI_PUBLIC_BASE_URL` 改成公网可访问的 `HTTPS` 地址，不能继续用 `http://127.0.0.1:8787`
2. `RUNSHI_PAYMENT_PROVIDERS=wechatpay,alipay`
3. 配齐 `.env.example` 里的微信支付 / 支付宝证书与密钥路径
4. 在商户平台把回调地址配置成：
   - 微信支付：`${RUNSHI_PUBLIC_BASE_URL}/api/pay/callback/wechat`
   - 支付宝 `notify_url`：`${RUNSHI_PUBLIC_BASE_URL}/api/pay/callback/alipay`
   - 支付宝 `return_url`：`${RUNSHI_PUBLIC_BASE_URL}/pay/alipay/return`

本地开发如果只是验证界面和登录流程，继续用 `127.0.0.1` 即可；但真实支付回调不会打回本机环回地址。

## 4. 当前已实现

- 手机号 + 验证码登录
- 新用户 10 次免费试用
- 会话鉴权
- 积分包方案（`9.9 / 300 积分`、`29.9 / 1000 积分`）
- 积分余额与消耗统计
- AI 请求代理转发
- 本地 mock 短信验证码
- 本地直开会员接口
- 微信 / 支付宝支付回调接口
- 浏览器可直接打开的后端状态页

## 5. 当前未实现

- 微信登录
- 正式短信服务商接入
- 正式微信支付 / 支付宝商户联调
- 自动续费
- 管理后台

## 6. 推荐的下一步

1. 接正式短信服务商
2. 联调正式微信支付 / 支付宝商户
3. 做管理后台
4. 将服务端上游模型配置迁移到生产环境变量
