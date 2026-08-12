# 魚骨洞天

「魚骨洞天」是用於創意發想與問題分析的教學活動網站。學生從人、方法與環境等角度拆解問題，再整理可嘗試的創意方案。

## 兩種可用版本

| 版本 | 位置 | 適合用途 |
| --- | --- | --- |
| GitHub Pages 範例 | [`docs/index.html`](docs/index.html) | 公開展示、快速教學活動、免伺服器。 |
| 完整活動網站 | [`public/fishbone.html`](public/fishbone.html) 與 [`app/`](app) | 後續擴充互動、資料保存或教師功能。 |

## 公開發布到 GitHub Pages

本 repository 已包含可以直接發布的靜態範例。請在 GitHub repository 進入 `Settings` → `Pages`，選擇以分支發布，並設定：

- Branch：`main`
- Folder：`/docs`

發布完成後，網站網址為：

`https://yiying010.github.io/fishbone/`

GitHub Pages 版本不會把輸入內容傳到伺服器或保存；重新整理頁面後，輸入內容會消失。

## 日後更新 GitHub Pages

修改 [`docs/index.html`](docs/index.html) 後，在專案資料夾開啟 PowerShell 並輸入：

```powershell
git add .
git commit -m "更新魚骨洞天網頁"
git push
```

GitHub Pages 會自動重新發布；公開網址不會改變。

## 本機開發完整版本

環境需求：Node.js `>=22.13.0`。

```powershell
npm install
npm run dev
```

驗證建置：

```powershell
npm run build
```

## 自架伺服器

目前最推薦先以 GitHub Pages 或其他靜態主機發布。若要部署到校內／自有伺服器，或未來需要保存學生資料與教師後台，請先閱讀完整的 [自架伺服器部署分析](SELF_HOSTING_ANALYSIS.md)。

簡要結論：靜態範例可直接自架；完整 vinext 應用可以自架，但目前偏向 Cloudflare Workers 執行環境，需要另外建立並驗證 Node.js 部署版本。

## 專案結構

```text
app/                     完整應用的頁面與樣式
public/fishbone.html     主要活動頁面
docs/index.html          GitHub Pages 靜態範例
worker/                  Cloudflare Worker 進入點
SELF_HOSTING_ANALYSIS.md 自架伺服器部署分析
```

## 資料與隱私

請勿將 API 金鑰、密碼或學生個資提交到 GitHub。公開發布前，也請確認教材與圖片具有可公開使用的授權。
