    async function pollLoop(session){
      while(SYNC.session===session&&S.joined&&!SYNC.offline){
        try{
          let began=Date.now();
          let res=await fetch(roomApi("state")+"?since="+SYNC.revision+"&wait=1&step="+S.step,{cache:"no-store",headers:syncHeaders(false)});
          if(SYNC.session!==session)return;
          if(res.status===404){
            if(await recoverSession(session))continue;
            if(SYNC.session!==session)return;
            throw new Error("HTTP 404");
          }
          /* Honour Retry-After rather than falling through to the generic
             backoff, whose status message would overwrite this one before the
             browser ever painted it. */
          if(res.status===429){let wait=retryAfterMs(res);setSyncStatus(false,"伺服器暫時限制了請求，"+Math.round(wait/1000)+" 秒後自動再試。");await syncSleep(wait);continue}
          if(!res.ok)throw new Error("HTTP "+res.status);
          let data=await res.json();
          if(SYNC.session!==session)return;
          SYNC.failures=0;
          if(!SYNC.connected)setSyncStatus(true,syncOnlineText());
          if(data.unchanged){
            /* The server may be configured not to hold the request at all
               (SYNC_LONG_POLL_MS=0), in which case this answers immediately and
               an unpaced loop would hammer a full snapshot read per iteration. */
            if(Date.now()-began<1000)await syncSleep(2000);
            continue;
          }
          /* A push accepted while this request was held can already have moved
             the revision past what this response carries. Applying the older
             snapshot would only cause a needless conflict on the next push. */
          if((data.revision||0)<SYNC.revision)continue;
          SYNC.revision=data.revision||0;
          SYNC.serverJson=canonJson(data.snapshot||{});
          applyRemote(data.snapshot);
          schedulePush();
        }catch(e){
          if(SYNC.session!==session)return;
          SYNC.failures++;
          setSyncStatus(false,"與小組伺服器的連線中斷，正在重試；你的操作會先留在這台裝置。");
          await syncSleep(Math.min(15000,600*Math.pow(2,Math.min(5,SYNC.failures))));
        }
      }
    }
    /* Resolves true once the server holds this device's current snapshot. The
       debounced callers ignore that answer; publishForAi is the one that needs
       it, because an AI review reads the server's copy rather than this one. */
    async function pushRoom(){
      if(!S.joined||SYNC.offline||!SYNC.session||SYNC.pushing){if(SYNC.pushing)SYNC.pushAgain=true;return false}
      SYNC.pushing=true;let session=SYNC.session;
      try{
        for(let attempt=0;attempt<6;attempt++){
          if(SYNC.session!==session)return false;
          let snap=sharedSnapshot(),json=canonJson(snap);
          if(json===SYNC.serverJson)return true;
          let res=await fetch(roomApi("state"),{method:"POST",cache:"no-store",headers:syncHeaders(true),body:JSON.stringify({step:S.step,baseRevision:SYNC.revision,snapshot:snap})});
          if(SYNC.session!==session)return false;
          if(res.status===404){
            if(await recoverSession(session))continue;
            if(SYNC.session!==session)return false;
            throw new Error("HTTP 404");
          }
          if(res.status===429){let wait=retryAfterMs(res);setSyncStatus(false,"伺服器暫時限制了請求，"+Math.round(wait/1000)+" 秒後自動再試。");setTimeout(schedulePush,wait);return false}
          if(res.status===409){let other=await res.json();SYNC.revision=other.revision||0;SYNC.serverJson=canonJson(other.snapshot||{});applyRemote(other.snapshot);continue}
          if(!res.ok)throw new Error("HTTP "+res.status);
          let data=await res.json();
          /* Only move forward: a poll running in parallel may already have seen
             a later revision, and rewinding would strand serverJson on an older
             snapshot. */
          if((data.revision||0)>SYNC.revision){SYNC.revision=data.revision||0;SYNC.serverJson=json}
          SYNC.failures=0;
          if(!SYNC.connected)setSyncStatus(true,syncOnlineText());
          return true;
        }
        setTimeout(schedulePush,1200);
        return false;
      }catch(e){
        if(SYNC.session!==session)return false;
        SYNC.failures++;
        setSyncStatus(false,"與小組伺服器的連線中斷，正在重試；你的操作會先留在這台裝置。");
        setTimeout(schedulePush,Math.min(15000,600*Math.pow(2,Math.min(5,SYNC.failures))));
        return false;
      }finally{
        SYNC.pushing=false;
        if(SYNC.pushAgain){SYNC.pushAgain=false;schedulePush()}
      }
    }
    async function refreshFromServer(){
      if(!S.joined||SYNC.offline||!SYNC.session)return;
      try{
        let res=await fetch(roomApi("state"),{cache:"no-store",headers:syncHeaders(false)});
        if(!res.ok)return;
        let data=await res.json();
        SYNC.revision=data.revision||0;SYNC.serverJson=canonJson(data.snapshot||{});
        applyRemote(data.snapshot);schedulePush();
      }catch(e){}
    }
    /* An AI review is answered from the server's authoritative snapshot, so
       whatever was just typed has to be up there first. Waiting for the 250ms
       debounce is not enough: it may still be pending, or a push already in
       flight may be carrying older content. */
    async function publishForAi(session){
      if(SYNC.pushTimer){clearTimeout(SYNC.pushTimer);SYNC.pushTimer=null}
      for(let attempt=0;attempt<6;attempt++){
        if(SYNC.session!==session)return false;
        if(canonJson(sharedSnapshot())===SYNC.serverJson)return true;
        if(SYNC.pushing){await syncSleep(200);continue}
        if(!await pushRoom())return false;
      }
      return false;
    }
    /* Returns "ok", "stale" or "unavailable". The three need different words in
       front of a student: their own content moved on, the group's content moved
       on, or this room has no AI to ask. */
    async function requestAiReview(task,itemId){
      if(!S.joined||SYNC.offline||!SYNC.session)return {status:"unavailable"};
      let session=SYNC.session;
      if(!await publishForAi(session))return {status:"unavailable"};
      let revision=SYNC.revision,res;
      try{res=await fetch(roomApi("ai/review"),{method:"POST",cache:"no-store",headers:syncHeaders(true),body:JSON.stringify({task,itemId,baseRevision:revision})})}catch(e){return {status:"unavailable"}}
      if(SYNC.session!==session)return {status:"stale"};
      if(res.status===409){await refreshFromServer();return {status:"stale"}}
      if(!res.ok)return {status:"unavailable"};
      let data=await res.json().catch(()=>({}));
      /* The server rejects a stale request itself; this guards the case where a
         reply is somehow answering a different revision than the one asked for. */
      return data.baseRevision===revision&&data.result?{status:"ok",result:data.result}:{status:"stale"};
    }
    function saveArtifact(format,filename,content){
      if(!S.joined||SYNC.offline||!SYNC.session)return;
      try{fetch(roomApi("artifacts"),{method:"POST",keepalive:true,headers:syncHeaders(true),body:JSON.stringify({format,filename,content})}).catch(()=>{})}catch(e){}
    }
    /* Last-gasp flush: the 250ms debounce above can still be in flight when the
       page is closed, and keepalive lets the browser finish the request anyway. */
    window.addEventListener("pagehide",()=>{
      if(!S.joined||SYNC.offline||!SYNC.session)return;
      let snap=sharedSnapshot();if(canonJson(snap)===SYNC.serverJson)return;
      try{fetch(roomApi("state"),{method:"POST",keepalive:true,headers:syncHeaders(true),body:JSON.stringify({step:S.step,baseRevision:SYNC.revision,snapshot:snap})}).catch(()=>{})}catch(e){}
    });
