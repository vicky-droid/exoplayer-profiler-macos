'use strict';
/* ═══════════════════════════ CONFIG ═══════════════════════════ */
const CAT_COLORS={app:'#6e7681',sdk:'#58a6ff',network:'#1f6feb',timeline:'#d29922',drm:'#f78166',tracks:'#bc4c8f',decoder:'#2ea043',renderer:'#8957e5',buffer:'#3fb950',playback:'#d29922',seek:'#e3b341',bandwidth:'#1f6feb',video:'#58a6ff',audio:'#3fb950',drops:'#f78166',underrun:'#e3b341',error:'#ff5252',default:'#484f58'};
const CAT_LABELS={app:'APP',sdk:'SDK',network:'NETWORK',timeline:'TIMELINE',drm:'DRM',tracks:'TRACKS',decoder:'DECODER',renderer:'RENDERER',buffer:'BUFFER',playback:'PLAYBACK',seek:'SEEK',bandwidth:'BANDWIDTH',video:'VIDEO',audio:'AUDIO',drops:'DROPS',underrun:'UNDERRUN',error:'ERROR'};
const CAT_ORDER=['app','sdk','network','timeline','drm','tracks','decoder','renderer','buffer','playback','seek','bandwidth','video','audio','drops','underrun','error'];
const LANE_DEFS=[
  {key:'manifest',label:'MANIFEST',color:'#d29922'},
  {key:'license',label:'LICENSE',color:'#f78166'},
  {key:'media_initialization',label:'INIT',color:'#8957e5'},
  {key:'video',label:'VIDEO SEG',color:'#1f6feb'},
  {key:'audio',label:'AUDIO SEG',color:'#3fb950'},
  {key:'other',label:'OTHER',color:'#6e7681'},
];
const ROWH=26, STALL_COLOR='#da3633';

/* ═══════════════════════════ STATE ═══════════════════════════ */
const S={
  raw:null, events:[], session:{},
  loads:[], estimates:[], bufferSamples:[], quality:{1:[],2:[],3:[]}, stalls:[],
  startup:null, playSegs:[], seeks:[], markers:[],
  categories:{}, kpis:[],
  view:{v0:0,v1:1000},
  hoverT:null, hoverEvt:null, hoverLoad:null, sel:null,
  filterText:'', hiddenCats:new Set(), showStalls:true,
  playing:false, playT:null, playRAF:null,
  tableSort:{key:'timeMs',dir:1},
  fullRange:1000,
};

/* ═══════════════════════════ DOM ═══════════════════════════ */
const $=id=>document.getElementById(id);
const stackEl=$('stack'), tipEl=$('tip'), kpiPopEl=$('kpiPop'), kpisEl=$('kpis'), chipsEl=$('chips');
const statLeft=$('statLeft'), statRight=$('statRight'), searchEl=$('search');
const drawer=$('drawer'), drawerTitle=$('drawerTitle'), drawerBody=$('drawerBody');
const modal=$('modal'), tableEl=$('table'), tableWrap=$('tableWrap');
const minimapEl=$('minimap');
let W=0; // shared canvas css width
const panels=[]; // {label, sub, height, draw, scrollable, canvas}

/* ═══════════════════════════ UTILS ═══════════════════════════ */
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));
function fmtMs(ms){if(ms==null)return '—';if(ms<1000)return ms.toFixed(0)+' ms';if(ms<60000)return (ms/1000).toFixed(2)+' s';const m=Math.floor(ms/60000),s=Math.round(ms%60000/1000);return m+'m '+s+'s'}
function fmtDur(ms){if(ms==null)return '—';if(ms<1)return '0 ms';if(ms<1000)return ms.toFixed(0)+' ms';return (ms/1000).toFixed(2)+' s'}
function fmtBytes(b){if(b==null)return '—';if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';if(b<1073741824)return (b/1048576).toFixed(1)+' MB';return (b/1073741824).toFixed(2)+' GB'}
function fmtKbps(k){if(k==null||isNaN(k))return '—';if(k>=1000)return (k/1000).toFixed(2)+' Mbps';return Math.round(k)+' kbps'}
function fmtKbpsInt(k){if(k==null||isNaN(k))return '—';if(k>=1000)return (k/1000).toFixed(1)+'M';return Math.round(k)+'k'}
function shortUri(u){if(!u)return '—';const p=u.split('/');return p.slice(-2).join('/')||u}
const TRACK={1:'AUDIO',2:'VIDEO',3:'TEXT',4:'METADATA',0:'DEFAULT','-1':'N/A'};
const SELREASON={0:'INITIAL',1:'ADAPTIVE',2:'MANUAL',3:'TRICKPLAY',4:'AD_INSERTION'};
const PSTATE={1:'IDLE',2:'BUFFERING',3:'READY',4:'ENDED'};
const DISCREASON={0:'AUTO_TRANSITION',1:'SEEK',2:'DISCONTINUITY',3:'AD_INSERTION',4:'INTERNAL'};
const PWR={0:'false',1:'true',2:'INTERRUPTED'};
function catOf(e){
  const c=(e.category||'').toLowerCase(),ev=e.event||'';
  if(ev==='DroppedFrames')return'drops';
  if(ev==='Underrun'||ev==='AudioSinkError')return'underrun';
  if(ev==='LoadError'||ev==='PlaybackError'||ev==='DrmError'||ev==='CodecError'||/error/i.test(ev))return'error';
  if(ev==='CodecDiscovered'||ev==='CodecCreated'||ev==='CodecConfigured'||ev==='CodecStarted')return'decoder';
  if(ev==='SessionAcquired'||ev==='KeysLoaded'||ev==='KeysRestored'||ev==='KeysRemoved')return'drm';
  if(c==='session')return'app';
  if(c==='video'||c==='audio')return'sdk';
  if(c==='network')return ev==='Estimate'?'bandwidth':'network';
  if(c==='timeline')return'timeline';
  if(c==='drm')return'drm';
  if(c==='tracks')return'tracks';
  if(c==='decoder')return'decoder';
  if(c==='renderer')return'renderer';
  if(c==='loading')return'buffer';
  if(c==='playback')return'playback';
  if(c==='seek')return'seek';
  if(c==='bandwidth')return'bandwidth';
  return'default';
}


/* ═══════════════════════════ TRACK INFO PANEL ═══════════════════════════ */
function trackMeta(tt){
  return tt===2?{emoji:'🎬',name:'VIDEO',color:'#58a6ff'}:tt===1?{emoji:'🔊',name:'AUDIO',color:'#7ee787'}:tt===3?{emoji:'📝',name:'SUBTITLE',color:'#d2a8ff'}:tt===4?{emoji:'📋',name:'METADATA',color:'#8b949e'}:{emoji:'📎',name:'OTHER',color:'#8b949e'};
}
function trackRoleStr(tr){
  const roles=[];
  if(tr.roleFlags!=null){const rf=+tr.roleFlags;if(rf&1)roles.push('main');if(rf&2)roles.push('alt');if(rf&4)roles.push('aux');if(rf&8)roles.push('cc');if(rf&16)roles.push('desc');if(rf&32)roles.push('sub');if(rf&64)roles.push('forced');}
  if(tr.selectionFlags!=null&&+tr.selectionFlags===1)roles.push('default');
  return roles.length?roles.join(','):'';
}
function ffprobeField(label, value, color){
  if(value==null||value===''||value===0)return '';
  return `<div class="ff-row"><span class="ff-k" style="color:${color||'#8b949e'}">${esc(label)}</span><span class="ff-v" style="color:${color||'#c9d1d9'}">${esc(String(value))}</span></div>`;
}
function updateTrackInfoPanel(quality){
  const el=document.getElementById('tracks');
  if(!el)return;
  const avail=S.availableTracks||{1:[],2:[],3:[],4:[]};
  const hasAvail=S.hasAvailableTracks;
  const kinds=[[2,'🎬','VIDEO','#58a6ff'],[1,'🔊','AUDIO','#7ee787'],[3,'📝','SUBTITLE','#d2a8ff'],[4,'📋','METADATA','#8b949e']];
  const parts=[];let totalTracks=0,totalSwitches=0;
  for(const[tt,emoji,label,color] of kinds){
    const hist=(S.quality||{})[tt]||[];
    const active=hist.length?hist[hist.length-1]:null;
    const pool=hasAvail&&avail[tt]&&avail[tt].length?avail[tt].length:hist.length;
    const sw=Math.max(0,(hist.length-1));
    totalTracks+=pool;totalSwitches+=sw;
    const kind=active?(active.h>0?active.h+'p · ':'')+(active.lang?active.lang+' · ':'')+(active.kbps?Math.round(active.kbps)+'kbps':''):(pool>0?pool+'' :'—');
    parts.push(`<span class="tk" style="color:${color}" title="${esc(label)}">${metaEmoji(tt)} ${esc(kind)}</span>`);
  }
  el.innerHTML=`<div class="kpi has-pop\" data-kpi-type=\"tracks\">
    <div class=\"v\">${parts.join('<span style=\"color:#30363d\"> · </span>')}</div>
    <div class=\"l\">Tracks<span class=\"pop-hint\">details ▾</span></div>
    <div class=\"s\">${totalTracks} track${totalTracks===1?'':'s'}${totalSwitches?` · ${totalSwitches} switch${totalSwitches===1?'':'es'}`:''}</div>
  </div>`;
  const card=el.querySelector('.kpi');
  if(card){
    card.addEventListener('mouseenter',()=>{clearTimeout(popTimer);if(popPinned&&activePopType==='tracks')return;popPinned=false;showKpiPop(card,renderTracksPopover());attachPopHandlers('tracks');activePopType='tracks';});
    card.addEventListener('mouseleave',()=>{if(!popPinned)popTimer=setTimeout(closeKpiPop,350);});
  }
}
function metaEmoji(tt){
  return tt===2?'🎬':tt===1?'🔊':tt===3?'📝':tt===4?'📋':'📎';
}
function renderTracksPopover(){
  const avail=S.availableTracks||{1:[],2:[],3:[],4:[]};
  const hasAvail=S.hasAvailableTracks;
  const full=S.fullRange||1;
  const t0=S.events[0]?.rel||0;
  const quality=S.quality||{};
  let html=`
    <div class="kpi-pop-head">
      <div class="kpi-pop-title"><span style="color:#d2a8ff">📊</span> Stream Info (ffprobe)</div>
      <span style="font-size:0.65rem;color:#8b949e">${hasAvail?'from app track list':'observed from DownstreamFormatChanged'}</span>
    </div>
    <div class="kpi-pop-body">`;
  let any=false;
  const order=[2,1,3,4];
  for(const tt of order){
    const meta=trackMeta(tt);
    const hist=quality[tt]||[];
    const list=hasAvail&&avail[tt]&&avail[tt].length?avail[tt]:(hist.length?hist.slice(-1):[]);
    if(!list.length)continue;
    any=true;
    const activeKey=hist.length?(hist[hist.length-1].id||((hist[hist.length-1].codecs||'')+'|'+(hist[hist.length-1].lang||'')+'|'+Math.round(hist[hist.length-1].kbps))):null;
    html+=`<div class=\"ff-section\" style=\"margin-bottom:10px\">
      <div style=\"font-size:0.7rem;font-weight:700;color:${meta.color};letter-spacing:0.06em;margin-bottom:6px\">${meta.emoji} ${meta.name} ${meta.emoji}</div>
      <div class=\"ff-grid\">`;
    for(const tr of list){
      const key=tr.id||((tr.codecs||'')+'|'+(tr.lang||tr.language||'')+'|'+Math.round(tr.kbps||tr.bitrate||0));
      const isAct=activeKey&&key===activeKey;
      const w=tr.w||tr.width||0;
      const h=tr.h||tr.height||0;
      const kbps=Math.round(tr.kbps||tr.bitrate||0);
      const lang=tr.lang||tr.language||'';
      const roles=trackRoleStr(tr);
      const fps=tr.frameRate||tr.framerate||'';
      const colorSpace=tr.colorSpace||tr.color_space||'';
      const colorTransfer=tr.colorTransfer||tr.color_transfer||'';
      const colorPrimaries=tr.colorPrimaries||tr.color_primaries||'';
      const sampleRate=tr.sampleRate||tr.sample_rate||'';
      const channels=tr.channels||'';
      const pixFmt=tr.pixFmt||tr.pix_fmt||'';
      const fourcc=tr.codecTagString||tr.fourcc||'';
      const profile=tr.profile||'';
      const level=tr.level||'';
      const codec=tr.codec_name||tr.codec||tr.codecs||'';
      const mime=tr.mimeType||tr.mime||'';
      html+=`<div class=\"ff-card ${isAct?'ff-active':''}\">
        <div class=\"ff-title\" style=\"color:${meta.color};font-weight:700;font-size:0.78rem\">${meta.emoji} ${esc(codec||mime||'unknown')}${isAct?' <span class=\"ff-active-badge\">ACTIVE</span>':''}</div>
        ${ffprobeField('Profile',profile||'—','#79c0ff')}
        ${ffprobeField('Level',level||'—','#79c0ff')}
        ${ffprobeField('FourCC',fourcc||'—','#8b949e')}
        ${ffprobeField('MIME',mime||'—','#8b949e')}
        ${w>0&&h>0?ffprobeField('Resolution',w+'x'+h,'#58a6ff'):''}
        ${fps?ffprobeField('Frame rate',fps+' fps','#58a6ff'):''}
        ${kbps>0?ffprobeField('Bitrate',kbps+' kbps','#7ee787'):''}
        ${sampleRate?ffprobeField('Sample rate',sampleRate+' Hz','#7ee787'):''}
        ${channels?ffprobeField('Channels',channels,'#7ee787'):''}
        ${lang?ffprobeField('Language',lang,'#d2a8ff'):''}
        ${pixFmt?ffprobeField('Pixel format',pixFmt,'#d2a8ff'):''}
        ${colorSpace?ffprobeField('Color space',colorSpace,'#d2a8ff'):''}
        ${colorTransfer?ffprobeField('Color transfer',colorTransfer,'#d2a8ff'):''}
        ${colorPrimaries?ffprobeField('Color primaries',colorPrimaries,'#d2a8ff'):''}
        ${roles?ffprobeField('Roles',roles,'#8b949e'):''}
      </div>`;
    }
    html+=`</div></div>`;
  }
  if(!any)html+=`<div style=\"font-size:0.72rem;color:#6e7681\">no stream info observed</div>`;
  html+=`</div>`;
  return html;
}

/* ═══════════════════════════ OPERATION PAIRING ENGINE ═══════════════════════════ */
function extractCorrelationId(details){
  if(!details||typeof details!=='object')return null;
  const keys=["correlationId","operationId","requestId","id","sessionId","adBreakId","drmSessionId","transactionId"];
  for(const k of keys){
    if(details[k]!=null&&String(details[k]).trim()!==''){
      return String(details[k]).trim();
    }
  }
  return null;
}

function parseOperations(evs, fullRange){
  const pendingMap = new Map();
  const operations = [];

  for(let i=0; i<evs.length; i++){
    const e = evs[i];
    const evtName = String(e.event||'').trim();

    if(evtName.endsWith('_start')){
      const opType = evtName.slice(0, -6);
      if(!opType) continue;

      const corrId = extractCorrelationId(e.details);
      if(!pendingMap.has(opType)) pendingMap.set(opType, []);
      pendingMap.get(opType).push({ idx: i, opType, event: e, corrId });

    } else if(evtName.endsWith('_end')){
      const opType = evtName.slice(0, -4);
      if(!opType) continue;

      const corrId = extractCorrelationId(e.details);
      const pendingList = pendingMap.get(opType) || [];
      let startItem = null;

      if(pendingList.length > 0){
        if(corrId !== null){
          for(let j=pendingList.length-1; j>=0; j--){
            if(pendingList[j].corrId === corrId){
              startItem = pendingList.splice(j, 1)[0];
              break;
            }
          }
        }
        if(!startItem){
          startItem = pendingList.pop();
        }
      }

      if(startItem){
        const st = startItem.event;
        const startT = st.rel != null ? st.rel : (st.timeMs != null ? st.timeMs : 0);
        const endT = e.rel != null ? e.rel : (e.timeMs != null ? e.timeMs : startT);
        const dur = Math.max(0, endT - startT);

        const startTs = st.timestampMs != null ? st.timestampMs : (st.ts != null ? Math.round(st.ts * 1000) : null);
        const endTs = e.timestampMs != null ? e.timestampMs : (e.ts != null ? Math.round(e.ts * 1000) : null);

        const mergedDetails = Object.assign({}, st.details || {}, e.details || {}, { durationMs: dur });

        operations.push({
          operation: opType,
          status: 'completed',
          startEvent: st.event,
          endEvent: e.event,
          category: st.cat || st.category || e.cat || e.category || opType,
          start: startT,
          end: endT,
          dur: dur,
          startTimestampMs: startTs,
          endTimestampMs: endTs,
          correlationId: corrId || startItem.corrId,
          startDetails: st.details,
          endDetails: e.details,
          details: mergedDetails,
          startIdx: startItem.idx,
          endIdx: i
        });
      } else {
        const endT = e.rel != null ? e.rel : (e.timeMs != null ? e.timeMs : 0);
        const endTs = e.timestampMs != null ? e.timestampMs : (e.ts != null ? Math.round(e.ts * 1000) : null);

        operations.push({
          operation: opType,
          status: 'unmatched_end',
          startEvent: null,
          endEvent: e.event,
          category: e.cat || e.category || opType,
          start: null,
          end: endT,
          dur: null,
          startTimestampMs: null,
          endTimestampMs: endTs,
          correlationId: corrId,
          startDetails: null,
          endDetails: e.details,
          details: e.details || {},
          startIdx: null,
          endIdx: i
        });
      }
    }
  }

  pendingMap.forEach((pendingList, opType) => {
    for(const item of pendingList){
      const st = item.event;
      const startT = st.rel != null ? st.rel : (st.timeMs != null ? st.timeMs : 0);
      const startTs = st.timestampMs != null ? st.timestampMs : (st.ts != null ? Math.round(st.ts * 1000) : null);

      operations.push({
        operation: opType,
        status: 'incomplete',
        startEvent: st.event,
        endEvent: null,
        category: st.cat || st.category || opType,
        start: startT,
        end: null,
        dur: null,
        startTimestampMs: startTs,
        endTimestampMs: null,
        correlationId: item.corrId,
        startDetails: st.details,
        endDetails: null,
        details: st.details || {},
        startIdx: item.idx,
        endIdx: null
      });
    }
  });

  operations.sort((a, b) => {
    const tA = a.start != null ? a.start : (a.end != null ? a.end : 0);
    const tB = b.start != null ? b.start : (b.end != null ? b.end : 0);
    return tA - tB || (a.startIdx != null ? a.startIdx : 0) - (b.startIdx != null ? b.startIdx : 0);
  });

  return operations;
}

const OP_COLORS = {
  ad_break: '#f78166',
  ad: '#f78166',
  drm_license: '#8957e5',
  drm: '#8957e5',
  authorization: '#58a6ff',
  content_authorization: '#38bdf8',
  auth: '#58a6ff',
  media_load: '#d29922',
  playback: '#3fb950',
  session: '#e3b341'
};

function colorForOp(opType, category) {
  const key = String(opType || '').toLowerCase();
  if (OP_COLORS[key]) return OP_COLORS[key];
  const catKey = String(category || '').toLowerCase();
  if (CAT_COLORS[catKey]) return CAT_COLORS[catKey];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function layoutOperationLanes(operations, fullRange) {
  const opTypes = [];
  const typeMap = new Map();

  for (const op of operations) {
    if (!typeMap.has(op.operation)) {
      typeMap.set(op.operation, []);
      opTypes.push(op.operation);
    }
    typeMap.get(op.operation).push(op);
  }

  let totalRows = 0;

  for (const type of opTypes) {
    const list = typeMap.get(type);
    const subLanesEnd = [];

    for (const op of list) {
      const s = op.start != null ? op.start : op.end;
      const e = op.end != null ? op.end : (fullRange || s + 1000);

      let assignedLane = -1;
      for (let l = 0; l < subLanesEnd.length; l++) {
        if (subLanesEnd[l] <= s) {
          assignedLane = l;
          subLanesEnd[l] = e;
          break;
        }
      }
      if (assignedLane < 0) {
        assignedLane = subLanesEnd.length;
        subLanesEnd.push(e);
      }
      op.row = totalRows + assignedLane;
      op.typeRow = totalRows;
      op.subLane = assignedLane;
    }
    totalRows += Math.max(1, subLanesEnd.length);
  }

  return { opTypes, typeMap, totalRows };
}

function opAt(t, mouseY, h) {
  const ops = S.operations || [];
  if (!ops.length) return null;
  const { totalRows } = layoutOperationLanes(ops, S.fullRange);
  const rowHeight = Math.max(18, Math.floor(h / Math.max(1, totalRows)));

  for (const op of ops) {
    const r = op.row != null ? op.row : 0;
    const oy = r * rowHeight;
    const oh = rowHeight;
    if (mouseY >= oy && mouseY <= oy + oh) {
      const s = op.start != null ? op.start : op.end;
      const e = op.end != null ? op.end : (S.fullRange || s + 1000);
      if (t >= s - 100 && t <= e + 100) {
        return op;
      }
    }
  }
  return null;
}

/* ═══════════════════════════ ANALYSIS ═══════════════════════════ */
function analyze(raw){
  const evs=(raw.events||[]).map((e,i)=>({...e,idx:i,rel:e.timeMs,cat:catOf(e)}));
  evs.sort((a,b)=>a.rel-b.rel||a.idx-b.idx);
  const t0=evs.length?evs[0].rel:0;
  const full=Math.max(1000,(raw.session?.durationMs||0),evs.length?evs[evs.length-1].rel+500:1000);

  /* paired operations */
  const operations = parseOperations(evs, full);

  /* loads: pair LoadStarted→LoadCompleted by uri */
  const loads=[],pending=new Map(),stalls=[];
  for(const e of evs){
    const d=e.details||{};
    if(e.event==='LoadStarted'){if(d.uri&&!pending.has(d.uri))pending.set(d.uri,e);}
    else if(e.event==='LoadCompleted'){
      const st=d.uri?pending.get(d.uri):null;if(st)pending.delete(d.uri);
      const start=st?st.rel:e.rel-(d.loadDurationMs||0);
      const dur=d.loadDurationMs||Math.max(1,e.rel-start);
      const bytes=d.bytesLoaded||0;
      let lane=LANE_DEFS.findIndex(l=>l.key===(d.dataType||'other'));
      if(lane<0&&d.dataType==='media'){lane=LANE_DEFS.findIndex(l=>l.key===(d.trackType===2?'video':d.trackType===1?'audio':'other'));}
      loads.push({start,end:e.rel,dur,bytes,kbps:bytes&&dur?bytes*8/dur:0,dataType:d.dataType||'media',trackType:d.trackType,uri:d.uri,contentType:d.contentType,lane:lane<0?LANE_DEFS.length-1:lane,retried:false});
    }
  }
  /* retries: a LoadError before the next completed load of the same uri */
  const loadErrs=evs.filter(e=>e.event==='LoadError');
  for(const er of loadErrs){
    const uri=er.details?.uri;if(!uri)continue;
    const next=loads.find(l=>l.uri===uri&&l.start>=er.rel&&l.start<=er.rel+10000);
    if(next)next.retried=true;
  }
  loads.sort((a,b)=>a.start-b.start);
  const laneMed={};
  for(const l of loads){if(laneMed[l.lane]===undefined)laneMed[l.lane]=[];laneMed[l.lane].push(l.dur)}
  for(const k in laneMed){laneMed[k].sort((a,b)=>a-b);laneMed[k]=laneMed[k][Math.floor(laneMed[k].length/2)]||0}
  for(const l of loads)l.slow=l.dur>laneMed[l.lane]*3,l.crit=l.dur>laneMed[l.lane]*5;

  /* estimates */
  const estimates=evs.filter(e=>e.event==='Estimate').map(e=>({t:e.rel,kbps:(e.details?.bitrateEstimate||0)/1000,loadMs:e.details?.totalLoadTimeMs||0,bytes:e.details?.totalBytesLoaded||0}));

  /* buffer samples */
  const bufferSamples=evs.filter(e=>e.event==='StateChanged'&&e.details&&e.details.bufferedDurationMs!=null).map(e=>({t:e.rel,v:e.details.bufferedDurationMs}));

  /* quality ladder */
  const q={1:[],2:[]};
  for(const e of evs)if(e.event==='DownstreamFormatChanged'){\n    const d=e.details||{},tt=d.trackType;\n    if(tt===1||tt===2||tt===3)q[tt]=(q[tt]||[]).concat([{\n      t:e.rel,\n      kbps:(d.bitrate||0)/1000,\n      w:d.width||0,\n      h:d.height||0,\n      mime:d.mimeType||'',\n      codecs:d.codecs||'',\n      lang:d.language||'',\n      sel:d.selectionReason,\n      idx:e.idx\n    }]);\n  }
  for(const tt of[1,2,3]){for(let i=0;i<(q[tt]||[]).length;i++)q[tt][i].end=(q[tt][i+1]?.t)||full;}
  const quality={1:q[1]||[],2:q[2]||[],3:q[3]||[]};

  /* seeks (before stalls — stalls reference them) */
  const seeks=[];
  const seenSeek=new Set();
  for(const e of evs)if(e.event==='PositionDiscontinuity'){
    const d=e.details||{};
    if(d.reason===1||(d.oldPositionMs!=null&&d.oldPositionMs!==d.newPositionMs)){
      if(seenSeek.has(e.rel))continue;
      seenSeek.add(e.rel);
      seeks.push({t:e.rel,from:d.oldPositionMs,to:d.newPositionMs});
    }
  }
  const seeksNear=t=>{let best=null,bd=2500;for(const sk of seeks){const dt=t-sk.t;if(dt>=0&&dt<bd){bd=dt;best=sk}}return best};

  /* stalls: StateChanged BUFFERING(2)→READY(3); startup = start→first READY */
  let bufStart=null,firstReady=null,firstBuf=null,lastEvt=0;
  for(const e of evs){lastEvt=Math.max(lastEvt,e.rel);if(e.event!=='StateChanged')continue;
    const st=e.details?.playbackState;
    if(st===2){if(bufStart==null)bufStart=e.rel;if(firstBuf==null)firstBuf=e.rel;}
    else if(st===3){if(firstReady==null)firstReady=e.rel;if(bufStart!=null){stalls.push({start:bufStart,end:e.rel,bufAtStart:e.details?.bufferedDurationMs||0,seek:seeksNear(bufStart)});bufStart=null;}}
    else bufStart=null;
  }
  /* fallback: ReadyChanged isRebuffering windows when no StateChanged pair covers them */
  if(!stalls.length&&firstBuf!=null&&firstReady!=null)stalls.push({start:firstBuf,end:firstReady,bufAtStart:0});
  const startup={start:t0,end:firstReady??(firstBuf??lastEvt),kind:'startup'};

  /* play segments */
  const playSegs=[];let cur=null;
  for(const e of evs){
    if(e.event==='Playing'&&!cur)cur={start:e.rel};
    else if((e.event==='Paused'||e.event==='Ended')&&cur){cur.end=e.rel;if(cur.end-cur.start>50)playSegs.push(cur);cur=null;}
  }
  if(cur)playSegs.push({start:cur.start,end:lastEvt});
  playSegs.sort((a,b)=>a.start-b.start);
  for(let i=playSegs.length-1;i>0;i--)if(playSegs[i].start-playSegs[i-1].end<1000){playSegs[i-1].end=Math.max(playSegs[i-1].end,playSegs[i].end);playSegs.splice(i,1);}

  /* markers */
  const markers=[];
  for(const e of evs){
    if(e.event==='Playing')markers.push({t:e.rel,type:'play'});
    else if(e.event==='Paused')markers.push({t:e.rel,type:'pause'});
    else if(e.event==='Ended')markers.push({t:e.rel,type:'end'});
    else if(e.event==='RenderedFirstFrame')markers.push({t:e.rel,type:'firstframe'});
    else if(e.event==='PositionDiscontinuity'&&(e.details?.reason===1)){
      const rich=evs.find(x=>x.event==='PositionDiscontinuity'&&x.rel===e.rel&&x.details?.oldPositionMs!=null)||e;
      markers.push({t:e.rel,type:'seek',from:rich.details?.oldPositionMs,to:rich.details?.newPositionMs});
    }
    else if(e.event==='SessionReleased')markers.push({t:e.rel,type:e.cat==='drm'?'drmrel':'release'});
  }
  /* quality switches */
  let prevV=null;
  for(const st of quality[2]){if(prevV!=null&&st.kbps!==prevV)markers.push({t:st.t,type:'qswitch',from:prevV,to:st.kbps});prevV=st.kbps;}
  /* audio + subtitle track switches */
  let prevA=null;
  for(const st of quality[1]){if(prevA!=null&&(st.kbps!==prevA.kbps||(st.codecs||'')!==(prevA.codecs||'')||(st.lang||'')!==(prevA.lang||'')))markers.push({t:st.t,type:'aswitch',from:prevA.kbps,to:st.kbps,lang:st.lang||''});prevA=st;}
  let prevT=null;
  for(const st of quality[3]){if(prevT!=null&&((st.codecs||'')!==(prevT.codecs||'')||(st.lang||'')!==(prevT.lang||'')))markers.push({t:st.t,type:'tswitch',from:0,to:0,lang:st.lang||''});prevT=st;}
  /* dedupe markers at identical time+type (exporter emits duplicate events) */
  {
    const seen=new Set(),deduped=[];
    for(const m of markers){const k=m.type+'@'+m.t;if(seen.has(k))continue;seen.add(k);deduped.push(m)}
    markers.length=0;markers.push(...deduped);
  }

  /* ── v3: startup stages (wait vs work) ── */
  const manifestEnd=(evs.find(e=>e.event==='LoadCompleted'&&e.details?.dataType==='manifest')||{}).rel??t0;
  const timelineEvt=evs.find(e=>e.event==='Changed'&&e.details?.periodCount!=null);
  const tracksEvt=evs.find(e=>e.event==='Changed'&&Array.isArray(e.details?.groups))||evs.find(e=>e.event==='Enabled');
  const vdEvt=evs.find(e=>e.event==='VideoDecoderInitialized');
  const decStart=vdEvt?Math.max(t0,vdEvt.rel-(vdEvt.details?.initializationDurationMs||0)):null;
  const decEnd=vdEvt?vdEvt.rel:null;
  const drmOpen=evs.find(e=>e.cat==='drm'&&(e.details?.state===1||e.details?.state===2||e.event==='SessionAcquired'));
  const drmReady=[...evs].reverse().find(e=>e.cat==='drm'&&(e.event==='KeysLoaded'||e.event==='KeysRestored'||e.details?.state===3));
  const drmStart=drmOpen?drmOpen.rel:null;
  const drmEnd=(drmReady?drmReady.rel:drmStart);
  const firstFrame=evs.find(e=>e.event==='RenderedFirstFrame');
  const startupStages=[];
  startupStages.push({name:'MANIFEST',start:t0,end:Math.min(timelineEvt?timelineEvt.rel:manifestEnd,manifestEnd),color:'#d29922'});
  if(tracksEvt)startupStages.push({name:'TRACKS',start:timelineEvt?timelineEvt.rel:manifestEnd,end:tracksEvt.rel,color:'#bc4c8f'});
  if(drmStart!=null&&drmEnd!=null)startupStages.push({name:'DRM',start:drmStart,end:Math.max(drmEnd,drmStart),color:'#f78166'});
  if(decStart!=null&&decEnd!=null)startupStages.push({name:'DECODER',start:decStart,end:decEnd,color:'#2ea043'});
  const lastStageEnd=startupStages.reduce((a,b)=>Math.max(a,b.end),t0);
  if(firstReady!=null&&lastStageEnd<firstReady)startupStages.push({name:'BUFFER FILL',start:lastStageEnd,end:firstReady,color:'#3fb950'});
  if(firstReady!=null&&firstFrame)startupStages.push({name:'PRESENT',start:firstReady,end:firstFrame.rel,color:'#58a6ff'});
  startupStages.forEach(s=>s.dur=Math.max(0,s.end-s.start));
  const blocking=firstReady!=null?startupStages.reduce((a,b)=>Math.abs(a.end-firstReady)<Math.abs(b.end-firstReady)?a:b):null;

  /* ── v3: pause windows (PlayWhenReady false) ── */
  const pwrSegs=[];let pwr=null;
  for(const e of evs)if(e.event==='PlayWhenReadyChanged'){
    if(e.details?.playWhenReady===false&&!pwr)pwr={start:e.rel,reason:e.details?.reason};
    else if(e.details?.playWhenReady!==false&&pwr){pwr.end=e.rel;pwrSegs.push(pwr);pwr=null;}
  }

  /* ── v3: seek windows (seek → recovery) ── */
  const seekWindows=[];
  for(const sk of seeks){
    let end=sk.t+800;
    for(const e of evs){
      if(e.rel<=sk.t)continue;
      if(e.event==='Playing'||(e.event==='StateChanged'&&e.details?.playbackState===3)||(e.event==='ReadyChanged'&&e.details?.state===1)){end=e.rel;break}
    }
    seekWindows.push({start:sk.t,end:Math.max(sk.t+200,Math.min(end,full))});
  }

  /* ── v3: brain phases (inferred intent timeline) ── */
  const phases=[];
  const tTimeline=timelineEvt?timelineEvt.rel:null,tTracks=tracksEvt?tracksEvt.rel:null;
  if(tTimeline!=null&&tTimeline>t0)phases.push({kind:'preparing',start:t0,end:tTimeline});
  else if(tTimeline==null)phases.push({kind:'preparing',start:t0,end:tTracks??firstReady??lastEvt});
  if(tTracks!=null&&tTracks>tTimeline)phases.push({kind:'selecting',start:tTimeline,end:tTracks});
  if(drmStart!=null&&drmEnd!=null&&drmEnd>drmStart)phases.push({kind:'drm',start:drmStart,end:drmEnd});
  if(firstReady!=null){const s=Math.max(tTracks??t0,lastStageEnd);if(s<firstReady)phases.push({kind:'buffering',start:s,end:firstReady});}
  for(const ps of playSegs)phases.push({kind:'playing',start:ps.start,end:ps.end});
  for(const sk of seekWindows)phases.push({kind:'seeking',start:sk.start,end:sk.end});
  for(const st of stalls)phases.push({kind:'rebuffer',start:st.start,end:st.end});
  for(const pw of pwrSegs)phases.push({kind:'paused',start:pw.start,end:pw.end});
  phases.sort((a,b)=>a.start-b.start||a.end-b.end);
  const phaseIn=phases.slice();phases.length=0;
  let pt=t0;
  for(const ph of phaseIn){
    const s=Math.max(pt,ph.start),e=Math.max(s,Math.min(ph.end,full));
    if(s>pt)phases.push({kind:'idle',start:pt,end:s});
    if(e>s)phases.push({kind:ph.kind,start:s,end:e});
    pt=Math.max(pt,e);
  }
  if(pt<lastEvt)phases.push({kind:'idle',start:pt,end:lastEvt});
  const merged=[];
  for(const ph of phases){const l=merged[merged.length-1];if(l&&l.kind===ph.kind)l.end=Math.max(l.end,ph.end);else merged.push({...ph});}
  const brainPhases=merged;

  /* ── v3: health counters ── */
  const drops=evs.filter(e=>e.event==='DroppedFrames').reduce((a,e)=>a+(e.details?.count||0),0);
  const underruns=evs.filter(e=>e.event==='Underrun').length;
  const errors=evs.filter(e=>e.cat==='error');
  const device=raw.device||raw.session?.device||null;

  /* categories */
  const categories={};
  for(const e of evs){(categories[e.cat]=categories[e.cat]||[]).push(e)}

  /* KPIs */
  const vRungs = computeVRungs(quality[2]||[], full);
  const vSwitches = computeVSwitches(vRungs);

  /* available tracks — from TracksChanged events emitted by the Android app.
     Supported shapes: {video:[...],audio:[...],text:[...]} or {tracks:[{trackType:1..4,...}]} */
  const availableTracks={1:[],2:[],3:[],4:[]};
  const tchEvs=evs.filter(e=>e.event==='TracksChanged'||e.event==='TracksAvailable');
  for(const e of tchEvs){
    const d=e.details||{};
    let groups=d.tracks||d.groups||null;
    if(!groups&&Array.isArray(d))groups=d;
    const byType={1:d.audio,2:d.video,3:d.text,4:d.metadata};
    for(const tt of[1,2,3,4]){
      const list=Array.isArray(byType[tt])?byType[tt]:null;
      if(list)for(const tr of list)availableTracks[tt].push({...tr,_ts:e.rel});
    }
    if(Array.isArray(groups))for(const tr of groups){
      const tt=tr.trackType!=null?tr.trackType:(tr.type!=null?tr.type:0);
      if(availableTracks[tt])availableTracks[tt].push({...tr,_ts:e.rel});
    }
  }
  /* dedupe by (trackType,id|mime+lang+bitrate) keeping latest */
  for(const tt of[1,2,3,4]){
    const seen=new Map();
    for(const tr of availableTracks[tt]){
      const key=tr.id||tr.trackId||(tr.mimeType||'')+'|'+(tr.language||'')+'|'+(tr.bitrate||0)+'|'+(tr.width||0);
      seen.set(key,tr);
    }
    availableTracks[tt]=[...seen.values()];
  }
  const hasAvailable=availableTracks[1].length+availableTracks[2].length+availableTracks[3].length>0;

  const kpis=computeKpis({raw,t0,evs,loads,estimates,bufferSamples,quality,stalls,startup,playSegs,seeks,full,drops,underruns,errors,device,drmReady,drmEnd,firstReady,vRungs,vSwitches});

  Object.assign(S,{raw,events:evs,session:raw.session||{},operations,loads,estimates,bufferSamples,quality,stalls,startup,playSegs,seeks,markers,categories,kpis,fullRange:full,device,startupStages,blocking,brainPhases,pwrSegs,seekWindows,drops,underruns,errors,drmReady,drmEnd,firstReady,vRungs,vSwitches,availableTracks,hasAvailableTracks:hasAvailable});
  updateTrackInfoPanel(quality);
  S.view={v0:0,v1:full};
  S.playT=null;S.playing=false;
}
function computeVRungs(vq, full){
  const rungs = [];
  let prev = null;
  for (const st of (vq || [])) {
    if (!prev || st.kbps !== prev.kbps || (st.h && st.h !== prev.h)) {
      rungs.push({...st});
      prev = st;
    }
  }
  for (let i = 0; i < rungs.length; i++) {
    rungs[i].end = rungs[i+1]?.t || full || (rungs[i].t + 1000);
    rungs[i].dur = Math.max(0, rungs[i].end - rungs[i].t);
  }
  return rungs;
}
function computeVSwitches(rungs){
  const switches = [];
  for (let i = 1; i < (rungs || []).length; i++) {
    const prev = rungs[i-1], curr = rungs[i];
    const isUp = curr.kbps > prev.kbps;
    switches.push({
      t: curr.t,
      from: prev,
      to: curr,
      isUpgrade: isUp,
      deltaKbps: curr.kbps - prev.kbps,
      ratio: prev.kbps ? Math.abs((curr.kbps - prev.kbps) / prev.kbps * 100) : 0,
      idx: curr.idx
    });
  }
  return switches;
}
function computeKpis(ctx){
  const{evs,loads,estimates,bufferSamples,quality,stalls,startup,playSegs,seeks,full,t0,drops,underruns,errors,device,drmReady,drmEnd,firstReady,vRungs:ctxVRungs,vSwitches:ctxVSwitches}=ctx;
  const s=ctx.raw.session||{};
  const out=[];
  const firstFrame=evs.find(e=>e.event==='RenderedFirstFrame');
  out.push({v:firstFrame?fmtDur(firstFrame.rel-t0):'—',l:'Time to first frame',s:'SessionStart → first frame',cls:firstFrame?'good':'',sub:firstFrame?'':'no first-frame event'});
  out.push({v:fmtDur((startup?.end||0)-t0),l:'Startup → READY',s:'manifest+decode+init buffering',cls:'acc'});
  const stallT=stalls.reduce((a,b)=>a+(b.end-b.start),0);
  const playT=playSegs.reduce((a,b)=>a+(b.end-b.start),0);
  const ratio=playT?stallT/(playT+stallT)*100:0;
  out.push({v:stalls.length+' · '+fmtDur(stallT),l:'Rebuffers',s:'total · '+ratio.toFixed(1)+'% of playback',cls:stalls.length>0?'bad':'good'});
  out.push({v:fmtDur(playT),l:'Playback time',s:playSegs.length+' segment'+(playSegs.length===1?'':'s')+' · '+fmtDur(full-t0)+' session'});
  const media=loads.filter(l=>l.dataType==='media'&&l.bytes>0&&l.dur>0);
  const totB=media.reduce((a,b)=>a+b.bytes,0),totD=media.reduce((a,b)=>a+b.dur,0);
  const avg=totD?totB*8/totD:0,peak=media.length?Math.max(...media.map(m=>m.kbps)):0;
  out.push({v:fmtKbps(avg),l:'Measured throughput',s:media.length+' segments · peak '+fmtKbps(peak),cls:'good'});
  const estK=estimates.map(e=>e.kbps);
  if(estK.length){
    const ea=estK.reduce((a,b)=>a+b,0)/estK.length;
    out.push({v:fmtKbps(ea),l:'ABR estimate (avg)',s:'min '+fmtKbps(Math.min(...estK))+' · max '+fmtKbps(Math.max(...estK)),cls:'acc'});
  }
  const vRungs = ctxVRungs || computeVRungs(quality[2]||[], full);
  const vSwitches = ctxVSwitches || computeVSwitches(vRungs);
  const switchN = vSwitches.length;
  const firstV = vRungs.length ? vRungs[0] : null;
  const lastV = vRungs.length ? vRungs[vRungs.length-1] : null;
  let qualSubtitle = 'No video track';
  if (vRungs.length === 1) {
    qualSubtitle = `Constant ${firstV.h > 0 ? firstV.h + 'p ' : ''}${fmtKbpsInt(firstV.kbps)}`;
  } else if (vRungs.length > 1 && firstV && lastV) {
    qualSubtitle = `${firstV.h > 0 ? firstV.h + 'p ' : ''}${fmtKbpsInt(firstV.kbps)} → ${lastV.h > 0 ? lastV.h + 'p ' : ''}${fmtKbpsInt(lastV.kbps)}`;
  }
  out.push({
    v: switchN + ' switch' + (switchN === 1 ? '' : 'es'),
    l: 'Quality ladder',
    s: qualSubtitle,
    cls: switchN > 1 ? 'warn' : (switchN === 1 ? 'good' : ''),
    type: 'quality'
  });
  const maxBuf=bufferSamples.length?Math.max(...bufferSamples.map(b=>b.v)):0;
  out.push({v:fmtDur(maxBuf),l:'Max buffer depth',s:bufferSamples.length+' samples',cls:maxBuf>10000?'good':''});
  out.push({v:fmtBytes(loads.reduce((a,b)=>a+b.bytes,0)),l:'Bytes downloaded',s:loads.length+' requests ('+loads.filter(l=>l.dataType==='media').length+' segments)'});
  const vd=evs.find(e=>e.event==='VideoDecoderInitialized'),ad=evs.find(e=>e.event==='AudioDecoderInitialized');
  out.push({v:vd?shortUri(String(vd.details?.decoder||'')).replace(/c2\./,''):'—',l:'Video decoder',s:vd?('init '+fmtDur(vd.details?.initializationDurationMs)):'',cls:'acc'});
  out.push({v:String(seeks.length),l:'Seeks',s:seeks.length?('last @'+fmtDur(seeks[seeks.length-1].t-t0)):'none',cls:seeks.length?'warn':''});
  if(drops>0)out.push({v:fmtDur(drops/30*1000)+' est',l:'Dropped frames',s:drops+' frames · 30fps estimate',cls:'warn'});
  else if(drops===0&&evs.some(e=>e.event==='DroppedFrames'))out.push({v:'0',l:'Dropped frames',s:'no drops',cls:'good'});
  if(underruns>0)out.push({v:String(underruns),l:'Audio underruns',s:'audio sink starved',cls:'bad'});
  if(errors.length>0){
    const errCounts={};
    for(const e of errors){
      const n=e.event||'Error';
      errCounts[n]=(errCounts[n]||0)+1;
    }
    const parts=Object.entries(errCounts).map(([n,c])=>c>1?`${c}× ${n}`:n);
    out.push({
      v: String(errors.length),
      l: 'Errors',
      s: parts.join(', '),
      cls: 'bad',
      type: 'errors'
    });
  }
  if(drmReady)out.push({v:fmtDur(drmReady.rel-t0),l:'DRM keys ready',s:'keys loaded @'+fmtDur(drmReady.rel-t0),cls:'acc'});
  const det=[];
  const sse=evs.find(e=>e.event==='SessionStart');
  const sd=sse?.details||{};
  if(sd.device)det.push(sd.device);
  if(sd.android)det.push('Android '+sd.android);
  out.push({v:det.join(' · ')||'—',l:'Device',s:(s.packageName||'').split('.').pop()||'',cls:''});
  return out;
}

/* ═══════════════════════════ PANEL SETUP ═══════════════════════════ */
function addPanel(label,sub,height,drawFn,scrollable){
  const row=document.createElement('div');row.className='panel';
  const lb=document.createElement('div');lb.className='plabel';
  lb.innerHTML='<span>'+label+'</span>'+(sub?'<span class="sub">'+sub+'</span>':'');
  const wrap=document.createElement('div');wrap.className=scrollable?'scrollwrap':'pwrap';
  const cv=document.createElement('canvas');cv.dataset.panel=panels.length;
  wrap.appendChild(cv);row.appendChild(lb);row.appendChild(wrap);
  stackEl.appendChild(row);
  const p={label,sub,height,draw:drawFn,scrollable,canvas:cv,wrap};
  panels.push(p);return p;
}
function fitCanvas(cv,h){
  const dpr=window.devicePixelRatio||1;
  const cw=cv.parentElement.clientWidth,ch=h||cv.parentElement.clientHeight;
  cv.width=Math.max(1,Math.round(cw*dpr));cv.height=Math.max(1,Math.round(ch*dpr));
  cv.style.height=ch+'px';
  cv._w=cw;cv._h=ch;cv._dpr=dpr;
  const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  return ctx;
}
function allCanvasW(){return W||1200}
function layoutPanels(){
  if(!stackEl.clientWidth)return;
  W=Math.max(300,stackEl.clientWidth-105);
  minimapEl.width=Math.round(W*(window.devicePixelRatio||1));
  minimapEl._w=W;
  for(const p of panels){
    let h=p.height;
    if(p==evtPanel){const rows=visibleRows().length;h=Math.max(40,rows*ROWH);}
    if(p==stOpsPanel){
      const ops=S.operations||[];
      const {totalRows}=layoutOperationLanes(ops, S.fullRange);
      h=Math.max(36,totalRows*24);
    }
    fitCanvas(p.canvas,h);
  }
  redraw();
}
function tickStep(range){
  for(const c of[20,50,100,200,500,1000,2000,5000,10000,20000,50000,100000,250000,500000,1000000,2500000,5000000])
    if(c/(range||1)*allCanvasW()>=65)return c;
  return 5000000;
}
const xOf=t=>(t-S.view.v0)/(S.view.v1-S.view.v0)*allCanvasW();
const vOf=range=>range*(S.view.v1-S.view.v0)/allCanvasW();

/* ═══════════════════════════ DRAWING ═══════════════════════════ */
let rafPending=false;
function redraw(){
  if(rafPending)return;rafPending=true;
  requestAnimationFrame(()=>{rafPending=false;
    const st=S;
    for(const p of panels){const ctx=p.canvas.getContext('2d');
      const cw=p.canvas._w,ch=p.canvas._h;if(!cw||!ch)continue;
      ctx.clearRect(0,0,cw,ch);
      ctx.fillStyle='#11151c';ctx.fillRect(0,0,cw,ch);
      if(S.hoverT!=null)drawCursorBand(ctx,cw,ch);
      drawGrid(ctx,cw,ch);
      if(S.showStalls)drawStalls(ctx,cw,ch);
      p.draw(ctx,cw,ch);
      drawSelectionMarks(ctx,cw,ch,p);
      drawPlayhead(ctx,cw,ch);
    }
    drawMinimap();
    updateStatus();
  });
}
function drawGrid(ctx,W,H){
  const step=tickStep(S.view.v1-S.view.v0);
  ctx.strokeStyle='rgba(255,255,255,0.035)';ctx.fillStyle='#484f58';
  ctx.font='8px ui-monospace,monospace';ctx.textAlign='center';ctx.textBaseline='bottom';
  const x0=Math.ceil(S.view.v0/step)*step;
  for(let t=x0;t<=S.view.v1;t+=step){
    const x=xOf(t);if(x<0||x>W)continue;
    ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,H);ctx.stroke();
  }
}
function drawCursorBand(ctx,W,H){
  if(S.sel&&S.sel.type==='stall')return;
  if(S.hoverT!=null){const x=xOf(S.hoverT);ctx.fillStyle='rgba(88,166,255,0.05)';ctx.fillRect(Math.floor(x)-1,0,3,H)}
}
function drawStalls(ctx,W,H){
  for(const st of S.stalls){
    const x0=xOf(st.start),x1=xOf(st.end);if(x1<0||x0>W)continue;
    ctx.fillStyle='rgba(218,54,51,0.10)';ctx.fillRect(Math.max(0,x0),0,Math.min(W,x1)-Math.max(0,x0),H);
    ctx.fillStyle='rgba(218,54,51,0.5)';
    for(let x=Math.max(0,x0);x<Math.min(W,x1);x+=6){ctx.fillRect(x,0,2,H)}
  }
}
function drawPlayhead(ctx,W,H){
  if(S.playT==null&&S.sel&&S.sel.type!=='stall'){return}
  const t=S.playT!=null?S.playT:(S.hoverT!=null?S.hoverT:null);
  if(t==null)return;
  if(S.sel&&S.sel.type==='stall'){return}
  const x=xOf(t);if(x<0||x>W)return;
  ctx.strokeStyle=S.playT!=null?'rgba(227,179,65,0.9)':'rgba(88,166,255,0.35)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,H);ctx.stroke();
  if(S.playT!=null){ctx.fillStyle='#e3b341';ctx.beginPath();ctx.arc(x,H/2,3,0,7);ctx.fill()}
}
function drawSelectionMarks(ctx,W,H,p){
  const sel=S.sel;if(!sel)return;
  if(sel.type==='event'){
    const e=S.events[sel.idx];if(!e)return;
    if(p===evtPanel){
      const rows=visibleRows();const y=rows.indexOf(e.cat);
      const yy=y>=0?y*ROWH+ROWH/2:0;
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.arc(xOf(e.rel),yy,6,0,7);ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,0.6)';
      ctx.beginPath();ctx.moveTo(xOf(e.rel)+0.5,0);ctx.lineTo(xOf(e.rel)+0.5,H);ctx.stroke();
    }
  }else if(sel.type==='load'){
    const l=S.loads[sel.idx];if(!l)return;
    if(p===netPanel){
      const lane=Math.min(l.lane,LANE_DEFS.length-1),yh=lane*19+2;
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;
      ctx.strokeRect(xOf(l.start)-2,yh-2,Math.max(4,xOf(l.end)-xOf(l.start)+4),17);
    }
    if(p!==netPanel){ctx.strokeStyle='rgba(255,255,255,0.4)';ctx.beginPath();ctx.moveTo(xOf(l.start)+0.5,0);ctx.lineTo(xOf(l.start)+0.5,H);ctx.stroke()}
  }else if(sel.type==='stall'){
    const st=S.stalls[sel.idx];if(!st)return;
    const x0=xOf(st.start),x1=xOf(st.end);
    ctx.fillStyle='rgba(218,54,51,0.18)';ctx.fillRect(Math.max(0,x0),0,Math.min(W,x1)-Math.max(0,x0),H);
    ctx.strokeStyle='#f78166';ctx.setLineDash([4,3]);ctx.strokeRect(Math.max(0,x0)+0.5,0.5,Math.min(W,x1)-Math.max(0,x0)-1,H-1);ctx.setLineDash([]);
  }else if(sel.type==='operation'){
    const op=(S.operations||[])[sel.idx];
    if(op&&p===stOpsPanel){
      const {totalRows}=layoutOperationLanes(S.operations, S.fullRange);
      const rowHeight=Math.max(20,Math.floor(H/Math.max(1,totalRows)));
      const r=op.row!=null?op.row:0;
      const oy=r*rowHeight+2;
      const oh=rowHeight-4;
      const x0=xOf(op.start!=null?op.start:op.end);
      const x1=op.end!=null?xOf(op.end):xOf(S.fullRange);
      ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;
      ctx.strokeRect(Math.max(0,x0)-2,oy-1,Math.max(6,x1-x0+4),oh+2);
    }
    if(op&&p!==stOpsPanel){
      const x0=xOf(op.start!=null?op.start:op.end);
      ctx.strokeStyle='rgba(255,255,255,0.4)';ctx.beginPath();ctx.moveTo(x0+0.5,0);ctx.lineTo(x0+0.5,H);ctx.stroke();
    }
  }
}

/* ── panels ── */
let evtPanel,netPanel,stOpsPanel,stStatePanel,stQualPanel,stBufPanel,stBwPanel,stBrainPanel,stStartupPanel;
const BRAIN_COLORS={preparing:'#8b949e',selecting:'#bc4c8f',drm:'#f78166',buffering:'#d29922',playing:'#3fb950',rebuffer:'#da3633',seeking:'#e3b341',paused:'#6e7681',idle:'#30363d'};
const BRAIN_LABELS={preparing:'PREPARING',selecting:'SELECTING',drm:'DRM',buffering:'INIT BUFFER',playing:'PLAYING',rebuffer:'REBUFFER',seeking:'SEEKING',paused:'PAUSED',idle:'IDLE'};
function buildPanels(){
  addPanel('TIME','session · ms',26,(ctx,W,H)=>{
    const step=tickStep(S.view.v1-S.view.v0);
    ctx.font='8px ui-monospace,monospace';ctx.textBaseline='middle';
    for(let t=Math.ceil(S.view.v0/step)*step;t<=S.view.v1;t+=step){
      const x=xOf(t);if(x<0||x>W)continue;
      ctx.fillStyle='rgba(255,255,255,0.35)';
      ctx.fillRect(x-0.5,H-8,1,4);
      ctx.fillStyle='#8b949e';ctx.textAlign='center';
      ctx.fillText(t>=1000?(t/1000).toFixed(step>=60000?0:1)+'s':t+'ms',x,4);
    }
    ctx.textAlign='right';ctx.fillStyle='#484f58';
    ctx.fillText('🔍 wheel / pinch / +−',W-4,H-2);
  });
  stStatePanel=addPanel('STATE','playback',54,(ctx,W,H)=>{
    const top=4,midY=H/2-7;
    /* play segments */
    for(const ps of S.playSegs){
      const x0=xOf(ps.start),x1=xOf(ps.end);if(x1<0||x0>W)continue;
      ctx.fillStyle='rgba(63,185,80,0.18)';ctx.fillRect(Math.max(0,x0),top,Math.min(W,x1)-Math.max(0,x0),H-top-18);
    }
    if(S.startup){
      const x0=xOf(S.startup.start),x1=xOf(S.startup.end);
      ctx.fillStyle='rgba(210,153,34,0.16)';ctx.fillRect(Math.max(0,x0),top,Math.max(0,Math.min(W,x1)-Math.max(0,x0)),H-top-18);
      ctx.fillStyle='#d29922';ctx.font='7px ui-monospace';ctx.textBaseline='top';
      if(x1-x0>40)ctx.fillText('STARTUP',Math.max(2,x0+3),6);
    }
    /* stalls */
    for(const st of S.stalls){
      const x0=xOf(st.start),x1=xOf(st.end);if(x1<0||x0>W)continue;
      ctx.fillStyle='rgba(218,54,51,0.5)';ctx.fillRect(Math.max(0,x0),top,Math.max(2,Math.min(W,x1)-Math.max(0,x0)),H-top-18);
      ctx.fillStyle='#ffa198';ctx.font='7px ui-monospace';ctx.textBaseline='top';
      if(x1-x0>46)ctx.fillText('REBUFFER',Math.max(2,x0+3),6);
    }
    /* READY + FIRST FRAME vertical lines */
    if(S.firstReady!=null){
      const x=xOf(S.firstReady);if(x>=0&&x<=W){
        ctx.strokeStyle='rgba(63,185,80,0.75)';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x+0.5,top);ctx.lineTo(x+0.5,H-18);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle='#3fb950';ctx.font='7px ui-monospace';ctx.textBaseline='top';ctx.textAlign='center';ctx.fillText('READY',x,top);
      }
    }
    if(S.firstFrame){
      const x=xOf(S.firstFrame.rel);if(x>=0&&x<=W){
        ctx.strokeStyle='rgba(88,166,255,0.8)';ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(x+0.5,top);ctx.lineTo(x+0.5,H-18);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle='#58a6ff';ctx.font='7px ui-monospace';ctx.textBaseline='top';ctx.textAlign='center';ctx.fillText('1ST FRAME',x,top);
      }
    }
    /* markers */
    for(const m of S.markers){
      const x=xOf(m.t);if(x<0||x>W)continue;
      ctx.font='9px ui-monospace';ctx.textAlign='center';ctx.textBaseline='middle';
      const sym={play:'▶',pause:'⏸',end:'■',seek:'⤳',firstframe:'☆',release:'◈',drmrel:'✕',qswitch:'⇄',aswitch:'⇄',tswitch:'⇄'}[m.type]||'•';
      const col={play:'#3fb950',pause:'#d29922',end:'#bc4c8f',seek:'#e3b341',firstframe:'#58a6ff',release:'#6e7681',drmrel:'#f78166',qswitch:'#8957e5',aswitch:'#3fb950',tswitch:'#d2a8ff'}[m.type]||'#8b949e';
      ctx.fillStyle=col;ctx.fillText(sym,x,midY+2);
      if(x<xOf(S.view.v1)-34&&m.type==='seek'){ctx.textAlign='left';ctx.fillStyle='#e3b341';ctx.font='6.5px ui-monospace';ctx.fillText('SEEK',x+2,midY+2)}
    }
    /* legend */
    ctx.textAlign='left';ctx.textBaseline='middle';ctx.font='7.5px ui-monospace';
    ctx.fillStyle='#6e7681';ctx.fillText('legend: ',3,H-9);
    let lx=40;
    const leg=[['▶','play','#3fb950'],['⏸','pause','#d29922'],['⤳','seek','#e3b341'],['☆','1st frame','#58a6ff'],['■','ended','#bc4c8f'],['⇄','quality','#8957e5'],['✕','drm rel','#f78166'],['◈','release','#6e7681']];
    for(const[g,lab,col]of leg){
      ctx.fillStyle=col;ctx.fillText(g,lx,H-9);const w=ctx.measureText(g).width;
      ctx.fillStyle='#8b949e';ctx.fillText(lab,lx+w+2,H-9);
      lx+=w+2+ctx.measureText(lab).width+14;
    }
  });
  stBrainPanel=addPanel('BRAIN','player intent',26,(ctx,W,H)=>{
    const y=4,h=18;
    for(const ph of S.brainPhases||[]){
      const x0=xOf(ph.start),x1=xOf(ph.end);if(x1<0||x0>W)continue;
      const c=BRAIN_COLORS[ph.kind]||'#30363d';
      ctx.fillStyle=c+'cc';
      ctx.fillRect(Math.max(0,x0),y,Math.max(1,Math.min(W,x1)-Math.max(0,x0)),h);
      if(x1-x0>34&&ph.kind!=='idle'){
        ctx.fillStyle=ph.kind==='rebuffer'||ph.kind==='seeking'||ph.kind==='buffering'?'#0d1117':'#e6edf3';
        ctx.font='6.5px ui-monospace';ctx.textBaseline='middle';ctx.textAlign='left';
        ctx.fillText(BRAIN_LABELS[ph.kind],Math.max(2,x0+3),y+h/2+1);
      }
    }
    ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.strokeRect(0,y,W,h);
  });
  stStartupPanel=addPanel('STARTUP','wait vs work',44,(ctx,W,H)=>{
    const y=6,h=13;
    const stages=(S.startupStages||[]).filter(s=>s.dur>1);
    if(!stages.length){ctx.fillStyle='#484f58';ctx.font='8px ui-monospace';ctx.textBaseline='middle';ctx.fillText('no startup stages (needs timeline/decoder events)',4,H/2+1);return}
    for(const st of stages){
      const x0=xOf(st.start),x1=xOf(st.end);if(x1<0||x0>W)continue;
      ctx.fillStyle=st.color+'bb';
      ctx.fillRect(Math.max(0,x0),y,Math.max(1.5,Math.min(W,x1)-Math.max(0,x0)),h);
      if(S.blocking===st){ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(Math.max(0,x0)+0.5,y+0.5,Math.max(1.5,Math.min(W,x1)-Math.max(0,x0))-1,h-1)}
      if(x1-x0>40){
        ctx.fillStyle='#e6edf3';ctx.font='7px ui-monospace';ctx.textBaseline='middle';ctx.textAlign='left';
        ctx.fillText(st.name,Math.max(3,x0+3),y+h/2+1);
      }
    }
    if(S.firstReady!=null){const x=xOf(S.firstReady);ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x+0.5,2);ctx.lineTo(x+0.5,H-2);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#e6edf3';ctx.font='7px ui-monospace';ctx.textBaseline='top';ctx.textAlign='center';ctx.fillText('READY',x,0)}
    if(S.firstFrame){const x=xOf(S.firstFrame.rel);ctx.fillStyle='#58a6ff';ctx.font='7px ui-monospace';ctx.textBaseline='top';ctx.textAlign='center';ctx.fillText('FIRST FRAME',x,0)}
  });
  stQualPanel=addPanel('QUALITY','bitrate ladder',68,(ctx,W,H)=>{
    const hasText=(S.quality[3]||[]).length>0;
    const yT=6,yA=hasText?24:34,yX=42,rowH=hasText?18:20;
    ctx.font='8px ui-monospace';ctx.textBaseline='middle';
    const maxQ=Math.max(2000,...(S.quality[2]||[]).map(s=>s.kbps),800);
    for(const tt of[2,1,3]){
      const steps=S.quality[tt]||[];
      if(tt===3&&!hasText)continue;
      const y=tt===2?yT:(tt===1?yA:yX);
      ctx.fillStyle='#6e7681';ctx.fillText(tt===2?'VIDEO':tt===1?'AUDIO':'SUBS',2,y+rowH/2);
      if(!steps.length)continue;
      let hue=0;
      for(const st of steps){
        hue=st.kbps/maxQ;
        const x0=xOf(st.t),x1=xOf(st.end);
        ctx.fillStyle=tt===2?`rgba(31,111,235,${0.25+hue*0.65})`:tt===1?`rgba(63,185,80,0.45)`:`rgba(210,168,255,0.4)`;
        ctx.fillRect(Math.max(0,x0),y,Math.max(1,Math.min(W,x1)-Math.max(0,x0)),rowH);
      }
      ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.strokeRect(0,y,W,rowH);
      for(const st of steps){
        const x0=xOf(st.t),x1=xOf(st.end);
        if(x1-x0>54){
          ctx.fillStyle='#fff';
          const label=(st.h>0?st.h+'p · ':'')+(st.lang?st.lang+' · ':'')+fmtKbpsInt(st.kbps);
          const tw=ctx.measureText(label).width;
          if(tw+6<x1-x0){ctx.textAlign='left';ctx.fillText(label,Math.max(3,x0+3),y+rowH/2+1)}
        }
        /* switch tick at each step boundary (not the first step) */
        if(st.t>(steps[0].t)){
          const sx=Math.max(0,xOf(st.t));
          ctx.strokeStyle='#d2a8ff';ctx.lineWidth=1.5;
          ctx.beginPath();ctx.moveTo(sx+0.5,y-3);ctx.lineTo(sx+0.5,y+rowH+3);ctx.stroke();
          ctx.fillStyle='#d2a8ff';ctx.fillText('⇄',sx+2,y+rowH/2);
          ctx.lineWidth=1;
        }
      }
    }
    /* footer: quality switch note + legend (own strip, no overlap) */
    ctx.fillStyle='rgba(22,27,34,0.8)';ctx.fillRect(0,60,W,8);
    const ff=S.markers.find(m=>m.type==='qswitch');
    if(ff){
      const note='⇄ quality ↑ '+fmtKbpsInt(ff.to)+' @'+fmtDur(ff.t-S.events[0]?.rel);
      ctx.textAlign='left';ctx.fillStyle='#d2a8ff';ctx.font='7px ui-monospace';ctx.textBaseline='middle';
      ctx.fillText(note,4,64);
    }
    ctx.textAlign='right';ctx.fillStyle='#6e7681';ctx.font='7px ui-monospace';
    ctx.fillText('blue = video · green = audio · violet = subs · ⇄ = switch',W-4,64);
  });
  stBufPanel=addPanel('BUFFER','ms of media',62,(ctx,W,H)=>{
    const pts=S.bufferSamples;
    ctx.fillStyle='#484f58';ctx.font='8px ui-monospace';ctx.textBaseline='middle';
    const maxB=Math.max(5000,...pts.map(p=>p.v),2000);
    ctx.fillStyle='rgba(255,255,255,0.06)';
    ctx.fillRect(0,H-2,100,1);
    const yOf=v=>H-4-(Math.min(v,maxB)/maxB)*(H-14);
    if(pts.length){
      ctx.beginPath();
      for(let i=0;i<pts.length;i++){const x=xOf(pts[i].t),y=yOf(pts[i].v);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
      ctx.lineTo(xOf(pts[pts.length-1].t),yOf(0));ctx.lineTo(xOf(pts[0].t),yOf(0));ctx.closePath();
      const g=ctx.createLinearGradient(0,H,0,0);g.addColorStop(0,'rgba(63,185,80,0.02)');g.addColorStop(1,'rgba(63,185,80,0.30)');
      ctx.fillStyle=g;ctx.fill();
      ctx.strokeStyle='#3fb950';ctx.lineWidth=1.5;ctx.beginPath();
      for(let i=0;i<pts.length;i++){const x=xOf(pts[i].t),y=yOf(pts[i].v);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
      ctx.stroke();
      ctx.fillStyle='#3fb950';
      for(const p of pts){const x=xOf(p.t);ctx.beginPath();ctx.arc(x,yOf(p.v),2.2,0,7);ctx.fill()}
      /* value labels */
      ctx.font='8px ui-monospace';ctx.fillStyle='#7ee787';
      for(const p of pts){const x=xOf(p.t);if(x>8&&x<W-8&&p.v>500){ctx.textAlign=x>W-50?'right':'left';ctx.fillText(fmtDur(p.v),x+(x>W-50?-4:4),yOf(p.v)-4)}}
    }
    ctx.fillStyle='#484f58';ctx.textAlign='left';
    ctx.fillText('0',2,H-2);ctx.textAlign='right';ctx.fillText(fmtDur(maxB),W-2,8);
    ctx.fillStyle='rgba(255,255,255,0.04)';ctx.fillRect(0,yOf(maxB/2),W,1);
  });
  stBwPanel=addPanel('BANDWIDTH','actual vs ABR est',96,(ctx,W,H)=>{
    const y0=H-16,ymax=Math.max(3500,...S.loads.map(l=>l.kbps),...(S.estimates.map(e=>e.kbps)),3000);
    const yOf=k=>y0-(Math.min(k,ymax)/ymax)*(H-30);
    ctx.fillStyle='#484f58';ctx.font='7px ui-monospace';ctx.textBaseline='middle';
    ctx.textAlign='left';
    for(const g of[1000,2000,3000,4000,ymax]){
      if(g>ymax*0.99)continue;
      ctx.strokeStyle='rgba(255,255,255,0.04)';ctx.beginPath();ctx.moveTo(0,yOf(g));ctx.lineTo(W,yOf(g));ctx.stroke();
      ctx.fillStyle='#6e7681';ctx.fillText(fmtKbpsInt(g)+'b',3,yOf(g));
    }
    /* actual bars */
    for(const l of S.loads){
      if(l.kbps<=0)continue;
      const x0=xOf(l.start),x1=xOf(l.end);if(x1<0||x0>W)continue;
      const bw=Math.max(1.5,x1-x0);
      const col=l.lane===4?'rgba(63,185,80,0.75)':'rgba(31,111,235,0.8)';
      ctx.fillStyle=col;
      ctx.fillRect(Math.max(0,x0),yOf(l.kbps),bw,y0-yOf(l.kbps));
      if(l.slow||l.crit){ctx.strokeStyle=l.crit?'#f78166':'#d29922';ctx.lineWidth=1;ctx.strokeRect(Math.max(0,x0),yOf(l.kbps),bw,y0-yOf(l.kbps))}
    }
    /* ABR estimate line */
    if(S.estimates.length>1){
      const pts=S.estimates;
      ctx.beginPath();
      for(let i=0;i<pts.length;i++){const x=xOf(pts[i].t),y=yOf(pts[i].kbps);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
      ctx.strokeStyle='rgba(88,166,255,0.25)';ctx.lineWidth=4;ctx.stroke();
      ctx.strokeStyle='#58a6ff';ctx.lineWidth=1.4;ctx.stroke();
      ctx.fillStyle='#58a6ff';
      for(const p of pts){const x=xOf(p.t);ctx.fillRect(x-1,yOf(p.kbps)-1,2,2)}
    }
    /* legend */
    ctx.font='7.5px ui-monospace';ctx.textBaseline='middle';
    ctx.fillStyle='#58a6ff';ctx.fillText('━ ABR estimate',6,10);
    ctx.fillStyle='#1f6feb';ctx.fillRect(110,7,8,6);ctx.fillStyle='#c9d1d9';ctx.fillText('actual video',122,10);
    ctx.fillStyle='#3fb950';ctx.fillRect(170,7,8,6);ctx.fillStyle='#c9d1d9';ctx.fillText('actual audio',182,10);
    ctx.fillStyle='#f78166';ctx.fillText('▣ slow',240,10);
  });
  netPanel=addPanel('NETWORK','waterfall',118,(ctx,W,H)=>{
    ctx.font='7px ui-monospace';ctx.textBaseline='middle';ctx.fillStyle='#6e7681';
    for(let i=0;i<LANE_DEFS.length;i++){
      const y=i*19;
      ctx.fillStyle='rgba(255,255,255,0.02)';ctx.fillRect(0,y,W,18);
      ctx.fillStyle='#6e7681';ctx.textAlign='left';ctx.fillText(LANE_DEFS[i].label,3,y+9);
    }
    for(const l of S.loads){
      const x0=xOf(l.start),x1=xOf(l.end);if(x1<0||x0>W)continue;
      const y=Math.min(l.lane,LANE_DEFS.length-1)*19+2,bw=Math.max(2,x1-x0);
      ctx.fillStyle=LANE_DEFS[Math.min(l.lane,LANE_DEFS.length-1)].color+'cc';
      ctx.fillRect(Math.max(0,x0),y,bw,14);
      if(l.retried){ctx.fillStyle='#ff5252';ctx.beginPath();ctx.moveTo(Math.max(0,x0)+2,y+1);ctx.lineTo(Math.max(0,x0)+7,y+1);ctx.lineTo(Math.max(0,x0)+4.5,y+6);ctx.closePath();ctx.fill()}
      if(l.slow||l.crit){ctx.strokeStyle=l.crit?'#f78166':'#d29922';ctx.lineWidth=1;ctx.strokeRect(Math.max(0,x0)+0.5,y+0.5,bw-1,13)}
    }
  });
  stOpsPanel=addPanel('OPERATIONS','paired spans',44,(ctx,W,H)=>{
    const ops=S.operations||[];
    if(!ops.length){
      ctx.fillStyle='#484f58';ctx.font='8px ui-monospace,monospace';ctx.textBaseline='middle';
      ctx.fillText('no paired operations observed (_start / _end events)',4,H/2+1);
      return;
    }
    const {opTypes,typeMap,totalRows}=layoutOperationLanes(ops,S.fullRange);
    const rowHeight=Math.max(18,Math.floor(H/Math.max(1,totalRows)));
    ctx.font='7px ui-monospace,monospace';ctx.textBaseline='middle';
    for(const op of ops){
      const r=op.row!=null?op.row:0;
      const y=r*rowHeight+2;
      const h=rowHeight-4;
      const baseColor=colorForOp(op.operation,op.category);
      if(op.status==='completed'){
        const x0=xOf(op.start);
        const x1=xOf(op.end);
        if(x1<0||x0>W)continue;
        const bw=Math.max(4,x1-x0);
        ctx.fillStyle=baseColor+'bb';
        ctx.fillRect(Math.max(0,x0),y,Math.min(W,bw),h);
        ctx.strokeStyle=baseColor;ctx.lineWidth=1;
        ctx.strokeRect(Math.max(0,x0)+0.5,y+0.5,Math.min(W,bw)-1,h-1);
        if(bw>24){
          ctx.fillStyle='#ffffff';ctx.textAlign='left';
          const labelText=op.operation+' ('+fmtDur(op.dur)+')';
          ctx.fillText(labelText,Math.max(2,x0+3),y+h/2+0.5);
        }
      }else if(op.status==='incomplete'){
        const x0=xOf(op.start);
        const x1=xOf(S.fullRange||op.start+2000);
        if(x1<0||x0>W)continue;
        const bw=Math.max(10,x1-x0);
        ctx.fillStyle=baseColor+'44';
        ctx.fillRect(Math.max(0,x0),y,Math.min(W,bw),h);
        ctx.strokeStyle=baseColor;ctx.setLineDash([4,3]);
        ctx.strokeRect(Math.max(0,x0)+0.5,y+0.5,Math.min(W,bw)-1,h-1);
        ctx.setLineDash([]);
        if(bw>24){
          ctx.fillStyle='#e3b341';ctx.textAlign='left';
          ctx.fillText('⚡ '+op.operation+' [active]',Math.max(2,x0+3),y+h/2+0.5);
        }
      }else if(op.status==='unmatched_end'){
        const x1=xOf(op.end);
        if(x1<0||x1>W)continue;
        ctx.fillStyle='#ff5252';ctx.beginPath();
        ctx.arc(x1,y+h/2,4,0,7);ctx.fill();
        ctx.fillStyle='#ffa198';ctx.textAlign='left';
        ctx.fillText('⚠ '+op.operation+'_end (unmatched)',x1+6,y+h/2+0.5);
      }
    }
  });
  evtPanel=addPanel('EVENTS','all categories',40,(ctx,W,H)=>{
    const rows=visibleRows();
    ctx.font='7px ui-monospace';ctx.textBaseline='middle';
    for(let ri=0;ri<rows.length;ri++){
      const cat=rows[ri],evs=S.categories[cat]||[];
      const y0=ri*ROWH;
      ctx.fillStyle='rgba(255,255,255,0.015)';ctx.fillRect(0,y0,W,ROWH);
      ctx.strokeStyle='rgba(255,255,255,0.03)';ctx.beginPath();ctx.moveTo(0,y0+ROWH);ctx.lineTo(W,y0+ROWH);ctx.stroke();
      for(const e of evs){
        const x=xOf(e.rel);if(x<-8||x>W+8)continue;
        const matched=S.filterText&&evtMatches(e);
        const dim=S.filterText&&!matched?0.15:0.75;
        ctx.globalAlpha=dim;
        if(e.duration>0){
          ctx.fillStyle=e.color;
          const w=Math.max(2,xOf(e.rel+e.duration)-x);
          ctx.fillRect(x,y0+4,Math.min(w,W-x),ROWH-8);
        }else{
          ctx.fillStyle=e.color;
          ctx.fillRect(x-1.5,y0+5,3,ROWH-10);
          if(matched){ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(x-3,y0+3,7,ROWH-6)}
        }
        ctx.globalAlpha=1;
      }
    }
  });
}

function visibleRows(){return CAT_ORDER.filter(c=>(S.categories[c]||[]).length>0&&!S.hiddenCats.has(c))}
function evtMatches(e){
  const q=S.filterText.toLowerCase();
  if(!q)return true;
  const d=e.details||{};
  return String(e.event||'').toLowerCase().includes(q)||String(e.category||'').toLowerCase().includes(q)
    ||String(e.cat||'').toLowerCase().includes(q)||String(d.uri||'').toLowerCase().includes(q)
    ||String(d.decoder||'').toLowerCase().includes(q)||String(d.mimeType||'').toLowerCase().includes(q)
    ||String(d.codecs||'').toLowerCase().includes(q)||String(d.dataType||'').toLowerCase().includes(q);
}

/* ── minimap ── */
function drawMinimap(){
  const cv=minimapEl,ctx=cv.getContext('2d');
  const cw=W,ch=cv._h=cv.clientHeight||44;
  ctx.setTransform((window.devicePixelRatio||1),0,0,(window.devicePixelRatio||1),0,0);
  ctx.clearRect(0,0,cw,ch);
  ctx.fillStyle='#0d1117';ctx.fillRect(0,0,cw,ch);
  const range=S.fullRange,nb=200,bins=new Array(nb).fill(0);
  for(const e of S.events){const b=Math.floor(e.rel/range*nb);if(b>=0&&b<nb)bins[b]++}
  const max=Math.max(1,...bins);
  ctx.strokeStyle='#2a3442';
  ctx.beginPath();
  for(let i=0;i<nb;i++){const x=i/nb*cw,y=ch-2-bins[i]/max*(ch-8);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)}
  ctx.lineTo(cw,ch);ctx.lineTo(0,ch);ctx.closePath();
  ctx.fillStyle='rgba(88,166,255,0.10)';ctx.fill();
  for(const st of S.stalls){ctx.fillStyle='rgba(218,54,51,0.8)';ctx.fillRect(st.start/range*cw,0,Math.max(1,st.end/range*cw-st.start/range*cw),ch)}
  ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=1;
  const x0=S.view.v0/range*cw,x1=S.view.v1/range*cw;
  ctx.strokeRect(x0+0.5,0.5,Math.max(3,x1-x0)-1,ch-1);
  ctx.fillStyle='rgba(88,166,255,0.08)';ctx.fillRect(x0,0,x1-x0,ch);
}

/* ═══════════════════════════ HEADER / KPI / CHIPS ═══════════════════════════ */
function renderHeader(){
  const s=S.session;
  const start=new Date(s.startedAtEpochMs||Date.now());
  const sse=S.events.find(e=>e.event==='SessionStart');
  const devInfo=sse?.details?.device ? ` · 📱 ${sse.details.device}${sse.details.android ? ' (Android ' + sse.details.android + ')' : ''}` : '';
  $('meta').textContent=`${s.packageName||'?'} · ${s.id||''}${devInfo} · started ${start.toLocaleString()} · schema ${S.raw.schemaVersion||'?'} · ${S.events.length} events`;
  const renderKpiValue=value=>{
    const text=String(value??'');
    const m=text.match(/^(\d[\d.,]*)\s+(ms|s|sec|Mbps|kbps|MB|GB)$/i);
    return m?`${esc(m[1])}<span class=\"unit\">${esc(m[2])}</span>`:esc(text);
  };
  kpisEl.innerHTML=S.kpis.map((k,i)=>{
    const hasPop = (k.type === 'errors' || k.type === 'quality');
    const hint = hasPop ? `<span class=\"pop-hint\">details ▾</span>` : '';
    return `<div class=\"kpi ${k.cls||''}${hasPop ? ' has-pop' : ''}\" data-kpi-type=\"${esc(k.type||'')}\" data-kpi-idx=\"${i}\">
      <div class=\"v\" data-full=\"${esc([k.v,k.s].filter(Boolean).join(' · '))}\">${renderKpiValue(k.v)}</div>
      <div class=\"l\">${esc(k.l)}${hint}</div>
      <div class=\"s\" title=\"${esc(k.s||'')}\">${esc(k.s||'')}</div>
    </div>`;
  }).join('') + renderTracksCardHtml();
  requestAnimationFrame(()=>{
    kpisEl.querySelectorAll('.kpi .v').forEach(v=>{
      const clipped=v.scrollWidth>v.clientWidth;
      if(clipped){v.title=v.dataset.full||'';v.classList.add('truncated')}
      else{v.removeAttribute('title');v.classList.remove('truncated')}
    });

    kpisEl.querySelectorAll('.kpi.has-pop').forEach(kpiEl=>{
      const type = kpiEl.dataset.kpiType;
      kpiEl.addEventListener('mouseenter',()=>{
        clearTimeout(popTimer);
        if(popPinned && activePopType === type) return;
        popPinned = false;
        let html = '';
        if(type === 'errors') html = renderErrorsPopover();
        else if(type === 'quality') html = renderQualityPopover();
        else if(type === 'tracks') html = renderTracksPopover();
        if(html){
          activePopType = type;
          showKpiPop(kpiEl, html);
          attachPopHandlers(type);
        }
      });
      kpiEl.addEventListener('mouseleave',()=>{
        if(!popPinned){
          popTimer = setTimeout(closeKpiPop, 250);
        }
      });
      kpiEl.addEventListener('click',(ev)=>{
        if(activePopType === type && popPinned){
          forceCloseKpiPop();
        } else {
          clearTimeout(popTimer);
          let html = '';
          if(type === 'errors') html = renderErrorsPopover();
          else if(type === 'quality') html = renderQualityPopover();
          if(html){
            activePopType = type;
            popPinned = true;
            showKpiPop(kpiEl, html);
            attachPopHandlers(type);
          }
        }
        ev.stopPropagation();
      });
    });
  });
  const cats=CAT_ORDER.filter(c=>(S.categories[c]||[]).length>0);
  chipsEl.innerHTML=cats.map(c=>{
    const col=CAT_COLORS[c];
    return `<span class=\"chip${S.hiddenCats.has(c)?' hidden':''}\" data-cat=\"${c}\" style=\"border-left:3px solid ${col}\">${CAT_LABELS[c]||c.toUpperCase()} <span class=\"n\">${S.categories[c].length}</span></span>`;
  }).join('');
  chipsEl.querySelectorAll('.chip').forEach(ch=>ch.addEventListener('click',()=>{
    const c=ch.dataset.cat;
    if(S.hiddenCats.has(c))S.hiddenCats.delete(c);else S.hiddenCats.add(c);
    ch.classList.toggle('hidden');
    layoutPanels();
    updateStatus();
  }));
}

/* ═══════════════════════════ KPI POPOVER ═══════════════════════════ */
let activePopType = null;
let popPinned = false;
let popTimer = null;

function closeKpiPop(){
  if(popPinned) return;
  if(kpiPopEl) kpiPopEl.style.display = 'none';
  activePopType = null;
}

function forceCloseKpiPop(){
  popPinned = false;
  clearTimeout(popTimer);
  if(kpiPopEl) kpiPopEl.style.display = 'none';
  activePopType = null;
}

function showKpiPop(targetEl, html){
  if(!kpiPopEl) return;
  kpiPopEl.innerHTML = html;
  kpiPopEl.style.display = 'flex';
  const r = targetEl.getBoundingClientRect();
  const popW = Math.min(520, Math.max(340, window.innerWidth - 32));
  kpiPopEl.style.width = popW + 'px';

  let left = r.left;
  if(left + popW > window.innerWidth - 16){
    left = Math.max(16, window.innerWidth - 16 - popW);
  }

  const popH = kpiPopEl.offsetHeight || 320;
  let top = r.bottom + 8;
  if(top + popH > window.innerHeight - 16 && r.top > popH + 16){
    top = r.top - popH - 8;
  }
  kpiPopEl.style.left = Math.max(16, Math.round(left)) + 'px';
  kpiPopEl.style.top = Math.max(16, Math.round(top)) + 'px';
}

function renderErrorsPopover(){
  const errs = S.errors || [];
  if(!errs.length) return '';
  const errCounts = {};
  for(const e of errs) errCounts[e.event || 'Error'] = (errCounts[e.event || 'Error'] || 0) + 1;

  const msgs = errs.map(e => e.details?.message || e.details?.errorCodeName || '').filter(Boolean);
  const commonMsg = msgs[0] || '';

  let html = `
    <div class="kpi-pop-head">
      <div class="kpi-pop-title">
        <span style="color:#f85149">⚠️</span> Playback Errors (${errs.length})
        <span class="kpi-pop-badge bad">Critical</span>
      </div>
      <span style="font-size:0.65rem;color:#8b949e">first @ +${fmtDur(errs[0].rel - (S.events[0]?.rel || 0))}</span>
    </div>
    <div class="kpi-pop-body">
      <div class=\"kpi-pop-chips\">
        ${Object.entries(errCounts).map(([k,v]) => `<span class=\"kpi-pop-chip bad\">${v}× ${esc(k)}</span>`).join('')}
      </div>
  `;

  if(commonMsg){
    html += `
      <div style=\"background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.25);border-radius:8px;padding:8px 10px;font-size:0.68rem;color:#ff7b72;line-height:1.4\">
        <b>Primary cause:</b> ${esc(commonMsg.slice(0, 160))}${commonMsg.length > 160 ? '…' : ''}
      </div>
    `;
  }

  html += `<div style=\"font-size:0.65rem;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em;margin-top:2px\">Error Event Feed (${errs.length})</div>`;
  html += `<div style=\"display:flex;flex-direction:column;gap:6px\">`;

  const baseT = S.events[0]?.rel || 0;
  errs.forEach((e, idx) => {
    const d = e.details || {};
    const errCode = d.errorCodeName || (d.errorCode != null ? 'CODE ' + d.errorCode : '');
    const msg = d.message || d.error || '';
    const uri = d.uri ? shortUri(d.uri) : '';
    const relSec = '+' + fmtDur(e.rel - baseT);
    html += `
      <div class=\"kpi-err-item\" data-evt-idx=\"${e.idx}\" title=\"Click to view details in inspector\">
        <div class=\"kpi-err-header\">
          <span class=\"kpi-err-name\">#${idx+1} ${esc(e.event || 'Error')}</span>
          <span class=\"kpi-err-time\">${esc(relSec)}</span>
        </div>
        ${errCode ? `<div class=\"kpi-err-code\">${esc(errCode)}</div>` : ''}
        ${msg ? `<div class=\"kpi-err-msg\">${esc(msg.slice(0, 180))}${msg.length > 180 ? '…' : ''}</div>` : ''}
        ${uri ? `<div style=\"font-size:0.63rem;color:#79c0ff;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">🔗 ${esc(uri)}</div>` : ''}
      </div>
    `;
  });

  html += `</div></div>`;
  html += `
    <div class=\"kpi-pop-foot\">
      <span>💡 Click any error to inspect in drawer</span>
      <button class=\"mini-btn\" id=\"btnPopViewAllErrors\" style=\"border-color:#da3633;color:#ffa198\">Open in Table ➔</button>
    </div>
  `;
  return html;
}

function renderQualityPopover(){
  const rungs = S.vRungs || [];
  const switches = S.vSwitches || [];
  if(!rungs.length) return '';

  let html = `
    <div class=\"kpi-pop-head\">
      <div class=\"kpi-pop-title\"><span style=\"color:#79c0ff\">📶</span> Quality Progression</div>
      <span class=\"kpi-pop-badge ${switches.length > 1 ? 'warn' : 'good'}\">${switches.length} switches</span>
    </div>
    <div class=\"kpi-pop-body\">
      <div class=\"ql-ladder-bar\">
  `;

  const totalD = rungs.reduce((a,b)=>a+b.dur,0) || 1;
  rungs.forEach((r, idx) => {
    const pct = (r.dur / totalD * 100);
    if(pct < 1) return;
    const level = r.h >= 1080 ? 4 : r.h >= 720 ? 3 : r.h >= 480 ? 2 : 1;
    html += `<div class=\"ql-segment rung-${level}\" style=\"width:${pct}%\" title=\"${r.h}p @ ${fmtKbpsInt(r.kbps)} (${fmtDur(r.dur)})\">${r.h?r.h+'p':''}</div>`;
  });

  html += `</div><table class=\"ql-table\"><thead><tr><th>Time</th><th>Change</th><th>Resolution</th><th>Bitrate</th><th></th></tr></thead><tbody>`;

  rungs.forEach((r, idx) => {
    const prev = rungs[idx-1];
    const isUp = prev ? r.kbps > prev.kbps : true;
    const time = idx === 0 ? 'START' : '+' + fmtDur(r.t - (S.events[0]?.rel || 0));
    html += `
      <tr class=\"ql-row\" onclick=\"setView(${r.t-2000},${r.t+2000});select({type:'event',idx:${r.idx}})\">
        <td>${esc(time)}</td>
        <td>${idx===0?'—':`<span class=\"ql-arrow ${isUp?'':'down'}\">${isUp?'▲':'▼'}</span>`}</td>
        <td style=\"font-weight:700\">${r.h?r.h+'p':'—'}</td>
        <td style=\"color:#8b949e\">${fmtKbpsInt(r.kbps)}</td>
        <td><button class=\"ql-btn-jump\">jump ➔</button></td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  html += `<div class=\"kpi-pop-foot\"><span>💡 Hover timeline for point-in-time info</span></div>`;
  return html;
}

function renderTracksCardHtml(){
  const avail=S.availableTracks||{1:[],2:[],3:[],4:[]};
  const parts=[];
  const order=[[2,'#58a6ff'],[1,'#7ee787'],[3,'#d2a8ff']];
  for(const[tt,col] of order){
    const list=avail[tt]||[];
    if(list.length) parts.push(`<span style=\"color:${col}\">${metaEmoji(tt)} ${list.length}</span>`);
  }
  if(!parts.length) return '';
  return `<div class=\"kpi has-pop\" data-kpi-type=\"tracks\"><div class=\"v\">${parts.join(' · ')}</div><div class=\"l\">Manifest Tracks<span class=\"pop-hint\">details ▾</span></div><div class=\"s\">${(avail[2]||[]).length} video · ${(avail[1]||[]).length} audio</div></div>`;
}

function attachPopHandlers(type){
  if(type === 'errors'){
    kpiPopEl.querySelectorAll('.kpi-err-item').forEach(el=>{
      el.onclick = () => { select({type:'event', idx:+el.dataset.evtIdx}); forceCloseKpiPop(); };
    });
    const btnTable = $('btnPopViewAllErrors');
    if(btnTable) btnTable.onclick = () => { openModal(); forceCloseKpiPop(); };
  }
}

function showTip(html,x,y){
  tipEl.innerHTML=html;tipEl.style.display='block';
  const tw=tipEl.clientWidth,th=tipEl.clientHeight;
  let tx=x+15,ty=y+15;
  if(tx+tw>window.innerWidth-10)tx=x-tw-15;
  if(ty+th>window.innerHeight-10)ty=y-th-15;
  tipEl.style.left=tx+'px';tipEl.style.top=ty+'px';
}
function hideTip(){tipEl.style.display='none'}

function eventTip(e){
  const d=e.details||{};
  let h=`<div class=\"t\">${esc(e.event)}</div><div class=\"d\">${e.cat.toUpperCase()} · ${fmtDur(e.rel-(S.events[0]?.rel||0))}</div>`;
  if(d.uri)h+=`<div class=\"row\"><span class=\"k\">URI:</span> ${esc(shortUri(d.uri))}</div>`;
  if(d.playbackState!=null)h+=`<div class=\"row\"><span class=\"k\">State:</span> ${PSTATE[d.playbackState]||d.playbackState}</div>`;
  if(d.errorCodeName)h+=`<div class=\"row bad\"><span class=\"k\">Error:</span> ${esc(d.errorCodeName)}</div>`;
  if(d.bitrate)h+=`<div class=\"row\"><span class=\"k\">Bitrate:</span> ${fmtKbps(d.bitrate/1000)}</div>`;
  return h;
}
function loadTip(l){
  let h=`<div class=\"t\">${LANE_DEFS[l.lane].label} download</div><div class=\"d\">${fmtDur(l.dur)} · ${fmtKbps(l.kbps)}</div>`;
  if(l.cdnCache)h+=`<div class=\"row\"><span class=\"k\">CDN:</span> <b style=\"color:${l.cdnCache==='HIT'?'#3fb950':'#d29922'}\">${l.cdnCache}</b></div>`;
  h+=`<div class=\"row\" style=\"font-size:0.6rem;opacity:0.8;word-break:break-all\">${esc(shortUri(l.uri))}</div>`;
  return h;
}
function stallTip(s){return `<div class=\"t bad\">REBUFFER</div><div class=\"d\">${fmtDur(s.end-s.start)} stall</div><div class=\"row\"><span class=\"k\">Started:</span> ${fmtDur(s.start-(S.events[0]?.rel||0))}</div>`}
function markerTip(m){
  const labels={play:'Playback Started',pause:'Playback Paused',seek:'Seek Performed',end:'Playback Ended',firstframe:'First Frame Rendered'};
  let h=`<div class=\"t\">${labels[m.type]||m.type.toUpperCase()}</div><div class=\"d\">@ ${fmtDur(m.t-(S.events[0]?.rel||0))}</div>`;
  if(m.type==='seek')h+=`<div class=\"row\"><span class=\"k\">From:</span> ${fmtDur(m.from)} ➔ ${fmtDur(m.to)}</div>`;
  if(m.type==='qswitch')h+=`<div class=\"row\"><span class=\"k\">Switch:</span> ${fmtKbpsInt(m.from)} ➔ ${fmtKbpsInt(m.to)}</div>`;
  return h;
}
function stageTip(s){return `<div class=\"t\">Startup: ${esc(s.name)}</div><div class=\"d\">${fmtDur(s.dur)} duration</div><div class=\"row\"><span class=\"k\">Range:</span> ${fmtDur(s.start)} - ${fmtDur(s.end)}</div>`}

function nearestEventInView(){
  const rows=visibleRows();
  let best=null,bd=10;
  for(let ri=0;ri<rows.length;ri++){
    const cat=rows[ri],evs=S.categories[cat]||[];
    for(const e of evs){
      const dx=Math.abs(xOf(e.rel)-xOf(S.hoverT)),dy=Math.abs(ri*ROWH+ROWH/2-(hoverY-stackEl.getBoundingClientRect().top-panels[+evtPanel.canvas.dataset.panel].canvas.offsetTop));
      if(dx<bd&&dy<ROWH){bd=dx;best={e,ri}}
    }
  }
  return best;
}
function nearestLoad(t){
  let best=null,bd=8;
  for(const l of S.loads){
    const mx=xOf(t);
    if(l.start<=t&&t<=l.end&&Math.abs(mx-(xOf(l.start)+xOf(l.end))/2)<bd){bd=Infinity;best=l;break}
    const d=Math.min(Math.abs(xOf(l.start)-mx),Math.abs(xOf(l.end)-mx));
    if(d<bd){bd=d;best=l}
  }
  return bd<8?best:null;
}
function stallAt(t){return S.stalls.find(s=>t>=s.start&&t<=s.end)||null}
function markerAt(t){
  let best=null,bd=10;
  for(const m of S.markers){
    const d=Math.abs(xOf(m.t)-xOf(t));
    if(d<bd){bd=d;best=m}
  }
  return best;
}
function stageAt(t){
  const stages=(S.startupStages||[]).filter(s=>s.dur>1);
  for(const st of stages)if(t>=st.start&&t<=st.end)return st;
  let best=null,bd=8;
  for(const st of stages){
    const d=Math.min(Math.abs(xOf(st.start)-xOf(t)),Math.abs(xOf(st.end)-xOf(t)));
    if(d<bd){bd=d;best=st}
  }
  return best;
}

let hoverX=0,hoverY=0;
function onMove(ev){
  const cv=ev.target;if(!cv.dataset)return;
  const p=panels[+cv.dataset.panel];if(!p)return;
  const r=cv.getBoundingClientRect();
  const x=ev.clientX-r.left,y=ev.clientY-r.top;
  const t=S.view.v0+(x/r.width)*(S.view.v1-S.view.v0);
  hoverX=ev.clientX;hoverY=ev.clientY;
  S.hoverT=Math.min(Math.max(t,S.view.v0),S.view.v1);
  S.hoverEvt=null;S.hoverLoad=null;
  let tipHTML=null;
  if(p===evtPanel){
    const n=nearestEventInView();
    if(n){S.hoverEvt=n.e;tipHTML=eventTip(n.e);}
  }else if(p===netPanel){
    const l=nearestLoad(t);
    if(l){S.hoverLoad=l;tipHTML=loadTip(l)}
  }else if(p===stStatePanel){
    const st=stallAt(t);
    if(st)tipHTML=stallTip(st);
    else{
      const m=markerAt(t);
      if(m)tipHTML=markerTip(m);
    }
  }else if(p===stStartupPanel){
    const st=stageAt(t);
    if(st)tipHTML=stageTip(st);
  }else if(p===stQualPanel){
    const st=stallAt(t);
    if(st){tipHTML=stallTip(st)}
    else{
      const vq=qualityAt(t);
      const aq=(S.quality[1]||[]).find(a=>t>=a.t&&t<=a.end);
      let h=`<div class=\"t\">Quality ladder @ ${fmtDur(t-(S.events[0]?.rel||0))}</div>`;
      if(vq) h+=`<div class=\"row\"><span class=\"k\">Video:</span> ${vq.h>0?vq.h+'p @ ':''}${fmtKbps(vq.kbps)} <span class=\"d\">${esc(vq.codecs||vq.mime||'')}</span></div>`;
      if(aq) h+=`<div class=\"row\"><span class=\"k\">Audio:</span> ${fmtKbps(aq.kbps)} <span class=\"d\">${esc(aq.codecs||aq.mime||'')}</span></div>`;
      const nearSwitch = (S.vSwitches||[]).find(s=>Math.abs(s.t - t) < 3000);
      if(nearSwitch){
        const isUp = nearSwitch.isUpgrade;
        h+=`<div class=\"row ${isUp?'good':'bad'}\" style=\"margin-top:4px\">⇄ Quality switch: ${nearSwitch.from.h?nearSwitch.from.h+'p':fmtKbpsInt(nearSwitch.from.kbps)} ➔ ${nearSwitch.to.h?nearSwitch.to.h+'p':fmtKbpsInt(nearSwitch.to.kbps)} (${isUp?'+':''}${nearSwitch.ratio.toFixed(0)}%)</div>`;
      }
      tipHTML=h;
    }
  }else if(p===stBufPanel||p===stBwPanel){
    const st=stallAt(t);
    if(st){tipHTML=stallTip(st)}
  }else if(p===stOpsPanel){
    const op=opAt(t,y,p.canvas._h);
    if(op){
      let h=`<div class=\"t\">⚡ ${esc(op.operation)}</div>`;
      h+=`<div class=\"row\"><span class=\"k\">Status:</span> <b>${esc(op.status.toUpperCase())}</b></div>`;
      if(op.dur!=null)h+=`<div class=\"row\"><span class=\"k\">Duration:</span> <b>${fmtDur(op.dur)}</b> (${op.dur.toFixed(2)} ms)</div>`;
      if(op.start!=null)h+=`<div class=\"row\"><span class=\"k\">Start:</span> ${fmtDur(op.start)} (${esc(op.startEvent)})</div>`;
      if(op.end!=null)h+=`<div class=\"row\"><span class=\"k\">End:</span> ${fmtDur(op.end)} (${esc(op.endEvent)})</div>`;
      if(op.correlationId)h+=`<div class=\"row\"><span class=\"k\">Correlation ID:</span> <code>${esc(op.correlationId)}</code></div>`;
      tipHTML=h;
    }
  }
  redraw();
  if(tipHTML){showTip(tipHTML,ev.clientX,ev.clientY)}else hideTip();
}
function onClick(ev){
  const cv=ev.target;const p=panels[+cv.dataset.panel];if(!p)return;
  const r=cv.getBoundingClientRect();const x=ev.clientX-r.left,y=ev.clientY-r.top;
  const t=S.view.v0+(x/r.width)*(S.view.v1-S.view.v0);
  if(p===stOpsPanel){
    const op=opAt(t,y,p.canvas._h);
    if(op){select({type:'operation',idx:S.operations.indexOf(op)});return}
  }
  if(p===evtPanel){
    const n=nearestEventInView();
    if(n){select({type:'event',idx:n.e.idx});return}
  }
  if(p===netPanel){
    const l=nearestLoad(t);
    if(l){select({type:'load',idx:S.loads.indexOf(l)});return}
  }
  if(p===stQualPanel){
    const vq=qualityAt(t);
    if(vq && vq.idx!=null){select({type:'event',idx:vq.idx});return}
  }
}
function select(sel){
  if(S.sel&&sel&&S.sel.type===sel.type&&S.sel.idx===sel.idx)S.sel=null;
  else S.sel=sel;
  updateDrawer();redraw();
}

function humanDetail(d,evt){
  const o={};
  for(const[k,v] of Object.entries(d)){
    let val=v;
    if(k==='playbackState')val=PSTATE[v]||v;
    else if(k==='trackType')val=TRACK[v]||v;
    else if(k==='selectionReason')val=SELREASON[v]||v;
    else if(k==='reason'&&(evt==='PositionDiscontinuity'))val=DISCREASON[v]||v;
    else if(k==='bitrate'||k==='bitrateEstimate')val=fmtKbps(v/1000);
    else if(k==='bytesLoaded')val=fmtBytes(v);
    else if(k.endsWith('Ms'))val=fmtDur(v);
    else if(typeof v==='object')val=JSON.stringify(v).slice(0,400);
    o[k]=val;
  }
  return o;
}
function drawerRows(rows){
  return rows.map(([k,v])=>`<div class=\"kv\"><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('');
}
function updateDrawer(){
  const sel=S.sel;
  if(!sel){drawer.classList.remove('open');return}
  drawer.classList.add('open');
  const baseT=S.events[0]?.rel||0;
  if(sel.type==='event'){
    const e=S.events[sel.idx];
    drawerTitle.textContent=e.event||'Event';
    const d=e.details||{};
    let html=`<div class=\"dw\"><h4>event</h4>${drawerRows([['category',e.cat.toUpperCase()],['event',e.event],['time',fmtDur(e.rel-baseT)],['thread',e.thread||'main'],['duration',e.duration?fmtDur(e.duration):'—']])}`;
    const pairedOp = (S.operations || []).find(o => (o.startIdx === sel.idx || o.endIdx === sel.idx));
    if (pairedOp) {
      const isStart = pairedOp.startIdx === sel.idx;
      html += `<div class=\"note good\" style=\"cursor:pointer;margin-top:6px;\" onclick=\"select({type:'operation',idx:${S.operations.indexOf(pairedOp)}})\">
        🔗 Paired Operation: <b>${esc(pairedOp.operation)}</b> (${isStart ? 'START' : 'END'}) — Calculated Duration: <b>${pairedOp.dur != null ? fmtDur(pairedOp.dur) : 'Active'}</b>. Click to inspect operation.
      </div>`;
    }
    if(e.cat==='network'||e.event.startsWith('Load')){
      const l=S.loads.find(x=>x.e===e);
      if(l)html+=`<h4>network</h4>${drawerRows([['download',fmtDur(l.dur)],['bytes',fmtBytes(l.bytes)],['throughput',fmtKbps(l.kbps)],['uri',shortUri(l.uri)]])}${l.slow?`<div class=\"note ${l.crit?'bad':'warn'}\">${l.crit?'Critically slow':'Slow'} segment — ${(l.dur/(laneMedNow(l.lane)||1)).toFixed(1)}× the lane median of ${fmtDur(laneMedNow(l.lane))}</div>`:''}`;
    }
    html+=`<h4>details</h4>${drawerRows(Object.entries(humanDetail(d,e.event)))}</div>`;
    drawerBody.innerHTML=html;
  }else if(sel.type==='operation'){
    const op=(S.operations||[])[sel.idx];
    if(!op)return;
    drawerTitle.textContent='Operation · '+(op.operation||'Paired Operation');
    const startT=op.start!=null?fmtDur(op.start-baseT):'—';
    const endT=op.end!=null?fmtDur(op.end-baseT):'—';
    const durText=op.dur!=null?fmtDur(op.dur):(op.status==='incomplete'?'Active / Incomplete':'—');

    let html=`<div class=\"dw\">
      <h4>paired operation</h4>${drawerRows([
        ['operation',op.operation],
        ['status',op.status.toUpperCase()],
        ['start time',startT],
        ['end time',endT],
        ['calculated duration',durText],
        ['correlation ID',op.correlationId||'—'],
        ['start event',op.startEvent||'—'],
        ['end event',op.endEvent||'—'],
        ['category',(op.category||'—').toUpperCase()]
      ])}
      ${op.startDetails?'<h4>start event details</h4>'+drawerRows(Object.entries(humanDetail(op.startDetails,op.startEvent))):''}
      ${op.endDetails?'<h4>end event details</h4>'+drawerRows(Object.entries(humanDetail(op.endDetails,op.endEvent))):''}
    </div>`;
    drawerBody.innerHTML=html;
  }else if(sel.type==='load'){
    const l=S.loads[sel.idx];
    if(!l)return;
    drawerTitle.textContent=LANE_DEFS[l.lane].label+' download';
    const st=stallAt(l.start);
    const vq=qualityAt(l.start);
    const est=estAt(l.start);
    const med=laneMedNow(l.lane);
    const m=`<div class=\"dw\">
      <h4>request</h4>${drawerRows([
        ['start',fmtDur(l.start-baseT)],
        ['end',fmtDur(l.end-baseT)],
        ['duration',fmtDur(l.dur)],
        ['bytes',fmtBytes(l.bytes)],
        ['throughput',fmtKbps(l.kbps)],
        ['dataType',l.dataType],
        ['contentType',l.contentType||'—']
      ])}
      ${l.retried?'<div class=\"note bad\">🔁 This load succeeded after a <b>LoadError</b> on the same URI — an automatic retry.</div>':''}
      <h4>context at download time</h4>${drawerRows([['video quality',vq?vq.h+'p @ '+fmtKbps(vq.kbps):'—'],['ABR estimate',est?fmtKbps(est.kbps):'—'],['lane median',fmtDur(med)+' per segment']])}
      ${st?`<div class=\"note bad\">⚠ This download happened during a rebuffer (${fmtDur(st.end-st.start)}).</div>`:''}
      ${l.slow?`<div class=\"note ${l.crit?'bad':'warn'}\">${l.crit?'Critically slow':'Slow'} segment — ${(l.dur/med).toFixed(1)}× the lane median.</div>`:''}
      <h4>uri</h4><div class=\"note\" style=\"word-break:break-all\">${esc(l.uri)}</div>
      <h4>events</h4><div class=\"note\">Click the <b>EVENTS</b> panel to inspect the raw LoadStarted / LoadCompleted pair.</div>
    </div>`;
    drawerBody.innerHTML=m;
  }else if(sel.type==='stall'){
    const st=S.stalls[sel.idx];
    drawerTitle.textContent='Stall forensic — '+fmtDur(st.end-st.start);
    const vqStart=qualityAt(st.start),vqEnd=qualityAt(st.end);
    const concurrent=S.loads.filter(l=>l.start<st.end&&l.end>st.start);
    const est0=estAt(st.start),est1=estAt(st.end);
    const seek=S.seeks.filter(s=>s.t>=st.start-2500&&s.t<=st.end);
    const playState='BUFFERING';
    const medDur=concurrent.length?Math.round(concurrent.reduce((a,b)=>a+b.dur,0)/concurrent.length):0;
    let loadRows=concurrent.length?concurrent.slice(0,8).map(l=>`<div class=\"loadRow\"><b>${esc(LANE_DEFS[l.lane].label)}</b><span>${fmtDur(l.dur)} · ${fmtKbps(l.kbps)}</span></div>`).join(''):'<div class=\"loadRow\"><span>none overlapping</span></div>';
    let html=`<div class=\"dw\">
      <h4>the stall</h4>${drawerRows([['started',fmtDur(st.start-baseT)],['recovered',fmtDur(st.end-baseT)],['duration',fmtDur(st.end-st.start)],['buffer at start',fmtDur(st.bufAtStart)+' — depleted'],['state during','BUFFERING (playbackState=2)']])}
      <div class=\"note ${seek.length?'warn':'bad'}\">${waitReason(st.start).emoji} Waiting on: <b>${waitReason(st.start).text}</b></div>
      ${seek.length?`<div class=\"note warn\">🔎 Triggered by a <b>seek</b> ${fmtDur(seek[0].t-st.start)} before the stall (${fmtDur(seek[0].from)} → ${fmtDur(seek[0].to)}). Buffer was flushed, then had to refill.</div>`:`<div class=\"note bad\">No seek nearby — likely network starvation.</div>`}
      <h4>why it buffered</h4>${drawerRows([['quality before',vqStart?vqStart.h+'p @ '+fmtKbps(vqStart.kbps):'—'],['quality after',vqEnd?vqEnd.h+'p @ '+fmtKbps(vqEnd.kbps):'—'],['ABR est before',est0?fmtKbps(est0.kbps):'—'],['ABR est after',est1?fmtKbps(est1.kbps):'—']])}
      ${vqStart&&vqEnd&&vqStart.kbps>vqEnd.kbps?'<div class=\"note good\">ABR stepped quality DOWN after the stall — recovering by shedding load.</div>':''}
      ${vqStart&&vqEnd&&vqStart.kbps===vqEnd.kbps&&(est0&&est1&&est1.kbps<est0.kbps*0.8)?'<div class=\"note warn\">ABR kept quality constant while its estimate fell — the estimate lagged reality.</div>':''}
      <h4>concurrent downloads (${concurrent.length})</h4>${loadRows}
      ${medDur?`<div class=\"note\">avg in-flight segment: ${fmtDur(medDur)}</div>`:''}
    </div>`;
    drawerBody.innerHTML=html;
  }
}
/* ═══════════════════════════ v3: DIAGNOSIS / DEVICE / SPEC ═══════════════════════════ */
function waitReason(t){
  const st=stallAt(t);
  const ph=(S.brainPhases||[]).find(p=>t>=p.start&&t<=p.end);
  const inPlay=S.playSegs.some(ps=>t>=ps.start&&t<=ps.end);
  const live=S.loads.filter(l=>l.start<t&&l.end>t);
  const evts=S.events.filter(e=>e.rel>=t-50&&e.rel<=t);
  if(ph&&ph.kind==='rebuffer'&&st){
    const seek=S.seeks.filter(s=>s.t>=st.start-2500&&s.t<=st.end);
    if(seek.length)return{emoji:'🔎',text:'refilling after a seek — buffer was flushed and must refill'};
    if(live.length)return{emoji:'🌐',text:'waiting on the network — '+live.length+' segment(s) in flight'};
    return{emoji:'🕳️',text:'buffer depleted, nothing in flight — possible decode/render gap'};
  }
  if(ph&&ph.kind==='buffering'){
    const dkeys=evts.filter(e=>e.cat==='drm');
    if(dkeys.length)return{emoji:'🔑',text:'blocked on DRM key acquisition'};
    const live2=S.loads.filter(l=>l.start<t&&l.end>t);
    if(live2.length)return{emoji:'🌐',text:'initial buffering — fetching '+live2.length+' segment(s) from network'};
    const de=S.events.find(e=>e.event==='VideoDecoderInitialized'&&e.rel<t);
    const deEnd=de?de.rel:null;
    if(de&&deEnd&&deEnd<t)return{emoji:'🎞️',text:'decoder ready but buffer below threshold — playing after '+fmtDur(S.firstReady-t)+' more'};
    return{emoji:'🎞️',text:'waiting for the decoder / renderer pipeline to come up'};
  }
  if(ph&&ph.kind==='preparing')return{emoji:'📄',text:'preparing media source — manifest + track selection'};
  if(ph&&ph.kind==='selecting')return{emoji:'🎚️',text:'selecting tracks'};
  if(ph&&ph.kind==='drm')return{emoji:'🔑',text:'acquiring DRM session / keys'};
  if(ph&&ph.kind==='seeking')return{emoji:'🎯',text:'seeking — flushing pipeline and refilling'};
  if(ph&&ph.kind==='paused')return{emoji:'⏸️',text:'paused — playWhenReady=false'};
  return{emoji:'—',text:'no inferred wait'};
}
function buildDiagnosis(){
  const d=[];
  const{stalls,startup,loads,estimates,startupStages,seekWindows,drops,underruns,errors,firstReady,full,t0,bufferSamples,device}=S;
  const playT=S.playSegs.reduce((a,p)=>a+(p.end-p.start),0);
  const stallRatio=stalls.length&&playT?stalls.reduce((a,s)=>a+(s.end-s.start),0)/playT:0;
  if(stalls.length>0){
    const firstDur=stalls[0].end-stalls[0].start;
    if(stallRatio>0.01||stalls.length>2)d.push({sev:'crit',t:stalls[0].start,title:'Rebuffers exceed 1% of playback',body:`${stalls.length} stall(s), ${(stallRatio*100).toFixed(1)}% of playback time. First at ${fmtDur(stalls[0].start-t0)} for ${fmtDur(firstDur)}.`});
    else d.push({sev:'warn',t:stalls[0].start,title:`Rebuffer of ${fmtDur(firstDur)}`,body:`${stalls.length} stall(s) totaling ${(stallRatio*100).toFixed(1)}% of playback. ${stalls[0].seek?'Triggered by a seek':'Likely network starvation'}.`});
  }
  const manifest=startupStages.find(s=>s.name==='MANIFEST');
  const startupDur=firstReady?firstReady-t0:0;
  if(manifest&&manifest.dur>0&&startupDur>0&&manifest.dur/startupDur>0.4)d.push({sev:'warn',t:manifest.start,title:'Manifest download dominates startup',body:`${fmtDur(manifest.dur)} of ${fmtDur(startupDur)} startup spent fetching the manifest (${(manifest.dur/startupDur*100).toFixed(0)}%) — slow CDN/TTFB.`});
  else if(manifest&&manifest.dur>800)d.push({sev:'info',t:manifest.start,title:'Manifest took '+fmtDur(manifest.dur),body:'Long manifest fetch — check CDN latency for the playlist request.'});
  if(estimates.length){
    const ests=estimates.map(e=>e.kbps);
    const avgEst=ests.reduce((a,b)=>a+b,0)/ests.length;
    const measured=loads.filter(l=>l.dataType==='media'&&l.kbps>0).reduce((a,b)=>a+b.kbps,0)/Math.max(1,loads.filter(l=>l.dataType==='media'&&l.kbps>0).length);
    if(measured<avgEst*0.6)d.push({sev:'warn',t:estimates[0].t,title:'ABR overestimates throughput',body:`Measured ${fmtKbps(measured)} vs ABR avg ${fmtKbps(avgEst)} (${(measured/avgEst*100).toFixed(0)}%) — the control loop thinks the network is better than it is.`});
  }
  const slow=loads.filter(l=>l.slow||l.crit).length;
  if(loads.length&&slow/loads.length>0.05)d.push({sev:'warn',t:loads.find(l=>l.slow||l.crit)?.start,title:`${slow} of ${loads.length} loads slow/critical`,body:`${(slow/loads.length*100).toFixed(0)}% exceeded 3× lane median — check for network contention or server stalls.`});
  const decInit=S.kpis.find(k=>k.l==='Video decoder');
  if(decInit&&/init/.test(decInit.s)){
    const ms=parseFloat(decInit.s.match(/(\d+) ms/)?.[1]||0);
    if(ms>300)d.push({sev:'warn',t:S.events.find(e=>e.event==='VideoDecoderInitialized')?.rel,title:`Decoder init ${ms}ms`,body:'MediaCodec initialization took over 300ms — check for codec contention or software fallback.'});
  }
  for(const sk of seekWindows){
    const st=S.stalls.find(s=>s.start>=sk.start&&s.start<=sk.end);
    if(st)d.push({sev:'warn',t:sk.start,title:'Seek caused a rebuffer',body:`Seek at ${fmtDur(sk.start-t0)} recovered in ${fmtDur(st.end-st.start)} — target the refill with pre-buffer.`});
  }
  if(drops>0)d.push({sev:drops>300?'crit':drops>100?'warn':'info',t:0,title:`${drops} frames dropped`,body:'Dropped video frames indicate decode/render pressure. Convert to time at 30fps: ~'+fmtDur(drops/30*1000)+'.'});
  if(errors.length){
    const errCounts={};
    for(const e of errors){const n=e.event||'Error';errCounts[n]=(errCounts[n]||0)+1}
    const errSummary=Object.entries(errCounts).map(([k,v])=>v>1?`${v}× ${k}`:k).join(', ');
    d.push({sev:'crit',t:errors[0].rel,title:`${errors.length} error(s): ${errSummary}`,body:'Errors occurred in the session — click the Errors KPI card or check the EVENTS panel for details.'});
  }
  const maxBuf=Math.max(...bufferSamples.map(p=>p.v),0);
  if(maxBuf<4000&&stalls.length)d.push({sev:'warn',t:0,title:'Shallow buffer ceiling',body:`Max buffer depth only ${fmtDur(maxBuf)} — aggressive low-latency or constrained device memory.`});
  if(!d.length)d.push({sev:'good',title:'No problems found',body:'This session looks healthy. Explore panels for detail.'});
  S.diag=d;
}
function renderDiagnosis(){
  const el=$('diagnosis');el.style.display=S.diag.length?'block':'none';
  el.innerHTML=`<div id=\"diagHead\"><b>Session diagnosis</b><span>${S.diag.length} findings · click to jump</span></div>`+S.diag.map((x,i)=>{
    const icon=x.sev==='crit'?'🔴':x.sev==='warn'?'🟠':x.sev==='good'?'🟢':'🔵';
    const label=x.sev==='crit'?'CRITICAL':x.sev==='warn'?'WARNING':x.sev==='good'?'GOOD':'INFO';
    return `<div class=\"dg ${x.sev}\" onclick=\"${x.t!=null?`setView(${Math.max(0,x.t-2000)},${Math.min(S.fullRange,x.t+2000)})`:''}\"><span class=\"sev\">${label}</span><div class=\"tg\"><div class=\"t\">${icon} ${esc(x.title)}</div><div class=\"d\">${esc(x.body)}</div></div><span class=\"jump\">↗</span></div>`;
  }).join('');
}
function buildDeviceReport(){
  const s=S.session||{},evs=S.events;
  const sse=evs.find(e=>e.event==='SessionStart');
  const sd=sse?.details||{};
  const dec=evs.find(e=>e.event==='VideoDecoderInitialized');
  const audioDec=evs.find(e=>e.event==='AudioDecoderInitialized');
  const drm=[...evs].reverse().find(e=>e.cat==='drm');
  const rows=[];
  rows.push(['Device',[['model',sd.device||'—'],['OS',sd.android!=null?('Android '+sd.android):'—'],['API',sd.apiLevel!=null?sd.apiLevel:'—'],['package',s.packageName||'—']]]);
  rows.push(['Decoder',[['video',dec?dec.details?.decoder||dec.details?.name||'—':'not captured'],['video init',dec?fmtDur(dec.details?.initializationDurationMs||0):'—'],['audio',audioDec?audioDec.details?.decoder||audioDec.details?.name||'—':'—']]]);
  rows.push(['DRM',[['scheme',drm?drm.details?.scheme||drm.details?.uuid||'—':'not captured'],['state',drm?PSTATE_HINT(drm):'no DRM events'],['keys ready',S.drmReady?fmtDur(S.drmReady.rel):'—']]]);
  rows.push(['Network',[['total bytes',fmtBytes(S.loads.reduce((a,l)=>a+(l.bytes||0),0))],['requests',S.loads.length],['avg throughput',fmtKbps(S.loads.filter(l=>l.kbps>0).reduce((a,l)=>a+l.kbps,0)/Math.max(1,S.loads.filter(l=>l.kbps>0).length))]]]);
  rows.push(['Health',[['drops',S.drops||0],['underruns',S.underruns||0],['errors',S.errors.length]]]);
  const missing=[];
  if(!dec)missing.push('decoder name/init (wrap MediaCodecAdapter.Factory)');
  if(!S.drmReady)missing.push('DRM session states (DrmSessionManager events)');
  if(!sd.device)missing.push('device info in SessionStart event');
  rows.push(['Not captured',missing.map(m=>['—',m])]);
  S.deviceRows=rows;
}
function PSTATE_HINT(e){const st=e.details?.state;if(st===0)return'UNRELEASED';if(st===1)return'OPENING';if(st===2)return'OPENED';if(st===3)return'OPENED_WITH_KEYS';return e.event}
function renderDeviceReport(){
  const el=$('deviceRep');
  if(!S.deviceRows){el.style.display='none';return}
  el.style.display='block';
  $('deviceBody').innerHTML=S.deviceRows.map(([h,rows])=>`<h4>${h}</h4>`+rows.map(([k,v])=>`<div class=\"dev-row\"><span class=\"k\">${esc(k)}</span><span>${esc(String(v))}</span></div>`).join('')).join('');
}
const SPEC_TEXT=`CAPTURE SPEC — ExoPlayer session.json for Profiler v3
================================================================
Required top-level keys (session header):
  device      string  e.g. \"SM-E625F\"       (optional: brand, os, api, packageName)
  startedAt   number  epoch ms
  events      [ { cat, event, thread, rel, duration, details } ]
  rel         number  ms since session start (monotonic)

Events the profiler expects (match these names exactly):
  StateChanged             details.playbackState 0-4
  PlayWhenReadyChanged     details.playWhenReady, details.reason
  Enabled / Changed        details.groups[] (track groups) for track select
  LoadStarted/Completed    details.uri, dataType(\"manifest\"|\"media\"), trackType(1 audio,2 video), bytesLoaded, loadDurationMs
  LoadError                same as LoadStarted + details.error (for retry/redirect chains keep separate pairs)
  Estimate                 details.kbps
  Video/AudioDecoderInitialized  details.decoder, details.initializationDurationMs
  DroppedFrames            details.count
  Underrun                 (audio sink underrun)
  RenderedFirstFrame       (frame presented)
  SessionReleased          (session end)

Required for the v3 DRM timeline (not present in most current exports):
  DRM: DrmSessionManager events — SessionAcquired {state:1 OPENING}, {state:2 OPENED}, KeysLoaded / KeysRestored (state:3)
  License HTTP timing: wrap the HttpDataSource.Factory you pass to DefaultHttpMediaDrmCallback and emit LoadStarted/Completed with dataType:\"license\" — gets a LICENSE lane in the waterfall.

Required for wait-vs-work startup stages:
  manifest load pair + the first Changed(timeline) event delimit MANIFEST and TRACKS stages.
  A VideoDecoderInitialized BEFORE first RenderedFirstFrame gives a DECODER stage.
  RenderedFirstFrame after StateChanged(3) gives the PRESENT stage. Without it only BUFFER FILL is shown.

Optional but recommended (lightweight, huge diagnostic value):
  onVideoFrameProcessingOffset (exoPlaybackException not needed) → emit as FrameProcessed events for jank
  onAudioUnderrun {bufferSize, bufferSizeMs, elapsedSinceLastFeedMs} → emit as Underrun
  onPlaybackErrorChanged {errorCode, message} → emit as PlaybackError (cat:\"error\")
  onPlaybackSuppressionReasonChanged → PlayWhenReadyChanged with reason
  onUpstreamDiscarded → emit for cache eviction diagnosis
  onMediaSourceInfoRefreshed → emits with manifest event, lets us color reloads
  onLoadCanceled → emit so canceled prefetches don't read as failures

Implementation notes (Media3 / ExoPlayer 1.x+):
  • RendererFactory wrapper: build your renderers, poll renderer.isReady()/getState() into the stream.
  • MediaCodecAdapter.Factory: pass a wrapping factory to MediaCodecRenderer.initialize (or via Player.Listener's onVideoDecoderInitialized which already gives name+initMs — no wrapping needed for the basics).
  • TrackSelector fork: needed only to dump adaptation decisions (AdaptiveTrackSelection) — optional.
  • DrmSessionManager: emit from onDrmSessionAcquired/Released + onDrmKeysLoaded/Restored/Removed.
  • MediaDrm: wrap for provisioning events; MediaDrm.getMetrics() (API 28+) gives raw key-download timing.
  • Keep payloads flat and numeric where possible; the profiler renders details object verbatim.

The profiler needs only this file — no server, no deps.`;
function openSpec(){const m=$('specModal');$('specText').textContent=SPEC_TEXT;m.classList.add('open')}
function closeSpec(){$('specModal').classList.remove('open')}

function qualityAt(t){
  const vq=S.quality[2]||[];
  let cur=null;
  for(const st of vq)if(st.t<=t)cur=st;
  return cur;
}
function estAt(t){
  let cur=null;
  for(const e of S.estimates)if(e.t<=t)cur=e;
  return cur;
}

function laneMedNow(lane){
  // Calculate median duration for current lane from S.loads
  const durs = S.loads.filter(l=>l.lane===lane).map(l=>l.dur).sort((a,b)=>a-b);
  if(!durs.length)return 0;
  return durs[Math.floor(durs.length/2)];
}

/* ═══════════════════════════ VIEW / ZOOM / REPLAY ═══════════════════════════ */
function setView(v0,v1){
  const range=S.fullRange;
  v0=Math.max(0,Math.min(v0,range-1));v1=Math.min(range,Math.max(v1,v0+30));
  S.view={v0,v1};
  if(S.playT!=null&&(S.playT<S.view.v0||S.playT>S.view.v1))S.playT=null;
  redraw();
}
function zoomAt(factor,cx){
  const r=S.view.v1-S.view.v0;
  const nr=Math.min(r*factor,S.fullRange);
  const ratio=Math.min(Math.max(cx,0),allCanvasW())/(allCanvasW()||1);
  const t=S.view.v0+r*ratio;
  setView(t-nr*ratio,t+nr*(1-ratio));
}
function startReplay(){
  if(S.playing){stopReplay();return}
  S.playing=true;$('btnReplay').textContent='⏸ Stop';$('btnReplay').classList.add('on');
  if(S.playT==null||S.playT>S.view.v1||S.playT<S.view.v0)S.playT=S.view.v0;
  const t0=performance.now(),p0=S.playT;
  const loop=()=>{
    if(!S.playing)return;
    S.playT=p0+(performance.now()-t0);
    if(S.playT>=S.view.v1){S.playT=S.view.v1;redraw();stopReplay();return}
    redraw();
    S.playRAF=requestAnimationFrame(loop);
  };
  S.playRAF=requestAnimationFrame(loop);
}
function stopReplay(){
  S.playing=false;if(S.playRAF)cancelAnimationFrame(S.playRAF);
  $('btnReplay').textContent='▶ Replay';$('btnReplay').classList.remove('on');
  redraw();
}
function liveReadout(){
  const t=S.playT;if(t==null)return'';
  const st=stallAt(t);
  const vq=qualityAt(t),est=estAt(t);
  const lastLoad=[...S.loads].reverse().find(l=>l.end<=t);
  const inPlay=S.playSegs.some(ps=>t>=ps.start&&t<=ps.end);
  const state=st?'BUFFERING':inPlay?'READY':'IDLE';
  let s=`<span style=\"color:#e3b341\">▶ ${fmtDur(t-S.events[0].rel)}</span> · state <b>${state}</b>`;
  if(vq)s+=` · ${vq.h}p ${fmtKbpsInt(vq.kbps)}`;
  if(est)s+=` · ABR ${fmtKbpsInt(est.kbps)}`;
  if(lastLoad)s+=` · seg ${fmtKbpsInt(lastLoad.kbps)}`;
  return s;
}
function updateStatus(){
  if(S.playT!=null){statLeft.innerHTML=liveReadout();}
  else if(S.hoverT!=null){
    const t=S.hoverT;
    const st=stallAt(t),vq=qualityAt(t),est=estAt(t);
    const inPlay=S.playSegs.some(ps=>t>=ps.start&&t<=ps.end);
    let s=`<b>${fmtDur(t-S.events[0]?.rel)}</b>`;
    s+=` · state <b>${st?'BUFFERING':inPlay?'READY':'IDLE'}</b>`;
    if(vq)s+=` · ${vq.h}p ${fmtKbpsInt(vq.kbps)}`;
    if(est)s+=` · ABR est ${fmtKbpsInt(est.kbps)}`;
    if(st)s+=` · <b style=\"color:#f78166\">REBUFFER</b>`;
    statLeft.innerHTML=s;
  }else statLeft.innerHTML='hover timeline — click for details';
  const range=S.view.v1-S.view.v0;
  statRight.innerHTML=`<span>view ${fmtDur(S.view.v0)} → ${fmtDur(S.view.v1)}</span><span>zoom ${(S.fullRange/Math.max(range,1)).toFixed(1)}×</span><span>${S.events.length} events · ${S.loads.length} requests</span>`;
}

/* ═══════════════════════════ TABLE / CSV ═══════════════════════════ */
function renderTable(){
  const key=S.tableSort.key,dir=S.tableSort.dir;
  const q=($('tableSearch')?.value||'').trim().toLowerCase();
  const rows=[...S.events].filter(e=>{
    if(!q)return true;
    const d=e.details||{};
    return [e.event,e.cat,e.category,e.thread,JSON.stringify(d)].some(v=>String(v||'').toLowerCase().includes(q));
  }).sort((a,b)=>{const va=a[key]??a.rel,vb=b[key]??b.rel;return (va<vb?-1:va>vb?1:0)*dir});
  const tableTitle=document.querySelector('#tableHead b');
  if(tableTitle)tableTitle.textContent=q?`Events · ${rows.length}/${S.events.length}`:'All events';
  tableEl.tHead.innerHTML=`<tr><th data-k=\"rel\">time</th><th data-k=\"cat\">category</th><th data-k=\"event\">event</th><th data-k=\"thread\">thread</th><th>details</th></tr>`;
  tableEl.tBodies[0].innerHTML=rows.map(e=>{
    const d=e.details||{};
    const det=Object.entries(d).map(([k,v])=>{
      if(v==null)return'';
      if(k==='uri')return'uri: '+shortUri(v);
      if(k==='bitrate')return'bitrate: '+fmtKbps(v/1000);
      if(k==='bytesLoaded')return'bytes: '+fmtBytes(v);
      if(k==='trackType')return'track: '+(TRACK[v]||v);
      if(k==='playbackState')return'state: '+(PSTATE[v]||v);
      if(k==='selectionReason')return'sel: '+(SELREASON[v]||v);
      if(typeof v==='object')return k+': '+JSON.stringify(v).slice(0,80);
      return k+': '+v;
    }).filter(Boolean).join(' · ');
    return `<tr data-i=\"${e.idx}\"><td class=\"time\">${e.rel.toFixed(0)}</td><td class=\"cat td-cat-${CAT_ORDER.indexOf(e.cat)}\">${e.cat.toUpperCase()}</td><td class=\"evt\">${esc(e.event)}</td><td>${e.thread||'main'}</td><td class=\"det\">${esc(det)}</td></tr>`;
  }).join('');
  tableEl.querySelectorAll('th').forEach(th=>{
    th.onclick=()=>{if(S.tableSort.key===th.dataset.k)S.tableSort.dir*=-1;else S.tableSort={key:th.dataset.k,dir:1};renderTable()};
  });
  tableEl.querySelectorAll('tr[data-i]').forEach(tr=>{
    tr.onclick=()=>{
      const idx=+tr.dataset.i;
      const e=S.events[idx];
      setView(e.rel-1500,e.rel+1500);
      select({type:'event',idx});
      closeModal();
    };
  });
}
function exportCsv(){
  const rows=[['timeMs','relative_s','category','event','thread','details']];
  const base=S.events[0]?.rel||0;
  for(const e of S.events){
    const d=e.details||{};
    rows.push([e.rel,(e.rel-base)/1000,e.category,e.event,e.thread||'main',JSON.stringify(d)]);
  }
  const csv=rows.map(r=>r.map(c=>'\"'+String(c).replace(/\"/g,'\"\"')+'\"').join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=(S.session?.id||'session')+'_events.csv';
  a.click();
}
function saveSessionProfiler(){
  if(!S.events||S.events.length===0){alert('No events to save.');return;}
  const listKey='exo_saved_sessions';
  let list=[];
  try{
    list=JSON.parse(localStorage.getItem(listKey)||'[]');
  }catch(e){list=[];}
  const id='session_'+new Date().toISOString().replace(/[:.]/g,'-');
  list.push({id,timestamp:Date.now(),eventCount:S.events.length});
  try{localStorage.setItem(listKey,JSON.stringify(list));}catch(e){console.error('Failed to save session list:',e);}
  const data={schemaVersion:1,session:S.session||{id:id,packageName:'live-profiler',startedAtEpochMs:Date.now(),exportedAtEpochMs:Date.now(),durationMs:S.fullRange||0,eventCount:S.events.length},events:S.events};
  try{localStorage.setItem('exo_session_'+id,JSON.stringify(data));}catch(e){console.error('Failed to save session data:',e);}
  alert('Saved '+S.events.length+' events as session '+id);
}
function openModal(){renderTable();modal.classList.add('open')}
function closeModal(){modal.classList.remove('open')}

/* ═══════════════════════════ INTERACTIONS ═══════════════════════════ */
let dragging=false,lastX=0;
stackEl.addEventListener('mousemove',e=>{
  if(dragging){const dx=e.clientX-lastX;lastX=e.clientX;setView(S.view.v0-dx/allCanvasW()*(S.view.v1-S.view.v0),S.view.v1-dx/allCanvasW()*(S.view.v1-S.view.v0));return}
  onMove(e);
});
stackEl.addEventListener('mouseleave',()=>{S.hoverT=null;S.hoverEvt=null;S.hoverLoad=null;hideTip();redraw()});
stackEl.addEventListener('mousedown',e=>{if(e.button!==0)return;dragging=true;lastX=e.clientX;e.preventDefault();hideTip()});
window.addEventListener('mouseup',()=>{if(dragging){dragging=false;S.hoverT=null;redraw()}});
stackEl.addEventListener('dblclick',()=>setView(0,S.fullRange));
stackEl.addEventListener('wheel',e=>{
  e.preventDefault();
  const r=e.target.getBoundingClientRect();
  const cx=e.clientX-r.left;
  const scale=Math.exp(e.deltaY*0.0025);
  zoomAt(scale,cx);
},{passive:false});
stackEl.addEventListener('click',onClick);

minimapEl.addEventListener('mousedown',e=>{
  const r=minimapEl.getBoundingClientRect();
  const ratio=S.fullRange/r.width;
  const c=(e.clientX-r.left)*ratio;
  const half=(S.view.v1-S.view.v0)/2;
  setView(c-half,c+half);
  const mv=ev=>{
    const rr=minimapEl.getBoundingClientRect();
    const cc=(ev.clientX-rr.left)*S.fullRange/rr.width;
    setView(cc-half,cc+half);
  };
  const up=()=>{window.removeEventListener('mousemove',mv);window.removeEventListener('mouseup',up)};
  window.addEventListener('mousemove',mv);window.addEventListener('mouseup',up);
});

searchEl.addEventListener('input',()=>{S.filterText=searchEl.value.trim();
  $('searchCount').textContent=S.filterText?`${S.events.filter(evtMatches).length} match`:'';
  redraw();
});
searchEl.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&S.filterText){
    const matches=S.events.filter(evtMatches);
    const m=matches[0];
    if(m){
      setView(m.rel-2000,m.rel+2000);
      if(matches.length===1)select({type:'event',idx:m.idx});
      else{S.sel=null;updateDrawer();redraw()}
    }
  }
});
document.addEventListener('keydown',e=>{
  if(e.target===searchEl){if(e.key==='Escape')searchEl.blur();return}
  if(e.key==='Escape'){if(modal.classList.contains('open'))closeModal();else if(drawer.classList.contains('open'))select(null);return}
  if(modal.classList.contains('open'))return;
  if(e.key==='/'){e.preventDefault();searchEl.focus();return}
  const r=S.view.v1-S.view.v0;
  if(e.key==='ArrowLeft')setView(S.view.v0-r*0.1,S.view.v1-r*0.1);
  else if(e.key==='ArrowRight')setView(S.view.v0+r*0.1,S.view.v1+r*0.1);
  else if(e.key==='+'||e.key==='=')zoomAt(0.8,allCanvasW()/2);
  else if(e.key==='-')zoomAt(1.25,allCanvasW()/2);
  else if(e.key==='0')setView(0,S.fullRange);
});

$('btnReset').onclick=()=>{stopReplay();setView(0,S.fullRange);select(null)};
$('btnZoomIn').onclick=()=>zoomAt(0.6,allCanvasW()/2);
$('btnZoomOut').onclick=()=>zoomAt(1.5,allCanvasW()/2);
$('btnReplay').onclick=startReplay;
$('btnTable').onclick=openModal;
$('btnSpec').onclick=openSpec;
if($('btnSpecClose'))$('btnSpecClose').onclick=closeSpec;
window.addEventListener('keydown',e=>{if(e.key==='Escape')closeSpec()});
$('btnModalClose').onclick=closeModal;
$('tableSearch').addEventListener('input',renderTable);
$('btnCsv').onclick=exportCsv;
$('btnLoad').onclick=openFilePicker;
$('btnSaveSessionProfiler').onclick=saveSessionProfiler;
if($('btnBack'))$('btnBack').onclick=()=>{window.location.href='index.html';};
$('drawerClose').onclick=()=>select(null);

/* ═══════════════════════════ LIVE TAIL (real-time refresh) ═══════════════════════════ */
const LIVE={ws:null,enabled:false,pending:[],refreshTimer:null,follow:true};
function liveBtnLabel(){
  const b=$('btnLive');if(!b)return;
  if(!LIVE.enabled){b.textContent='🔴 Live';b.classList.remove('on');return;}
  const n=LIVE.pending.length+S.events.length;
  b.textContent=`🟢 Live · ${n} evts`;
  b.classList.add('on');
}

function wsToSessionEvent(d){
  const rawEvts=S.raw?.events||[];
  const last=rawEvts[rawEvts.length-1];
  const tsMs=Math.round((d.ts??Date.now()/1000)*1000);
  let timeMs;
  if(last){timeMs=last.timeMs+Math.max(0,tsMs-(last.timestampMs??tsMs));}
  else{timeMs=Math.round((d.rel??0)*1000);}
  return{timeMs,timestampMs:tsMs,category:d.category||'Live',event:d.event||'Log',thread:d.tag||'live',details:(d.details&&typeof d.details==='object')?d.details:{}};
}
function ensureLiveSession(){
  if(S.raw&&S.raw.events)return;
  const now=Date.now();
  S.raw={schemaVersion:1,session:{id:'live-'+new Date().toISOString().replace(/[:.]/g,'-'),packageName:'live-adb',startedAtEpochMs:now,exportedAtEpochMs:now,durationMs:1000,eventCount:0},events:[]};
  $('dropzone').classList.add('hidden');
  $('app').style.display='flex';
}
function scheduleLiveRefresh(){
  if(LIVE.refreshTimer)return;
  LIVE.refreshTimer=setTimeout(()=>{
    LIVE.refreshTimer=null;
    if(!LIVE.pending.length)return;
    ensureLiveSession();
    const evts=S.raw.events||[];
    evts.push(...LIVE.pending);
    LIVE.pending.length=0;
    const last=evts[evts.length-1];
    S.raw.session=S.raw.session||{};
    S.raw.session.eventCount=evts.length;
    S.raw.session.durationMs=Math.max(1000,(last?last.timeMs:0)+500);
    S.raw.session.exportedAtEpochMs=Date.now();
    const keepView=LIVE.follow?null:{...S.view};
    try{stopReplay();}catch(e){}
    analyze(S.raw);
    renderHeader();buildDiagnosis();renderDiagnosis();buildDeviceReport();renderDeviceReport();layoutPanels();
    if(LIVE.follow||!keepView)setView(0,S.fullRange);
    else{const v0=Math.min(keepView.v0,S.fullRange),v1=Math.min(keepView.v1,S.fullRange);setView(v0,Math.max(v1,v0+10));}
    liveBtnLabel();
  },1500);
}
function setLive(on){
  LIVE.enabled=on;
  if(!on&&LIVE.ws){try{LIVE.ws.close();}catch(e){}LIVE.ws=null;}
  if(on){
    const connect=()=>{
      if(!LIVE.enabled)return;
      try{if(LIVE.ws)LIVE.ws.close();}catch(e){}
      const ws=new WebSocket('ws://localhost:9090');
      LIVE.ws=ws;
      ws.onopen=()=>{liveBtnLabel();};
      ws.onmessage=(ev)=>{
        try{
          const d=JSON.parse(ev.data);
          LIVE.pending.push(wsToSessionEvent(d));
          if(LIVE.pending.length>2000)LIVE.pending=LIVE.pending.slice(-2000);
          if(S.raw.events.length+LIVE.pending.length>5000){
            S.raw.events=S.raw.events.slice(-3000);
          }
          scheduleLiveRefresh();
          liveBtnLabel();
        }catch(e){console.error('bad live frame',e);}
      };
      ws.onclose=()=>{if(LIVE.enabled)setTimeout(connect,3000);};
      ws.onerror=()=>{try{ws.close();}catch(e){}};
    };
    connect();
  }
  liveBtnLabel();
}
if($('btnLive'))$('btnLive').onclick=()=>setLive(!LIVE.enabled);

/* ═══════════════════════════ FILE LOADING ═══════════════════════════ */
function openFilePicker(){
  const input=document.createElement('input');
  input.type='file';input.accept='.json,application/json';
  input.onchange=()=>{if(input.files[0])loadFile(input.files[0])};
  input.click();
}
function loadFile(file){
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const data=JSON.parse(reader.result);
      bootstrap(data);
    }catch(err){alert('Failed to parse: '+err.message)}
  };
  reader.readAsText(file);
}
function bootstrap(raw){
  analyze(raw);
  $('dropzone').classList.add('hidden');
  $('app').style.display='flex';
  renderHeader();
  buildDiagnosis();
  renderDiagnosis();
  buildDeviceReport();
  renderDeviceReport();
  layoutPanels();
  setView(0,S.fullRange);
}
/* drop zone */
const dz=$('dzBox');
if(dz){
  ['dragover','dragenter'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('drag')}));
  ['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('drag')}));
  dz.addEventListener('drop',e=>{
    const f=e.dataTransfer.files[0];
    if(f)loadFile(f);
  });
  dz.addEventListener('click',openFilePicker);
}
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>e.preventDefault());

/* ── build panels & wire ── */
buildPanels();
stStatePanel=panels[1];stBrainPanel=panels[2];stStartupPanel=panels[3];stQualPanel=panels[4];stBufPanel=panels[5];stBwPanel=panels[6];netPanel=panels[7];stOpsPanel=panels[8];evtPanel=panels[9];
window.addEventListener('resize',()=>layoutPanels());
window.loadSession=raw=>bootstrap(typeof raw==='string'?JSON.parse(raw):raw);

const params=new URLSearchParams(location.search);
function maybeAutoLive(){
  try{
    const isLiveSession=(S.raw?.session?.id||'').startsWith('live-')||(S.raw?.session?.packageName==='live-adb');
    if(params.get('live')==='1'||isLiveSession){setLive(true);}
  }catch(e){}
}
try{
  const pending=sessionStorage.getItem('exo_pending_session');
  if(pending){
    sessionStorage.removeItem('exo_pending_session');
    bootstrap(JSON.parse(pending));
    maybeAutoLive();
  }else if(params.get('file')){
    fetch(params.get('file')).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(data=>{bootstrap(data);maybeAutoLive();}).catch(err=>{console.error('Failed to load ?file=:',err);});
  }
}catch(err){console.error('Failed to load pending session:',err);}
console.log('🎥 ExoPlayer Profiler v4 ready — drag session.json, or window.loadSession(json)');
