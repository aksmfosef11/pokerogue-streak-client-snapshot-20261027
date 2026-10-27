// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
const directory=resolve(process.argv[2]);
const accounts=JSON.parse(readFileSync(resolve(directory,"accounts.local.json")));
const results=[];
for(const account of accounts){
 assert.match(account.username,/^qa/);
 const api=async(path,body)=>{
  const res=await fetch(`http://localhost:8001/pvp/${path}`,{method:body?"POST":"GET",headers:{Authorization:account.token,"Content-Type":"application/json","PKR-Client-Version":account.version},body:body?JSON.stringify(body):undefined});assert.equal(res.status,200,await res.clone().text());return res.json();
 };
 let status=await api("status");
 if(process.argv.includes("--finalize")&&status.streakAttempt?.status==="active"){
  assert.notEqual(status.match?.status,"active","refuse to finalize a running QA battle");await api("end-streak",{});status=await api("status");
 }
 const board=await api("leaderboard");
 if(status.streakAttempt?.status==="active")assert.equal(board.self,null,"running attempt must not be ranked");
 else if(status.streakAttempt){
  assert.equal(board.self.wins,status.streakAttempt.wins);assert.ok(board.self.rank>=1);
  const page=await api(`leaderboard?page=${Math.floor((board.self.position-1)/board.pageSize)}`);
  const self=page.entries.find(e=>e.id===board.self.id);assert.equal(self.isSelf,true);
  const team=await api(`leaderboard/team?id=${encodeURIComponent(self.id)}`);assert.ok(team.session.party.length>0);
  const same=page.entries.filter(e=>e.wins===self.wins);for(const other of same)assert.equal(other.rank,self.rank);
  const frozen=await api("leaderboard");assert.deepEqual(frozen,board);
 }
 results.push({username:account.username,version:account.version,streakStatus:status.streakAttempt?.status,wins:status.streakAttempt?.wins,rank:board.self?.rank??null,total:board.total,passed:true});
}
writeFileSync(resolve(directory,"ranking-results.json"),JSON.stringify(results,null,2));console.log("PASS: finalized wins, self marker, party snapshot, tie ranks and stable refresh");
