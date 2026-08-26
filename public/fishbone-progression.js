    function canAdvance(step){
      if(step===1)return {ok:S.joined,msg:"請先輸入姓名或暱稱與小組房間碼，並加入活動。"};
      if(step===2)return {ok:S.distresses.some(d=>isOwnCard(d)),msg:"請先提出至少一個自己的生活困擾。"};
      if(step===3){let count=groupDistressCount(),multi=count>1,info=groupingVoteInfo();if(!count)return {ok:false,msg:"請先回到上一步提出生活困擾。"};if(!multi&&joinedMembers().length>1)return {ok:false,msg:"目前小組困擾池尚未同步到多張困擾，請等待或刷新小組困擾池後再判斷。"};if(!multi)return {ok:true,msg:""};if(S.groupingConfirmed)return {ok:true,msg:""};if(!S.groupProposals.length)return {ok:false,msg:"請先提交至少一版分群結果。"};if(!info.allVoted||activeVoteCount(S.groupingVotes||{})<=1&&joinedMembers().length>1)return {ok:false,msg:"請等待所有組員完成投票。"};if(info.tie||info.own)return {ok:false,msg:groupingTieAdvice(info)};return {ok:false,msg:"請先投票選出一版正式分群。"}};
      if(step===4){let items=problemCandidates(),info=topInfo(items,S.problemVotes,"problem");return {ok:!!(S.selected&&S.confirmBy.selected),msg:S.selected?"請先完成選題投票。":(info.tie||info.own?problemChoiceAdvice(items,info):"請先投票選出目前想分析的問題。")}};
      if(step===5)return {ok:S.problemOk&&S.problem.trim(),msg:"請先完成主要問題草稿表態。"};
      if(step===6)return {ok:true,msg:""};
      if(step===7)return {ok:S.causes.some(c=>isOwnCard(c)),msg:"請先提出至少一個自己的可能原因。"};
      if(step===8){let st=causeHandlingDone();return {ok:st.ok,msg:st.done<st.total?"請先確認或處理每一張原因卡，再進入原因分類。":st.hasCause?"":"請至少保留一張已確認為原因的原因卡，再進入原因分類。"}};
      if(step===9){let causes=usableCauses(),info=causeClassVoteInfo();if(!causes.length)return {ok:false,msg:"請先在 Step 8 確認至少一張原因卡。"};if(S.causeClassConfirmed)return {ok:true,msg:""};if(!S.causeClassProposals.length)return {ok:false,msg:"請先提交至少一版原因分類。"};if(!info.allVoted||activeVoteCount(S.causeClassVotes||{})<=1&&joinedMembers().length>1)return {ok:false,msg:"請等待所有組員完成投票。"};if(info.tie||info.own)return {ok:false,msg:causeClassTieAdvice(info)};return {ok:false,msg:"請先投票選出一版正式原因分類。"}};
      if(step===10){let r=rightVoteStatus();return {ok:S.rightOk||r.allVoted&&r.go>r.revise,msg:!r.allVoted?"請先讓所有成員完成向右魚骨圖表態。":r.revise>r.go?"需要回到原因分類調整，請重新整理原因分類後再確認。":r.go===r.revise?"目前平票，請檢查大要因名稱、原因歸類與是否符合主要問題，再重新表態。":"請先在本頁確認向右魚骨圖可繼續。"}};
      if(step===11)return {ok:goalClear(S.goal)&&!!S.confirmBy.goal,msg:S.goal.trim()?"請先完成決策目標草稿表態。":"請先提出決策目標想法，並完成草稿表態。"};
      if(step===12)return {ok:true,msg:""};
      if(step===13)return {ok:S.methods.some(m=>isOwnCard(m)),msg:"請先提出至少一個自己的可能方法。"};
      if(step===14){let st=methodCheckDone();return {ok:st.ok,msg:st.total?"請先讓每張方法卡完成 AI 對應檢查，或由原提出者選擇暫不處理／暫不保留。":"請先回到 Step 13 提出至少一個方法。"}};
      if(step===15){let methods=methodClassCandidates(),info=methodClassVoteInfo();if(S.methodClassConfirmed&&formalMethods().length)return {ok:true,msg:""};if(!methods.length)return {ok:false,msg:"請先在 Step 14 完成至少一張方法檢查。"};if(!S.methodClassProposals.length)return {ok:false,msg:"請先提交至少一版方法分類。"};if(!info.allVoted||activeVoteCount(S.methodClassVotes||{})<=1&&joinedMembers().length>1)return {ok:false,msg:"請等待所有組員完成投票。"};if(info.tie||info.own)return {ok:false,msg:methodClassTieAdvice(info)};return {ok:false,msg:"請先投票選出一版正式方法分類。"}};
      if(step===16){let r=outcomeVoteStatus(),rv=outcomeRevisionStatus();return {ok:S.outcomeOk,msg:S.outcomeNeedsRevision?(!rv.allVoted?"請先讓所有成員選擇最需要先修改的地方。":rv.tie?outcomeRevisionTieAdvice():"請依全組選出的修改方向返回調整。"):!r.allVoted?"請先讓所有成員完成雙向魚骨圖成果表態。":r.revise>r.go?"請先進入第二階段，選出最需要先修改的地方。":r.go===r.revise?"目前平票，請重新檢查成果內容後再表態。":"請先在本頁確認成果內容可繼續。"}};
      if(step===17){let s=solutionVoteStatus();return {ok:s.allVoted&&!!S.feasible&&!!S.unique,msg:!s.allVoted?"請先讓所有成員完成方案選擇。":"請先完成方案選擇並填寫理由。"}};
      if(step===18){let st=reflectionStatus();return {ok:S.reflectionSummaryOk,msg:st.done<st.total?"請等待每位成員完成個人反思。":"請先完成反思並產生小組反思摘要。"}};
      return {ok:false,msg:"已到最後一步。"};
    }
