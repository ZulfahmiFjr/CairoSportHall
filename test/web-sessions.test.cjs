// Offline regression tests: execute the actual session controller with isolated
// browser tabs and an in-memory Firebase transport. Never contacts production.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const source = readFileSync(resolve(__dirname, '../op.js'), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
let now = Date.now();
const rows = new Map();
const tabs = [];
const channels = [];
const localValues = new Map();
const locks = new Set();
const store = (values = new Map()) => ({ getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k), values });
const snap = value => ({ val: () => structuredClone(value ?? null), exists: () => value != null });
function resolveTime(value) {
    if (value?.['.sv'] === 'timestamp') return now;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,resolveTime(v)]));
    return value;
}
function presence(row) {
    return row?.revoked ? {...row,online:false} : row?.connectionId ? {...row,...row.connections?.[row.connectionId]} : row;
}
function valueAt(path) {
    const parts=path.split('/');
    if(parts[0]==='sessions' && parts.length>3) {
        let value=rows.get(parts.slice(0,3).join('/'));
        for(const key of parts.slice(3))value=value?.[key];
        return value || null;
    }
    if (rows.has(path)) return rows.get(path);
    const result = {};
    for (const [key,value] of rows) if (key.startsWith(path+'/')) {
        const parts = key.slice(path.length+1).split('/');
        let node = result;
        for (const part of parts.slice(0,-1)) node = node[part] ||= {};
        node[parts.at(-1)] = value;
    }
    return Object.keys(result).length ? result : null;
}
function notify() {
    for (const tab of tabs) if (tab.connected) for (const [path,callbacks] of tab.listeners) {
        if (!path.startsWith('.info/')) for (const cb of [...callbacks]) cb(snap(valueAt(path)));
    }
}
function write(path, value) {
    const parts=path.split('/');
    if(parts[0]==='sessions' && parts.length>3) {
        const base=parts.slice(0,3).join('/');
        const root=structuredClone(rows.get(base)||{});let node=root;
        for(const key of parts.slice(3,-1))node=node[key] ||= {};
        node[parts.at(-1)]=resolveTime(value);rows.set(base,root);
    } else rows.set(path, resolveTime(value));
    notify();
}
function tab(storageValues = new Map()) {
    const t = { connected: true, visible: true, focused: true, listeners: new Map(), events: {}, documentEvents: {}, intervals: new Map(), disconnects: new Map(), elements: new Map(), disconnectRegistrations: 0, signouts: 0 };
    tabs.push(t);
    const el = id => {
        if (!t.elements.has(id)) t.elements.set(id,{style:{}, innerText:'', innerHTML:'', addEventListener(type, cb){ this[type]=cb; }, closest(){return null;} });
        return t.elements.get(id);
    };
    class Channel {
        constructor(name){this.name=name;this.listeners=new Set();this.closed=false;channels.push(this);t.channel=this;}
        addEventListener(_,cb){this.listeners.add(cb);}
        removeEventListener(_,cb){this.listeners.delete(cb);}
        postMessage(data){for(const channel of channels) if(channel!==this&&!channel.closed&&channel.name===this.name) for(const cb of [...channel.listeners]) cb({data});}
        close(){this.closed=true;}
    }
    const auth = { currentUser:null };
    const context = {
        console, crypto:{randomUUID,getRandomValues(a){return require('node:crypto').randomFillSync(a);}},
        Date:class extends Date {static now(){return now+(t.clockOffset||0);}}, Intl, Uint8Array,
        localStorage:store(localValues), sessionStorage:store(storageValues), BroadcastChannel:Channel,
        navigator:{userAgent:'Mozilla/5.0 Android Chrome/120',onLine:true,
            locks:process.env.TEST_WEB_LOCKS ? { async request(name,options,callback){
                if(locks.has(name))return callback(null);
                locks.add(name);try{return await callback({name});}finally{locks.delete(name);}
            }} : undefined},
        document:{getElementById:el,get visibilityState(){return t.visible?'visible':'hidden';},hasFocus:()=>t.focused,addEventListener(type,cb){t.documentEvents[type]=cb;}},
        window:{addEventListener(type,cb){t.events[type]=cb;}},
        setTimeout, clearTimeout, setInterval(cb,ms){const id=randomUUID();t.intervals.set(id,{cb,ms});return id;}, clearInterval(id){t.intervals.delete(id);},
        auth,db:{},setTabLogoutPending(value){t.logoutPending=value;},publishTabUser(user){t.verified=user;},
        onAuthStateChanged(_,cb){t.authCallback=cb;cb(null);},
        async signOut(){t.signouts++;auth.currentUser=null;t.authCallback(null);},
        ref:(_,path)=>path,child:(path,key)=>path+'/'+key,serverTimestamp:()=>({'.sv':'timestamp'}),
        async get(path){return snap(valueAt(path));},
        async set(path,value){write(path,value);},
        async update(path,payload){write(path,{...(valueAt(path)||{}),...payload});},
        async runTransaction(path,fn){const next=fn(structuredClone(valueAt(path)));if(next===undefined)return {committed:false,snapshot:snap(valueAt(path))};write(path,next);return {committed:true,snapshot:snap(valueAt(path))};},
        onDisconnect(path){return {async update(payload){t.disconnectRegistrations++;t.disconnects.set(path,payload);},async cancel(){t.disconnects.delete(path);}};},
        onValue(path,cb){if(!t.listeners.has(path))t.listeners.set(path,new Set());t.listeners.get(path).add(cb);queueMicrotask(()=>{if(t.listeners.get(path)?.has(cb))cb(snap(path==='.info/connected'?t.connected:path==='.info/serverTimeOffset'?0:valueAt(path)));});return ()=>t.listeners.get(path).delete(cb);},
        query:path=>path,orderByChild:()=>{},limitToLast:()=>{}
    };
    t.context=vm.createContext(context);
    vm.runInContext(source+`\nglobalThis.inspect = () => ({ id: currentSessionId, ready: sessionReady, profile: currentUserProfile });\nglobalThis.drain = () => presenceQueue;\nglobalThis.testOnline = sessionIsOnline;`,t.context);
    t.storage=storageValues;
    t.login=(uid='admin')=>{auth.currentUser={uid,email:uid+'@cairo.com'};t.authCallback(auth.currentUser);};
    t.active=active=>{t.visible=active;t.focused=active;t.documentEvents.visibilitychange();t.events[active?'focus':'blur']();};
    t.connection=connected=>{t.connected=connected;for(const cb of t.listeners.get('.info/connected')||[])cb(snap(connected));if(!connected){for(const [p,v] of t.disconnects)write(p,{...(valueAt(p)||{}),...v});t.disconnects.clear();}};
    t.destroy=()=>{t.connection(false);t.channel.close();vm.runInContext('releaseTabLock?.()',t.context);};
    t.row=()=>presence(valueAt('sessions/'+auth.currentUser?.uid+'/'+t.context.inspect().id));
    t.path=()=>`sessions/${auth.currentUser.uid}/${t.context.inspect().id}`;
    return t;
}
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
const check=(label,fn)=>{fn(); console.log('PASS '+label);};
(async()=>{
    const a=tab();a.login();await settle();const pathA=a.path();const created=a.row().createdAt;
    check('login creates an online row only after session registration',()=>{assert.equal(a.row().online,true);assert.equal(a.context.inspect().ready,true);assert.equal(a.disconnectRegistrations,1);});
    a.active(false);await settle();
    const b=tab();b.login();await settle();const pathB=b.path();
    check('second tab has a separate row and same device ID',()=>{assert.notEqual(pathA,pathB);assert.equal(a.row().deviceId,b.row().deviceId);assert.equal(a.row().online,false);assert.equal(b.row().online,true);});
    b.active(false);a.active(true);await settle();
    check('switching back reverses the two presence states',()=>{assert.equal(a.row().online,true);assert.equal(b.row().online,false);});
    // A copied sessionStorage must not overwrite the source tab's row.
    const copy=tab(new Map(a.storage));copy.login();await new Promise(r=>setTimeout(r,230));await settle();
    check('duplicated tab claims a different session',()=>assert.notEqual(copy.path(),pathA));
    copy.destroy();
    now+=5000;a.connection(false);await settle();
    check('connection loss keeps the row but marks it offline',()=>assert.equal(presence(rows.get(pathA)).online,false));
    a.connection(true);await settle();
    check('reconnect re-arms onDisconnect and preserves login time',()=>{assert.equal(a.disconnectRegistrations,2);assert.equal(a.row().createdAt,created);assert.equal(a.row().online,true);});
    a.connection(false);await settle();
    check('second disconnect still marks row offline',()=>assert.equal(presence(rows.get(pathA)).online,false));
    a.connection(true);await settle();
    const op=tab();op.login('op');await settle();
    // Simulate the actual OP table button, while target is disconnected/suspended.
    b.connection(false);await settle();
    op.elements.get('session-table-body').click({target:{closest:()=>({dataset:{uid:'admin',session:pathB.split('/').at(-1)}})}});
    await settle();
    check('forced logout hides the row immediately',()=>{assert.equal(rows.get(pathB).revoked,true);assert.ok(!op.elements.get('session-table-body').innerHTML.includes(pathB.split('/').at(-1)));});
    b.connection(true);await settle();
    check('revoked tab must sign in again on reconnect',()=>{assert.equal(b.context.auth.currentUser,null);assert.equal(b.signouts,1);assert.equal(presence(rows.get(pathB)).online,false);assert.equal(a.context.auth.currentUser.uid,'admin');});
    b.login();await settle();
    check('fresh login gets a new session without reviving revoked row',()=>{assert.notEqual(b.path(),pathB);assert.equal(rows.get(pathB).revoked,true);});
    const liveB=b.path();b.elements.get('btn-logout').click();await settle();
    check('self logout hides only its own row',()=>{assert.equal(rows.get(liveB).revoked,true);assert.equal(a.context.auth.currentUser.uid,'admin');});
    now+=21000;
    for(const {cb,ms} of op.intervals.values())if(ms===1000)cb();
    check('stale heartbeat becomes offline without a new database event',()=>{assert.equal(op.context.testOnline(rows.get(pathA)),false);assert.equal(op.elements.get('op-session-count').innerText,'0');});
    const previousConnection=rows.get(pathA).connectionId;
    a.destroy();await settle();
    const refreshed=tab(new Map(a.storage));refreshed.login();await new Promise(r=>setTimeout(r,230));await settle();
    check('restored tab reuses its row and preserves login timestamp',()=>{assert.equal(refreshed.path(),pathA);assert.equal(refreshed.row().createdAt,created);assert.equal(refreshed.row().online,true);});
    write(pathA+'/connections/'+previousConnection,{online:false,lastSeen:now});
    check('late disconnect from pre-refresh page cannot mark replacement offline',()=>assert.equal(refreshed.row().online,true));
    refreshed.active(false);await settle();
    check('background tab stays offline even with heartbeat',()=>{assert.equal(refreshed.row().online,false);});
    op.connection(false);await settle();for(const {cb,ms} of op.intervals.values())if(ms===1000)cb();
    check('offline OP does not claim other devices are definitely offline',()=>{assert.equal(op.elements.get('op-session-count').innerText,'-');assert.ok(op.elements.get('session-table-body').innerHTML.includes('Tidak diketahui'));});
    const offline=tab();offline.login();await settle();const offlinePath=offline.path();
    offline.connection(false);await settle();offline.elements.get('btn-logout').click();await settle();
    check('offline logout completes locally without waiting for network',()=>assert.equal(offline.context.auth.currentUser,null));
    offline.connection(true);offline.login();await settle();
    check('pending offline logout is removed from listings after authenticated reconnect',()=>assert.equal(rows.get(offlinePath).revoked,true));
    const denied=tab(new Map(offline.storage));const deniedPath=offline.path();
    offline.destroy();await settle();write(deniedPath,{...rows.get(deniedPath),revoked:true,forceLogout:true,online:false});
    denied.login();await new Promise(r=>setTimeout(r,230));await settle();
    check('refresh of revoked session cannot recreate an online row',()=>{assert.equal(denied.context.auth.currentUser,null);assert.equal(rows.get(deniedPath).revoked,true);});
    // Clock skew must be cancelled by Firebase's server-time offset.
    op.connection(true);await settle();
    const sample={online:true,lastSeen:now};
    for(const skew of [60000,-60000]) {
        op.clockOffset=skew;
        for(const cb of op.listeners.get('.info/serverTimeOffset')||[])cb(snap(-skew));
        check('server time handles operator clock skew '+skew,()=>assert.equal(op.context.testOnline(sample),true));
    }
    now+=21000;
    check('stale status expires despite a slow operator clock',()=>assert.equal(op.context.testOnline(sample),false));
    // Two simultaneously restored copies must elect different owners too.
    const origin=tab();origin.login();await settle();const sharedStorage=new Map(origin.storage);
    origin.destroy();await settle();
    const restoreA=tab(new Map(sharedStorage)),restoreB=tab(new Map(sharedStorage));
    restoreA.login();restoreB.login();await new Promise(resolve=>setTimeout(resolve,230));await settle();
    check('simultaneous restored copies cannot share a row',()=>{assert.notEqual(restoreA.path(),restoreB.path());assert.ok(restoreA.verified);assert.ok(restoreB.verified);});
    const failed=tab();failed.context.get=async()=>{throw new Error('simulated permission denied');};
    failed.login();await settle();
    check('failed validation never exposes an authenticated dashboard',()=>{assert.equal(failed.verified,null);assert.equal(failed.context.auth.currentUser,null);});
    const delayed=tab();let resolveRead;
    delayed.context.get=()=>new Promise(resolve=>{resolveRead=resolve;});
    delayed.login();await settle();
    check('dashboard waits for session verification',()=>assert.equal(delayed.verified,null));
    delayed.elements.get('btn-logout').click();await settle();
    resolveRead(snap(null));await settle();
    check('late initialization cannot revive a logged-out session',()=>{assert.equal(delayed.verified,null);assert.equal(delayed.context.auth.currentUser,null);});
    const ghostPath='sessions/admin/tab-ghost';
    write(ghostPath,{online:false,lastSeen:now});await settle();
    check('partial old disconnect records never appear as device rows',()=>assert.ok(!op.elements.get('session-table-body').innerHTML.includes('tab-ghost')));
    const late=tab();late.login();await settle();const latePath=late.path();const lateDisconnects=[...late.disconnects];
    late.elements.get('btn-logout').click();await settle();
    for(const [path,payload] of lateDisconnects)write(path,{...(valueAt(path)||{}),...payload});
    check('late disconnect cannot resurrect a logged-out row',()=>{assert.equal(rows.get(latePath).revoked,true);assert.ok(!op.elements.get('session-table-body').innerHTML.includes(latePath.split('/').at(-1)));});
    const hanging=tab();hanging.login();await settle();
    hanging.context.update=()=>new Promise(()=>{});
    hanging.context.setTimeout=(cb,ms)=>setTimeout(cb,ms===3000?1:ms);
    hanging.elements.get('btn-logout').click();await new Promise(resolve=>setTimeout(resolve,15));await settle();
    check('unacknowledged logout write cannot block local sign-out',()=>{assert.equal(hanging.context.auth.currentUser,null);assert.equal(hanging.logoutPending,false);});
    const racing=tab();racing.login();await settle();const racingPath=racing.path();
    let resumeTransaction;
    racing.context.runTransaction=(path,fn)=>new Promise(resolve=>{resumeTransaction=()=>{const next=fn(structuredClone(valueAt(path)));if(next!==undefined)write(path,next);resolve({committed:next!==undefined,snapshot:snap(valueAt(path))});};});
    racing.active(false);await settle();
    write(racingPath,{...rows.get(racingPath),revoked:true,forceLogout:true});await settle();
    resumeTransaction();await settle();
    check('delayed heartbeat transaction cannot undo forced logout',()=>{assert.equal(rows.get(racingPath).revoked,true);assert.equal(racing.context.auth.currentUser,null);});
    assert.ok(readFileSync(resolve(__dirname,'../tab-auth.js'),'utf8').includes('browserSessionPersistence'));
    console.log('All web session regression scenarios passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
