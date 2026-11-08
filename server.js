<?php
declare(strict_types=1);
require_once __DIR__ . '/init.php';

$user = sp_session_user();
if (!$user) { header('Location: login.php'); exit; }

$token = $_GET['token'] ?? '';
$stmt = sp_pdo()->prepare("SELECT id, player1_id, player2_id, voice_session_id FROM matches WHERE room_token = ? AND status = 'active' LIMIT 1");
$stmt->execute([$token]);
$match = $stmt->fetch();

if (!$match) { header('Location: index.php'); exit; }

$isPlayer1 = ($match['player1_id'] == $user['id']);
$slot = $isPlayer1 ? 1 : 2;
$userId = $user['id'];
$matchId = $match['id'];
$roomId = $match['voice_session_id'];
$opponentId = $isPlayer1 ? $match['player2_id'] : $match['player1_id'];

$stmtOpp = sp_pdo()->prepare("SELECT username FROM users WHERE id = ? LIMIT 1");
$stmtOpp->execute([$opponentId]);
$opponentName = $stmtOpp->fetchColumn() ?: 'Opponent';

$stmtEq = sp_pdo()->prepare("SELECT puck_key FROM equipped_items WHERE user_id = ? LIMIT 1");
$stmtEq->execute([$userId]);
$eqPuckKey = $stmtEq->fetchColumn();
$stmtPuck = sp_pdo()->prepare("SELECT si.item_code, si.preview_data FROM user_inventory ui JOIN store_items si ON si.id = ui.item_id WHERE ui.user_id = ? AND ui.purchase_key = ? AND ui.revoked_at IS NULL");
$stmtPuck->execute([$userId, $eqPuckKey]);
$equippedPuck = $stmtPuck->fetch() ?: ['preview_data' => 'radial-gradient(circle at 32% 25%,#797979,#050505)'];

$activePuckColor = ['#797979','#373737','#171717','#050505'];
$tableColors = ['#432818','#81502e','#a87645','#9b6a3c','#a87645','#81502e','#432818'];
$activeBarrierColor = ['#301a0e','#bc8a51','#7a4825','#a36e3c','#2c190e'];

$wsBase = 'wss://super-player-server.onrender.com';

$ticketSecret = (string)sp_config('ws_ticket_secret', '');
$ticketPayload = ['uid' => $userId, 'mid' => $matchId, 'slot' => $slot, 'rid' => $roomId, 'exp' => time() + 3600];
$ticketBody = rtrim(strtr(base64_encode(json_encode($ticketPayload, JSON_UNESCAPED_SLASHES)), '+/', '-_'), '=');
$wsTicket = $ticketBody . '.' . hash_hmac('sha256', $ticketBody, $ticketSecret);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Online Match | Super Player</title>
<style>
:root{--gold:#e9bd7b;--gold-light:#ffe4b1;--dark:#100d0b;--panel:#211811;--green:#72d7a0;--red:#ff4545;}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
html,body{width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:none;}
body{color:#fff;font-family:Inter,"Segoe UI",Arial,sans-serif;background:radial-gradient(ellipse at 50% 25%,#382719 0%,#17110d 48%,#090807 100%);user-select:none;-webkit-user-select:none;}
#app{width:100%;height:100dvh;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px;}
#game{width:min(100%,510px);display:flex;flex-direction:column;align-items:center;gap:13px;}
.hud{width:100%;min-height:68px;padding:10px 17px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;border:1px solid #b88b5544;border-radius:15px;background:linear-gradient(135deg,#392718,#19120d);box-shadow:0 8px 25px #0008,inset 0 1px 0 #ffffff10;}
.hud-player{display:flex;align-items:center;gap:9px;}
.hud-player.opponent{justify-content:flex-end;text-align:right;}
.hud-disc{flex-shrink:0;width:24px;height:24px;border-radius:50%;box-shadow:inset 0 2px 4px #ffffff66,0 3px 8px #0009;}
.hud-disc.black{background:radial-gradient(circle at 30% 25%,#777,#080808 75%);}
.hud-disc.brown{background:radial-gradient(circle at 30% 25%,#f4d5a5,#86532d 75%);}
.hud-label{color:#cfb18b;font-size:9px;font-weight:800;letter-spacing:1.5px;}
.hud-score{color:var(--gold-light);font-size:26px;font-weight:900;line-height:1.1;font-variant-numeric:tabular-nums;}
.hud-center{text-align:center;white-space:nowrap;}
.hud-brand{color:var(--gold);font-family:Georgia,serif;font-size:13px;font-weight:900;letter-spacing:1.8px;}
.hud-goal{margin-top:4px;color:#a78d6c;font-size:8px;letter-spacing:1.3px;}
#boardWrap{position:relative;width:min(92vw,480px);aspect-ratio:2/3;overflow:visible;border:5px solid #382315;border-radius:16px;background:#82542f;box-shadow:0 0 0 2px #bc8c54,0 12px 45px #000c,0 30px 70px #0006;}
#board{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;border-radius:11px;overflow:hidden;}
.hint{color:#bda17f;text-align:center;font-size:10px;font-weight:700;letter-spacing:1.6px;}
#micBtn{position:absolute;top:10px;right:10px;width:44px;height:44px;border-radius:50%;background:#00000080;border:2px solid var(--gold);color:var(--gold);font-size:20px;font-weight:900;display:flex;align-items:center;justify-content:center;z-index:20;cursor:pointer;}
#micBtn.active{background:var(--green);color:#0a2a1a;border-color:var(--green);}
#result{position:fixed;inset:0;z-index:80;display:none;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:25px;background:#090705ed;backdrop-filter:blur(10px);}
.result-title{color:var(--gold);font-size:clamp(44px,12vw,75px);font-weight:1000;text-align:center;text-shadow:0 0 35px #e9b36b77;}
.result-description{color:#d0b58d;font-size:12px;text-align:center;letter-spacing:2px;line-height:1.8;}
.start-button{position:relative;overflow:hidden;min-width:230px;padding:17px 36px;border-radius:50px;color:#281707;background:linear-gradient(135deg,#ffe4af,#c08a4b);box-shadow:0 8px 28px #d49a4f44,inset 0 2px 2px #ffffff99;font-size:16px;font-weight:900;letter-spacing:2px;transition:transform .2s,filter .2s;}
.start-button:active{transform:scale(.95);filter:brightness(1.15);}
</style>
</head>
<body>
<div id="app">
  <main id="game">
    <header class="hud">
      <div class="hud-player"><div class="hud-disc black" style="background: <?= sp_e($equippedPuck['preview_data']) ?>"></div><div><div class="hud-label">YOU</div><div class="hud-score" id="p1score">5</div></div></div>
      <div class="hud-center"><div class="hud-brand">SUPER PLAYER</div><div class="hud-goal">ONLINE MATCH</div></div>
      <div class="hud-player opponent"><div><div class="hud-label" style="text-transform:uppercase;"><?= sp_e($opponentName) ?></div><div class="hud-score" id="p2score">5</div></div><div class="hud-disc brown"></div></div>
    </header>
    <div id="boardWrap">
        <canvas id="board"></canvas>
        <button id="micBtn" title="Voice Chat">&#127908;</button>
    </div>
    <div class="hint">DRAG BACKWARD · RELEASE TO LAUNCH</div>
  </main>
</div>

<div id="result">
  <div class="result-title" id="resultTitle">...</div>
  <div class="result-description" id="resultDescription">...</div>
  <button class="start-button" onclick="location.href='index.php'">MAIN MENU</button>
</div>

<script>
(() => {
"use strict";
const W=600,H=900,R=22,MID_Y=450,GAP=50;
const MY_SLOT=<?= (int)$slot ?>;
const MY_USER_ID=<?= json_encode((string)$userId) ?>;
const OPPONENT_USER_ID=<?= json_encode((string)$opponentId) ?>;
const ROOM_ID=<?= json_encode($roomId) ?>;
const MATCH_ID=<?= json_encode((string)$matchId) ?>;
const WS_BASE=<?= json_encode($wsBase) ?>;
const WS_TICKET=<?= json_encode($wsTicket) ?>;
const PLAYER_PUCK_COLORS = <?= json_encode($activePuckColor) ?>;
const TABLE_BG_COLORS = <?= json_encode($tableColors) ?>;
const BARRIER_COLORS = <?= json_encode($activeBarrierColor) ?>;

const canvas=document.getElementById("board");
const ctx=canvas.getContext("2d");
const micBtn=document.getElementById("micBtn");
const result=document.getElementById("result");
const resultTitle=document.getElementById("resultTitle");
const resultDescription=document.getElementById("resultDescription");
const p1ScoreEl=document.getElementById("p1score");
const p2ScoreEl=document.getElementById("p2score");

let latestPucks=[], dragging=false, dragStart=null, dragEnd=null, selectedPuckId=null, scaleX=1, scaleY=1;
let socket=null, gameEnded=false, reconnectTimer=null;
let pc=null, localStream=null, micOn=false;
const rtcConfig={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};

function resizeCanvas(){
  const rect=canvas.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);
  canvas.height=Math.round(rect.height*dpr);
  scaleX=canvas.width/W;scaleY=canvas.height/H;
  ctx.setTransform(scaleX,0,0,scaleY,0,0);
  render();
}
window.addEventListener("resize",resizeCanvas);

function drawBoard(){
  const wood=ctx.createLinearGradient(0,0,W,0);
  TABLE_BG_COLORS.forEach((c,i)=>wood.addColorStop(i/(TABLE_BG_COLORS.length-1),c));
  ctx.fillStyle=wood;ctx.fillRect(0,0,W,H);
  const rail=ctx.createLinearGradient(0,0,22,0);
  rail.addColorStop(0,"#26140c");rail.addColorStop(0.35,"#b0804b");rail.addColorStop(0.65,"#e0b477");rail.addColorStop(1,"#422717");
  ctx.fillStyle=rail;ctx.fillRect(7,7,15,H-14);
  ctx.save();ctx.translate(W,0);ctx.scale(-1,1);ctx.fillStyle=rail;ctx.fillRect(7,7,15,H-14);ctx.restore();
  const barrier=ctx.createLinearGradient(0,MID_Y-18,0,MID_Y+18);
  BARRIER_COLORS.forEach((c,i)=>barrier.addColorStop(i/(BARRIER_COLORS.length-1),c));
  const leftWidth=(W-GAP)/2;
  ctx.fillStyle=barrier;
  ctx.fillRect(20,MID_Y-15,leftWidth-20,30);
  ctx.fillRect(W/2+GAP/2,MID_Y-15,leftWidth-20,30);
}

function drawPuckAt(x, y, isMe){
  ctx.save();ctx.translate(x,y);
  ctx.shadowColor="#000b";ctx.shadowBlur=13;ctx.shadowOffsetY=5;
  const colors = isMe ? PLAYER_PUCK_COLORS : ["#f7dfb6","#d4a66d","#9a602f","#593116"];
  const grad=ctx.createRadialGradient(-9,-11,2,0,0,R);
  colors.forEach((c,i)=>grad.addColorStop([0,0.28,0.72,1][i],c));
  ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.fill();
  ctx.restore();
}

function render(){
  if(!canvas.width||!canvas.height)return;
  ctx.setTransform(scaleX,0,0,scaleY,0,0);
  ctx.clearRect(0,0,W,H);
  drawBoard();
  
  const isSlot2 = MY_SLOT === 2;
  for(const p of latestPucks){
    const drawX = isSlot2 ? W - p.x : p.x;
    const drawY = isSlot2 ? H - p.y : p.y;
    drawPuckAt(drawX, drawY, p.owner === MY_SLOT);
  }
  
  if(dragging && dragStart && dragEnd){
    ctx.beginPath(); ctx.moveTo(dragStart.x, dragStart.y); ctx.lineTo(dragEnd.x, dragEnd.y);
    ctx.strokeStyle="#ec3434"; ctx.lineWidth=7; ctx.lineCap="round"; ctx.stroke();
  }
}

function updateScores(pucks){
  let p1=0,p2=0;
  for(const p of pucks){
    if(p.owner===MY_SLOT){ if(p.y>=MID_Y) p1++; else p2++; }
    else { if(p.y<=MID_Y) p2++; else p1++; }
  }
  p1ScoreEl.textContent=p1;
  p2ScoreEl.textContent=p2;
}

function getCanvasPosition(event){
  const rect=canvas.getBoundingClientRect();
  let x = (event.clientX-rect.left)*W/rect.width;
  let y = (event.clientY-rect.top)*H/rect.height;
  if(MY_SLOT === 2) { x = W - x; y = H - y; }
  return {x, y};
}

canvas.addEventListener("pointerdown",event=>{
  if(gameEnded || dragging || !socket)return;
  const pos=getCanvasPosition(event);
  const puck=latestPucks.find(v=>v.owner === MY_SLOT && Math.hypot(v.x-pos.x, v.y-pos.y)<R*1.5);
  if(!puck)return;
  dragging=true; selectedPuckId=puck.id; dragStart={x:puck.x,y:puck.y}; dragEnd={x:pos.x,y:pos.y};
  canvas.setPointerCapture(event.pointerId); render();
});
canvas.addEventListener("pointermove",event=>{if(!dragging)return;dragEnd=getCanvasPosition(event);render();});
canvas.addEventListener("pointerup",event=>{
  if(!dragging||!selectedPuckId)return;
  let dx=dragEnd.x-dragStart.x, dy=dragEnd.y-dragStart.y;
  const distance=Math.hypot(dx,dy);
  if(distance>145){dx=dx*145/distance;dy=dy*145/distance;}
  if(Math.hypot(dx,dy)>10 && socket && socket.readyState===WebSocket.OPEN){
    socket.send(JSON.stringify({type:'launch',puckId:selectedPuckId,dx,dy}));
  }
  dragging=false;selectedPuckId=null;render();
});

function connect(){
  if(socket) socket.close();
  socket=new WebSocket(`${WS_BASE}?room_id=${encodeURIComponent(ROOM_ID)}&ticket=${encodeURIComponent(WS_TICKET)}`);
  
  socket.onmessage=async e=>{
    let m;try{m=JSON.parse(e.data)}catch{return}
    if(m.type==='state'||m.type==='joined'){
      if(m.state?.pucks){ latestPucks=m.state.pucks; updateScores(latestPucks); render(); }
    }else if(m.type==='game_over'){
      showResult(m.isWinner, m.winnerId);
    }else if(m.type==='webrtc'){
      await onSignal(m);
    }
  };

  socket.onclose=()=>{ if(!gameEnded){ clearTimeout(reconnectTimer); reconnectTimer=setTimeout(connect, 2000); } };
}

function showResult(isWinner, winnerId){
  gameEnded=true;
  result.style.display="flex";
  resultTitle.textContent=isWinner?"VICTORY!":"DEFEAT!";
  resultDescription.textContent=isWinner?"YOU WON 250 ZX!":"YOU GOT 100 COINS!";
  resultDescription.style.color=isWinner?"#72d7a0":"#ff4545";

  fetch('api/receive_match_result.php', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ match_id: <?= $matchId ?>, winner_id: winnerId })
  }).catch(console.error);
}

function makePeer(){if(pc)return pc;pc=new RTCPeerConnection(rtcConfig);pc.ontrack=e=>{const a=new Audio();a.srcObject=e.streams[0];a.play()};pc.onicecandidate=e=>{if(e.candidate)socket.send(JSON.stringify({type:'webrtc',to:OPPONENT_USER_ID,candidate:e.candidate}))};return pc}
micBtn.onclick=async()=>{
  if(micOn){localStream.getTracks().forEach(t=>t.stop());micOn=false;micBtn.classList.remove('active');return}
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true});
    const peer=makePeer();localStream.getTracks().forEach(t=>peer.addTrack(t,localStream));
    micOn=true;micBtn.classList.add('active');
    if(peer.signalingState==='stable'){const offer=await peer.createOffer();await peer.setLocalDescription(offer);socket.send(JSON.stringify({type:'webrtc',to:OPPONENT_USER_ID,offer:peer.localDescription}))}
  }catch(e){alert('تعذر تشغيل المايك')}
};
async function onSignal(m){
  const peer=makePeer();
  try{
    if(m.offer||m.answer){await peer.setRemoteDescription(m.offer||m.answer);if(m.offer){const ans=await peer.createAnswer();await peer.setLocalDescription(ans);socket.send(JSON.stringify({type:'webrtc',to:OPPONENT_USER_ID,answer:peer.localDescription}))}}
    if(m.candidate){await peer.addIceCandidate(m.candidate)}
  }catch(e){}
}

window.addEventListener("load", () => { resizeCanvas(); connect(); });
})();
</script>
</body>
</html>
