export const DAY=86400000;
const id=p=>`${p}-${crypto.randomUUID().slice(0,8)}`;
const need=(ok,message)=>{if(!ok)throw new Error(message)};
const finite=(n,label)=>{need((typeof n==='number'||typeof n==='string'&&n.trim()!=='')&&Number.isFinite(Number(n)),`${label} must be finite.`);return Number(n)};
export const money=n=>{const v=finite(n,'Amount'),c=Math.round((v+Number.EPSILON)*100);need(Number.isSafeInteger(c),'Amount exceeds safe accounting precision.');return c/100};
const positive=(n,label)=>{const v=money(finite(n,label));need(v>0,`${label} must be a positive amount of at least one cent.`);return v};
const integer=(n,label,min,max)=>{const v=finite(n,label);need(Number.isSafeInteger(v)&&v>=min&&v<=max,`${label} must be an integer between ${min} and ${max}.`);return v};
const duration=(n,label,scale,maxSeconds=Number.MAX_SAFE_INTEGER/1000)=>{const v=finite(n,label),seconds=v*scale;need(Number.isSafeInteger(seconds)&&seconds>=0&&seconds<=maxSeconds,`${label} must represent a finite whole number of seconds.`);return v};
const principal=b=>b.seniorCapitalBasis??b.seniorShares;
const role=(s,...roles)=>need(roles.includes(s.role),`Switch to the ${roles.join(' or ')} workspace to perform this action.`);
const wallet=s=>need(s.wallet.connected,'Open your workspace before recording an action.');
const book=(s,key)=>{const b=s.books.find(b=>b.id===key);need(b,'Book not found.');return b};
const log=(s,type,bookId,detail,amount=0)=>{const e={id:id('receipt'),type,bookId,detail,amount:money(amount),timestamp:s.now};s.activity.unshift(e);return e};
const mandate=()=>({maxInventoryUsd:125000,maxSkewBps:1500,minQuoteWidthBps:5,maxHedgeLeverageX10:30,hedgeRatioMinBps:2500,hedgeRatioMaxBps:9000,noNewRiskOffHours:true,killAtDrawdownBps:-800,hedgeAllowRoot:'Local allow-list: canonical Stock Tokens / permitted perps'});
export function createState(now=Date.now()){
 need(Number.isFinite(now)&&Math.abs(now+DAY)<8.64e15,'Invalid workspace clock.');
 const books=['NVDA','TSLA','STOCK'].map((symbol,i)=>({id:`book-${i+1}`,symbol:symbol==='STOCK'?'Stock index':symbol,underlying:symbol==='STOCK'?'Stock-Token index':`${symbol} Stock Token`,venue:i===2?'In-house':'Orderly',status:'Open',paused:false,windowEnd:now+DAY/2,seniorCapBps:7000,seniorHurdleBps:6000,juniorNoticeSeconds:604800,seniorNav:60000,juniorNav:40000,seniorShares:60000,juniorShares:40000,seniorCapitalBasis:60000,sponsorJuniorShares:6000,liquidity:25000,venueEquity:75000,inventory:32000+i*6000,skewBps:300+i*50,hedgeRatioBps:5500,drawdownBps:0,offHours:false,oracleHeld:false,mandate:mandate(),marks:[],settlements:[],agents:[{id:`agent-${i+1}`,name:`${symbol} quoting desk`,keyPrefix:`local-${i+1}`,status:'Active',tier:'Entry',scope:'Quote + hedge; no withdrawals'}]}));
 const s={schema:1,mode:'preview',now,role:'allocator',wallet:{connected:false,address:null},balance:100000,bkrnBalance:25000,staked:0,backstop:15000,books,positions:[{bookId:'book-1',tranche:'senior',shares:6000,sponsorShares:0},{bookId:'book-1',tranche:'junior',shares:2000,sponsorShares:0},{bookId:'book-2',tranche:'senior',shares:2000,sponsorShares:0},{bookId:'book-2',tranche:'junior',shares:1000,sponsorShares:0}],redemptions:[],charters:[],activity:[],committee:['Member 1','Member 2','Member 3'],settings:{charterFee:100,sponsorBond:1000,walletCap:100000},selectedBook:'book-1'};
 for(const b of books)log(s,'Book configured',b.id,'Illustrative charter: 60% Senior hurdle, 70% capital cap; proposed launch book.');
 return s;
}
export const nav=b=>money(b.seniorNav+b.juniorNav);
export const sharePrice=(b,t)=>b[`${t}Shares`]>0?b[`${t}Nav`]/b[`${t}Shares`]:1;
export const position=(s,b,t)=>s.positions.find(p=>p.bookId===b&&p.tranche===t);
export const locked=(s,b,t)=>s.redemptions.filter(r=>r.bookId===b&&r.tranche===t&&r.status==='Queued').reduce((n,r)=>n+r.shares,0);
export const available=(s,b,t)=>Math.max(0,(position(s,b,t)?.shares||0)-locked(s,b,t));
export function invariants(s){
 const numbers=(v,path='state')=>{if(typeof v==='number')need(Number.isFinite(v),`Non-finite number at ${path}.`);else if(v&&typeof v==='object')for(const [k,n]of Object.entries(v))numbers(n,`${path}.${k}`)};numbers(s);
 const scalar=(v,label,min=0)=>need(Number.isFinite(v)&&v>=min,`${label} numeric invariant failed.`);
 for(const f of ['balance','bkrnBalance','staked','backstop']){scalar(s[f],f);money(s[f])}
 scalar(s.now,'Clock',-8.64e15);need(Math.abs(s.now)<8.64e15,'Invalid workspace clock.');
 for(const f of ['charterFee','sponsorBond','walletCap'])need(Number.isFinite(s.settings[f])&&s.settings[f]>0,`${f} must be positive and finite.`);
 need(s.committee.length===3&&new Set(s.committee).size===3,'The committee requires three distinct members.');
 need(new Set(s.books.map(b=>b.id)).size===s.books.length,'Duplicate book identity.');
 for(const b of s.books){
  for(const f of ['seniorNav','juniorNav','seniorShares','juniorShares','liquidity','venueEquity','sponsorJuniorShares','inventory','hedgeRatioBps','juniorNoticeSeconds'])scalar(b[f],`${b.id}.${f}`);
  scalar(principal(b),'Senior capital basis');need(Number.isFinite(b.windowEnd)&&Math.abs(b.windowEnd)<8.64e15,'Invalid window deadline.');
  for(const f of ['seniorCapBps','seniorHurdleBps'])integer(b[f],f,0,10000);
  need(Number.isFinite(b.skewBps)&&Number.isFinite(b.drawdownBps),'Risk observations must be finite.');
  need(b.sponsorJuniorShares<=b.juniorShares+1e-7,'Sponsor commitment exceeds Junior shares.');
  need(nav(b)===money(b.liquidity+b.venueEquity),'Vault and venue equity must reconcile to book NAV.');
  for(const t of ['senior','junior'])need(b[`${t}Shares`]>0||b[`${t}Nav`]===0,'An empty tranche cannot hold unallocated NAV.');
  need(money(b.seniorNav)===b.seniorNav&&money(b.juniorNav)===b.juniorNav&&money(b.liquidity)===b.liquidity&&money(b.venueEquity)===b.venueEquity,'Capital accounting must use whole cents.');
  need(Number.isFinite(b.mandate.maxInventoryUsd)&&b.mandate.maxInventoryUsd>0,'Inventory mandate must be finite and positive.');
  integer(b.mandate.maxSkewBps,'Skew mandate',1,32767);integer(b.mandate.minQuoteWidthBps,'Quote width',1,65535);integer(b.mandate.maxHedgeLeverageX10,'Hedge leverage',1,65535);
  integer(b.mandate.hedgeRatioMinBps,'Minimum hedge ratio',0,10000);integer(b.mandate.hedgeRatioMaxBps,'Maximum hedge ratio',0,10000);need(b.mandate.hedgeRatioMinBps<=b.mandate.hedgeRatioMaxBps,'Hedge ratio bounds are inverted.');integer(b.mandate.killAtDrawdownBps,'Drawdown kill',-10000,-1);
  for(const e of b.settlements){for(const f of ['gross','expenses','carry','senior','junior','buyback','backstop'])scalar(e[f],`Settlement ${f}`);need(e.gross===money(e.expenses+e.carry+e.senior+e.junior)&&e.carry===money(e.buyback+e.backstop),'Fee distribution must conserve every cent.');}
 }
 const positions=new Set();
 for(const p of s.positions){const b=book(s,p.bookId),key=`${p.bookId}:${p.tranche}`;need(['senior','junior'].includes(p.tranche)&&!positions.has(key),'Invalid or duplicate tranche position.');positions.add(key);scalar(p.shares,'Position shares');scalar(p.sponsorShares??0,'Sponsor position shares');need((p.sponsorShares??0)<=p.shares+1e-7&&(p.tranche==='junior'||!p.sponsorShares),'Invalid sponsor contribution.');need(p.shares<=b[`${p.tranche}Shares`]+1e-7&&locked(s,p.bookId,p.tranche)<=p.shares+1e-7,'Redemption share invariant failed.');if(p.tranche==='junior')need((p.sponsorShares??0)<=b.sponsorJuniorShares+1e-7,'Sponsor contribution does not reconcile.');}
 for(const r of s.redemptions){book(s,r.bookId);need(['senior','junior'].includes(r.tranche)&&['Queued','Cancelled','Fulfilled'].includes(r.status),'Invalid redemption record.');scalar(r.shares,'Redemption shares');scalar(r.eligibleAt,'Redemption eligibility',-8.64e15);scalar(r.noticeAt,'Notice timestamp',-8.64e15);scalar(r.paid,'Redemption payment');need(r.eligibleAt>=r.noticeAt,'Notice eligibility precedes notice.');if(r.status==='Queued')need(position(s,r.bookId,r.tranche),'Queued notice has no position.');}
 return true;
}
export function execute(current,a){
 invariants(current);const s=structuredClone(current);let message='Recorded.';
 switch(a.type){
 case 'connect':s.wallet={connected:true,address:a.address||`local:${crypto.randomUUID().slice(0,12)}`};message='Workspace opened.';break;
 case 'disconnect':s.wallet.connected=false;message='Workspace closed.';break;
 case 'role':need(['allocator','sponsor','committee','operator'].includes(a.role),'Unknown workspace.');s.role=a.role;break;
 case 'select':book(s,a.bookId);s.selectedBook=a.bookId;break;
 case 'subscribe':{
  wallet(s);role(s,'allocator','sponsor');const b=book(s,a.bookId),t=a.tranche;need(['senior','junior'].includes(t),'Select a tranche.');
  need(b.status==='Open'&&!b.paused&&s.now<b.windowEnd,'Subscriptions require an open subscription or top-up window.');
  const amount=positive(a.amount,'Subscription');need(amount<=s.balance,'Insufficient available capital.');
  const prior=s.positions.filter(p=>p.bookId===b.id).reduce((n,p)=>n+p.shares*sharePrice(b,p.tranche),0);need(prior+amount<=s.settings.walletCap,'This subscription exceeds the example per-wallet cap.');
  if(t==='senior')need((b.seniorNav+amount)/(nav(b)+amount)*10000<=b.seniorCapBps+.001,'This subscription would exceed the charter’s Senior capital cap.');
  need(b[`${t}Shares`]===0||b[`${t}Nav`]>0,'A tranche with outstanding shares and zero NAV must settle those shares before new subscriptions.');
  const shares=amount/sharePrice(b,t);need(Number.isFinite(shares)&&shares>0,'Invalid subscription share amount.');let p=position(s,b.id,t);if(!p){p={bookId:b.id,tranche:t,shares:0,sponsorShares:0};s.positions.push(p)}p.shares+=shares;
  if(t==='senior')b.seniorCapitalBasis=money(principal(b)+amount);
  b[`${t}Shares`]+=shares;b[`${t}Nav`]=money(b[`${t}Nav`]+amount);b.liquidity=money(b.liquidity+amount);s.balance=money(s.balance-amount);
  if(s.role==='sponsor'&&t==='junior'){b.sponsorJuniorShares+=shares;p.sponsorShares=(p.sponsorShares??0)+shares}
  log(s,'Subscription',b.id,`${t} subscription recorded`,amount);message=`${amount.toLocaleString()} USDC allocated to ${t}.`;break;
 }
 case 'redeem':{
  wallet(s);role(s,'allocator','sponsor');const b=book(s,a.bookId),t=a.tranche;need(['senior','junior'].includes(t),'Select a tranche.');
  let shares=finite(a.shares,'Redemption shares');need(shares>0,'Enter a positive number of shares.');const unlocked=available(s,b.id,t);need(shares<=unlocked+1e-8,'Insufficient unlocked shares.');shares=Math.min(shares,unlocked);need(shares>0,'Insufficient unlocked shares.');
  const eligibleAt=s.now+(t==='junior'?b.juniorNoticeSeconds*1000:0);
  s.redemptions.unshift({id:id('redemption'),bookId:b.id,tranche:t,shares,noticeAt:s.now,eligibleAt,status:'Queued',fulfilledMark:null,paid:0});
  log(s,'Redemption notice',b.id,`${t}: ${shares.toFixed(4)} shares queued. Deposits may pause; redemption access remains open.`);message='Redemption queued for its next eligible daily mark.';break;
 }
 case 'cancelRedemption':{
  wallet(s);const r=s.redemptions.find(r=>r.id===a.id);need(r?.status==='Queued','Only queued notices can be cancelled.');r.status='Cancelled';log(s,'Notice cancelled',r.bookId,r.id);message='Queued notice cancelled.';break;
 }
 case 'topup':{
  wallet(s);role(s,'sponsor');const b=book(s,a.bookId);need(!['Retired','Retiring','Killed'].includes(b.status),'This book cannot reopen a subscription window.');const hours=duration(a.hours??24,'Window hours',3600,4294967295);need(hours>0,'Window hours must be positive.');b.status='Open';b.windowEnd=s.now+hours*3600000;log(s,'Top-up window',b.id,'Sponsor opened a new subscription round.');message='Top-up round opened.';break;
 }
 case 'closeWindow':{
  wallet(s);role(s,'sponsor');const b=book(s,a.bookId);need(b.status==='Open','Only an open subscription window can close.');need(nav(b)>0&&b.juniorNav>0&&b.juniorShares>0,'Capitalise Junior before closing the subscription window.');need(b.sponsorJuniorShares>=b.juniorShares*.1-1e-8,'Sponsor must hold at least 10% of Junior at subscription close.');need(b.seniorNav/nav(b)*10000<=b.seniorCapBps+.001,'Senior capital exceeds the charter cap.');
  b.windowEnd=s.now;b.status='Active';log(s,'Subscription close',b.id,'Sponsor Junior commitment and Senior capital cap checked.');message='Subscription window closed; charter checks passed.';break;
 }
 case 'pause':{
  wallet(s);role(s,'committee','operator');const b=book(s,a.bookId);b.paused=!b.paused;log(s,'Deposit pause',b.id,b.paused?'New deposits paused. Redemptions remain open.':'New deposits resumed.');message=b.paused?'Deposits paused. Redemptions remain accessible.':'Deposits resumed.';break;
 }
 case 'agentRegister':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId);need(!['Killed','Retired','Retiring'].includes(b.status),'Restore or reopen the mandate before registering an agent.');need(a.name?.trim(),'Enter an agent name.');need(/^[a-zA-Z0-9:_-]{4,40}$/.test(a.keyPrefix),'Enter a public key prefix only (4–40 characters).');
  need(!b.agents.some(k=>k.keyPrefix===a.keyPrefix&&k.status==='Active'),'An active key already uses that prefix.');
  b.agents.push({id:id('agent'),name:a.name.trim(),keyPrefix:a.keyPrefix,status:'Active',tier:'Entry',scope:'Quote + hedge; no withdrawals'});log(s,'Agent registered',b.id,`${a.name}: scoped trade-only/session key prefix ${a.keyPrefix}`);message='Agent registered with scoped book access.';break;
 }
 case 'agentRevoke':{
  wallet(s);role(s,'operator','committee');const b=book(s,a.bookId),k=b.agents.find(k=>k.id===a.id);need(k?.status==='Active','This key is not active.');k.status='Revoked';log(s,'Agent revoked',b.id,k.keyPrefix);message='Agent key revoked.';break;
 }
 case 'risk':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId);for(const f of ['inventory','skewBps','hedgeRatioBps','drawdownBps'])if(a[f]!==undefined)b[f]=finite(a[f],f);
  need(b.inventory>=0&&b.hedgeRatioBps>=0&&b.hedgeRatioBps<=10000&&b.drawdownBps<=0&&b.drawdownBps>=-10000,'Inventory, hedge ratio or drawdown is outside valid bounds.');if(a.offHours!==undefined){need(typeof a.offHours==='boolean','Off-hours must be boolean.');b.offHours=a.offHours}if(a.oracleHeld!==undefined){need(typeof a.oracleHeld==='boolean','Oracle hold must be boolean.');b.oracleHeld=a.oracleHeld}
  const breach=b.inventory>b.mandate.maxInventoryUsd||Math.abs(b.skewBps)>b.mandate.maxSkewBps||b.hedgeRatioBps<b.mandate.hedgeRatioMinBps||b.hedgeRatioBps>b.mandate.hedgeRatioMaxBps||b.drawdownBps<=b.mandate.killAtDrawdownBps;
  if(breach){b.status='Killed';b.paused=true;for(const k of b.agents)k.status='Revoked';b.inventory=0;log(s,'Kill executed',b.id,'Cancel → flatten within mandate → revoke keys → notify sponsor.');message='Mandate breached. Quotes stopped, inventory flattened and keys revoked.'}
  else{log(s,'Risk observation',b.id,b.offHours||b.oracleHeld?'Reduce-only; no new risk.':'Risk observation within configured limits.');message='Risk observation recorded.'}break;
 }
 case 'remandate':{
  wallet(s);role(s,'committee');const b=book(s,a.bookId);need(!['Retired','Retiring'].includes(b.status),'A retired book cannot be re-mandated.');const limit=positive(a.maxInventoryUsd,'Maximum inventory'),kill=integer(a.killAtDrawdownBps,'Drawdown kill',-10000,-1);need(b.inventory<=limit&&Math.abs(b.skewBps)<=b.mandate.maxSkewBps&&b.hedgeRatioBps>=b.mandate.hedgeRatioMinBps&&b.hedgeRatioBps<=b.mandate.hedgeRatioMaxBps&&b.drawdownBps>kill,'Restore risk observations within the mandate before resuming.');b.mandate.maxInventoryUsd=limit;b.mandate.killAtDrawdownBps=kill;b.status='Active';b.paused=false;log(s,'Re-mandated',b.id,'Committee restored a mandate; revoked agent keys remain revoked.');message='Mandate restored. Register new agent keys separately.';break;
 }
 case 'charterFile':{
  wallet(s);role(s,'sponsor');need(a.charter&&typeof a.charter==='object','Charter terms are required.');const c=structuredClone(a.charter);for(const f of ['symbol','underlying','sessions','hedgeAllowRoot']){need(typeof c[f]==='string'&&c[f].trim(),`${f} is required.`);c[f]=c[f].trim()}need(['Orderly','In-house'].includes(c.venue),'Select a venue.');need(['Chainlink','Attested multi-source TEE'].includes(c.oracle),'Select an oracle plan.');
  for(const f of ['ifTargetUsd','mmInventoryUsd','maxInventoryUsd'])c[f]=positive(c[f],f);
  c.subscriptionHours=duration(c.subscriptionHours,'Subscription window',3600,4294967295);need(c.subscriptionHours>0,'Subscription window must be positive.');
  c.juniorNoticeDays=duration(c.juniorNoticeDays,'Junior notice',86400);need(Math.abs(s.now+c.juniorNoticeDays*DAY)<8.64e15,'Junior notice exceeds the supported clock range.');
  c.maxSkewBps=integer(c.maxSkewBps,'Maximum skew',1,32767);c.minQuoteWidthBps=integer(c.minQuoteWidthBps,'Minimum quote width',1,65535);c.maxHedgeLeverageX10=integer(c.maxHedgeLeverageX10,'Maximum hedge leverage',1,65535);
  for(const f of ['seniorHurdleBps','seniorCapBps','hedgeRatioMinBps','hedgeRatioMaxBps'])c[f]=integer(c[f],f,0,10000);
  need(c.hedgeRatioMinBps<=c.hedgeRatioMaxBps,'Minimum hedge ratio cannot exceed maximum.');c.killAtDrawdownBps=integer(c.killAtDrawdownBps,'Drawdown kill',-10000,-1);
  if(c.noNewRiskOffHours===undefined)c.noNewRiskOffHours=true;need(typeof c.noNewRiskOffHours==='boolean','Off-hours mandate must be boolean.');
  need(s.balance>=s.settings.charterFee&&s.bkrnBalance>=s.settings.sponsorBond,'Insufficient review fee or sponsor bond balance.');s.balance=money(s.balance-s.settings.charterFee);s.bkrnBalance=money(s.bkrnBalance-s.settings.sponsorBond);
  s.charters.unshift({...c,id:id('charter'),sponsor:s.wallet.address,status:'Filed',filedAt:s.now,juryCid:null,votes:{},fee:s.settings.charterFee,bond:s.settings.sponsorBond,bookId:null});log(s,'Charter filed',null,`${c.symbol}: review deadline ${new Date(s.now+2*DAY).toISOString()}.`);message='Charter filed for bonded committee and jury review.';break;
 }
 case 'charterVote':{
  wallet(s);role(s,'committee');const c=s.charters.find(c=>c.id===a.id);need(c&&c.status==='Filed','Only filed charters can be reviewed.');need(s.committee.includes(a.member),'Unknown committee member.');need(typeof a.juryCid==='string'&&a.juryCid.trim(),'Provide a jury verdict reference.');need(typeof a.approve==='boolean','Committee decision must be boolean.');need(!Object.hasOwn(c.votes,a.member),'This committee member has already voted.');need(!c.juryCid||c.juryCid===a.juryCid.trim(),'All votes must reference the same jury verdict.');c.juryCid=a.juryCid.trim();c.votes[a.member]=a.approve;
  const yes=Object.values(c.votes).filter(Boolean).length,no=Object.values(c.votes).filter(v=>!v).length;
  if(yes>=2){c.status='Approved';c.decidedAt=s.now;const m={};for(const f of Object.keys(mandate()))m[f]=c[f]??mandate()[f];const b={id:id('book'),symbol:c.symbol.toUpperCase(),underlying:c.underlying,venue:c.venue,status:'Open',paused:false,windowEnd:s.now+c.subscriptionHours*3600000,seniorCapBps:c.seniorCapBps,seniorHurdleBps:c.seniorHurdleBps,juniorNoticeSeconds:c.juniorNoticeDays*86400,seniorNav:0,juniorNav:0,seniorShares:0,juniorShares:0,seniorCapitalBasis:0,sponsorJuniorShares:0,liquidity:0,venueEquity:0,inventory:0,skewBps:0,hedgeRatioBps:c.hedgeRatioMinBps,drawdownBps:0,offHours:false,oracleHeld:false,mandate:m,marks:[],settlements:[],agents:[]};s.books.push(b);c.bookId=b.id;log(s,'Charter approved',b.id,'Two-of-three approval and jury reference recorded.');message='Charter approved and market book opened.'}
  else if(no>=2){c.status='Rejected';c.decidedAt=s.now;s.balance=money(s.balance+c.fee);s.bkrnBalance=money(s.bkrnBalance+c.bond);log(s,'Charter rejected',null,`${c.symbol}: review fee refunded and bond released.`);message='Charter rejected. Review fee refunded; local bond released.'}
  else message='Vote recorded. Two committee votes are needed for a decision.';break;
 }
 case 'stake':{
  wallet(s);const amount=positive(a.amount,'Stake');need(amount<=s.bkrnBalance,'Insufficient $BKRN balance.');need(['sponsor','committee','operator'].includes(a.purpose),'Select an access/bonding purpose.');s.bkrnBalance=money(s.bkrnBalance-amount);s.staked=money(s.staked+amount);log(s,'Stake recorded',null,`$BKRN for ${a.purpose} access and bonding.`,amount);message='Access/bonding stake recorded.';break;
 }
 case 'recall':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId);const amount=positive(a.amount,'Recall');need(amount<=b.venueEquity,'Recall exceeds venue equity.');b.venueEquity=money(b.venueEquity-amount);b.liquidity=money(b.liquidity+amount);log(s,'Venue recall',b.id,'Capital recalled to UnderwritingVault only.',amount);message='Capital recalled to the underwriting vault.';break;
 }
 case 'deploy':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId);need(!b.paused&&!['Killed','Retiring','Retired'].includes(b.status),'New risk is paused for this book.');need(!b.offHours&&!b.oracleHeld,'Off-hours or held feeds permit reduce-only actions.');const amount=positive(a.amount,'Deployment');need(amount<=b.liquidity,'Insufficient vault liquidity.');b.liquidity=money(b.liquidity-amount);b.venueEquity=money(b.venueEquity+amount);log(s,'Venue deployment',b.id,'Vault capital deployed to approved venue.',amount);message='Capital deployed to the approved venue.';break;
 }
 case 'loss':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId),amount=positive(a.amount,'Observed loss');need(amount<=nav(b),'Loss cannot exceed accounted book capital.');const junior=Math.min(amount,b.juniorNav),senior=money(amount-junior);b.juniorNav=money(b.juniorNav-junior);b.seniorNav=money(b.seniorNav-senior);const fromVenue=Math.min(amount,b.venueEquity);b.venueEquity=money(b.venueEquity-fromVenue);b.liquidity=money(b.liquidity-(amount-fromVenue));log(s,'Loss absorbed',b.id,`Junior ${junior.toFixed(2)} → Senior ${senior.toFixed(2)}.`,amount);message='Loss applied in Junior-then-Senior order.';break;
 }
 case 'backstop':{
  wallet(s);role(s,'committee');const b=book(s,a.bookId);need(b.juniorNav===0,'Junior must be exhausted before Senior backstop coverage.');const shortfall=money(principal(b)-b.seniorNav);need(shortfall>0,'No Senior capital shortfall is recorded.');const amount=Math.min(shortfall,s.backstop);need(amount>0,'No backstop capital is available.');s.backstop=money(s.backstop-amount);b.seniorNav=money(b.seniorNav+amount);b.liquidity=money(b.liquidity+amount);log(s,'Backstop coverage',b.id,'Available balance used after Junior exhaustion.',amount);message='Available backstop capital applied to the Senior shortfall.';break;
 }
 case 'retire':{
  wallet(s);role(s,'sponsor','committee');const b=book(s,a.bookId);need(!['Retired','Retiring'].includes(b.status),'Book retirement is already in progress or complete.');b.status='Retiring';b.paused=true;b.inventory=0;b.liquidity=nav(b);b.venueEquity=0;b.agents.forEach(k=>k.status='Revoked');log(s,'Retirement',b.id,'Quotes stopped → inventory flattened → capital recalled. Final mark pending.');message='Book retired from quoting; commit the final mark next.';break;
 }
 case 'mark':{
  wallet(s);role(s,'operator');const b=book(s,a.bookId);const grossValue=finite(a.gross,'Fee flow'),expenseValue=finite(a.expenses,'Expenses');need(grossValue>=0&&expenseValue>=0,'Fee flow and expenses must be nonnegative.');need(expenseValue<=grossValue,'Expenses cannot exceed this period’s fee flow.');
  s.now+=DAY;const gross=money(a.gross),expenses=money(a.expenses),net=money(gross-expenses),carry=money(net*.1),distributable=money(net-carry),senior=b.seniorShares?money(distributable*b.seniorHurdleBps/10000):0,junior=money(distributable-senior);
  const buyback=Math.floor(Math.round(carry*100)/2)/100,backstop=money(carry-buyback);
  need(b.juniorShares>0||junior===0,'Junior must be capitalised before recording residual fee flow.');b.seniorNav=money(b.seniorNav+senior);b.juniorNav=money(b.juniorNav+junior);b.liquidity=money(b.liquidity+distributable);s.backstop=money(s.backstop+backstop);
  const settlement={id:id('settlement'),timestamp:s.now,source:b.venue,gross,expenses,carry,senior,junior,buyback,backstop};b.settlements.unshift(settlement);
  const markId=id('mark');
  for(const r of s.redemptions.filter(r=>r.bookId===b.id&&r.status==='Queued'&&r.eligibleAt<=s.now)){
    const p=position(s,b.id,r.tranche),amount=r.shares===b[`${r.tranche}Shares`]?b[`${r.tranche}Nav`]:money(r.shares*sharePrice(b,r.tranche));
    if(amount>b.liquidity){const recall=Math.min(amount-b.liquidity,b.venueEquity);b.venueEquity=money(b.venueEquity-recall);b.liquidity=money(b.liquidity+recall)}
    need(amount<=b.liquidity,'Venue liquidity recall is needed before honouring this notice.');
    if(r.tranche==='junior'){const sponsorShares=(p.sponsorShares??0)*r.shares/p.shares;p.sponsorShares=Math.max(0,(p.sponsorShares??0)-sponsorShares);b.sponsorJuniorShares=Math.max(0,b.sponsorJuniorShares-sponsorShares);r.sponsorShares=sponsorShares}
    else b.seniorCapitalBasis=money(principal(b)*(1-r.shares/b.seniorShares));
    p.shares=Math.max(0,p.shares-r.shares);b[`${r.tranche}Shares`]=Math.max(0,b[`${r.tranche}Shares`]-r.shares);b[`${r.tranche}Nav`]=money(b[`${r.tranche}Nav`]-amount);b.liquidity=money(b.liquidity-amount);s.balance=money(s.balance+amount);r.status='Fulfilled';r.fulfilledMark=markId;r.paid=amount;log(s,'Redemption honoured',b.id,r.id,amount);
  }
  if(b.status==='Retiring')b.status='Retired';
  log(s,'Distribution',b.id,'Expenses → 10% carry → Senior hurdle → Junior residual.',distributable);
  b.marks.unshift({id:markId,bookId:b.id,periodEnd:s.now,nav:nav(b),seniorNav:b.seniorNav,juniorNav:b.juniorNav,inventory:b.inventory,pnl:distributable,receiptRecords:structuredClone(s.activity.filter(e=>e.bookId===b.id)),signature:null,publicKey:null,receiptsRoot:null});
  log(s,'Mark recorded',b.id,'Daily accounting reconciled; local signature and receipt root prepared.');message='Daily mark recorded; eligible redemption notices honoured.';break;
 }
 case 'settings':{
  role(s,'operator');for(const f of ['charterFee','sponsorBond','walletCap']){positive(a[f],f);s.settings[f]=money(a[f])}message='Preview configuration saved.';break;
 }
 default:throw new Error('Unknown operation.');
 }
 invariants(s);return {state:s,message};
}
const encode=s=>new TextEncoder().encode(s);
export async function digest(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('')}
export async function merkle(records){
 let leaves=await Promise.all(records.map(r=>digest(JSON.stringify(r))));if(!leaves.length)leaves=[await digest('')];const levels=[leaves];
 while(levels.at(-1).length>1){const prev=levels.at(-1),next=[];for(let i=0;i<prev.length;i+=2)next.push(await digest(prev[i]+(prev[i+1]||prev[i])));levels.push(next)}
 return {root:levels.at(-1)[0],levels};
}
export async function proof(records,index=0){need(Array.isArray(records)&&Number.isSafeInteger(index)&&index>=0&&index<records.length,'Select an existing receipt for its inclusion proof.');const {root,levels}=await merkle(records);let i=index;const steps=[];for(const level of levels.slice(0,-1)){const sibling=i^1;steps.push({hash:level[sibling]||level[i],left:sibling<i});i=Math.floor(i/2)}return {root,leaf:levels[0][index],steps,record:structuredClone(records[index])}}
const hashValue=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function verifyProof(p,expectedRoot=p?.root){try{if(!p||!hashValue(p.root)||!hashValue(p.leaf)||!hashValue(expectedRoot)||p.root!==expectedRoot||!Array.isArray(p.steps)||p.record===undefined)return false;let hash=await digest(JSON.stringify(p.record));if(hash!==p.leaf)return false;for(const step of p.steps){if(!hashValue(step.hash)||typeof step.left!=='boolean')return false;hash=await digest(step.left?step.hash+hash:hash+step.hash)}return hash===expectedRoot}catch{return false}}
const markPayload=m=>JSON.stringify({id:m.id,...(m.bookId===undefined?{}:{bookId:m.bookId}),periodEnd:m.periodEnd,nav:m.nav,seniorNav:m.seniorNav,juniorNav:m.juniorNav,inventory:m.inventory,pnl:m.pnl,receiptsRoot:m.receiptsRoot});
export async function signMark(mark){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);mark.receiptsRoot=(await merkle(mark.receiptRecords)).root;const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encode(markPayload(mark)));mark.signature=[...new Uint8Array(sig)];mark.publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);return mark;
}
export async function verifyMark(mark){try{if(!mark?.signature||!mark.publicKey||!hashValue(mark.receiptsRoot)||!Array.isArray(mark.receiptRecords)||!Array.isArray(mark.signature)||!mark.signature.every(v=>Number.isInteger(v)&&v>=0&&v<=255))return false;for(const f of ['periodEnd','nav','seniorNav','juniorNav','inventory','pnl'])if(!Number.isFinite(mark[f]))return false;if(mark.nav!==money(mark.seniorNav+mark.juniorNav))return false;const key=await crypto.subtle.importKey('jwk',mark.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,new Uint8Array(mark.signature),encode(markPayload(mark)))&&mark.receiptsRoot===(await merkle(mark.receiptRecords)).root}catch{return false}}
