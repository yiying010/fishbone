import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../public/fishbone-advanced-flow.js", import.meta.url), "utf8");

function runtime(){
  const sandbox={
    console,setTimeout,clearTimeout,Date,JSON,Math,Set,Object,Array,String,Number,RegExp,
    S:{step:1,selfId:"m1",joined:true,roomCode:"room12345",confirmBy:{},sources:[
      {id:"m1",name:"甲",color:"#111",system:false,joined:true},
      {id:"m2",name:"乙",color:"#222",system:false,joined:true},
    ],rightVotes:{m1:{value:"go",round:1},m2:{value:"revise",round:1}},rightRound:1,rightOk:false,rightNeedsRevision:false,
      groupingVotes:{},problemVotes:{},problemDraftVotes:{},causeClassVotes:{},goalDraftVotes:{},methodClassVotes:{},outcomeVotes:{},outcomeRevisionVotes:{},
      causes:[],stash:[],cats:[],goalIdeas:[],methods:[],methodClassProposals:[],problemDetails:[]},
    document:{activeElement:null,querySelectorAll:()=>[],addEventListener:()=>{},createElement:()=>({className:"",textContent:""})},
    window:null,
    sharedSnapshot:()=>({}),mergeRoom:()=>{},mergeById:(a,b)=>{const out=[...(a||[])];for(const item of b||[]){const at=out.findIndex(x=>x.id===item.id);if(at<0)out.push(item);else out[at]={...out[at],...item}}return out},
    joinedMembers(){return sandbox.S.sources.filter(x=>!x.system&&x.joined)},
    step1:()=>"",joinActivity:async()=>{},canAdvance:()=>({ok:true,msg:""}),
    render:()=>{},autoAdvanceFromShared:()=>{},previousStep:()=>{},reviewDistress:()=>({ok:true,msg:""}),
    schedulePush:()=>{sandbox.pushes=(sandbox.pushes||0)+1},showGate:msg=>{sandbox.gate=msg},showOk:msg=>{sandbox.ok=msg},
    $:()=>null,esc:value=>String(value??""),panel:(_a,_b,c)=>c,src:id=>sandbox.S.sources.find(x=>x.id===id)||{name:id},
    actor:()=>sandbox.S.selfId,hasSpeaker:()=>true,remindSpeaker:()=>{},uid:prefix=>`${prefix}-1`,
    resetProblemChoiceState:()=>{},resetProblemDraftState:()=>{},
    groupingVoteInfo:()=>({allVoted:false,tie:false,own:false}),groupingTieAdvice:()=>"比較分群",
    problemCandidates:()=>[],topInfo:()=>({allVoted:false,tie:false,own:false}),problemChoiceAdvice:()=>"比較問題",
    problemDraftStatus:()=>({allVoted:false,total:0,revise:0,agree:0}),causeClassVoteInfo:()=>({allVoted:false,tie:false,own:false}),causeClassTieAdvice:()=>"比較原因分類",
    rightVoteStatus:()=>sandbox.rightStatus||({allVoted:false,total:0,go:0,revise:0}),goalDraftStatus:()=>({allVoted:false,total:0,revise:0,agree:0}),
    methodClassVoteInfo:()=>({allVoted:false,tie:false,own:false}),methodClassTieAdvice:()=>"比較方法分類",
    outcomeRevisionStatus:()=>({allVoted:false,tie:false}),outcomeRevisionTieAdvice:()=>"比較返回位置",outcomeVoteStatus:()=>({allVoted:false,total:0,go:0,revise:0}),
    validOutcomeRevisionStep:step=>[5,9,11,14,15].includes(Number(step)),
    applyOutcomeRevisionTarget:()=>false,
    newVoteRound(kind){const key=`${kind}Round`;sandbox.S[key]=(sandbox.S[key]||1)+1;const map={grouping:"groupingVotes",problem:"problemVotes",problemDraft:"problemDraftVotes",causeClass:"causeClassVotes",right:"rightVotes",goalDraft:"goalDraftVotes",methodClass:"methodClassVotes",outcome:"outcomeVotes",outcomeRevision:"outcomeRevisionVotes"};sandbox.S[map[kind]]={}},
  };
  for(const name of ["voteGrouping","voteProblem","voteProblemDraft","voteCauseClass","voteRight","voteGoalDraft","voteMethodClass","voteOutcome","voteOutcomeRevision"])sandbox[name]=()=>{};
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox,{filename:"fishbone-advanced-flow.js"});
  return sandbox;
}

test("locking captures the current roster and starts step 2",()=>{
  const app=runtime();
  app.requestMemberLock();
  assert.equal(app.S.membersLocked,true);
  assert.deepEqual([...app.S.lockedMemberIds],["m1","m2"]);
  assert.equal(app.S.step,2);
  assert.ok(app.pushes>0);
});

test("a tied decision must be reset through the discussion/revote action",()=>{
  const app=runtime();
  app.S.membersLocked=true;app.S.lockedMemberIds=["m1","m2"];app.S.step=10;
  app.rightStatus={allVoted:true,total:2,go:1,revise:1};
  app.restartFlowVote("right");
  assert.equal(app.S.rightRound,2);
  assert.deepEqual(Object.keys(app.S.rightVotes),[]);
  assert.match(app.ok,/新一輪/);
});

test("revision checkpoints wait for every locked member",()=>{
  const app=runtime();
  app.S.membersLocked=true;app.S.lockedMemberIds=["m1","m2"];app.S.step=16;
  assert.equal(app.applyOutcomeRevisionTarget(14,3,true),true);
  assert.deepEqual([...app.S.revisionReturnChain],[14,15]);
  assert.equal(app.S.step,14);
  app.confirmFlowRevision();
  assert.equal(app.S.step,14);
  app.S.selfId="m2";
  app.confirmFlowRevision();
  assert.equal(app.S.step,15);
});

