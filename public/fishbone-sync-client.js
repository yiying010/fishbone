    const SYNC={base:"",offline:false,session:0,revision:0,serverJson:"",connected:false,status:"尚未加入小組。",pushTimer:null,pushing:false,pushAgain:false,failures:0,token:""};
    /* The app is mounted at an unknown public subpath and is never told what it
       is, so the API base is derived from the address bar: a trailing slash means
       a directory, a page filename means take its directory, anything else is the
       mount point itself served without its trailing slash.

       The filename test is a page extension rather than "contains a dot", so a
       prefix such as /fishbone.v2 is still recognised as a mount point. The only
       page this server hands out is fishbone.html. */
    SYNC.base=(function(){let p=location.pathname||"/";if(p.endsWith("/"))return p;let cut=p.lastIndexOf("/"),last=p.slice(cut+1);return /\.x?html?$/i.test(last)?p.slice(0,cut+1):p+"/"})();
    function roomApi(suffix){return SYNC.base+"api/rooms/"+encodeURIComponent(String(S.roomCode||"").trim())+"/"+suffix}
    /* Joining returns a session token; reading or writing a room needs it. The
       room code alone is no longer enough, so a request without a token gets the
       same answer for a room that exists and one that never did. */
    /* Mirrors the server's canonical form, so the request path and the local
       cache key do not depend on how the code was typed. The o/i/l mappings are
       Crockford Base32's: those letters are not in the alphabet, so a student
       who reads 0 as O still lands in the right room. */
    const CODE_ALPHABET="0123456789abcdefghjkmnpqrstvwxyz";
    function canonRoomCode(value){let out="";for(let ch of String(value||"").toLowerCase()){if(ch==="o")ch="0";else if(ch==="i"||ch==="l")ch="1";if(CODE_ALPHABET.includes(ch))out+=ch}return out}
    function showRoomCode(value){let code=String(value||""),groups=[];for(let at=0;at<code.length;at+=5)groups.push(code.slice(at,at+5));return groups.join("-")}
    /* The member id travels in the shared snapshot, so it names a collaborator
       but proves nothing. The session token is what proves ownership of that id,
       and it is kept in sessionStorage next to the tab-scoped member id itself:
       a reload can then re-join as the same person, while a second tab gets a
       new id rather than a claim on this one. It never enters the snapshot or
       the localStorage cache, both of which are shared with the whole group. */
    function roomTokenKey(code){return "fishboneRoomToken:"+canonRoomCode(code)}
    function loadRoomToken(code){try{return sessionStorage.getItem(roomTokenKey(code))||""}catch(e){return ""}}
    function saveRoomToken(code,token){try{if(token)sessionStorage.setItem(roomTokenKey(code),token)}catch(e){}}
    function clearRoomToken(code){try{sessionStorage.removeItem(roomTokenKey(code))}catch(e){}}
    const ROOM_CONTEXT_KEY="fishboneRoomContext";
    function saveRoomContext(){try{sessionStorage.setItem(ROOM_CONTEXT_KEY,JSON.stringify({roomCode:canonRoomCode(S.roomCode),name:String(S.nameDraft||src(S.selfId).name||"")}))}catch(e){}}
    function loadRoomContext(){try{let data=JSON.parse(sessionStorage.getItem(ROOM_CONTEXT_KEY)||"null"),room=canonRoomCode((data||{}).roomCode),name=String((data||{}).name||"").trim();return room&&name?{roomCode:room,name}:null}catch(e){return null}}
    function clearRoomContext(){try{sessionStorage.removeItem(ROOM_CONTEXT_KEY)}catch(e){}}
    function syncHeaders(sendsJson){let h={accept:"application/json"};if(sendsJson)h["content-type"]="application/json";if(SYNC.token)h["authorization"]="Bearer "+SYNC.token;return h}
    /* Postgres stores the snapshot as jsonb, which does not preserve key order, so
       "did anything actually change" has to be asked of a canonical form.

       Lists merged by id are also compared as sets. Each device puts its own
       member first in `sources`, so an order-sensitive comparison would make
       every device see every other device's snapshot as new, forever, and the
       two would push at each other for the whole lesson. Only this comparison
       ignores order; what is actually sent keeps the local order untouched. */
    function canonJson(v){if(v===undefined)return "null";if(v===null||typeof v!=="object")return JSON.stringify(v);if(Array.isArray(v)){let parts=v.map(canonJson);if(v.every(x=>x&&typeof x==="object"&&!Array.isArray(x)&&typeof x.id==="string"))parts.sort();return "["+parts.join(",")+"]"}return "{"+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+":"+canonJson(v[k])).join(",")+"}"}
    function syncSleep(ms){return new Promise(r=>setTimeout(r,ms))}
    function retryAfterMs(res){let header=Number(res.headers.get("retry-after"));return Math.min(60000,Math.max(1000,(Number.isFinite(header)&&header>0?header:5)*1000))}
    function syncOnlineText(){return "已連上小組伺服器，其他裝置的更新會自動出現。"}
    function setSyncStatus(connected,msg){SYNC.connected=connected;SYNC.status=msg;let el=$("syncStatus");if(el){el.textContent=msg;el.className=connected?"syncNote ok":"syncNote"}}
    function applyRoomPolicy(data){
      if(!data)return false;let changed=false;
      if(Object.prototype.hasOwnProperty.call(data,"expectedMemberCount")){
        let count=data.expectedMemberCount===null?null:Number(data.expectedMemberCount);
        if((count===null||Number.isInteger(count))&&S.expectedMemberCount!==count){S.expectedMemberCount=count;changed=true}
      }
      if(Object.prototype.hasOwnProperty.call(data,"membersLocked")){
        let locked=!!data.membersLocked;if(S.membersLocked!==locked){S.membersLocked=locked;changed=true}
      }
      if(Array.isArray(data.members))data.members.forEach((member,index)=>{
        if(!member||!member.memberId)return;
        let source=S.sources.find(s=>s.id===member.memberId),name=String(member.displayName||member.name||"");
        if(source){if(name&&source.name!==name){source.name=name;changed=true}if(!source.joined){source.joined=true;changed=true}}
        else{S.sources.splice(Math.max(0,S.sources.length-2),0,{id:member.memberId,name:name||"未命名成員",color:colors[(joinedMembers().length+index)%colors.length],system:false,joined:true});changed=true}
      });
      return changed;
    }
    /* Remote data may merge immediately, but repainting while an input, textarea
       or native select is active would destroy its value, focus, caret or open
       picker. Defer only the paint; the next local command still reads the live
       control before its own render. */
    let remotePaintPending=false,imeComposing=false,remoteDraftSnapshot=null;
    function activeDraftControl(){let el=document.activeElement;return el&&["INPUT","TEXTAREA","SELECT"].includes(el.tagName)&&el.id?el:null}
    function captureRemoteDraft(){let el=activeDraftControl();if(!el)return null;let snap={id:el.id,step:S.step,value:el.type==="checkbox"?!!el.checked:el.value,start:null,end:null};if(typeof el.selectionStart==="number"){snap.start=el.selectionStart;snap.end=el.selectionEnd}return snap}
    function restoreRemoteDraft(snap){if(!snap||snap.step!==S.step)return;let el=$(snap.id);if(!el)return;if(el.type==="checkbox")el.checked=!!snap.value;else el.value=snap.value;if(typeof el.setSelectionRange==="function"&&snap.start!==null){let len=String(el.value||"").length;el.setSelectionRange(Math.min(snap.start,len),Math.min(snap.end,len))}}
    function flushRemotePaint(){if(!remotePaintPending||imeComposing||activeDraftControl())return;let snap=remoteDraftSnapshot;remotePaintPending=false;remoteDraftSnapshot=null;let muted=syncMuted;syncMuted=true;try{render();restoreRemoteDraft(snap)}finally{syncMuted=muted}}
    document.addEventListener("compositionstart",e=>{if(e.target&&["INPUT","TEXTAREA"].includes(e.target.tagName)){imeComposing=true;remoteDraftSnapshot=captureRemoteDraft()||remoteDraftSnapshot}},true);
    document.addEventListener("compositionend",()=>{imeComposing=false;setTimeout(flushRemotePaint,0)},true);
    document.addEventListener("focusout",()=>setTimeout(flushRemotePaint,0),true);
    /* A focused field may render its card during blur/change. Without preserving
       the intended button activation, that render removes the original button
       before its click fires, so the user has to click a second time. */
    let pendingDraftButtonActivation=null;
    function isDraftControl(el){return !!(el&&["INPUT","TEXTAREA","SELECT"].includes(el.tagName)&&el.id)}
    document.addEventListener("pointerdown",e=>{
      let button=e.target&&e.target.closest?e.target.closest("button"):null,control=document.activeElement;
      if(!button||button.disabled||!isDraftControl(control)||control===button)return;
      if(remotePaintPending)remoteDraftSnapshot=captureRemoteDraft()||remoteDraftSnapshot;
      pendingDraftButtonActivation={button,control,step:Number(S.step),id:button.id||"",action:button.getAttribute("onclick")||"",text:button.textContent||""};
      e.preventDefault();
    },true);
    document.addEventListener("click",e=>{
      let pending=pendingDraftButtonActivation,button=e.target&&e.target.closest?e.target.closest("button"):null;
      if(!pending||button!==pending.button)return;
      pendingDraftButtonActivation=null;e.preventDefault();e.stopImmediatePropagation();
      if(pending.control&&typeof pending.control.blur==="function")pending.control.blur();
      setTimeout(()=>{
        if(Number(S.step)!==pending.step||imeComposing)return;
        let target=pending.button.isConnected?pending.button:[...document.querySelectorAll("button")].find(b=>!b.disabled&&(pending.id&&b.id===pending.id||pending.action&&b.getAttribute("onclick")===pending.action&&(b.textContent||"")===pending.text));
        if(target&&!target.disabled)target.click();
      },0);
    },true);
    document.addEventListener("pointercancel",()=>{pendingDraftButtonActivation=null},true);
    function applyRemote(data,currentStep){
      if(!data)return;syncMuted=true;
      try{
        let draft=captureRemoteDraft();if(draft)remoteDraftSnapshot=draft;
        mergeRoom(data);
        let step=Number(currentStep);if(Number.isFinite(step)&&step>=0&&!S.reviewingStep)S.step=Math.max(S.step,Math.min(19,Math.trunc(step)));
        autoAdvanceFromShared();
        if(imeComposing||activeDraftControl()){remotePaintPending=true;return}
        render();remotePaintPending=false;remoteDraftSnapshot=null;
      }finally{syncMuted=false}
    }
    /* The room is gone from the server: deleted by a teacher, or purged by the
       retention sweep. Stop the session rather than re-joining, because a
       re-join would recreate the room and the next push would upload the whole
       snapshot again, quietly undoing a deletion that was meant to be final.
       Rejoining from Step 1 stays available as a deliberate choice. */
    function roomGone(){
      clearRoomToken(S.roomCode);clearRoomContext();SYNC.session=0;SYNC.token="";
      if(SYNC.pushTimer){clearTimeout(SYNC.pushTimer);SYNC.pushTimer=null}
      SYNC.pushAgain=false;
      setSyncStatus(false,"這個房間在伺服器上已不存在，可能已被移除或超過保存期限。目前內容仍留在這台裝置，若要繼續請回到 Step 1 重新加入。");
      render();
    }
    function schedulePush(){if(!S.joined||SYNC.offline||!SYNC.session)return;if(SYNC.pushTimer)return;SYNC.pushTimer=setTimeout(()=>{SYNC.pushTimer=null;pushRoom()},250)}
    /* Returns "ok", "not-found", "rate-limited" or "error". The caller decides
       what to tell the student, because a failure while joining and a failure
       while already in a room mean different things to them. */
    async function connectRoom(initial,beforeApply){
      if(location.protocol==="file:"){SYNC.offline=true;SYNC.session=0;setSyncStatus(false,"目前以 file:// 開啟，只有這台裝置看得到內容。請改用伺服器網址進行小組活動。");render();return "error"}
      /* Carry the stored token into the join request: it is the only way the
         server can tell this reload from someone else claiming the id. */
      SYNC.offline=false;let session=++SYNC.session;SYNC.revision=0;SYNC.serverJson="";SYNC.token=loadRoomToken(S.roomCode);
      setSyncStatus(false,"正在連線到小組伺服器…");
      try{
        let res=await fetch(roomApi("join"),{method:"POST",cache:"no-store",headers:syncHeaders(true),body:JSON.stringify({memberId:S.selfId,name:S.nameDraft,step:S.step})});
        if(SYNC.session!==session)return "error";
        /* 404 and 400 are both "this code will never work": the server answers a
           missing room and a mistyped one without saying which. */
        if(res.status===404||res.status===400){SYNC.session=0;setSyncStatus(false,"找不到這個房間碼。");return "not-found"}
        if(res.status===429){SYNC.session=0;setSyncStatus(false,"嘗試次數過多，請稍候再試。");return "rate-limited"}
        if(res.status===409){let error=await res.json().catch(()=>({}));SYNC.session=0;if(error.error==="room_full_or_locked"){setSyncStatus(false,"這個小組目前不接受新成員。");return "room-full"}setSyncStatus(false,"這個身分已經在別的裝置或分頁使用中。");return "taken"}
        if(!res.ok)throw new Error("HTTP "+res.status);
        let data=await res.json();
        if(SYNC.session!==session)return "error";
        SYNC.token=data.token||"";saveRoomToken(S.roomCode,SYNC.token);saveRoomContext();
        // Anything the caller wants merged before the server's snapshot lands.
        if(beforeApply)beforeApply();
        applyRoomPolicy(data);SYNC.revision=data.revision||0;SYNC.serverJson=canonJson(data.snapshot||{});SYNC.failures=0;
        applyRemote(data.snapshot,data.currentStep);
        setSyncStatus(true,syncOnlineText());
        pollLoop(session);schedulePush();
        return "ok";
      }catch(e){
        if(SYNC.session!==session)return "error";
        SYNC.failures++;
        setSyncStatus(false,"還沒連上小組伺服器，內容先留在這台裝置，正在重試。");
        render();
        if(!initial)setTimeout(()=>{if(SYNC.session===session&&S.joined)connectRoom()},Math.min(15000,800*Math.pow(2,Math.min(5,SYNC.failures))));
        return "error";
      }
    }
    async function restoreRoomSession(){
      let saved=loadRoomContext();if(!saved||!loadRoomToken(saved.roomCode))return false;
      S.step=1;S.roomCode=saved.roomCode;S.createdRoom=showRoomCode(saved.roomCode);S.nameDraft=saved.name;S.joined=true;S.active=S.selfId;render();
      let outcome=await connectRoom(true,()=>{ensureSource(S.selfId,saved.name,colors[joinedMembers().length%colors.length]);S.active=S.selfId});
      if(outcome==="ok"){S.step=Math.max(2,S.step);S.reviewingStep=0;render();schedulePush();return true}
      if(outcome!=="error"){clearRoomToken(saved.roomCode);clearRoomContext();S.joined=false;S.roomCode="";S.createdRoom="";S.step=0;render()}
      return false;
    }
    /* A 404 on a running session means either the room is gone or this token is
       no longer valid; the server answers both identically on purpose. Asking to
       join again separates them here, where it is safe to know. */
    async function recoverSession(session){
      if(SYNC.session!==session)return false;
      try{
        let res=await fetch(roomApi("join"),{method:"POST",cache:"no-store",headers:syncHeaders(true),body:JSON.stringify({memberId:S.selfId,name:S.nameDraft,step:S.step})});
        if(SYNC.session!==session)return false;
        if(res.status===404||res.status===400){roomGone();return false}
        if(!res.ok)return false;
        let data=await res.json();
        if(SYNC.session!==session)return false;
        SYNC.token=data.token||"";saveRoomToken(S.roomCode,SYNC.token);applyRoomPolicy(data);SYNC.revision=data.revision||0;SYNC.serverJson=canonJson(data.snapshot||{});
        applyRemote(data.snapshot,data.currentStep);
        return true;
      }catch(e){return false}
    }
    /* Long poll: the server holds the request until the room changes, so a card
       submitted on one phone shows up on the others within a fraction of a second
       without a socket that an intermediate proxy might refuse to upgrade. */
