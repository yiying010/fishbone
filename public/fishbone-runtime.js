    let recognition=null,voiceBusy=false,voiceTargetId="",voiceStartedOnce=false;function isFileMode(){return location.protocol==="file:"}function voiceHelp(needsSpeaker=false){let base=needsSpeaker?`語音轉文字後，會以「${src(actor()).name}」送出；請確認內容再送出。`:"語音轉文字後，請確認內容再送出。";return isFileMode()?base+" 目前是 file:// 離線測試，Chrome 可能每次錄音都重新詢問麥克風權限；若出現此情況，請以文字輸入為主，STT 改到 localhost 或 HTTPS 測試。":base}function setVoiceStatus(msg){let el=$("voiceStatus");if(el)el.textContent=msg}function initVoice(){if(recognition)return recognition;const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return null;recognition=new SR();recognition.lang="zh-TW";recognition.interimResults=false;recognition.continuous=false;recognition.onresult=e=>{let target=$(voiceTargetId);if(target){target.value=e.results[0][0].transcript;target.dispatchEvent(new Event("input",{bubbles:true}));target.dispatchEvent(new Event("change",{bubbles:true}))}setVoiceStatus("已轉成文字，請確認內容後再送出。")};recognition.onerror=()=>{voiceBusy=false;S.recordingBy="";setVoiceStatus(isFileMode()?"語音辨識沒有成功。你目前用 file:// 離線測試，若 Chrome 反覆要求權限，請先改用文字輸入，STT 留到 localhost 或 HTTPS 測試。":"語音辨識沒有成功，請再試一次或改用文字。")};recognition.onend=()=>{voiceBusy=false;S.recordingBy="";setVoiceStatus("已結束聆聽，請確認文字後再送出。")};return recognition}function startVoice(id){if(id==="newText"&&!hasSpeaker()){remindSpeaker();return}let target=$(id);if(!target)return;let rec=initVoice();if(!rec){setVoiceStatus("這個瀏覽器目前不支援語音辨識，請改用文字輸入。");return}if(voiceBusy){setVoiceStatus("目前正在聽，請先說完這一段。");return}voiceTargetId=id;voiceBusy=true;voiceStartedOnce=true;S.recordingBy=actor();setVoiceStatus(isFileMode()?"正在聽，說完請稍等轉文字。提醒：file:// 離線模式下，Chrome 可能每次錄音都要求麥克風權限。":"正在聽，說完請稍等轉文字。");render();try{rec.start()}catch(e){voiceBusy=false;S.recordingBy="";setVoiceStatus("語音輸入尚未結束，請稍後再試。")}}
    function render(){saveRoom();document.title="魚骨洞天";let teacher=$("teacherPanel"),preview=$("preview"),prevBtn=$("prevBtn"),nextBtn=$("nextBtn");$("stepNum").textContent=S.step===0?"起始頁":S.step+"/19";$("bar").style.width=(S.step===0?0:S.step/19*100)+"%";if(prevBtn)prevBtn.style.display=S.step<=1?"none":"";if(nextBtn)nextBtn.style.display=S.step>=19?"none":"";if(S.step===0){if(teacher)teacher.style.display="none";if(preview)preview.style.display="none";$("main").innerHTML=screen();return}if(teacher)teacher.style.display="";if(preview)preview.style.display="";$("aiTitle").textContent=stepNames[S.step-1];$("aiText").innerHTML=(ai[S.step]||[]).map(x=>`<p>${x}</p>`).join("");$("ttsToggle").textContent=S.autoTts?"關閉自動朗讀":"開啟自動朗讀";$("agentHint").innerHTML=agentFeedback();$("gateMsg").innerHTML="";$("main").innerHTML=screen();$("preview").innerHTML=collabPanel()+previewFish("right")+previewFish("left");if(!S.ttsReady)setTtsStatus("可按重播提示聆聽老師提示。");else if(S.autoTts&&S.lastSpokenStep!==S.step){S.lastSpokenStep=S.step;speakTeacher(false)}else setTtsStatus("")}
    function panel(title,hint,body){return `<section class="panel">${title||hint?`<div class="panelHead">${title?`<h2>${title}</h2>`:""}${hint?`<p class="hint">${hint}</p>`:""}</div>`:""}${body}</section>`}
    function speakBox(kind,placeholder,buttonText){return `<div class="speakBox"><p class="small">將以「${esc(src(actor()).name)}」送出。</p><textarea id="newText" placeholder="${placeholder}"></textarea><div class="speakControls"><button class="secondary" onclick="startVoice('newText')">語音輸入</button><button onclick="addSpoken('${kind}')">${buttonText}</button></div><p class="voiceStatus" id="voiceStatus">${voiceHelp(true)}</p></div>`}
    function textAreaWithVoice(id,value,placeholder,onSaveLabel,onSaveCode){return `<div class="speakBox"><textarea id="${id}" placeholder="${placeholder}">${esc(value||"")}</textarea><div class="speakControls"><button class="secondary" onclick="startVoice('${id}')">語音輸入</button><button onclick="${onSaveCode}">${onSaveLabel}</button></div><p class="voiceStatus" id="voiceStatus">${voiceHelp(false)}</p></div>`}
    function screen(){if(S.step===0)return step0();return [step1,step2,step3,step4,step5,step6,step7,step8,step9,step10,step11,step12,step13,step14,step15,step16,step17,step18,step19][S.step-1]()}
    function startActivity(){markInteraction();S.lastSpokenStep=0;S.step=1;render()}
    /* Joining now has to succeed on the server before the student is in the
       room: an unknown code no longer quietly creates one. S.joined is set
       first because pollLoop stops while it is false, and rolled back if the
       server turns the code away. */
    async function joinActivity(){
      let name=$("joinName").value.trim(),typed=$("joinRoom").value.trim(),room=canonRoomCode(typed);
      if(!name||!typed){showGate("請先輸入姓名或暱稱與小組房間碼。");return}
      if(room.length<8){showGate("房間碼看起來不正確，請向老師再確認一次。");return}
      /* Switching rooms in place would carry this room's cards into the next
         one: S still holds them, and the first push after joining uploads the
         lot. A reload is the only way that cannot leak one class's writing into
         another class's room. */
      if(S.joined&&room!==S.roomCode){showGate("你目前已經在另一個房間中。請先重新整理頁面再加入新房間，否則這個房間的內容會被帶過去。");return}
      let wasJoined=S.joined,wasRoom=S.roomCode;
      S.nameDraft=name;S.roomCode=room;S.joined=true;S.active=S.selfId;
      /* The local cache is merged before the server's snapshot, not after:
         mergeRoom lets the incoming object win for the fields it does not
         version, so the other order would let a stale device overwrite what the
         group has since confirmed. */
      let outcome=await connectRoom(true,()=>{
        loadRoom(room);
        ensureSource(S.selfId,name,colors[joinedMembers().length%colors.length]);
        S.active=S.selfId;
      });
      if(outcome!=="ok"){
        S.joined=wasJoined;S.roomCode=wasRoom;
        // Leave no half-live session pointing at a room this device is not in.
        SYNC.session=0;SYNC.token="";
        // render() clears the gate message, so it has to come first.
        render();
        showGate(outcome==="not-found"?"找不到這個房間碼，請再確認一次。房間碼由老師建立後提供。":outcome==="rate-limited"?"嘗試次數過多，請稍候一分鐘再試。":outcome==="taken"?"這個身分已經在別的裝置或分頁使用中。請關閉那一邊，或改用另一個瀏覽器分頁重新加入。":"目前連不上小組伺服器，請確認網路後再試一次。");
        /* The attempt stopped the poll loop that was running for the room this
           device was already in. Without this the student keeps working and
           keeps seeing "connected", but never receives another teammate's
           update for the rest of the lesson. */
        if(wasJoined)setTimeout(()=>{if(S.joined&&!SYNC.session)connectRoom()},1200);
        return;
      }
      S.step=2;markInteraction();
      if(roomChannel)roomChannel.postMessage({room:S.roomCode,from:S.selfId,kind:"sync-request"});
      render();schedulePush();
    }
    /* Teachers create the room here and read the code off the projector. Codes
       are generated by the server precisely so that nobody can pick 六年三班. */
    async function createRoom(){
      markInteraction();
      if(location.protocol==="file:"){showGate("目前以 file:// 開啟，無法建立房間。請改用伺服器網址。");return}
      /* Same reason as joinActivity: S.roomCode is read at request time, so
         pointing it at a new room while a session is live would send this
         room's snapshot into the new one. */
      if(S.joined){showGate("你目前已經在房間中。請先重新整理頁面再建立新房間，否則目前房間的內容會被帶進新房間。");return}
      // render() rebuilds Step 1 from state, so keep whatever name was typed.
      let typedName=(($("joinName")||{}).value||"").trim();if(typedName)S.nameDraft=typedName;
      let btn=$("createRoomBtn");if(btn)btn.disabled=true;
      try{
        let res=await fetch(SYNC.base+"api/rooms",{method:"POST",cache:"no-store",headers:{"content-type":"application/json"},body:"{}"});
        if(res.status===429){showGate("建立房間的次數過多，請稍後再試。");return}
        if(!res.ok)throw new Error("HTTP "+res.status);
        let data=await res.json();
        S.roomCode=canonRoomCode(data.room||"");S.createdRoom=data.displayCode||showRoomCode(S.roomCode);
        render();
      }catch(e){showGate("目前無法建立房間，請確認網路後再試一次。")}
      finally{if(btn)btn.disabled=false}
    }
