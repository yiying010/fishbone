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
    function applyRemote(data){if(!data)return;syncMuted=true;try{mergeRoom(data);autoAdvanceFromShared();render()}finally{syncMuted=false}}
    /* The room is gone from the server: deleted by a teacher, or purged by the
       retention sweep. Stop the session rather than re-joining, because a
       re-join would recreate the room and the next push would upload the whole
       snapshot again, quietly undoing a deletion that was meant to be final.
       Rejoining from Step 1 stays available as a deliberate choice. */
    function roomGone(){
      clearRoomToken(S.roomCode);SYNC.session=0;SYNC.token="";
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
        /* 409 means this member id belongs to a session this tab cannot prove it
           owns, which for a student is another device already in the room under
           the same identity, not a bad room code. */
        if(res.status===409){SYNC.session=0;setSyncStatus(false,"這個身分已經在別的裝置或分頁使用中。");return "taken"}
        if(!res.ok)throw new Error("HTTP "+res.status);
        let data=await res.json();
        if(SYNC.session!==session)return "error";
        SYNC.token=data.token||"";saveRoomToken(S.roomCode,SYNC.token);
        // Anything the caller wants merged before the server's snapshot lands.
        if(beforeApply)beforeApply();
        SYNC.revision=data.revision||0;SYNC.serverJson=canonJson(data.snapshot||{});SYNC.failures=0;
        applyRemote(data.snapshot);
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
        SYNC.token=data.token||"";saveRoomToken(S.roomCode,SYNC.token);SYNC.revision=data.revision||0;SYNC.serverJson=canonJson(data.snapshot||{});
        applyRemote(data.snapshot);
        return true;
      }catch(e){return false}
    }
    /* Long poll: the server holds the request until the room changes, so a card
       submitted on one phone shows up on the others within a fraction of a second
       without a socket that an intermediate proxy might refuse to upgrade. */
