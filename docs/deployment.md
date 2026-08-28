# 部署與維運

本文說明「魚骨洞天」房間伺服器的部署方式、環境變數、掛載路徑約定，以及備份與資料保存政策。目標環境為 Ubuntu 24.04、Docker 28、Compose v2，前方有兩層 nginx，TLS 在最外層終止。

## 服務組成

Compose 定義三個服務：`db`（PostgreSQL 17）、`migrate`（一次性，套用資料庫遷移後結束）、`app`（Node 22 執行的 Fastify 伺服器）。

`app` 同時負責兩件事：提供活動頁 `public/fishbone.html`，以及提供房間同步 API。活動頁本身是單一 HTML 檔，所有 CSS 與 JavaScript 內嵌，不載入任何外部資源。伺服器不做任何伺服器端渲染。

## 資料庫遷移

遷移由專屬的 `migrate` 服務執行，`app` 透過 `service_completed_successfully` 等待它成功後才啟動。

這樣做是為了讓失敗看得見。若遷移寫錯，停下來的會是一個狀態明確為 `Exited(1)` 的容器，訊息就在 `docker compose logs migrate`；相對地，若讓應用在啟動時自行遷移，同樣的錯誤會表現為應用不斷重啟，真正的原因埋在反覆滾動的日誌裡。

`migrate` 服務執行結束後會停在 `Exited(0)`，這是正常狀態，不是故障。

遷移可重複執行，也可並行執行：`runMigrations` 會取得 PostgreSQL advisory lock，並跳過 `schema_migrations` 中已記錄的項目。每一個遷移各自包在交易中，失敗即回滾。

`migrate` 服務需要 `DATA_RETENTION_DAYS`，雖然它完全用不到這個值。原因是設定載入是一次性驗證整份環境變數的，缺少必填項會直接失敗；若不提供，遷移會以一則關於保存期限的錯誤訊息中止，與遷移本身無關。

手動執行（例如在不啟動應用的情況下先套用遷移）：

```bash
docker compose run --rm migrate
```

### 升級到成員身分保護版本時的一次性影響

`0003_release_member_sessions` 會清掉所有既有的成員 session。這是必要的：新版的加入流程要求「已發過 token 的 member id 必須出示原 token 才能換發 session」，而這個版本之前發出的 token，瀏覽器並沒有存在重新整理後找得回來的地方。若保留那些 digest，每位既有學生一重新整理就會拿到 409 而被鎖在自己的身分外面，既有卡片也會因為 `canEditCard` 比對不上而變成唯讀。

實際影響是每個尚在進行中的 session 需要重新加入一次，這由前端自動完成，學生不需要操作。在各個 id 被重新認領之前，它們的可被冒用程度與升級前相同，因此這是一段會自行關閉的視窗，而不是新開的破口。

建議在沒有課堂進行中的時段部署。

## 掛載路徑：唯一需要特別注意的約定

應用在容器內固定服務於 `/`，而且**不知道也不需要知道**自己的公開路徑。前方 nginx 負責去掉 `/fishbone` 前綴。

前端所有 URL 都是相對路徑，同步 API 的位置在執行時由瀏覽器網址推導：

- 網址以 `/` 結尾，視為目錄，直接採用。
- 最後一段含有 `.`，視為檔名，取其所在目錄。
- 其餘情況（例如停在 `/fishbone` 而沒有結尾斜線），視為掛載點本身，補上斜線。

這三條規則涵蓋了實務上會出現的所有情形，包含 nginx 的 `location /fishbone/` 與 `location /fishbone` 兩種寫法。因此換到別的前綴、或在同一網域下再掛載其他專案，都不需要改任何設定或重新建置映像檔。

`docs/nginx/fishbone.conf` 是一份可直接參考的設定範例。其中兩點是必要的，不是風格問題：

第一，`proxy_read_timeout` 必須大於 `SYNC_LONG_POLL_MS`。房間同步是被伺服器「掛住」的 HTTP 請求，不是 WebSocket；預設掛住 20 秒，若代理在此之前切斷連線，客戶端會不斷重連，房間看起來會像是時好時壞。

第二，`proxy_buffering off`。被掛住的回應必須在產生的當下就送出，不能等緩衝區填滿。

若 nginx 的 `location` 寫成沒有結尾斜線的 `location /fishbone { proxy_pass http://app/; }`，nginx 會轉送出開頭為 `//` 的路徑。伺服器會把開頭重複的斜線收斂成一個再進行路由，因此這種寫法也能運作，只是仍建議採用範例中的寫法。

## Deployment on RCSL's server

This section describes only the deployment method used on RCSL's server, not any host-specific detail such as hostnames, filesystem paths, or credentials. Those live outside this repository, in the deployment host's own environment file and in a separate deployment repository not tracked here.

On RCSL's server this project does not run behind its own public-facing nginx. It is one of several research projects deployed behind a single shared reverse-proxy layer that owns the public domain, terminates TLS, and dispatches each project to its own containers by URL subpath. That shared layer is owned by a separate deployment repository, not by this one, and this project's own `docker-compose.yml` has no awareness of it: the compose file keeps working standalone for local development exactly as documented above.

The shared layer reaches this project's app container over an internal Docker network rather than through a published host port. A compose override file ("overlay") that lives in the deployment repository adds the app service to that network and gives it a stable container alias; it does not modify anything in this project's own compose file. Bringing the deployed app up therefore means running compose with two files together, this project's own `docker-compose.yml` plus the deployment repository's overlay for it, rather than the single-file command shown elsewhere in this document.

A location block owned by the deployment repository strips this project's URL prefix before proxying to the app. This is exactly why the mounting-path contract above matters in practice: the app must stay mount-agnostic, because it never learns what prefix it is served under, or whether it is even the only project on the domain.

Updating the deployed version is a pull-then-recompose on the deployment host: update this project's checkout there, then re-run compose with both files (this project's compose file and the deployment repository's overlay) so the app container is rebuilt and restarted while remaining attached to the shared network. The `db` and `migrate` services are unaffected by, and have no connection to, the shared layer.

Environment configuration, the `.env` file, the database, the admin token, and any AI provider credentials, is entirely local to this project's own deployment on the host. None of it is shared with, or visible to, the shared reverse-proxy layer.

## 環境變數

必填。缺少任何一項，程序會在啟動時列出所有問題並結束，不會以半套設定啟動。

| 變數 | 說明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 連線字串。在 Compose 中由 `POSTGRES_*` 三個變數組成。 |
| `DATA_RETENTION_DAYS` | 房間資料自最後一次活動起保存的天數。刻意沒有預設值，見下方「資料保存」。 |

選填，附預設值。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 監聽位址。 |
| `PORT` | `3000` | 監聽埠。 |
| `LOG_LEVEL` | `info` | `fatal`、`error`、`warn`、`info`、`debug`、`trace`。 |
| `MIGRATE_ON_START` | `true` | 應用程序啟動時自動套用未執行的資料庫遷移。Compose 會覆寫成 `false`，因為遷移已由專屬的 `migrate` 服務完成，見下方「資料庫遷移」。 |
| `RETENTION_SWEEP_INTERVAL_MINUTES` | `60` | 清除逾期房間的排程間隔。啟動時會先執行一次。 |
| `SYNC_LONG_POLL_MS` | `20000` | 同步請求最長掛住的時間。設為 `0` 表示不掛住，客戶端改為單純重複輪詢。 |
| `ADMIN_TOKEN` | 無 | 設定後才會註冊匯出與刪除房間的管理端點，最少 24 個字元。未設定時這些路由完全不存在。 |
| `TRUST_PROXY` | `false` | 是否從 `X-Forwarded-For` 取得客戶端位址。只有 app 僅能經過會**覆寫**此標頭的受信任 proxy 存取時才設為 `true`；隨附的 Compose + nginx 範例符合此前提。限流以此位址為鍵。 |
| `ROOM_CODE_LENGTH` | `10` | 新建房間碼的長度（Crockford Base32 字元），10 個字元為 50 位元。只影響新建的房間；已發出、長度在 8 到 24 之間的代碼仍可使用。 |
| `SESSION_TTL_HOURS` | `24` | 成員 session 權杖的有效期，每次請求都會延長。 |
| `MEMBER_ABSENT_AFTER_SECONDS` | `300` | 成員要安靜多久，小組才可以標記他為未參與並繼續進行。每一次通過驗證的請求都會重新計時，而只是在旁邊看的分頁也會持續輪詢，所以這裡量到的是真的離線的裝置，不是正在思考的學生。標記過的成員一旦重新連線就會自動恢復計算。 |
| `RATE_LIMIT_ENABLED` | `true` | 關閉後所有限流都不生效。 |
| `RATE_LIMIT_LOOKUP_FAILURES_PER_MINUTE` | `60` | 每個來源位址每分鐘可失敗的房間查詢次數。 |
| `RATE_LIMIT_ROOM_CREATES_PER_HOUR` | `60` | 每個來源位址每小時可建立的房間數。 |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `3000` | 每個來源位址每分鐘的 `/api` 請求總數上限。 |
| `DB_POOL_MAX` | `10` | 連線池上限。 |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | 取得連線的逾時。 |
| `MAX_SNAPSHOT_BYTES` | `1048576` | 單一房間快照的大小上限。 |
| `BODY_LIMIT_BYTES` | `4194304` | HTTP 請求主體上限，必須大於等於 `MAX_SNAPSHOT_BYTES`。 |
| `MAX_ARTIFACT_BYTES` | `4194304` | 匯出成果的大小上限。 |
| `PUBLIC_DIR` | 映像檔內的 `public/` | 靜態檔案目錄。 |
| `AI_ENABLED` | `false` | 是否註冊可用的外部 AI 協助。保持 `false` 時不會送出任何學生文字。設為 `true` 前須另行核准部署與研究／隱私流程。 |
| `OPENAI_API_KEY` | 無 | `AI_ENABLED=true` 時必填。只傳入 app 容器，不得提交到 Git、映像檔或前端。 |
| `OPENAI_MODEL` | `gpt-4.1` | 伺服器控制的模型名稱；瀏覽器不能指定。正式研究前應以代表性案例評估並固定版本。 |
| `AI_TIMEOUT_MS` | `30000` | 單次供應商請求逾時，最大 55 秒，須低於外層 proxy timeout。 |
| `AI_MAX_INPUT_CHARS` | `12000` | 送往 AI 的最小化內容字元上限；超過時拒絕，不會傳完整快照。 |
| `AI_MAX_OUTPUT_TOKENS` | `500` | 單次 AI 結果的輸出 token 上限。 |
| `AI_REQUESTS_PER_MEMBER_PER_MINUTE` | `10` | 每個房間、每位已驗證成員的 AI 請求上限；另有重複請求抑制。 |

`.env.example` 是這份表格的可執行版本，複製為 `.env` 後填入即可。

## 房間碼與存取控制

房間碼由伺服器產生，任何人都不能自行指定。老師在活動頁按「建立新房間」取得一組代碼，投影給全組抄寫；學生輸入姓名與代碼後加入。除了代碼的來源之外，課堂流程沒有改變。

這一點不是風格問題。先前的代碼是老師自行輸入的自由文字，實務上會出現「六年三班」或「fish01」這類值，搜尋空間只有幾十到幾百組；而一間房間裡是同學寫下的生活困擾，包含家庭與人際問題。代碼現在取自 CSPRNG，預設 10 個字元的 Crockford Base32，約 50 位元。

字母表使用小寫的 Crockford Base32，不含 `i`、`l`、`o`、`u`。這樣投影出來沒有一組字元會互相看錯，而且 Crockford 對人們仍然會讀錯的字元有定義好的對應：學生把 `0` 看成 `O`、把 `1` 看成 `I` 或 `l` 時，仍會進到正確的房間，而不是被告知代碼錯誤。大小寫、空白與顯示用的連字號在伺服器與瀏覽器都會被正規化掉。

加入房間會取得一組 session 權杖，之後讀取或寫入房間都必須附上它。因此**沒有權杖的請求，對「存在的房間」與「從未存在的房間」會得到完全相同的回應**：同樣的 404、同樣的內容、不含任何房間碼。掃描代碼空間得不到任何資訊。權杖只以雜湊形式保存，資料庫外洩不會連同有效 session 一起外洩。

加入端點本身仍然會區分「代碼存在」與「代碼不存在」，這是功能上必要的：學生打錯字必須得到回饋。這條路徑由下方的限流保護。

### 舊代碼無法再使用

在改為伺服器發碼之前，以人工命名的房間（例如 `六年三班`、`fish01`）已經無法再加入：那些代碼不符合現在的格式，會在查詢資料庫之前就被擋下。這是刻意的，因為那正是本次要移除的風險。

這類房間仍可透過管理端點匯出與刪除 — 管理路由使用較寬鬆的代碼解析，就是為了不讓舊資料變成無法處理、只能等保存期限到期被清掉的孤兒。若手上有這種房間，請在清除前先匯出。

## 限流

所有限額都以來源位址為鍵。整班學生共用一個學校 NAT 位址，所以對「成功的流量」限制必須寬鬆；真正需要嚴格限制的是**失敗的房間查詢**，那正是列舉攻擊的樣子，而正常使用幾乎不會產生。

失敗預算用盡時，該位址在最多一分鐘內無法再進行新的加入，回應為 429。已經在房間內的成員不受影響：帶有有效 session 的請求完全不查詢這個預算，因此某位同學不斷打錯字，不會把同班同學踢出他們已經在的房間。

建立房間不需要任何憑證，因此 `RATE_LIMIT_ROOM_CREATES_PER_HOUR` 是限制有人灌爆資料庫的那道防線。若未來需要更嚴格的控制，適合的做法是為建立端點加上教師憑證，而不是調低限額。

限流狀態存在行程記憶體中。若擴充為多個複本，每個複本各持一份預算，實際限額會乘上複本數；單一容器的部署沒有這個問題。

`AI_REQUESTS_PER_MEMBER_PER_MINUTE` 與 AI 重複請求抑制快取適用同樣的限制：狀態同樣只存在單一複本的行程記憶體中，多複本部署下實際的每人 AI 額度會乘上複本數。

## 記錄

日誌不會出現暱稱、成員識別碼，或任何學生輸入的內容，也不會出現仍然有效的房間碼。

Fastify 內建的請求與回應記錄會輸出完整 URL，對本服務而言那是 `/api/rooms/<房間碼>/state`，等於把房間的鑰匙寫進日誌檔。因此內建記錄已關閉，改由一個 hook 記錄比對到的路由樣板（`/api/rooms/:code/state`）、狀態碼與耗時。錯誤處理只記錄 `err`，而錯誤訊息本身不含房間碼。

唯一的例外是保存期限清除：它會記下被刪除房間的代碼。那些房間在同一個語句中已經被刪掉，代碼因此不再能開啟任何東西；而刪除是不可逆的，沒有這筆記錄就無法回答「剛才到底刪掉了什麼」。

## 同步機制

活動的協作狀態是一個 JSON 快照。快照的產生與合併全部在瀏覽器內完成，伺服器不重新實作合併邏輯，只負責保存與傳遞。

寫入採用對房間版本號的比較後寫入。客戶端送出時附上它最後看到的版本號；若版本號已經改變，伺服器回傳 HTTP 409 並附上目前的快照，客戶端合併後重送。這是兩台裝置同時編輯時不會互相覆蓋的原因。

讀取採用長輪詢。客戶端帶著已知版本號發出請求，伺服器在房間變動、或達到 `SYNC_LONG_POLL_MS` 之前不回應。實測在兩層 nginx 之後，一台裝置送出卡片到另一台看到，約需 0.3 秒。

伺服器同時把每次接受的快照投影成關聯式資料表（成員、提交內容、分群提案、投票輪次、票、匯出成果），方便查詢與匯出。這些資料表由快照推導而來，因此不會與快照不一致。

## 資料保存

`DATA_RETENTION_DAYS` 是必填且沒有預設值。學生的暱稱與所有輸入內容都會保存下來，保存期限應該由部署者明確決定，而不是繼承一個沒有人選過的數字。目前設定為 `3650`，即十年。

保存期限自房間最後一次活動起算，不是自建立起算。跨週使用的班級不會因為中間停了幾天而失去資料。

清除是真正的 `DELETE`，不是標記。房間被清除後，該房間的成員、提交內容、投票與匯出成果會一併經由外鍵串聯刪除，資料庫中不留殘骸。

刪除當下若仍有學生的頁面開著，該頁面會在下一次同步時收到 404，於是停止同步並顯示「這個房間在伺服器上已不存在」。它不會自動重新加入，否則房間會被重新建立、整份內容被重新上傳，等於默默撤銷了這次刪除。學生裝置上的內容仍在，若要繼續必須自行回到 Step 1 重新加入，這是明確的人為動作。

**備份會延長實際保存期限。** 若備份保留 7 天，而政策為 30 天，則資料實際可復原的期間是 37 天，因為在資料從資料庫刪除之後，最舊的備份仍然含有它，直到該備份自己輪替掉為止。對外說明保存期限時應以「政策天數 + 備份保留天數」為準。

手動刪除單一房間可使用管理端點（需 `ADMIN_TOKEN`）：

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://creativity.rcsl.online/fishbone/api/admin/rooms/FISH-042
```

刪除前若需要留存，先匯出：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://creativity.rcsl.online/fishbone/api/admin/rooms/FISH-042/export > FISH-042.json
```

## 健康檢查

`GET /healthz` 會實際查詢資料庫中的 `schema_migrations` 資料表。選擇這張表而不是 `select 1`，是為了讓「連得上資料庫但結構不存在」也被判定為不健康。資料庫無法連線時回傳 503。

容器的 `HEALTHCHECK` 呼叫的是同一個端點，因此資料庫中斷會讓容器被標記為 unhealthy，而不只是留下一行日誌。

資料庫短暫中斷時，應用不會結束程序。連線池的閒置連線錯誤有被處理，避免可回復的中斷變成重啟迴圈。

## 沒有使用 WebSocket

原始需求傾向 WebSocket 加輪詢備援，最後決定只做長輪詢。理由有三：同步的資料模型是「整份快照加合併」，不是事件串流，長輪詢與它天然相符；兩層 nginx 之下 WebSocket 升級失敗時的症狀不易診斷，而長輪詢只要 HTTP 能通就能運作；實測延遲約 0.3 秒，對這個活動的節奏而言與即時無異。

## 已知取捨

卡片在不同裝置上的顯示順序可能不同。判斷「快照是否有變化」時，帶有 `id` 的陣列以集合方式比較而忽略順序；若不這麼做，每台裝置都會把自己排在成員清單最前面，導致兩台裝置整堂課互相推送快照。順序不影響任何內容或投票結果。

長輪詢的即時喚醒是行程內的。若未來擴充為多個複本，跨複本的變更仍會被偵測到，但延遲最多會多一秒，因為掛住期間也會固定重新查詢資料庫版本號。
