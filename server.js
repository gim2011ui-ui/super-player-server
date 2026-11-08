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
$myId = $isPlayer1 ? 1 : 2;
$userId = $user['id'];
$roomId = $match['voice_session_id'];
$slot = $isPlayer1 ? 1 : 2;

$opponentId = $isPlayer1 ? $match['player2_id'] : $match['player1_id'];

$stmtOpp = sp_pdo()->prepare("SELECT username FROM users WHERE id = ? LIMIT 1");
$stmtOpp->execute([$opponentId]);
$opponentName = $stmtOpp->fetchColumn() ?: 'Opponent';

$stmtEq = sp_pdo()->prepare("SELECT puck_key FROM equipped_items WHERE user_id = ? LIMIT 1");
$stmtEq->execute([$user['id']]);
$eqPuckKey = $stmtEq->fetchColumn();

$stmtPuck = sp_pdo()->prepare("SELECT si.item_code, si.preview_data FROM user_inventory ui JOIN store_items si ON si.id = ui.item_id WHERE ui.user_id = ? AND ui.purchase_key = ? AND ui.revoked_at IS NULL");
$stmtPuck->execute([$user['id'], $eqPuckKey]);
$equippedPuck = $stmtPuck->fetch();
if (!$equippedPuck) {
    $stmtPuck = sp_pdo()->prepare("SELECT item_code, preview_data FROM store_items WHERE item_code = 'puck_default' LIMIT 1");
    $stmtPuck->execute();
    $equippedPuck = $stmtPuck->fetch();
}

$puckColors = ['puck_default' => ["#797979","#373737","#171717","#050505"], 'puck_wood' => ["#f7dfb6","#d4a66d","#9a602f","#593116"], 'puck_jade' => ["#b8f0d0","#5fc090","#2f8a5f","#1f5c3f"], 'puck_ruby' => ["#ffb8c8","#e06080","#a03050","#6b1a2a"], 'puck_gold' => ["#fff2c0","#e9bd7b","#b08040","#8a5a1a"], 'puck_obsidian' => ["#6a6a8a","#3a3a5a","#1a1a2a","#05050f"]];
$activePuckColor = $puckColors[$equippedPuck['item_code']] ?? $puckColors['puck_default'];
$tableColors = ["#432818","#81502e","#a87645","#9b6a3c","#a87645","#81502e","#432818"];
$activeBarrierColor = ["#301a0e","#bc8a51","#7a4825","#a36e3c","#2c190e"];

$wsBase = 'wss://super-player-server.onrender.com';
?><!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#17100b">
<title>Sling Puck</title>
<style>
:root{color-scheme:dark;--gold:#d9ad68;--gold2:#f4d79b;--panel:#21160f;--ink:#f7ead4;--muted:#b9a48a}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:radial-gradient(ellipse at 50% 0,#49301d 0,#21160f 45%,#100b08 100%);color:var(--ink);font-family:Tahoma,Arial,sans-serif}
body{display:flex;justify-content:center;align-items:center;padding:16px;overflow-x:hidden}.game-shell{width:min(100%,560px);display:flex;flex-direction:column;gap:13px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border:1px solid #b8894d88;border-radius:16px;background:linear-gradient(145deg,#392516ee,#17100dee);box-shadow:0 12px 35px #0008,inset 0 1px #fff2}
.brand{font-weight:900;letter-spacing:1px;color:var(--gold2);font-size:20px;text-shadow:0 2px 12px #d99a3d55}.room-tag{font-size:11px;color:var(--muted);direction:ltr;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scorebar{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center}.score{padding:10px;border:1px solid #c69a5a77;border-radius:13px;background:linear-gradient(145deg,#382719,#1c130d);text-align:center;box-shadow:inset 0 1px #fff2}.score small{display:block;color:#cbb18d;font-size:11px;margin-bottom:4px}.score strong{font-size:25px;color:#ffe0a5}.versus{color:#d9ad68;font-weight:900;text-shadow:0 2px 10px #000}
.board-frame{position:relative;width:min(100%,calc((100dvh - 205px)*.6667));max-width:400px;align-self:center;padding:9px;border-radius:23px;background:linear-gradient(135deg,#fff0bd,#9b642b 18%,#f0cf8d 35%,#6c421e 65%,#f6d99c 82%,#71451f);box-shadow:0 20px 45px #0009,inset 0 0 0 2px #fff6}.board-inner{overflow:hidden;border-radius:15px;border:2px solid #3b2111;background:#4a2815;box-shadow:inset 0 0 18px #000b;line-height:0}#board{display:block;width:100%;height:auto;aspect-ratio:2/3;touch-action:none;user-select:none;-webkit-user-select:none}
.controls{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}.btn{border:1px solid #e0b875;border-radius:12px;padding:11px 18px;color:#fff1d5;font-weight:800;background:linear-gradient(145deg,#805127,#3b2414);box-shadow:0 5px 14px #0006,inset 0 1px #fff4;cursor:pointer}.btn.active{background:linear-gradient(145deg,#247b4c,#12432b);border-color:#80d9a7}.btn:disabled{opacity:.5;cursor:not-allowed}.status{min-height:20px;text-align:center;color:#e7c58e;font-size:13px}.hint{text-align:center;color:#bba58a;font-size:11px;line-height:1.6}.overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:#090604c9;z-index:10;padding:20px}.overlay.show{display:flex}.result-card{width:min(100%,340px);padding:25px;border:1px solid #e0b875;border-radius:20px;text-align:center;background:linear-gradient(145deg,#382516,#17100d);box-shadow:0 20px 60px #000b}.result-card h2{color:#ffdfa2;margin:0 0 12px}.result-card p{color:#d8c2a4;margin:0}
@media(min-width:700px){.game-shell{width:520px}.board-frame{width:390px}}
</style>
</head>
<body>
<main class="game-shell">
  <header class="topbar"><div class="brand">SLING PUCK</div><div class="room-tag">ROOM: <?= htmlspecialchars($roomId, ENT_QUOTES, 'UTF-8') ?></div></header>
  <section class="scorebar">
    <div class="score"><small>أنت</small><strong id="p1score">5</strong></div>
    <div class="versus">VS</div>
    <div class="score"><small><?= htmlspecialchars($opponentName) ?></small><strong id="p2score">5</strong></div>
  </section>
  <div class="board-frame"><div class="board-inner"><canvas id="board" width="600" height="900"></canvas></div></div>
  <div class="controls"><button class="btn" id="micBtn" type="button">تشغيل المايك</button></div>
  <div class="status" id="status">جارٍ الاتصال...</div>
  <div class="hint">اسحب القرص للخلف ثم اتركه لإطلاقه نحو نصف الخصم.</div>
</main>
<div class="overlay" id="resultOverlay"><div class="result-card"><h2 id="resultTitle">انتهت المباراة</h2><p id="resultText"></p></div></div>
<script>
'use strict';
const W=600,H=900,R=22,MID=450,GAP=50;
const MY_SLOT=<?= (int)$slot ?>;
const MY_USER_ID=<?= json_encode($userId) ?>;
const ROOM_ID=<?= json_encode($roomId) ?>;
const WS_BASE=<?= json_encode($wsBase) ?>;
const PUCK_COLORS=<?= json_encode($activePuckColor) ?>;
const WOOD_COLORS=<?= json_encode($tableColors) ?>;
const BARRIER_COLORS=<?= json_encode($activeBarrierColor) ?>;
const OPPONENT_SLOT=MY_SLOT===1?2:1;
const canvas=document.getElementById('board'),ctx=canvas.getContext('2d');
const statusEl=document.getElementById('status'),micBtn=document.getElementById('micBtn');
let socket=null,latestPucks=[],drag=null,retryTimer=null,retryDelay=1500,manualClose=false;
let pc=null,localStream=null,remoteAudio=null,ignoreOffer=false,makingOffer=false,settingRemoteAnswer=false,pendingCandidates=[];
let micOn=false;
const rtcConfig={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
function setStatus(s){statusEl.textContent=s;statusEl.style.display='block'}
function send(data){if(!socket||socket.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(data));return true}
function connect(){if(socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING))return;clearTimeout(retryTimer);setStatus('جارٍ الاتصال بالسيرفر...');const url=WS_BASE+'?room_id='+encodeURIComponent(ROOM_ID)+'&player_id='+MY_SLOT+'&user_id='+encodeURIComponent(MY_USER_ID);socket=new WebSocket(url);socket.onopen=()=>{retryDelay=1500};socket.onmessage=async e=>{let m;try{m=JSON.parse(e.data)}catch{return}try{if(m.type==='joined'){if(String(m.userId)!==String(MY_USER_ID)||Number(m.slot)!==MY_SLOT){setStatus('خطأ في هوية اللاعب');socket.close();return}if(m.state?.pucks){latestPucks=m.state.pucks;updateScores();render()}setStatus('تم الاتصال - بانتظار اللاعب الآخر');}else if(m.type==='state'){if(m.state&&Array.isArray(m.state.pucks)){latestPucks=m.state.pucks;updateScores();render();if(m.state.started)statusEl.style.display='none'}}else if(m.type==='start'){if(m.state?.pucks)latestPucks=m.state.pucks;updateScores();render();statusEl.style.display='none'}else if(m.type==='opponent_left'){setStatus('انقطع اتصال اللاعب الآخر')}else if(m.type==='error'){setStatus('خطأ: '+(m.code||'UNKNOWN'))}else if(m.type==='game_over'){showResult(m)}else if(m.type==='webrtc'){await onSignal(m)}}catch(err){console.error(err)}};socket.onerror=e=>console.error('WebSocket error',e);socket.onclose=()=>{if(!manualClose){setStatus('انقطع الاتصال، إعادة المحاولة...');retryTimer=setTimeout(connect,retryDelay);retryDelay=Math.min(retryDelay*1.7,10000)}}}
function updateScores(){let a=0,b=0;for(const p of latestPucks){if(Number(p.owner)===MY_SLOT&&p.y>=MID)a++;if(Number(p.owner)!==MY_SLOT&&p.y<=MID)b++}document.getElementById('p1score').textContent=a;document.getElementById('p2score').textContent=b}
function gradientStops(colors,fallback){const list=Array.isArray(colors)&&colors.length?colors:fallback;const g=ctx.createLinearGradient(0,0,W,0);list.forEach((c,i)=>g.addColorStop(i/Math.max(1,list.length-1),c));return g}
function drawBoard(){ctx.fillStyle=gradientStops(WOOD_COLORS,['#4a2412','#8b512b','#b97943','#61351c']);ctx.fillRect(0,0,W,H);const rail=ctx.createLinearGradient(0,0,22,0);rail.addColorStop(0,'#26140c');rail.addColorStop(.35,'#b0804b');rail.addColorStop(.65,'#e0b477');rail.addColorStop(1,'#422717');ctx.fillStyle=rail;ctx.fillRect(7,7,15,H-14);ctx.save();ctx.translate(W,0);ctx.scale(-1,1);ctx.fillStyle=rail;ctx.fillRect(7,7,15,H-14);ctx.restore();const barrier=ctx.createLinearGradient(0,MID-18,0,MID+18);(BARRIER_COLORS.length?BARRIER_COLORS:['#26140c','#b0804b','#e0b477','#422717']).forEach((c,i,a)=>barrier.addColorStop(i/Math.max(1,a.length-1),c));const bw=(W-GAP)/2;ctx.fillStyle=barrier;ctx.fillRect(20,MID-15,bw-20,30);ctx.fillRect(W/2+GAP/2,MID-15,bw-20,30);ctx.save();ctx.strokeStyle='#f7dca055';ctx.lineWidth=2;ctx.setLineDash([7,9]);ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();ctx.restore()}
function drawPuck(p){const colors=Array.isArray(PUCK_COLORS)&&PUCK_COLORS.length>=4?PUCK_COLORS:['#f7dfb6','#d4a66d','#9a602f','#593116'];ctx.save();ctx.translate(p.x,p.y);ctx.shadowColor='#000b';ctx.shadowBlur=13;ctx.shadowOffsetY=5;const g=ctx.createRadialGradient(-9,-11,2,0,0,R);[0,.28,.72,1].forEach((s,i)=>g.addColorStop(s,colors[Math.min(i,colors.length-1)]));ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle='#fff8';ctx.lineWidth=1.5;ctx.stroke();ctx.restore()}
function render(){ctx.clearRect(0,0,W,H);drawBoard();for(const p of latestPucks)drawPuck(p);if(drag){ctx.save();ctx.beginPath();ctx.moveTo(drag.start.x,drag.start.y);ctx.lineTo(drag.end.x,drag.end.y);ctx.strokeStyle='#f6e2bd';ctx.lineWidth=5;ctx.lineCap='round';ctx.shadowColor='#000';ctx.shadowBlur=5;ctx.stroke();ctx.restore()}}
function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*W/r.width,y:(e.clientY-r.top)*H/r.height}}
canvas.addEventListener('pointerdown',e=>{if(drag||!socket||socket.readyState!==WebSocket.OPEN)return;const q=point(e);const p=latestPucks.find(v=>Number(v.owner)===MY_SLOT&&Math.hypot(v.x-q.x,v.y-q.y)<R*1.5);if(!p)return;drag={id:String(p.id),start:{x:p.x,y:p.y},end:q};canvas.setPointerCapture(e.pointerId);render()});canvas.addEventListener('pointermove',e=>{if(!drag)return;drag.end=point(e);render()});function release(){if(!drag)return;const dx=drag.end.x-drag.start.x,dy=drag.end.y-drag.start.y;if(Math.hypot(dx,dy)>8)send({type:'launch',puckId:drag.id,dx,dy});drag=null;render()}canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
function showResult(m){const won=String(m.winner_user_id)===String(MY_USER_ID);document.getElementById('resultTitle').textContent=won?'فوز!':'انتهت المباراة';document.getElementById('resultText').textContent=won?'مبروك، لقد فزت بالمباراة.':'هذه المرة لم يحالفك الحظ.';document.getElementById('resultOverlay').classList.add('show');}
function makePeer(){if(pc)return pc;pc=new RTCPeerConnection(rtcConfig);remoteAudio=new Audio();remoteAudio.autoplay=true;remoteAudio.playsInline=true;pc.ontrack=async e=>{if(e.streams?.[0]){remoteAudio.srcObject=e.streams[0];try{await remoteAudio.play()}catch(err){console.warn('Audio playback needs a user gesture',err)}}};pc.onicecandidate=e=>{if(e.candidate)send({type:'webrtc',to:OPPONENT_SLOT,candidate:e.candidate})};pc.onconnectionstatechange=()=>{console.log('WebRTC:',pc.connectionState)};return pc}
async function enableMic(){if(micOn){disableMic();return}if(!navigator.mediaDevices?.getUserMedia){alert('يلزم HTTPS ومتصفح يدعم الميكروفون.');return}try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});const peer=makePeer();for(const track of localStream.getAudioTracks())peer.addTrack(track,localStream);micOn=true;micBtn.classList.add('active');micBtn.textContent='إيقاف المايك';if(peer.signalingState==='stable'){const offer=await peer.createOffer();await peer.setLocalDescription(offer);send({type:'webrtc',to:OPPONENT_SLOT,offer:peer.localDescription})}}
catch(e){console.error('Mic error',e);setStatus('تعذر تشغيل الميكروفون: '+e.message)}}
function disableMic(){if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}if(pc){pc.getSenders().filter(s=>s.track?.kind==='audio').forEach(s=>pc.removeTrack(s))}micOn=false;micBtn.classList.remove('active');micBtn.textContent='تشغيل المايك'}
async function onSignal(m){if(Number(m.from)!==OPPONENT_SLOT)return;const peer=makePeer();try{if(m.offer||m.answer){const d=m.offer||m.answer;const ready=!makingOffer&&(peer.signalingState==='stable'||settingRemoteAnswer);const collision=d.type==='offer'&&!ready;ignoreOffer=MY_SLOT===1&&collision;if(ignoreOffer)return;settingRemoteAnswer=d.type==='answer';if(collision){await peer.setLocalDescription({type:'rollback'});await peer.setRemoteDescription(d)}else await peer.setRemoteDescription(d);settingRemoteAnswer=false;for(const c of pendingCandidates)await peer.addIceCandidate(c);pendingCandidates=[];if(d.type==='offer'){const answer=await peer.createAnswer();await peer.setLocalDescription(answer);send({type:'webrtc',to:OPPONENT_SLOT,answer:peer.localDescription})}}if(m.candidate){if(ignoreOffer)return;if(!peer.remoteDescription)pendingCandidates.push(m.candidate);else await peer.addIceCandidate(m.candidate)}}catch(e){if(!ignoreOffer)console.error('WebRTC signaling',e)}}
micBtn.addEventListener('click',enableMic);render();connect();
</script>
</body></html>
