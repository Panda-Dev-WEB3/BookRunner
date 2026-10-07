(() => {
 const tabs=[...document.querySelectorAll('.flow-tabs [role="tab"]')];
 function select(tab){tabs.forEach(t=>{const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;document.getElementById(t.getAttribute('aria-controls')).hidden=!active;});}
 tabs.forEach(tab=>{tab.addEventListener('click',()=>select(tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(tab)+1)%tabs.length];select(next);next.focus();});});
 const links=[...document.querySelectorAll('.chapter-index a[href^="#"]')],chapters=links.map(link=>document.querySelector(link.getAttribute('href'))).filter(Boolean);let scheduled=false;
 function update(){const threshold=innerWidth<721?155:140;let current=chapters[0];chapters.forEach(chapter=>{if(chapter.getBoundingClientRect().top<=threshold)current=chapter;});links.forEach(link=>{const active=link.hash==='#'+current.id;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});scheduled=false;}
 addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(update);}}, {passive:true});update();
})();
