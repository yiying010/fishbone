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
    async function pushRoom(){
      if(!S.joined||SYNC.offline||!SYNC.session||SYNC.pushing){if(SYNC.pushing)SYNC.pushAgain=true;return}
      SYNC.pushing=true;let session=SYNC.session;
      try{
        for(let attempt=0;attempt<6;attempt++){
          if(SYNC.session!==session)return;
          let snap=sharedSnapshot(),json=canonJson(snap);
          if(json===SYNC.serverJson)return;
          let res=await fetch(roomApi("state"),{method:"POST",cache:"no-store",headers:syncHeaders(true),body:JSON.stringify({step:S.step,baseRevision:SYNC.revision,snapshot:snap})});
          if(SYNC.session!==session)return;
          if(res.status===404){
            if(await recoverSession(session))continue;
            if(SYNC.session!==session)return;
            throw new Error("HTTP 404");
          }
          if(res.status===429){let wait=retryAfterMs(res);setSyncStatus(false,"伺服器暫時限制了請求，"+Math.round(wait/1000)+" 秒後自動再試。");setTimeout(schedulePush,wait);return}
          if(res.status===409){let other=await res.json();SYNC.revision=other.revision||0;SYNC.serverJson=canonJson(other.snapshot||{});applyRemote(other.snapshot);continue}
          if(!res.ok)throw new Error("HTTP "+res.status);
          let data=await res.json();
          /* Only move forward: a poll running in parallel may already have seen
             a later revision, and rewinding would strand serverJson on an older
             snapshot. */
          if((data.revision||0)>SYNC.revision){SYNC.revision=data.revision||0;SYNC.serverJson=json}
          SYNC.failures=0;
          if(!SYNC.connected)setSyncStatus(true,syncOnlineText());
          return;
        }
        setTimeout(schedulePush,1200);
      }catch(e){
        if(SYNC.session!==session)return;
        SYNC.failures++;
        setSyncStatus(false,"與小組伺服器的連線中斷，正在重試；你的操作會先留在這台裝置。");
        setTimeout(schedulePush,Math.min(15000,600*Math.pow(2,Math.min(5,SYNC.failures))));
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
