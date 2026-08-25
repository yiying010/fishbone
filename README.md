# 魚骨洞天

「魚骨洞天」是用於創意發想與問題分析的教學活動。學生以姓名或暱稱加上小組房間碼加入，經過 19 個步驟提出生活困擾、分群、界定主要問題、找出原因、建立決策目標、發想方法，最後投票、反思並匯出成果。

活動設計為小組協作。同一個房間碼的成員，不論使用哪一台裝置，都會看到同一份小組內容。

## 課堂流程

老師在活動頁按「建立新房間」，伺服器產生一組代碼（形如 `k7m2x-9qpwd`），投影給全組抄寫；學生輸入姓名與代碼後加入。

代碼由伺服器產生，不能自行指定。房間裡是同學寫下的生活困擾，而「六年三班」這類自訂代碼只有幾十組的搜尋空間，猜中一組就等於讀到整組的內容。字母表刻意排除 `i`、`l`、`o`、`u`，投影時沒有互相看錯的字元；學生把 `0` 讀成 `O` 或把 `1` 讀成 `l` 時，仍會進到正確的房間。大小寫、空白與連字號都會自動正規化。

加入房間後會取得一組 session 權杖，讀寫房間都需要它。沒有權杖的請求，對存在與不存在的房間會得到完全相同的回應，因此無法藉由掃描代碼找出哪些房間是活的。詳見 [docs/deployment.md](docs/deployment.md)。

## 專案結構

```text
public/fishbone.html     活動本體，單一 HTML 檔，唯一的前端來源
server/src/              房間伺服器（Fastify + PostgreSQL）
server/test/             測試
docs/deployment.md       部署、環境變數、維運與資料保存
docs/nginx/fishbone.conf 前端 nginx 設定範例
docs/index.html          舊的 GitHub Pages 單機展示頁，與本服務無關
Dockerfile               多階段建置，最終映像檔以非 root 執行
docker-compose.yml       本機開發與單機部署
```

`public/fishbone.html` 是唯一一份活動頁。伺服器會同時以 `/` 與 `/fishbone.html` 提供它。

## 快速開始

需求：Docker 與 Compose v2。

```bash
cp .env.example .env
# 至少要修改 POSTGRES_PASSWORD，並確認 DATA_RETENTION_DAYS
docker compose up -d --build
```

啟動後開啟 <http://127.0.0.1:3000/>。資料庫遷移會在啟動時自動套用。

要驗證服務正常，請看 `/healthz`，它會實際查詢資料庫：

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

## 建置

```bash
npm ci
npm run build      # TypeScript 編譯到 build/
npm start          # 執行編譯後的伺服器，需要 DATABASE_URL 與 DATA_RETENTION_DAYS
```

本機直接以原始碼開發（需要 Node 22.18 以上，使用 Node 內建的 TypeScript 型別移除）：

```bash
npm run dev
```

套件管理器為 npm。專案只保留 `package-lock.json`。

## 資料庫遷移

遷移是純 SQL，內嵌在 `server/src/db/migrations.ts`，以附加方式維護，已發布的遷移不再修改。

預設在服務啟動時自動套用（`MIGRATE_ON_START=true`）。若要關閉自動套用並手動執行：

```bash
# 容器內
docker compose exec app node build/cli/migrate.js

# 本機原始碼
npm run migrate
```

多個複本同時啟動是安全的：遷移以 PostgreSQL advisory lock 保護，後到者會等待，然後發現沒有事情要做。

## 備份與還原

備份整個資料庫：

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > backup-$(date +%F).dump
```

還原到一個空的資料庫：

```bash
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  < backup-2026-08-25.dump
```

匯出單一房間為 JSON（需設定 `ADMIN_TOKEN`）：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/admin/rooms/FISH-042/export > FISH-042.json
```

## 資料保存

`DATA_RETENTION_DAYS` 是必填，沒有預設值；未設定時服務不會啟動。活動會保存學生的暱稱與所有輸入內容，保存期限應由部署者明確決定。目前設定為 3650 天（十年）。

期限自房間最後一次活動起算。逾期的房間會被真正刪除，不是標記，相關的成員、提交內容、投票與匯出成果會一併刪除。

備份會延長實際可復原的期間。若備份保留 7 天而政策為 30 天，資料實際上要到第 37 天才完全消失，因為資料庫刪除之後，最舊的備份仍含有它，直到該備份自己輪替掉。對外說明保存期限時請以「政策天數加上備份保留天數」為準。

## 測試

```bash
npm test
```

會先執行 `npm run build`，因為測試是針對編譯後的輸出。不需要資料庫也能執行，此時整合測試會跳過並說明原因。要完整執行，請提供一個**可拋棄**的資料庫，測試會先刪除並重建其 `public` schema：

```bash
docker run -d --name fishbone-test-db -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=fishbone_test \
  postgres:17-alpine

TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5433/fishbone_test npm test
```

## 部署

正式部署、nginx 設定、掛載到子路徑的約定、完整環境變數表與維運說明，見 [docs/deployment.md](docs/deployment.md)。

重點：應用在容器內服務於 `/`，不知道自己的公開路徑，前端所有 URL 皆為相對路徑並在執行時由瀏覽器網址推導。因此掛載到 `https://creativity.rcsl.online/fishbone` 或任何其他前綴，都不需要修改設定或重新建置。

外部 AI 協助預設關閉。伺服器端 API、資料最小化、權限與環境變數要求見
[AI-assisted step requirements](docs/ai-integration-requirements.md)；在研究／隱私審查與另外的部署核准完成前，請保持 `AI_ENABLED=false`。
活動原有判斷規則與正式啟用前的代表性評估案例另見
[AI evaluation rules](docs/ai-evaluation-rules.md)。

## 隱私

請勿將 API 金鑰、密碼或學生個資提交到版本庫；`.env` 已被忽略，只有 `.env.example` 會進版控。公開的 `docs/index.html` 展示頁不保存任何內容，不適合放入名冊或可識別個人的作品。

日誌不會記錄暱稱或任何學生輸入的內容，也不會記錄仍然有效的房間碼；唯一的例外是保存期限清除會記下已刪除房間的代碼，作為不可逆刪除的稽核紀錄。房間碼等同於房間的鑰匙，請以口頭或投影方式傳遞，不要放進聊天群組或公開文件。

改用伺服器發碼之前以人工命名的房間（例如班級名稱）已無法再加入，僅能透過管理端點匯出或刪除。
