    const stepNames=["開始活動","提出生活困擾","整理相近主題","選擇想分析的問題","界定主要問題","認識向右魚骨圖","提出可能原因","確認原因內容","原因分類與大要因命名","確認向右魚骨圖","建立決策目標","認識向左魚骨圖","提出解決方法","檢查方法與原因對應","確認要放進魚骨圖的方法","成果整理","選擇方案","反思","最終成果呈現與匯出"];
    const ai={
      1:["歡迎進入「魚骨洞天」。今天會先選一個生活中想分析的問題，再找原因，最後想方法。","請輸入你的姓名或暱稱，以及小組房間碼，加入活動後就可以開始。"],
      2:["請說出或輸入一個生活困擾；可參考人際、課業、家庭、校園、時間管理等方向。"],
      3:["請把相近的困擾整理到同一個主題中。整理完成後，提交你的分群結果，再投票選出最適合小組使用的一版。","如果目前只有一張困擾，可以直接往下一步。"],
      4:["請從已確認的分群中選出目前想分析的一項。每位成員投一票，平票時請先討論再重新投票。"],
      5:["我會先看看目前選出的共同問題是否夠清楚。如果還有模糊的地方，我會請你補充一個最需要說清楚的地方，讓問題更容易分析。","主要問題草稿整理好後，請每位成員確認：這是不是符合小組原本想討論的問題？"],
      6:["向右魚骨圖是用來找原因。魚頭放主要問題，魚骨上整理大要因與具體原因。"],
      7:["提出可能原因","請每個人提出一個或多個可能原因，先求多樣，不急著分類。","如果想不到，可以換角度想：人、環境、時間、規則或工具，哪一邊可能有影響？"],
      8:["我會先幫每項內容做初步檢查，提醒它可能比較像原因、結果或方法；最後仍由你確認、補充或修正。"],
      9:["請先把相近的原因整理到大要因下面，並為大要因命名。整理完成後，提交你的原因分類版本，再投票選出最適合放進向右魚骨圖的一版。"],
      10:["這是目前的向右魚骨圖，請檢查主要問題、大要因和具體原因是否符合原本的想法。"],
      11:["現在請根據剛剛整理出的原因，提出你覺得想改善的情況。AI 會依全組提出的想法整理成一份決策目標草稿，大家確認後才會成為正式決策目標。","優先處理原因只是選填輔助；目標不一定要一次處理所有原因，但要清楚說出想改善什麼，後面才比較好發展方法。"],
      12:["向左魚骨圖是用來找方法。魚頭放決策目標，魚骨上整理大方法與具體方法。"],
      13:["請先提出你想到的做法，可以一個，也可以多個。現在先不用分類，也不用急著連到原因。","你可以把做法說得更清楚一點，例如：誰來做？什麼時候做？怎麼做？需要哪些工具或幫忙？"],
      14:["請看看你想保留的方法，想一想它主要是在回應哪一個原因。","選好原因後，再用一句話說明：這個方法怎麼幫助我們達成決策目標？"],
      15:["請確認要放進魚骨圖的方法，並為它們整理大方法名稱。"],
      16:["請看一下這一版雙向魚骨圖，確認它是不是符合小組目前的想法。","如果有內容漏掉、放錯位置，或需要調整，可以選擇返回修改。"],
      17:["現在請看看正式放進向左魚骨圖的方法，先選一個你覺得最做得到的方法，並寫下原因。","接著再選一個你覺得最有新意的方法，也寫下原因。兩個選擇可以相同，也可以不同，但都要和前面找出的原因與決策目標有關。"],
      18:["最後請寫下你的反思。可以想一想：魚骨圖怎麼幫助你看見問題背後的原因？你在小組整理過程中有什麼新的發現？"],
      19:["這是小組最後成果。請查看完整雙向魚骨圖、最可行與最獨特方法，以及小組反思摘要；確認後可以匯出圖片版或文字版成果。"]
    };
    const colors=["#276EF1","#00A676","#D95D39","#7B61FF","#B7791F","#008C95"];
    const risks=["自殺","自傷","傷害自己","不想活","傷人","殺人","暴力","性侵","性暴力","虐待","威脅","勒索","跟蹤","霸凌","不安全","家暴"];
    let S={step:0,mode:"group",roomCode:"",createdRoom:"",selfId:"self",nameDraft:"",joined:false,autoTts:true,ttsReady:false,lastSpokenStep:0,recordingBy:"",confirmBy:{grouping:"",selected:"",problem:"",right:"",goal:"",outcome:"",feasible:"",reflection:""},sources:[{id:"self",name:"尚未加入",color:colors[0],system:false,joined:false},{id:"group",name:"小組提出",color:"#46515f",system:true,joined:true},{id:"unknown",name:"未指定",color:"#8a8f98",system:true,joined:false}],active:"self",distresses:[],distressesVersion:0,deletedDistressIds:[],topics:[{id:"t1",name:"主題 A"},{id:"t2",name:"主題 B"}],draftTopics:[{id:"dt1",name:"主題 A"},{id:"dt2",name:"主題 B"}],draftAssignments:{},groupProposals:[],groupingVotes:{},groupingVersion:0,groupConfirmVotes:{},groupingOwnConcern:false,groupingConfirmed:"",selectedCandidate:"",problemVotes:{},problemVoteVersion:0,selected:"",problem:"",problemOk:false,problemDetails:[],problemDetailsVersion:0,problemDraft:"",problemDraftHold:false,problemDraftUpdated:false,problemDraftVotes:{},problemRevisionNotes:[],causes:[],causesVersion:0,deletedCauseIds:[],cats:[{id:"c1",name:"大要因 1"},{id:"c2",name:"大要因 2"}],draftCats:[{id:"dc1",name:"大要因 1"},{id:"dc2",name:"大要因 2"}],draftCauseAssignments:{},causeClassProposals:[],causeClassVotes:{},causeClassVersion:0,causeClassConfirmed:"",rightOk:false,rightVotes:{},rightVoteVersion:0,rightNeedsRevision:false,goal:"",goalIdeas:[],goalIdeasVersion:0,goalDraft:"",goalDraftHold:false,goalDraftUpdated:false,goalDraftVotes:{},priority:[],priorityOpen:true,stash:[],methods:[],methodsVersion:0,deletedMethodIds:[],draftMethodCats:[{id:"dmc1",name:"大方法 1"},{id:"dmc2",name:"大方法 2"}],draftMethodAssignments:{},methodClassProposals:[],methodClassVotes:{},methodClassVersion:0,methodClassConfirmed:"",outcomeOk:false,outcomeVotes:{},outcomeVoteVersion:0,outcomeNeedsRevision:false,solutionVotes:{},solutionVoteVersion:0,solutionTie:false,feasible:"",feasibleReason:"",unique:"",uniqueReason:"",reflections:[],reflectionsVersion:0,reflectionSummary:"",reflectionSummaryOk:false,reflection:""};
    const tabUserId=sessionStorage.getItem("fishboneUserId")||("u-"+Date.now()+"-"+Math.random().toString(16).slice(2));sessionStorage.setItem("fishboneUserId",tabUserId);S.selfId=tabUserId;S.active=tabUserId;S.sources[0].id=tabUserId;
    const roomPrefix="fishbone-room-v2:";let syncMuted=false;const roomChannel=("BroadcastChannel" in window)?new BroadcastChannel("fishbone-room-v2"):null;
    const $=id=>document.getElementById(id), uid=p=>p+"-"+Date.now()+"-"+Math.random().toString(16).slice(2), esc=s=>(s||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
    const src=id=>S.sources.find(s=>s.id===id)||S.sources.find(s=>s.id==="unknown");
    function renameSource(id,value){src(id).name=value;document.querySelectorAll(`[data-source-id="${id}"]`).forEach(el=>el.textContent=value)}
    const badge=id=>`<span class="badge" data-source-id="${esc(id)}" style="border-color:${src(id).color};color:${src(id).color}">提出者：${esc(src(id).name)}</span>`;
    function risk(text,type){let hit=risks.find(r=>(text||"").includes(r));if(!hit)return false;$("safetyMeta").textContent=`紀錄：Step ${S.step}、內容類型「${type}」、高風險訊號類型「${hit}」、處理狀態「已暫停並提示轉介」。不保存完整敏感原文。`;$("afterHelp").classList.remove("show");$("safety").classList.add("show");return true}
    function compactInput(t){return String(t||"").trim().replace(/\s+/g,"")}
    function privateDistress(text){let s=String(text||"");return /(真名|全名|姓名|身分證|電話|手機號碼|地址|住址|帳號|密碼|個資|私人秘密|不想公開)/.test(s)||/[王李張陳林黃吳劉蔡楊許鄭謝郭洪邱曾廖賴徐周葉蘇莊江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯][\u4e00-\u9fff]{1,2}(同學|老師|主任|教官|學長|學姊|學弟|學妹|朋友)/.test(s)||/(外遇|出軌|家裡欠債|家人欠債|私人對話截圖)/.test(s)}
    function vagueDistress(text){let s=compactInput(text);if(!s)return true;if(/^(課業|很煩|朋友|時間管理|人際|家庭|校園|作業|考試|報告|手機|讀書|壓力|生活)$/.test(s))return true;return s.length<8&&!/(在|時|因為|常常|容易|無法|不能|不知道|困難|卡住|忘記|來不及|太多|分心|吵架|不會|沒辦法|影響|拖延|不平均|不順)/.test(s)}
    function reviewDistress(text){if(privateDistress(text))return {ok:false,msg:"這個困擾可能包含比較私人的細節。請先改成匿名、一般化的說法，例如不寫真名、不公開私人事件細節，再送出。"};if(vagueDistress(text))return {ok:false,msg:"這個困擾還有點籠統。你想分析的是哪一個具體困擾？請補成一個生活中實際發生的情況。"};return {ok:true,msg:""}}
    function reviewCauseText(text){let s=compactInput(text),meaningful=/[\u4e00-\u9fffA-Za-z0-9]/.test(s),nonsense=/^(哈+|呵+|嘻+|嘿+|ㄏ+|XD+|x+d+|test|測試|隨便|不知道|沒有|無|算了|亂打|asdf+|qwer+|123+|111+|[@]+|[？?]+|。+)$/.test(s),emotionOnly=/^(很煩|好煩|煩|生氣|難過|開心|無聊|壓力大|累|好累)$/.test(s),tooVague=/^(課業|朋友|時間|時間管理|人際|家庭|校園|作業|考試|報告|手機|讀書|生活|問題|原因)$/.test(s);if(!s)return {ok:false,msg:"請先寫下一個可能原因。"};if(!meaningful||nonsense||emotionOnly)return {ok:false,msg:"這看起來還不像一個可能原因，請重新輸入。"};let g=classifyCause(s);if(s.length<3||tooVague)return {ok:true,msg:"這張先建立為待 Step 8 確認；如果可以，下一張請把原因說得更具體一點。"};if(g.kind==="比較像方法"||g.kind==="比較像結果")return {ok:true,msg:"這張先建立為待 Step 8 確認；下一步會再確認它比較像原因、結果還是方法。"};return {ok:true,msg:""}}
    function reviewMethodText(text){let raw=String(text||""),s=compactInput(raw),meaningful=/[\u4e00-\u9fffA-Za-z0-9]/.test(s),action=/設定|使用|運用|安排|建立|提醒|約定|分工|改善|增加|減少|解決|處理|規劃|檢查|記錄|溝通|練習|請教|詢問|討論|列|寫|做|完成|準備|整理|分類|收納|關掉|限制|放下|提早|固定|每天|每週|時間|清單|計畫|表|工具|流程|步驟|番茄鐘|互相|輪流|先|後|選出|挑出|排出|排序|轉換|估計|估算|修正|執行/.test(s),nonsense=/^(哈+|呵+|嘻+|嘿+|ㄏ+|XD+|x+d+|test|測試|隨便|不知道|沒有|無|算了|亂打|asdf+|qwer+|123+|111+|[@]+|[？?]+|。+)$/.test(s),emotionOnly=/^(很煩|好煩|煩|生氣|難過|開心|無聊|壓力大|累|好累)$/.test(s),tooShort=s.length<3;if(!s)return {ok:false,vague:false,msg:"請先寫下你想到的做法。"};if(!meaningful||nonsense||emotionOnly||tooShort)return {ok:false,vague:false,msg:"這看起來還不像一個可以做的方式，請改成具體做法。"};if(vagueMethod({text:s})||/^(更努力|努力|認真|更認真|好好讀書|改善時間管理|專心|提高專注力|變好|加油|改進|改善)$/.test(s))return {ok:true,vague:true,msg:"這個方法還有點籠統，可以補充誰做、什麼時候做、怎麼做。"};if(!action&&s.length<8)return {ok:false,vague:false,msg:"這看起來還不像一個可以做的方式，請改成具體做法。"};return {ok:true,vague:false,msg:"這是一個可能方法，下一步再檢查它回應哪個原因。"}}
    function stuckCauseText(text){return /(想不到|想不出|不知道要寫什麼|不知道原因|沒有想法|卡住|不會想)/.test(String(text||""))}
    function repeatedCauseText(text,items){let s=compactInput(text);if(!s||!items.length)return false;let chars=a=>[...new Set(compactInput(a).split("").filter(ch=>/[\u4e00-\u9fffA-Za-z0-9]/.test(ch)))];return items.some(x=>{let o=compactInput(x.text);if(o===s)return true;let A=chars(o),B=chars(s);if(Math.min(A.length,B.length)<5)return false;let common=A.filter(ch=>B.includes(ch)).length;return common/Math.min(A.length,B.length)>.75})}
    function ownActiveCauses(){return S.causes.filter(c=>isOwnCard(c)&&c.status!=="已移到方法暫存區"&&c.status!=="暫不使用")}
    function ownCausesHighlyRepeated(){let list=ownActiveCauses();if(list.length<2)return false;let normalized=list.map(c=>compactInput(c.text)).filter(Boolean);return new Set(normalized).size<normalized.length||list.some((c,i)=>repeatedCauseText(c.text,list.filter((_,j)=>j!==i)))}
    function actor(){let a=src(S.active);return a&&!a.system&&a.joined?S.active:(S.joined?S.selfId:"group")}
    function audit(x){return `<div class="meta">${badge(x.source||x.createdBy||"unknown")}</div>`}
    function canEditCard(x){let owner=x.createdBy||x.source||"unknown";return owner==="group"||owner==="unknown"||owner===actor()}
