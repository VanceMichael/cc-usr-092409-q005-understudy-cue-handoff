# 戏曲舞台口令服务

制作团队用结构化口令包衔接灯光、字幕、锣鼓和上下场动作。`contracts/domain.json` 保存领域对象与枚举，`src/server.js` 提供单进程 HTTP 服务，默认监听 8082 端口并暴露 `GET /health`。

## 测试

```bash
npm test
```

## 编译或构建

```bash
npm run build
```

## 启动

```bash
npm start
```

领域载荷使用 JSON，时间使用带时区的 RFC 3339 字符串。日志不得写入联系人、身份信息或原始凭据。
