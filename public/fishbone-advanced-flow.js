/* Advanced group-flow safeguards layered on top of the recovered cloud version.
   This file intentionally keeps the existing room API and activity modules. */
(function(){
  const nowVersion=()=>Date.now();
  const clone=value=>JSON.parse(JSON.stringify(value));

  S.membersLocked=!!S.membersLocked;
  S.lockedMemberIds=Array.isArray(S.lockedMemberIds)?S.lockedMemberIds:[];
  S.memberLockVersion=Number(S.memberLockVersion||0);
  S.groupProgressStep=Number(S.groupProgressStep||1);
  S.discussions=Array.isArray(S.discussions)?S.discussions:[];
  S.discussionVersion=Number(S.discussionVersion||0);
  S.revisionMode=!!S.revisionMode;
  S.revisionTarget=String(S.revisionTarget||"");
  S.revisionReturnChain=Array.isArray(S.revisionReturnChain)?S.revisionReturnChain:[];
  S.revisionChainIndex=Number(S.revisionChainIndex||0);
  S.revisionRoundId=Number(S.revisionRoundId||0);
  S.revisionCompletedRound=Number(S.revisionCompletedRound||0);
  S.revisionCheckpointConfirmations=S.revisionCheckpointConfirmations||{};
  S.revisionCheckpointGenerations=S.revisionCheckpointGenerations||{};
  S.revisionStateVersion=Number(S.revisionStateVersion||0);

  const baseSharedSnapshot=sharedSnapshot;
  sharedSnapshot=function(){
    const data=baseSharedSnapshot();
    data.membersLocked=!!S.membersLocked;
    data.lockedMemberIds=clone(S.lockedMemberIds||[]);
    data.memberLockVersion=Number(S.memberLockVersion||0);
    data.groupProgressStep=Number(S.groupProgressStep||1);
    data.discussions=clone(S.discussions||[]);
    data.discussionVersion=Number(S.discussionVersion||0);
    data.revisionMode=!!S.revisionMode;
    data.revisionTarget=S.revisionTarget||"";
    data.revisionReturnChain=clone(S.revisionReturnChain||[]);
    data.revisionChainIndex=Number(S.revisionChainIndex||0);
    data.revisionRoundId=Number(S.revisionRoundId||0);
    data.revisionCompletedRound=Number(S.revisionCompletedRound||0);
    data.revisionCheckpointConfirmations=clone(S.revisionCheckpointConfirmations||{});
    data.revisionCheckpointGenerations=clone(S.revisionCheckpointGenerations||{});
    data.revisionStateVersion=Number(S.revisionStateVersion||0);
    return data;
  };

  function mergeConfirmations(local,remote){
    const out={...(local||{})};
    Object.keys(remote||{}).forEach(key=>{out[key]={...(out[key]||{}),...(remote[key]||{})}});
    return out;
  }
  const baseMergeRoom=mergeRoom;
  mergeRoom=function(data){
    baseMergeRoom(data);
    if(!data)return;
    const remoteLockVersion=Number(data.memberLockVersion||0);
    if(data.membersLocked&&(remoteLockVersion>=Number(S.memberLockVersion||0)||!S.membersLocked)){
      S.membersLocked=true;
      S.lockedMemberIds=[...new Set((data.lockedMemberIds||[]).map(String))];
      S.memberLockVersion=Math.max(remoteLockVersion,Number(S.memberLockVersion||0));
    }
    S.groupProgressStep=Math.max(Number(S.groupProgressStep||1),Number(data.groupProgressStep||1));
    if(Number(data.discussionVersion||0)>Number(S.discussionVersion||0)){
      S.discussions=mergeById(S.discussions||[],data.discussions||[]);
      S.discussionVersion=Number(data.discussionVersion||0);
    }else if(data.discussions)S.discussions=mergeById(S.discussions||[],data.discussions||[]);
    S.revisionCheckpointConfirmations=mergeConfirmations(S.revisionCheckpointConfirmations,data.revisionCheckpointConfirmations);
    Object.keys(data.revisionCheckpointGenerations||{}).forEach(key=>{
      S.revisionCheckpointGenerations[key]=Math.max(Number(S.revisionCheckpointGenerations[key]||1),Number(data.revisionCheckpointGenerations[key]||1));
    });
    const remoteRevisionVersion=Number(data.revisionStateVersion||0);
    if(remoteRevisionVersion>Number(S.revisionStateVersion||0)){
      S.revisionMode=!!data.revisionMode;
      S.revisionTarget=String(data.revisionTarget||"");
      S.revisionReturnChain=clone(data.revisionReturnChain||[]);
      S.revisionChainIndex=Number(data.revisionChainIndex||0);
      S.revisionRoundId=Number(data.revisionRoundId||0);
      S.revisionCompletedRound=Number(data.revisionCompletedRound||0);
      S.revisionStateVersion=remoteRevisionVersion;
    }
    if(S.revisionMode)normalizeFlowRevisionStep();
  };

  const baseJoinedMembers=joinedMembers;
  joinedMembers=function(){
    const members=baseJoinedMembers();
    if(!S.membersLocked)return members;
    const locked=new Set((S.lockedMemberIds||[]).map(String));
    return members.filter(member=>locked.has(String(member.id)));
  };
  function allVisibleMembers(){return (S.sources||[]).filter(source=>!source.system&&source.joined)}
  function isLockedMember(id=S.selfId){return !!S.membersLocked&&(S.lockedMemberIds||[]).includes(String(id))}

  const baseStep1=step1;
  step1=function(){
    const selfName=S.joined?src(S.selfId).name:(S.nameDraft||"");
    const members=S.membersLocked?joinedMembers():allVisibleMembers();
    const roster=members.length?`<ul class="memberRoster">${members.map(m=>`<li><span class="dot" style="background:${m.color}"></span>${esc(m.name)}</li>`).join("")}</ul>`:'<p class="small">目前還沒有成員加入。</p>';
    const lockBox=S.joined?`<section class="memberLockBox"><h3>成員名單</h3>${roster}${S.membersLocked?'<p class="ok"><strong>本輪成員名單已鎖定。</strong> 投票與進度只計算以上成員。</p>':`<p class="small">全組都加入後，由任一成員鎖定本輪名單。鎖定後不能再加入新成員。</p><button onclick="requestMemberLock()">鎖定成員名單並開始</button>`}</section>`:"";
    return panel("加入活動／加入小組","",`<div class="joinBox"><label>你的姓名或暱稱</label><input id="joinName" maxlength="40" value="${esc(selfName==="尚未加入"?"":selfName)}" placeholder="例如：小安" ${S.membersLocked?"disabled":""}><label>小組房間碼／活動代碼</label><input id="joinRoom" value="${esc(showRoomCode(S.roomCode))}" placeholder="例如：k7m2x-9qpwd" ${S.joined?"disabled":""}><button onclick="joinActivity()" ${S.membersLocked?"disabled":""}>加入</button>${S.joined?`<p class="joinedNote">已加入 ${esc(showRoomCode(S.roomCode))}，請等組員到齊後鎖定名單。</p>`:""}</div>${lockBox}<section class="surface"><h3>老師：建立新房間</h3><p class="small">房間碼由伺服器產生，建立後投影給全組抄寫。請勿使用真實學生姓名或敏感資料。</p>${S.createdRoom?`<div class="roomCode">${esc(S.createdRoom)}</div><p class="small">已填入上方欄位；輸入暱稱後按加入。</p>`:""}<button class="secondary" id="createRoomBtn" onclick="createRoom()" ${S.joined?"disabled":""}>建立新房間</button></section>`);
  };
  function requestMemberLock(){
    if(!S.joined){showGate("請先加入房間。");return}
    if(S.membersLocked){showGate("本輪成員名單已經鎖定。");return}
    const members=allVisibleMembers();
    if(members.length<2){showGate("請等待至少兩位成員加入後，再鎖定名單。");return}
    S.membersLocked=true;
    S.lockedMemberIds=members.map(member=>String(member.id));
    S.memberLockVersion=nowVersion();
    S.groupProgressStep=Math.max(2,Number(S.groupProgressStep||1));
    S.step=2;
    S.reviewingStep=0;
    render();
    schedulePush();
  }
  window.requestMemberLock=requestMemberLock;

  const baseJoinActivity=joinActivity;
  joinActivity=async function(){
    const nameEl=$("joinName"),name=(nameEl&&nameEl.value||"").trim();
    if(name.length>40||meaninglessInput(name)){showGate("請輸入可辨識的姓名或暱稱（40 字以內）。");return}
    await baseJoinActivity();
    if(!S.joined)return;
    if(S.membersLocked){
      if(isLockedMember())S.step=Math.max(2,Number(S.groupProgressStep||2));
    }else S.step=1;
    render();
    schedulePush();
  };

  const baseCanAdvance=canAdvance;
  canAdvance=function(step){
    if(Number(step)===1)return {ok:S.joined&&S.membersLocked&&isLockedMember(),msg:!S.joined?"請先加入活動。":"請等待全組加入，再鎖定成員名單。"};
    return baseCanAdvance(step);
  };

  function votesForKind(kind){
    const map={grouping:"groupingVotes",problem:"problemVotes",problemDraft:"problemDraftVotes",causeClass:"causeClassVotes",right:"rightVotes",goalDraft:"goalDraftVotes",methodClass:"methodClassVotes",outcome:"outcomeVotes",outcomeRevision:"outcomeRevisionVotes"};
    return S[map[kind]]||{};
  }
  function flowDiscussionMeta(){
    if(!S.membersLocked||![3,4,5,9,10,11,15,16].includes(Number(S.step)))return null;
    if(S.step===3){const info=groupingVoteInfo();if(info.allVoted&&(info.tie||info.own))return {kind:"grouping",reason:"分群版本同票或沒有形成唯一選擇",advice:groupingTieAdvice(info)}}
    if(S.step===4){const items=problemCandidates(),info=topInfo(items,S.problemVotes,"problem");if(info.allVoted&&(info.tie||info.own))return {kind:"problem",reason:"問題選擇沒有形成唯一結果",advice:problemChoiceAdvice(items,info)}}
    if(S.step===5){const status=problemDraftStatus();if(status.allVoted&&status.total>0&&status.revise>=status.agree)return {kind:"problemDraft",reason:"主要問題草稿仍需要調整",advice:"確認草稿是否保留共同問題核心、整合小組補充，且沒有改變原意。"}}
    if(S.step===9){const info=causeClassVoteInfo();if(info.allVoted&&(info.tie||info.own))return {kind:"causeClass",reason:"原因分類沒有形成唯一結果",advice:causeClassTieAdvice(info)}}
    if(S.step===10){const status=rightVoteStatus();if(status.allVoted&&status.total>0&&status.go===status.revise)return {kind:"right",reason:"向右魚骨圖表態平票",advice:"比較大要因名稱是否清楚、原因歸類是否合理，以及是否足以支持下一步。"}}
    if(S.step===11){const status=goalDraftStatus();if(status.allVoted&&status.total>0&&status.revise>=status.agree)return {kind:"goalDraft",reason:"決策目標草稿仍需要調整",advice:"確認目標是否清楚、能回應原因，而且不是空泛口號。"}}
    if(S.step===15){const info=methodClassVoteInfo();if(info.allVoted&&(info.tie||info.own))return {kind:"methodClass",reason:"方法分類沒有形成唯一結果",advice:methodClassTieAdvice(info)}}
    if(S.step===16&&S.outcomeNeedsRevision){const status=outcomeRevisionStatus();if(status.allVoted&&status.tie)return {kind:"outcomeRevision",reason:"返回修改的位置同票",advice:outcomeRevisionTieAdvice()}}
    if(S.step===16&&!S.outcomeNeedsRevision){const status=outcomeVoteStatus();if(status.allVoted&&status.total>0&&status.go===status.revise)return {kind:"outcome",reason:"成果確認表態平票",advice:"檢查主要問題、原因、決策目標、方法與對應關係，說明最需要先調整的一處。"}}
    return null;
  }
  function flowDiscussionKey(meta){return `${S.roomCode||"room"}:${S.step}:${meta.kind}:${S[meta.kind+"Round"]||1}`}
  function flowDiscussionPanel(){
    const meta=flowDiscussionMeta();if(!meta)return "";
    const key=flowDiscussionKey(meta),messages=(S.discussions||[]).filter(message=>message.key===key).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)),inputId=`flow-discussion-${meta.kind}`;
    return `<section class="discussionBox" data-flow-kind="${esc(meta.kind)}"><h3>先討論，再重新投票</h3><div class="discussionReason">${esc(meta.reason)}</div><p><strong>比較提醒：</strong>${esc(meta.advice)}</p><div class="discussionFeed">${messages.length?messages.map(message=>`<div class="discussionMsg"><strong>${esc(src(message.source).name)}</strong><p>${esc(message.text)}</p></div>`).join(""):'<p class="small">還沒有討論訊息；可以先說明你選擇的理由。</p>'}</div><div class="discussionInput"><textarea id="${inputId}" placeholder="輸入討論訊息"></textarea><button type="button" class="secondary" onclick="sendFlowDiscussion('${esc(key)}','${inputId}')">送出訊息</button></div><button type="button" onclick="restartFlowVote('${meta.kind}')">討論完成，開始新一輪投票</button></section>`;
  }
  function sendFlowDiscussion(key,inputId){
    if(!hasSpeaker()){remindSpeaker();return}
    const el=$(inputId),text=(el&&el.value||"").trim();
    if(meaninglessInput(text)){showGate("請輸入一段有意義的討論內容。");return}
    S.discussions.push({id:uid("msg"),key,source:actor(),text:text.slice(0,1000),createdAt:Date.now()});
    S.discussionVersion=nowVersion();render();schedulePush();
  }
  function restartFlowVote(kind){
    const meta=flowDiscussionMeta();
    if(!meta||meta.kind!==kind){showGate("目前沒有需要重新投票的項目。");return}
    newVoteRound(kind);
    if(kind==="grouping"){S.groupingConfirmed="";S.confirmBy.grouping="";resetProblemChoiceState()}
    if(kind==="problem"){S.selected="";S.selectedCandidate="";S.confirmBy.selected="";resetProblemDraftState(true)}
    if(kind==="problemDraft"){S.problemDraftHold=false;S.problemDraftUpdated=false;S.problemOk=false;S.confirmBy.problem=""}
    if(kind==="causeClass"){S.causeClassConfirmed="";S.rightOk=false;S.rightNeedsRevision=false;S.confirmBy.right="";newVoteRound("right")}
    if(kind==="right"){S.rightOk=false;S.rightNeedsRevision=false;S.confirmBy.right=""}
    if(kind==="goalDraft"){S.goalDraftHold=false;S.goalDraftUpdated=false;S.goal="";S.confirmBy.goal=""}
    if(kind==="methodClass"){S.methodClassConfirmed="";S.outcomeOk=false;S.outcomeNeedsRevision=false;S.confirmBy.outcome="";newVoteRound("outcome")}
    if(kind==="outcome"){S.outcomeOk=false;S.outcomeNeedsRevision=false;S.confirmBy.outcome=""}
    if(kind==="outcomeRevision"){S.outcomeRevisionTarget="";S.outcomeRevisionTargetRound=0}
    render();showOk("已開始新一輪，請重新投票。");schedulePush();
  }
  window.sendFlowDiscussion=sendFlowDiscussion;
  window.restartFlowVote=restartFlowVote;

  ["voteGrouping","voteProblem","voteProblemDraft","voteCauseClass","voteRight","voteGoalDraft","voteMethodClass","voteOutcome","voteOutcomeRevision"].forEach(name=>{
    const original=window[name];
    window[name]=function(...args){const meta=flowDiscussionMeta();if(meta){showGate("請先完成討論，再按『開始新一輪投票』。");return}return original.apply(this,args)};
  });

  const revisionChains={5:[5,7,8,9,10,11,13,14,15],9:[9,10,11,13,14,15],11:[11,13,14,15],14:[14,15],15:[15]};
  function revisionOfficialStep(){return Number((S.revisionReturnChain||[])[Number(S.revisionChainIndex||0)]||16)}
  function revisionBaseKey(step=revisionOfficialStep()){return `${S.revisionRoundId||1}:${step}`}
  function revisionGeneration(step=revisionOfficialStep()){return Number(S.revisionCheckpointGenerations[revisionBaseKey(step)]||1)}
  function revisionKey(step=revisionOfficialStep()){return `${revisionBaseKey(step)}:${revisionGeneration(step)}`}
  function revisionConfirmations(step=revisionOfficialStep()){return S.revisionCheckpointConfirmations[revisionKey(step)]||{}}
  function revisionStatus(step=revisionOfficialStep()){
    const ids=(S.lockedMemberIds||[]),map=revisionConfirmations(step),done=ids.filter(id=>map[id]).length;
    return {done,total:ids.length,all:ids.length>0&&done===ids.length,mine:!!map[S.selfId]};
  }
  function revisionFingerprint(step=revisionOfficialStep()){
    const fields={5:[S.problemDraft,S.problem,S.problemDetails],7:[S.causes],8:[S.causes,S.stash],9:[S.cats,S.causeClassConfirmed,S.causeClassProposals],10:[S.rightOk,S.cats,S.causes],11:[S.goalDraft,S.goal,S.goalIdeas],13:[S.methods],14:[S.methods],15:[S.methodClassConfirmed,S.methodClassProposals,S.methods]};
    return JSON.stringify(fields[step]||[]);
  }
  let lastRevisionFingerprint="";
  function normalizeFlowRevisionStep(){
    if(!S.revisionMode)return;
    const official=revisionOfficialStep();
    if(official!==16&&Number(S.step)!==official){S.step=official;S.reviewingStep=0}
  }
  function startFlowRevision(stepId,round){
    const step=Number(stepId),chain=revisionChains[step];if(!chain)return false;
    S.revisionMode=true;S.revisionTarget=String(step);S.revisionReturnChain=chain;S.revisionChainIndex=0;
    S.revisionRoundId=Number(round||S.outcomeRevisionRound||1);S.revisionStateVersion=nowVersion();
    S.outcomeOk=false;S.outcomeNeedsRevision=false;S.confirmBy.outcome="";S.step=chain[0];S.reviewingStep=0;
    lastRevisionFingerprint=revisionFingerprint(chain[0]);schedulePush();return true;
  }
  applyOutcomeRevisionTarget=function(stepId,round=S.outcomeRevisionTargetRound||S.outcomeRevisionRound||1,force=false){
    const step=Number(stepId);if(!validOutcomeRevisionStep(step))return false;
    if(!force&&!(S.step===16||S.outcomeNeedsRevision||S.outcomeOk||S.revisionMode))return false;
    if(S.revisionMode&&String(S.revisionTarget)===String(step))return true;
    S.outcomeRevisionTarget=String(step);S.outcomeRevisionTargetRound=round;S.outcomeRevisionAppliedRound=round;
    return startFlowRevision(step,round);
  };
  function advanceFlowRevision(){
    if(Number(S.revisionChainIndex||0)<S.revisionReturnChain.length-1){
      S.revisionChainIndex+=1;S.step=revisionOfficialStep();S.revisionStateVersion=nowVersion();lastRevisionFingerprint=revisionFingerprint();render();schedulePush();return;
    }
    S.revisionCompletedRound=S.revisionRoundId;S.revisionMode=false;S.revisionTarget="";S.revisionReturnChain=[];S.revisionChainIndex=0;
    S.outcomeOk=false;S.outcomeNeedsRevision=false;S.confirmBy.outcome="";newVoteRound("outcome");S.step=16;S.revisionStateVersion=nowVersion();render();schedulePush();
  }
  function confirmFlowRevision(){
    if(!S.revisionMode)return;
    const step=revisionOfficialStep(),check=baseCanAdvance(step);
    if(!check.ok){showGate(check.msg||"請先完成目前檢查點的必要內容。");return}
    const key=revisionKey(step),all={...(S.revisionCheckpointConfirmations||{})},map={...(all[key]||{})};map[S.selfId]=Date.now();all[key]=map;S.revisionCheckpointConfirmations=all;S.revisionStateVersion=nowVersion();
    const status=revisionStatus(step);if(status.all)advanceFlowRevision();else{render();showOk(`已確認，等待其他成員（${status.done}/${status.total}）。`);schedulePush()}
  }
  window.confirmFlowRevision=confirmFlowRevision;
  function flowRevisionBanner(){
    if(!S.revisionMode)return "";const step=revisionOfficialStep(),status=revisionStatus(step),labels={5:"主要問題",7:"可能原因",8:"原因內容",9:"原因分類",10:"向右魚骨圖",11:"決策目標",13:"解決方法",14:"方法與原因對應",15:"方法分類"};
    return `<section class="revisionCheckpoint"><h3>修改後重新確認：${esc(labels[step]||"內容")}</h3><p>請檢查目前內容。若有人修改，先前確認會自動失效；全員重新確認後才會進到下一個檢查點。</p><p class="small">已確認 ${status.done}/${status.total} 人。</p><button type="button" ${status.mine?"disabled":""} onclick="confirmFlowRevision()">${status.mine?"你已確認，等待其他成員":"確認目前內容"}</button></section>`;
  }

  function meaninglessInput(value){
    const text=String(value||"").trim().replace(/\s+/g,"");if(!text)return true;
    if(/^(哈+|呵+|ㄏ+|啊+|嗯+|test|測試|隨便|不知道|沒有|無|asdf+|qwer+|123+|111+|[?？。.!！@#]+)$/i.test(text))return true;
    return text.length>=3&&new Set([...text]).size<=2&&!/[因為所以可以希望想要改善解決安排提醒完成]/.test(text);
  }
  window.meaninglessInput=meaninglessInput;
  function distressLooksLikeGoal(text){return /^(希望|想要|目標是|我要|我們要|改善|增加|減少|提升|建立|完成|做到)/.test(String(text||"").trim())}
  const baseReviewDistress=reviewDistress;
  reviewDistress=function(text){
    if(meaninglessInput(text))return {ok:false,msg:"這段內容還看不出具體困擾，請重新輸入一個實際發生的情況。"};
    if(distressLooksLikeGoal(text))return {ok:false,msg:"這句比較像目標或做法。請改寫成目前實際遇到的困擾，例如『在什麼情況下，遇到什麼困難』。"};
    return baseReviewDistress(text);
  };

  const drafts={};let composing=false,pendingRender=false,selecting=false,activeSelectId="",pendingSelectRender=false;
  function draftControl(el){return el&&/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)&&!!el.id}
  function captureDrafts(){const el=document.activeElement;if(draftControl(el))drafts[`${S.step}:${el.id}`]=el.value}
  function restoreDrafts(){document.querySelectorAll("input[id],textarea[id],select[id]").forEach(el=>{const key=`${S.step}:${el.id}`;if(Object.prototype.hasOwnProperty.call(drafts,key))el.value=drafts[key]})}
  function captureFocus(){const el=document.activeElement;if(!draftControl(el))return null;return {id:el.id,start:el.selectionStart,end:el.selectionEnd}}
  function restoreFocus(info){if(!info)return;const el=$(info.id);if(!el)return;el.focus({preventScroll:true});if(typeof el.setSelectionRange==="function"&&info.start!==null)el.setSelectionRange(info.start,info.end)}
  function applyReadOnlyReview(){
    if(S.revisionMode||!S.reviewingStep||Number(S.step)>=Number(S.groupProgressStep||1))return;
    const main=$("main");if(!main)return;
    main.querySelectorAll("input,textarea,select,button").forEach(el=>{el.disabled=true});
    const note=document.createElement("div");note.className="readOnlyReview";note.textContent="這是已完成步驟的唯讀回顧；若要修改，請在成果確認選擇『需要返回修改』。";main.prepend(note);
  }
  const baseRender=render;
  render=function(force=false){
    if(composing&&!force){pendingRender=true;return}
    if(selecting&&!force){pendingSelectRender=true;return}
    captureDrafts();const focus=captureFocus();
    if(S.revisionMode){normalizeFlowRevisionStep();const fingerprint=revisionFingerprint();if(lastRevisionFingerprint&&fingerprint!==lastRevisionFingerprint){const key=revisionBaseKey(),generation=revisionGeneration()+1;S.revisionCheckpointGenerations[key]=generation;S.revisionStateVersion=nowVersion()}lastRevisionFingerprint=fingerprint}
    else if(S.joined&&S.membersLocked&&!S.reviewingStep)S.groupProgressStep=Math.max(Number(S.groupProgressStep||1),Number(S.step||1));
    baseRender();
    const main=$("main");if(main){const revision=flowRevisionBanner(),discussion=flowDiscussionPanel();if(revision)main.insertAdjacentHTML("afterbegin",revision);if(discussion)main.insertAdjacentHTML("beforeend",discussion)}
    restoreDrafts();restoreFocus(focus);applyReadOnlyReview();
  };
  const baseAutoAdvance=autoAdvanceFromShared;
  autoAdvanceFromShared=function(){if(S.revisionMode){normalizeFlowRevisionStep();return}if(Number(S.step)===1&&S.membersLocked&&isLockedMember())S.step=Math.max(2,Number(S.groupProgressStep||2));baseAutoAdvance()};
  const basePreviousStep=previousStep;
  previousStep=function(){if(S.revisionMode){showGate("修改流程中請依檢查點前進，不要跳離目前步驟。");return}basePreviousStep()};

  document.addEventListener("input",event=>{if(draftControl(event.target))drafts[`${S.step}:${event.target.id}`]=event.target.value},true);
  document.addEventListener("change",event=>{if(draftControl(event.target))drafts[`${S.step}:${event.target.id}`]=event.target.value;if(event.target&&event.target.tagName==="SELECT"){selecting=false;activeSelectId="";pendingSelectRender=false}},true);
  document.addEventListener("pointerdown",event=>{if(event.target&&event.target.tagName==="SELECT"){selecting=true;activeSelectId=event.target.id||""}},true);
  document.addEventListener("keydown",event=>{if(!event.target||event.target.tagName!=="SELECT")return;if(event.key==="Escape"){selecting=false;activeSelectId="";if(pendingSelectRender){pendingSelectRender=false;setTimeout(()=>render(true),20)};return}if(["Enter"," ","ArrowDown","ArrowUp","Home","End"].includes(event.key)){selecting=true;activeSelectId=event.target.id||""}},true);
  document.addEventListener("blur",event=>{if(!event.target||event.target.tagName!=="SELECT"||activeSelectId&&event.target.id!==activeSelectId)return;selecting=false;activeSelectId="";if(pendingSelectRender){pendingSelectRender=false;setTimeout(()=>render(true),20)}},true);
  document.addEventListener("compositionstart",event=>{if(draftControl(event.target))composing=true},true);
  document.addEventListener("compositionend",event=>{if(!draftControl(event.target))return;composing=false;if(pendingRender){pendingRender=false;setTimeout(()=>render(true),20)}},true);
  document.addEventListener("keydown",event=>{if((event.isComposing||event.keyCode===229)&&draftControl(event.target)){event.stopPropagation();return}if(event.key==="Enter"&&draftControl(event.target)&&event.target.tagName!=="TEXTAREA"){event.preventDefault();event.stopPropagation()}},true);
  document.addEventListener("submit",event=>{event.preventDefault();event.stopPropagation()},true);
})();
