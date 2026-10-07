(async () => {
  await window.BookRunnerPageReady;
  document.body.classList.add('br-arriving');
  window.addEventListener('pageshow',()=>document.documentElement.classList.remove('br-leaving'));
  const icons={
    GitHub:'<path d="M12 .9a11.1 11.1 0 0 0-3.5 21.63c.55.1.76-.24.76-.54v-2.07c-3.1.67-3.76-1.32-3.76-1.32-.5-1.28-1.23-1.62-1.23-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15 1 .17 2.18.71 3.26-.1.1-.72.4-1.21.71-1.49-2.47-.28-5.06-1.23-5.06-5.5 0-1.22.44-2.22 1.14-3-.11-.28-.5-1.42.11-2.97 0 0 .93-.3 3.06 1.14a10.6 10.6 0 0 1 5.57 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.55.22 2.7.11 2.97.71.78 1.14 1.78 1.14 3 0 4.29-2.6 5.22-5.08 5.49.4.35.75 1.02.75 2.06v3.08c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/>',
    Telegram:'<path d="m21.2 3.4-3.3 16.2c-.25 1.15-.93 1.43-1.9.88l-5.04-3.71-2.43 2.34c-.27.27-.5.5-1.02.5l.37-5.16 9.4-8.5c.4-.36-.1-.56-.64-.2L5.03 13.1.7 11.75c-.94-.3-.96-.94.2-1.4L17.8 3.8c.79-.29 1.49-.34 1.93-.12.37.18.42.58.28 1.18Z"/>',
    X:'<path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.9-9L1 2h6.5l4.4 6.8L18.9 2Zm-1.1 18h1.8L6.5 3.9H4.6L17.8 20Z"/>'
  };
  const filters=document.createElementNS('http://www.w3.org/2000/svg','svg');filters.setAttribute('width','0');filters.setAttribute('height','0');filters.setAttribute('aria-hidden','true');filters.style.position='absolute';filters.innerHTML='<defs><filter id="bookrunner-print-ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values=".175 .590 .060 0 .12 .144 .483 .049 0 .27 .047 .157 .016 0 .74 0 0 0 1 0"/></filter><filter id="bookrunner-fantasy-ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values=".252168 .848261 .085629 0 -.093023 .252168 .848261 .085629 0 -.093023 .252168 .848261 .085629 0 -.093023 0 0 0 1 0"/><feColorMatrix type="matrix" values=".9215686 0 0 0 .0392157 0 .945098 0 0 .0156863 0 0 -.0039216 0 .9568627 0 0 0 1 0"/></filter></defs>';document.body.append(filters);
  const modal=document.createElement('dialog');modal.className='br-dialog';modal.setAttribute('aria-labelledby','br-coming-title');modal.innerHTML='<img class="br-logo" src="/assets/bookrunner-logo-transparent.png" alt="BookRunner"><h2 id="br-coming-title">Coming soon</h2><button type="button">Close</button>';document.body.append(modal);modal.querySelector('button').onclick=()=>modal.close();modal.onclick=e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}};
  function social(){const box=document.createElement('div');box.className='br-socials';for(const [name,path] of Object.entries(icons)){const b=document.createElement('button');b.className='br-social';b.type='button';b.setAttribute('aria-label',name);const shifts={GitHub:'0.916 .276',Telegram:'1.394 -.075',X:'-.1 0'};b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="translate('+shifts[name]+')">'+path+'</g></svg>';b.onclick=()=>modal.showModal();box.append(b)}return box}
  function lockup(a){
    a.setAttribute('aria-label','BookRunner');
    if(!a.querySelector(':scope > .br-brand-lockup')){
      const mark=document.createElement('span');mark.className='br-brand-lockup';
      mark.innerHTML=a.classList.contains('br-footer-wordmark')?'<img class="br-logo" src="/assets/bookrunner-logo-transparent.png" alt=""><span class="br-name">BookRunner</span>':'<span class="br-name">BookRunner</span>';
      a.append(mark);
    }
  }
  function fitWords(){
    document.querySelectorAll('svg > foreignObject.framer-fit-text > p').forEach(p=>{
      const svg=p.closest('svg'); if(!svg||!svg.clientWidth)return;
      p.removeAttribute('data-br-glyph-room');p.style.removeProperty('font-size');
      p.style.whiteSpace='nowrap';
      const vb=svg.viewBox.baseVal;
      if(!vb.width||!vb.height)return;
      const range=document.createRange();range.selectNodeContents(p);
      const rect=svg.getBoundingClientRect();
      const scale=Math.min(rect.width/vb.width,rect.height/vb.height);
      const width=range.getBoundingClientRect().width/scale;
      if(width>0&&Number.isFinite(width)){
        // Re-measure the replacement word, retaining the reference's frame,
        // centre alignment and the original motion on the SVG itself.
        const measured=Math.ceil(width+parseFloat(getComputedStyle(p).fontSize)*.04);
        if(Math.abs(vb.width-measured)>1)svg.setAttribute('viewBox',`0 0 ${measured} ${vb.height}`);
      }
    });
  }
  function brandHeroMovie(){
    const video=document.querySelector('#hero video');
    if(!video)return;
    video.setAttribute('aria-label','BookRunner engraved laptop animation');
    // Mobile-only: the hero film is removed entirely on phones (user request),
    // desktop keeps the original cinematic hero video.
    if(window.matchMedia('(max-width: 809.98px)').matches){
      video.classList.add('br-mobile-hero-hidden');
      video.removeAttribute('autoplay');
      video.pause();
      video.removeAttribute('poster');
      video.preload='none';
      const source=video.querySelector('source');
      if(source)source.remove();
      if(video.getAttribute('src'))video.removeAttribute('src');
      video.load();
    } else {
      video.preload='auto';
    }
  }

  const fantasyAlternates={".framer-t6jba8 img": "/assets/fantasy/images/fantasy-art-96.webp", ".framer-1nzq9q6 img": "/assets/fantasy/images/fantasy-art-97.webp", ".framer-19i0twy img": "/assets/fantasy/images/fantasy-art-98.webp", ".framer-1uk4kv img": "/assets/fantasy/images/waterfall-warrior.webp", ".framer-tzeqk2 img": "/assets/fantasy/images/waterfall-column-fish.webp"};
  const fantasyFooters={ '/':'home-syndicate', '/research':'reports-archivists', '/jobs':'jobs-envoys', '/research/human-creativity-benchmark':'charter-council' };
  function fantasyMedia(){
    const route=location.pathname.replace(/\/$/,'')||'/';
    if(route==='/')for(const [selector,src] of Object.entries(fantasyAlternates))document.querySelectorAll(selector).forEach(image=>{if(new URL(image.src,location.href).pathname!==src){image.src=src;image.removeAttribute('srcset');}image.dataset.brFantasyPlacement=selector;});
    document.querySelectorAll('img[src*="/assets/fantasy/"]').forEach(image=>image.classList.add('br-fantasy-art'));
    document.querySelectorAll('video').forEach(video=>{
      const footer=video.closest('.framer-wvp6og-container');
      const banner=video.closest('.framer-g7a8rw-container');
      const name=footer?fantasyFooters[route]:banner?(route==='/jobs'?'agent-stylus':'mandate-seal'):null;
      if(footer){const frame=footer.closest('.framer-1gxpqik');if(frame)frame.style.setProperty('--br-footer-aspect',route==='/'?'1920 / 740':route==='/jobs'?'1920 / 940':'1920 / 820');}
      if(name){const src='/assets/fantasy/videos/'+name+'.webm';if(new URL(video.src,location.href).pathname!==src){video.src=src;video.load();}video.poster='/assets/fantasy/videos/'+name+'-poster.webp';}
      if((video.currentSrc||video.src).includes('/assets/fantasy/')){video.classList.add('br-fantasy-video');video.preload='auto';const ownPoster=new URL(video.src,location.href).pathname.replace(/\.(webm|mp4)$/,'-poster.webp');if(!video.poster||!video.poster.includes('/assets/fantasy/'))video.poster=ownPoster;}
      if(route==='/research/human-creativity-benchmark'&&!footer){video.style.height='auto';video.style.maxHeight='none';video.style.aspectRatio='16 / 9';}
    });
  }

  let chosenTranche=null;
  function waterfallSelection(){
    document.querySelectorAll('.framer-hgvfu0').forEach(root=>{
      root.classList.add('br-tranche-selector');
      root.dataset.brSelected=chosenTranche||root.dataset.brSelected||'Senior';
      const frames=[...root.querySelectorAll(':scope > .framer-kkesgz > div')].filter(e=>e.querySelector('img'));
      frames.forEach((frame,index)=>{
        const name=index===0?'Senior':'Junior';frame.dataset.brTranche=name;
        const art='/assets/fantasy/images/'+(name==='Senior'?'senior-treasury':'junior-voyage')+'-v11.webp';frame.querySelectorAll('img').forEach(image=>{if(new URL(image.src,location.href).pathname!==art){image.src=art;image.removeAttribute('srcset');}image.alt=name==='Senior'?'Senior tranche, Ionic treasury':'Junior tranche, Greek ship under sail';});
        let tag=frame.querySelector(':scope > .br-tranche-tag');
        if(!tag){tag=document.createElement('span');tag.className='br-tranche-tag';frame.append(tag);}
        const selected=root.dataset.brSelected===name;
        tag.textContent=name+(selected?' · Selected':'');frame.classList.toggle('br-choice-active',selected);
      });
      root.querySelectorAll('.framer-aSSE6').forEach(control=>{
        const text=control.querySelector('p')?.textContent.trim();
        const name=text==='Select Senior'?'Senior':text==='Select Junior'?'Junior':null;
        if(!name)return;control.dataset.brChoice=name;control.setAttribute('role','button');
        control.setAttribute('aria-label','Select '+name);control.setAttribute('aria-pressed',String(root.dataset.brSelected===name));
      });
    });
  }
  function selectTranche(control){
    const root=control.closest('.br-tranche-selector');if(!root)return;
    chosenTranche=control.dataset.brChoice;root.dataset.brSelected=chosenTranche;
    const text=root.querySelector('.framer-1vqvgwi p');
    if(text)text.textContent=control.dataset.brChoice==='Senior'?'Senior: first claim on fee flow up to its hurdle share, last loss. Redeem at NAV on the next daily mark. Senior carries capital risk.':'Junior: residual fee flow, first loss. Redeem at NAV after the notice period and the next daily mark. Default notice: seven days.';
    waterfallSelection();
  }
  document.addEventListener('click',event=>{
    const control=event.target.closest('[data-br-choice]');if(!control)return;
    event.preventDefault();event.stopImmediatePropagation();selectTranche(control);
  },true);
  document.addEventListener('keydown',event=>{
    if(!['Enter',' '].includes(event.key))return;
    const control=event.target.closest('[data-br-choice]');if(!control)return;
    event.preventDefault();event.stopImmediatePropagation();selectTranche(control);
  },true);
  function productIcons(){
    // The reference used quotation marks for personal testimonials. These
    // cards now describe book controls, so use a book and a verified shield.
    document.querySelectorAll('svg[viewBox="0 0 32 32"]').forEach(svg=>{
      if(svg.dataset.brIcon||!svg.querySelector('path[d^="M5 21V15"]'))return;
      svg.dataset.brIcon='book-control';svg.setAttribute('viewBox','0 0 24 24');
      svg.classList.add('br-product-icon');svg.style.transform='none';
      svg.innerHTML='<path d="M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2Z"/>';
    });
  }
  let copy={};fetch('/assets/brand-copy.json').then(r=>r.json()).then(r=>{copy=r;refresh()}).catch(()=>{});
  const socialPattern=/x\.com\/|youtube\.com\/channel|linkedin\.com\/company|instagram\.com\/bookrunner/;
  function destination(a){
    const text=a.textContent.replace(/\s+/g,' ').trim(),href=a.getAttribute('href')||'';
    if(/^(\.\/|\/)research\/[^#]/.test(href))return '/documents/';
    if(href.includes('research#datasets')||href.includes('research/#datasets'))return '/research/#documents';
    if(/^(Open dashboard|Run a book|For allocators)/.test(text))return '/dashboard/';
    if(/^(Open BookRunner|Join the syndicate|Bookrunners)/.test(text))return '/jobs/';
    if(text==='Robinhood Chain'||text==='01 October 2026'||text==='Run the book.')return '/documents/';
    if(text==='$BKRN access & bonding')return '/dashboard/#staking';
    if(/^Charter termss/.test(text))return null;
    if(/^Reports/.test(text))return '/research/';
    if(/^Receipts/.test(text))return '/research/#documents';
    if(/^Books(?:\s*Books)?$/.test(text))return '/#offerings';
    if(/^Explore the books/.test(text))return '/dashboard/#books';
    if(/^(Read the spec|Read specification|Download report|View the marks|Export)/.test(text))return '/documents/';
    if(/Senior allocators|Junior allocators/.test(text))return '/dashboard/#portfolio';
    if(/Charter sponsors|Market sponsors/.test(text))return '/dashboard/#charters';
    if(/Risk Committee/.test(text))return '/dashboard/#risk';
    if(/Mark signers|Receipt keepers/.test(text))return '/dashboard/#marks';
    if(/Bookrunner agents|Venue operators|Hedge operators|Oracle operators/.test(text))return '/dashboard/#agents';
    if(/calendly|bookrunner-work\.slack|bookrunner\.com\/(discover|bookrunner-network)/.test(href))return '/dashboard/';
    if(/huggingface\.co|linkedin\.com\/sharing/.test(href))return '/documents/';
    if(/^(\.\/|\/)research\/[^#]/.test(href))return '/documents/';
    return null;
  }
  function refresh(){
    if(!document.body)return;
    document.title=document.title.replaceAll("&amp;","&");
    document.body.classList.toggle("br-bookrunners-page",location.pathname.startsWith("/jobs"));
    document.querySelectorAll('a[href]').forEach(a=>{
      let href=a.getAttribute('href')||'';
      if(/creative-human-data|human-creativity-benchmark/.test(href)){
        const reports=href.includes('creative-human-data');href=reports?'/research/':'/jobs/';a.setAttribute('href',href);a.dataset.brFullRoute='true';
        const labels=a.querySelectorAll('p');labels.forEach(p=>p.textContent=reports?'Reports':'Bookrunners');
      }
      if(/#hero$/.test(href)){a.setAttribute('href','/#hero');a.removeAttribute('target')}
      if(/#hero$/.test(href)&&!a.matches('[data-framer-name="Logo Banner"]')&&!a.textContent.trim())a.classList.add('br-wordmark');
      if(socialPattern.test(href)){
        let parent=a.parentElement;
        while(parent.parentElement&&parent.querySelectorAll('a[href]').length<3)parent=parent.parentElement;
        if(!parent.querySelector(':scope > .br-socials')&&(!location.pathname.startsWith('/jobs')||!document.querySelector('.br-socials')))parent.append(social());
        parent.querySelectorAll('a[href]').forEach(link=>{if(socialPattern.test(link.getAttribute('href')||'')){const wrapper=link.parentElement;link.style.display='none';link.setAttribute('aria-hidden','true');link.setAttribute('tabindex','-1');if(wrapper!==parent&&wrapper.querySelectorAll('a').length===1)wrapper.style.display='none'}});
      }
      const target=destination(a);if(target){a.setAttribute('href',target);a.removeAttribute('target')}
      if(a.closest('[name="Logo"]'))a.classList.add('br-wordmark');
    });
    document.querySelectorAll('a[style]').forEach(a=>{if(a.style.aspectRatio==='4 / 5')a.classList.add('br-role-card')});
    document.querySelectorAll('a.framer-zubHS').forEach(a=>{a.classList.add('br-footer-wordmark');a.href='/#hero';lockup(a)});
    document.querySelectorAll('a.framer-roWoR,.br-wordmark').forEach(a=>{a.classList.add('br-wordmark');lockup(a)});
    document.querySelectorAll('a[data-framer-name="Logo Banner"]').forEach(a=>{a.setAttribute('aria-label','BookRunner home');a.setAttribute('href','/#hero')});
    document.querySelectorAll('.framer-8lv7W[data-framer-name^="Phone"]').forEach(header=>{
      header.classList.add('br-mobile-header');
      if(!header.querySelector(':scope > .br-mobile-wordmark')){
        const link=document.createElement('a');link.className='br-mobile-wordmark';link.href='/#hero';link.textContent='BookRunner';link.setAttribute('aria-label','BookRunner home');header.append(link);
      }
      header.querySelectorAll('a[href="/dashboard/"]').forEach(a=>a.classList.add('br-mobile-action'));
      header.querySelectorAll('.framer-qO1PU').forEach(menu=>{menu.setAttribute('role','button');menu.setAttribute('aria-label','Navigation menu');menu.setAttribute('aria-expanded',String(menu.getAttribute('data-framer-name')?.startsWith('Open')))});
    });
    document.querySelectorAll('button[aria-label*="Share on"]').forEach(button=>{
      const parent=button.parentElement;
      if(!parent.querySelector(':scope > .br-socials')&&(!location.pathname.startsWith('/jobs')||!document.querySelector('.br-socials')))parent.append(social());
      button.style.display='none';button.setAttribute('tabindex','-1');button.setAttribute('aria-hidden','true');
    });
    document.querySelectorAll('p').forEach(p=>{if(p.textContent==='Agent market-making'){let card=p.parentElement;while(card&& !card.querySelector('h3'))card=card.parentElement;const h=card?.querySelector('h3');if(h?.textContent==='Senior')h.textContent='Agent'}});
    const walk=document.createTreeWalker(document.getElementById('main')||document.body,NodeFilter.SHOW_TEXT);
    let n;while(n=walk.nextNode()){if(n.parentElement?.closest('script,style,.br-dialog,.br-socials,.br-brand-lockup,.br-mobile-wordmark'))continue;const t=n.nodeValue.trim();if(copy[t]&&copy[t]!==t)n.nodeValue=n.nodeValue.replace(t,copy[t]);if(n.nodeValue.includes('Charter termss'))n.nodeValue=n.nodeValue.replaceAll('Charter termss','Example charter parameters');if(n.nodeValue.includes('&amp;'))n.nodeValue=n.nodeValue.replaceAll('&amp;','&');if(n.nodeValue.includes(String.fromCharCode(8212)))n.nodeValue=n.nodeValue.replaceAll(String.fromCharCode(8212),',')}
    document.querySelectorAll('img').forEach(im=>{
      im.loading='eager';im.decoding='async';
      if(im.classList.contains('br-logo'))return;
      if(im.src.includes('/assets/tech/')){const titles={'robinhood-chain':'Robinhood Chain','orderly-venue':'Orderly Perp Anything','underwriting-vault':'UnderwritingVault','mandate-registry':'MandateRegistry and scoped session keys','stablecoin-capital':'USDC and USDG capital','mark-registry':'MarkRegistry and receipt roots','book-avatar':'Market book','mandate-avatar':'Risk mandate','receipt-avatar':'Signed receipt','chain-avatar':'Chain settlement'};im.alt=titles[im.src.split('/').pop().split('.')[0]];im.closest('[data-framer-name^="tool-"]')?.setAttribute('data-br-tech','');return;}
      if(im.src.includes('/assets/report-graphics/')){im.classList.add('br-report-art');if(im.parentElement.style.aspectRatio)im.parentElement.dataset.brReportThumbnail='';im.alt='BookRunner blue ink illustration';return}
      if(im.closest('[data-br-tech]'))return;
      im.alt='Classical illustration in BookRunner blue ink';
    });
    if(location.pathname.startsWith('/jobs')){
      const groups=[...document.querySelectorAll('.br-socials')];
      groups.slice(1).forEach(group=>group.remove());
    }
    document.querySelectorAll('[data-framer-name="ai tool logos"] img').forEach(im=>{im.closest('[data-framer-name^="tool-"]')?.setAttribute('data-br-tech','');});
    document.querySelectorAll('.framer-1skbf83 p').forEach(p=>{
      const expected='$BKRN access & bonding · Run the book.';
      if(p.textContent!==expected)p.innerHTML='<a class="framer-text" href="/dashboard/#staking">$BKRN access &amp; bonding</a> · <a class="framer-text" href="/documents/">Run the book</a>.';
    });
    fantasyMedia();
    brandHeroMovie();
    productIcons();
    waterfallSelection();
    fitWords();
    document.querySelectorAll('a[target="_blank"]').forEach(a=>{if(a.getAttribute('href')?.startsWith('/'))a.removeAttribute('target')});
  }
  let queued=false;const observer=new MutationObserver(records=>{if(!records.some(r=>r.type==='childList'||r.type==='characterData'||(r.type==='attributes'&&r.target.matches('a.framer-roWoR,a.framer-zubHS,img,video'))))return;if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;observer.disconnect();refresh();{const scope=document.getElementById('main')||document.body;if(scope)observer.observe(scope,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','src','poster']})}})}});refresh();{const scope=document.getElementById('main')||document.body;if(scope)observer.observe(scope,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','src','poster']})};
  function navigate(target){
    if(window.BookRunnerTransition)window.BookRunnerTransition.go(target);
    else location.assign(target);
  }
  // Preload local custom destinations on intent; Framer retains its own router
  // and page transitions for the three original public pages.
  const prefetched=new Set();
  document.addEventListener('pointerover',e=>{
    const link=e.target.closest('a[href]');if(!link)return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin||url.pathname===location.pathname||prefetched.has(url.pathname))return;
    prefetched.add(url.pathname);const preload=document.createElement('link');preload.rel='prefetch';preload.href=url.pathname;document.head.append(preload);
  },{passive:true});
  document.addEventListener('click',e=>{
    if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const a=e.target.closest('a');if(!a)return;const href=a.getAttribute('href')||'';
    if(socialPattern.test(href)){e.preventDefault();e.stopImmediatePropagation();modal.showModal();return}
    const target=destination(a)||(/^\/?dashboard\/?|^\/documents\//.test(href)?href:null);
    if(target){
      const url=new URL(target,location.href);
      if(['/','/research/','/research','/jobs/','/jobs'].includes(url.pathname))return;
      e.preventDefault();e.stopImmediatePropagation();navigate(target);return;
    }
    if(/^https?:/.test(href)&&!href.includes(location.host)){e.preventDefault();e.stopImmediatePropagation();navigate('/documents/');return}
  },true);
  document.fonts.ready.then(()=>requestAnimationFrame(fitWords));
  window.addEventListener('resize',()=>requestAnimationFrame(fitWords));
})();
