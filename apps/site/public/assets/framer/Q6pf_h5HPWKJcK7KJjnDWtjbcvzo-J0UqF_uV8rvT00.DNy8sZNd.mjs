import{t as e}from"./rolldown-runtime.Dh6celcD.mjs?br=12.0";import{A as t,C as n,P as r,_ as i,b as ee,c as a,j as te,l as o,o as s,p as c,s as l,w as u,y as ne}from"./react.CKky1o2r.mjs?br=12.0";import{N as d,i as re,o as ie,t as f}from"./motion.D3lr8OBC.mjs?br=12.0";import{Dt as p,F as m,H as h,Mt as g,N as _,St as v,T as y,Tt as ae,V as b,Y as x,_t as oe,a as S,b as C,ft as se,ht as ce,i as w,k as T,lt as le,pt as ue,u as E,vt as de}from"./framer.ZMYI__yC.mjs?br=12.0";import{i as D,n as O,r as k,t as fe}from"./lBKy44ghE.DcuKtDKc.mjs?br=12.0";import{n as A,t as j}from"./Lenis.1Z142ViW.mjs?br=12.0";import{i as M,n as N,r as P,t as pe}from"./lowhArszT.DIfBMUlg.mjs?br=12.0";import{i as me,n as he,r as ge,t as _e}from"./mvgU8yBlz.DvMiXncX.mjs?br=12.0";import{n as ve,t as F}from"./XqOH1xljs.D95_SzDd.mjs?br=12.0";import{n as ye,t as I}from"./kjbCwU0in.DF_iOX-h.mjs?br=12.0";import be,{t as xe}from"./vraCp4fzHRY-1jNyV2AH2nKByQ9YJTfk3fkgEskOces.qwfwkDWF.mjs?br=12.0";function L({items:e}){let t=e[0][1];return s(`div`,{children:e.map(([n,r],i)=>o(`div`,{style:{marginBottom:i<e.length-1?20:0},children:[o(`div`,{style:{display:`flex`,justifyContent:`space-between`,marginBottom:8,fontSize:`0.9rem`},children:[s(`span`,{style:{color:`#1748C7`},children:n}),o(`span`,{style:{color:`#888`},children:[r,`%`]})]}),s(`div`,{style:{width:`100%`,height:6,background:`rgba(0,0,0,0.12)`,borderRadius:3,overflow:`hidden`},children:s(`div`,{style:{width:`${r/t*100}%`,height:`100%`,borderRadius:3,background:B[i],transition:`width 0.3s`}})})]},n))})}function Se(){let[e,t]=i(null);return o(`div`,{className:`cl-faq-container`,children:[o(`h5`,{className:`cl-faq-heading`,children:[`Frequently asked`,s(`br`,{}),`questions`]}),s(`div`,{children:[{q:`What makes the Human Creativity Benchmark different?`,a:`Every prompt starts from an anonymized deliverable of a real, paid client project on BookRunner, not synthetic tasks or toy examples. And every vote comes from a verified creative professional from our network of 1.5M+ members across 150+ countries.`},{q:`How are models selected for tournaments?`,a:`Four distinct models are sampled from the active pool. Side assignment (left/right) is randomized every battle to eliminate position bias.`},{q:`Do ratings change after every battle?`,a:`Yes. Elo ratings update after each individual battle. We maintain both overall and per-category ratings so you can see how models perform on specific types of work.`},{q:`What modalities do you support?`,a:`We currently evaluate across three modalities: Image (ad design, brand assets, logo), Code (landing page, desktop app, UI component), and Video (ad designs, product shots). Each is tested across three creative phases: ideation, mockup, and refinement.`}].map((n,r)=>o(`div`,{className:`cl-faq-item`,children:[o(`div`,{className:`cl-faq-question`,onClick:()=>t(e===r?null:r),children:[s(`span`,{className:`cl-faq-q-text`,children:n.q}),s(`svg`,{width:`16`,height:`16`,viewBox:`0 0 16 16`,fill:`none`,style:{flexShrink:0,transition:`transform 0.3s`,transform:e===r?`rotate(180deg)`:`rotate(0)`},children:s(`path`,{d:`M4 6L8 10L12 6`,stroke:`currentColor`,strokeWidth:`1.5`,strokeLinecap:`round`,strokeLinejoin:`round`})})]}),s(`div`,{className:`cl-faq-answer`,style:{maxHeight:e===r?300:0,opacity:+(e===r),paddingBottom:e===r?24:0},children:s(`p`,{children:n.a})})]},r))})]})}function R(){let[e,t]=i(`All categories`);ne(()=>{let e=document.createElement(`link`);e.href=`https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400&display=swap`,e.rel=`stylesheet`,document.head.appendChild(e)},[]);let n=z[e];return o(`div`,{className:`cl`,children:[s(`style`,{children:V}),s(`section`,{className:`cl-section cl-bg-warm`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Overview`}),o(`h5`,{className:`cl-title`,children:[`Real work.`,s(`br`,{}),`Real professionals.`]}),o(`div`,{style:{marginBottom:56},children:[s(`p`,{className:`cl-body`,children:`The Creative Arena by BookRunner compares AI models on tasks that mirror real professional use cases via paid projects commissioned on BookRunner. We convert anonymized deliverables into prompts, run controlled tournaments with four models at a time, and update overall and per-category Elo ratings after every\xA0battle.`}),s(`p`,{className:`cl-body`,style:{marginTop:20},children:`Unlike synthetic benchmarks, every prompt originates from an actual client project. And unlike crowd-sourced preference tests, every vote comes from a verified creative professional: designers, developers, and video editors who do this work for a living.`})]}),s(`div`,{className:`cl-chart-tabs`,children:Object.keys(z).map(n=>s(`button`,{className:`cl-chart-tab ${n===e?`active`:``}`,onClick:()=>t(n),children:n},n))}),o(`div`,{className:`cl-charts-row`,children:[o(`div`,{className:`cl-chart-card`,children:[s(`p`,{className:`cl-chart-card-title`,children:`Top skills`}),s(L,{items:n.skills})]}),o(`div`,{className:`cl-chart-card`,children:[s(`p`,{className:`cl-chart-card-title`,children:`Top tools`}),s(L,{items:n.tools})]})]})]})}),s(`section`,{className:`cl-section cl-bg-dark`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Categories`}),s(`h5`,{className:`cl-title`,children:`Professional use cases`}),s(`p`,{className:`cl-body`,style:{marginBottom:48},children:`We evaluate models across the categories that matter to working creatives. These are the actual deliverables clients commission on BookRunner, organized by\xA0modality.`}),[{label:`Capital`,icon:`✦`,items:[`Ad Design`,`Brand Assets`,`Logo`]},{label:`Code`,icon:`</>`,items:[`Landing Page`,`Desktop App`,`UI Component`]},{label:`Agents`,icon:`▶`,items:[`Ad Designs`,`Product Shots`]}].map(e=>o(`div`,{className:`cl-cat-group`,children:[s(`p`,{className:`cl-cat-group-label`,children:e.label}),s(`div`,{className:`cl-cat-pills`,children:e.items.map(t=>o(`span`,{className:`cl-pill`,children:[s(`span`,{className:`cl-pill-icon`,children:e.icon}),` `,t]},t))})]},e.label))]})}),s(`section`,{className:`cl-section cl-bg-sage`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Evaluation Depth`}),o(`h5`,{className:`cl-title`,children:[`Three phases of`,s(`br`,{}),`creative work`]}),s(`p`,{className:`cl-body`,style:{marginBottom:48},children:`Within each category, we evaluate models across the phases of the creative process, from first spark to final polish.`}),s(`div`,{className:`cl-phases-grid`,children:[{num:`Phase 01`,name:`NVDA`,desc:`Generating the initial creative concept from a prompt. Models produce directional output that captures tone, mood, and creative intent.`,goal:`Goal: Direction, not precision`},{num:`Phase 02`,name:`TSLA`,desc:`Translating that concept into a structured, composed layout. Models must execute against a clear creative brief with proper hierarchy and composition.`,goal:`Goal: Execution against a brief`},{num:`Phase 03`,name:`Stock index`,desc:`Fine-tuning a near-final output with precise edits. Models must demonstrate control, consistency, and attention to production-level detail.`,goal:`Goal: Polish & production readiness`}].map(e=>o(`div`,{className:`cl-phase-card`,children:[s(`p`,{className:`cl-phase-num`,children:e.num}),s(`p`,{className:`cl-phase-name`,children:e.name}),s(`p`,{className:`cl-phase-desc`,children:e.desc}),s(`p`,{className:`cl-phase-goal`,children:e.goal})]},e.name))})]})}),s(`section`,{className:`cl-section cl-bg-warm`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Data Sourcing & Prompt Generation`}),o(`h5`,{className:`cl-title`,children:[`From real projects`,s(`br`,{}),`to controlled prompts`]}),s(`div`,{className:`cl-steps`,children:[{n:`01`,t:`Collect Deliverables`,d:`We sample deliverables from real, completed paid projects commissioned on BookRunner's marketplace.`},{n:`02`,t:`Anonymize & Sanitize`,d:`We remove personally identifiable information, trademarks, and client-specific terms that would reveal identity or confidential details.`},{n:`03`,t:`Category Classification`,d:`Deliverables are run through a classifier (LLM-assisted) to map to one of the Arena categories and creative phases.`},{n:`04`,t:`Prompt Drafting`,d:`From the anonymized deliverable, we generate a prompt that captures the intent, constraints, and style of the original request while remaining generic and safe.`},{n:`05`,t:`Generation`,d:`An output is generated for the given prompt for each active model: images, code, or video depending on category.`}].map((e,t)=>o(`div`,{className:`cl-step`,style:{borderBottom:t<4?`1px solid rgba(0,0,0,0.08)`:`none`},children:[s(`span`,{className:`cl-step-num`,children:e.n}),o(`div`,{children:[s(`p`,{className:`cl-step-title`,children:e.t}),s(`p`,{className:`cl-step-desc`,children:e.d})]})]},e.n))})]})}),s(`section`,{className:`cl-section cl-bg-warm`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Tournament Format`}),o(`h5`,{className:`cl-title`,children:[`4 models. 6 battles.`,s(`br`,{}),`Full ranking.`]}),s(`p`,{className:`cl-body`,style:{marginBottom:48},children:`Each tournament samples four models from the active pool, runs a fixed six-battle bracket, and yields a complete 1st–4th ordering per prompt.`}),o(`div`,{className:`cl-tourney-visual`,children:[o(`div`,{className:`cl-tourney-header`,children:[s(`span`,{className:`cl-tourney-header-title`,children:`Tournament Flow`}),s(`span`,{className:`cl-tourney-badge`,children:`6 Battles`})]}),o(`div`,{className:`cl-bracket`,children:[o(`div`,{className:`cl-bracket-round`,children:[s(`p`,{className:`cl-bracket-label`,children:`Initial`}),s(`div`,{className:`cl-bracket-match`,children:`A vs B`}),s(`div`,{className:`cl-bracket-match`,children:`C vs D`})]}),s(`span`,{className:`cl-bracket-arrow`,children:`→`}),o(`div`,{className:`cl-bracket-round`,children:[s(`p`,{className:`cl-bracket-label`,children:`Middle`}),s(`div`,{className:`cl-bracket-match`,children:`Winners`}),s(`div`,{className:`cl-bracket-match`,children:`Losers`}),s(`div`,{className:`cl-bracket-match`,children:`1-win cross`})]}),s(`span`,{className:`cl-bracket-arrow`,children:`→`}),o(`div`,{className:`cl-bracket-round`,children:[s(`p`,{className:`cl-bracket-label`,children:`Final`}),s(`div`,{className:`cl-bracket-match`,children:`2-win tie`})]})]}),o(`div`,{className:`cl-ranking`,children:[s(`div`,{className:`cl-rank cl-rank-1st`,children:`Junior`}),s(`div`,{className:`cl-rank cl-rank-other`,children:`Mandate`}),s(`div`,{className:`cl-rank cl-rank-other`,children:`Mark Registry`}),s(`div`,{className:`cl-rank cl-rank-other`,children:`Receipt root`})]})]})]})}),s(`section`,{className:`cl-section cl-bg-warm`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Fairness & Bias Controls`}),s(`h5`,{className:`cl-title`,children:`Blind, balanced, audited`}),s(`div`,{className:`cl-controls-grid`,children:[{title:`Left/Right Randomization`,desc:`Each battle randomizes side assignment so no model benefits from position bias.`,icon:o(a,{children:[s(`polyline`,{points:`16 3 21 3 21 8`}),s(`line`,{x1:`4`,y1:`20`,x2:`21`,y2:`3`}),s(`polyline`,{points:`21 16 21 21 16 21`}),s(`line`,{x1:`15`,y1:`15`,x2:`21`,y2:`21`}),s(`line`,{x1:`4`,y1:`4`,x2:`9`,y2:`9`})]})},{title:`Blind Judging`,desc:`No model names, vendors, prompts, or metadata are shown to judges. Only the outputs.`,icon:o(a,{children:[s(`path`,{d:`M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24`}),s(`line`,{x1:`1`,y1:`1`,x2:`23`,y2:`23`})]})},{title:`Prompt Hygiene`,desc:`Prompts are anonymized, policy-compliant, and category-consistent before entering the system.`,icon:o(a,{children:[s(`path`,{d:`M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z`}),s(`polyline`,{points:`9 12 11 14 15 10`})]})},{title:`Balanced Exposure`,desc:`Scheduler ensures broad coverage across models and pairings over time.`,icon:o(a,{children:[s(`rect`,{x:`3`,y:`3`,width:`7`,height:`7`}),s(`rect`,{x:`14`,y:`3`,width:`7`,height:`7`}),s(`rect`,{x:`14`,y:`14`,width:`7`,height:`7`}),s(`rect`,{x:`3`,y:`14`,width:`7`,height:`7`})]})},{title:`Audit Sampling`,desc:`A subset of matches is reviewed by humans for quality control and consistency checks.`,icon:o(a,{children:[s(`circle`,{cx:`11`,cy:`11`,r:`8`}),s(`line`,{x1:`21`,y1:`21`,x2:`16.65`,y2:`16.65`})]})}].map(e=>o(`div`,{className:`cl-control-card`,children:[s(`div`,{className:`cl-control-icon`,children:s(`svg`,{width:`20`,height:`20`,viewBox:`0 0 24 24`,fill:`none`,stroke:`currentColor`,strokeWidth:`2`,strokeLinecap:`round`,strokeLinejoin:`round`,children:e.icon})}),o(`div`,{children:[s(`p`,{className:`cl-control-title`,children:e.title}),s(`p`,{className:`cl-control-desc`,children:e.desc})]})]},e.title))})]})}),s(`section`,{className:`cl-section cl-bg-warm`,children:o(`div`,{className:`cl-inner`,children:[s(`p`,{className:`cl-label`,children:`Ratings`}),s(`h5`,{className:`cl-title`,children:`Elo scoring`}),s(`p`,{className:`cl-body`,style:{marginBottom:48},children:`We maintain two Elo ratings per model: an overall Elo and a per-category Elo. All models start at 1500. After every battle, we apply a standard Elo update.`}),o(`div`,{className:`cl-elo-stats`,children:[o(`div`,{children:[s(`p`,{className:`cl-elo-value`,children:`1500`}),s(`p`,{className:`cl-elo-label`,children:`Starting Elo Rating`})]}),o(`div`,{children:[s(`p`,{className:`cl-elo-value`,children:`K = 32`}),s(`p`,{className:`cl-elo-label`,children:`Update Factor Per Battle`})]})]})]})}),s(`section`,{className:`cl-section cl-bg-warm`,children:s(`div`,{className:`cl-inner`,children:s(Se,{})})})]})}var z,B,V,Ce=e((()=>{l(),u(),z={"All categories":{skills:[[`Mark signer`,14.84],[`Web Developer`,10.55],[`Charter sponsor`,10.1],[`UI Designer`,9.04],[`Junior allocator`,8.46],[`Receipt keeper`,8.29]],tools:[[`Adobe Suite`,48.22],[`Figma`,27.03],[`Canva`,18.25],[`WordPress`,11.75],[`React`,9.3],[`JavaScript`,8.22]]},Design:{skills:[[`Mark signer`,22.89],[`Charter sponsor`,15.57],[`UI Designer`,13.94],[`Junior allocator`,13.05],[`UX Designer`,11.23],[`Logo Designer`,8.46]],tools:[[`Adobe Suite`,53.8],[`Figma`,37.35],[`Canva`,13.8],[`WordPress`,7.73],[`Framer`,7.42],[`Webflow`,4.95]]},Writing:{skills:[[`Copywriter`,28.53],[`Content Writer`,16.24],[`Writer`,12.27],[`Translator`,8.5],[`Editor`,6.76],[`Blog Writer`,6.43]],tools:[[`Google Docs`,22.03],[`Canva`,18.63],[`Microsoft Word`,18.47],[`Google Drive`,12.13],[`WordPress`,10.64],[`Microsoft Office 365`,9.87]]},Marketing:{skills:[[`Digital Marketer`,21.06],[`Marketing Strategist`,13.54],[`SEO Specialist`,13.12],[`Digital Marketing Specialist`,12.65],[`Brand Strategist`,10.15],[`Email Marketer`,9.17]],tools:[[`Canva`,16.81],[`Instagram`,11.98],[`WordPress`,9.97],[`Google Ads`,9.28],[`Facebook Ads`,7.66],[`SEMrush`,7.08]]},"Social Media":{skills:[[`Social Media Manager`,34.72],[`Content Creator`,23.95],[`Social Media Marketer`,14.72],[`Social Media Strategist`,7.61],[`AI Content Creator`,4.01],[`Community Manager`,3.43]],tools:[[`Adobe Suite`,30.55],[`Canva`,26.41],[`Instagram`,26.17],[`CapCut`,11.85],[`TikTok`,7.44],[`Facebook`,5.91]]},Engineering:{skills:[[`Web Developer`,32.48],[`Frontend Engineer`,14.41],[`Fullstack Engineer`,12.97],[`Software Engineer`,12.08],[`Backend Engineer`,8.3],[`WordPress Developer`,4.97]],tools:[[`React`,26.39],[`Figma`,25.72],[`WordPress`,15.88],[`JavaScript`,15.37],[`Next.js`,13.04],[`Node.js`,12.13]]},"Video & Animation":{skills:[[`Receipt keeper`,42.72],[`Photo Editor`,12.51],[`Motion Designer`,9.23],[`Oracle operator`,7.33],[`3D Modeler`,6.46],[`Hedge operator`,4.71]],tools:[[`Adobe Suite`,72.1],[`CapCut`,12.73],[`Blender`,12.68],[`Canva`,9.98],[`DaVinci Resolve`,8.66],[`Cinema 4D`,3.19]]},"Music & Audio":{skills:[[`Voice Over Artist`,18.46],[`Music Producer`,12.48],[`AI Writer`,12.47],[`Audio Editor`,11.35],[`Musician`,10.48],[`Sound Designer`,8]],tools:[[`Adobe Suite`,43.82],[`CapCut`,10],[`Logic Pro`,9.43],[`Ableton Live`,9.36],[`FL Studio`,8.79],[`DaVinci Resolve`,8.71]]}},B=[`#1a2a3a`,`#5B8DB8`,`#F0944D`,`#4DC8E0`,`#5BB8D8`,`#B8D84D`],V=`
  .cl { margin: 0; padding: 0; }
  .cl *, .cl *::before, .cl *::after { margin: 0; padding: 0; box-sizing: border-box; }

  .cl-section { width: 100%; }
  .cl-inner { max-width: 1200px; margin: 0 auto; padding: 100px 60px; }
  .cl-bg-warm, .cl-bg-dark, .cl-bg-sage { background: #F5F5F3; }

  .cl-label {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.75rem; font-weight: 500; letter-spacing: 0.12em;
    text-transform: uppercase; color: #888; margin-bottom: 16px;
  }

  .cl-title {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: clamp(2.2rem, 4.5vw, 3.8rem); font-weight: 400;
    letter-spacing: -0.04em; line-height: 1; color: #1748C7; margin-bottom: 32px;
  }

  .cl-body {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: clamp(1rem, 1.2vw, 1.25rem); font-weight: 400;
    color: #1748C7; line-height: 1.5; max-width: 720px;
  }

  /* Charts */
  .cl-chart-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 32px; }
  .cl-chart-tab {
    padding: 8px 20px; border-radius: 100px; border: 1.5px solid rgba(0,0,0,0.08);
    background: transparent; font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.85rem; font-weight: 400; color: #888; cursor: pointer;
    transition: all 0.25s; white-space: nowrap;
  }
  .cl-chart-tab:hover { border-color: rgba(0,0,0,0.15); color: #555; background: rgba(255,255,255,0.5); }
  .cl-chart-tab.active { border-color: #1748C7; color: #1748C7; font-weight: 500; background: #fff; }
  .cl-charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .cl-chart-card { background: #F5F5F3; border-radius: 12px; padding: 32px; }
  .cl-chart-card-title {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 1.05rem; font-weight: 500; color: #1748C7; margin-bottom: 28px;
  }

  /* Categories */
  .cl-cat-group { margin-bottom: 40px; }
  .cl-cat-group:last-child { margin-bottom: 0; }
  .cl-cat-group-label {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.8rem; font-weight: 500; color: #888;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 16px;
  }
  .cl-cat-pills { display: flex; gap: 12px; flex-wrap: wrap; }
  .cl-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 24px; border-radius: 100px;
    border: 1px solid rgba(0,0,0,0.1); background: transparent;
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9rem; color: #1748C7; transition: all 0.25s;
  }
  .cl-pill:hover { border-color: rgba(0,0,0,0.2); background: rgba(0,0,0,0.03); }
  .cl-pill-icon { font-size: 0.7rem; opacity: 0.5; }

  /* Phases */
  .cl-phases-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 24px; }
  .cl-phase-card {
    background: #EFEDE8; border-radius: 12px; padding: 32px;
    border: 1px solid rgba(0,0,0,0.12); display: flex; flex-direction: column; gap: 14px;
  }
  .cl-phase-num {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.75rem; font-weight: 500; color: rgba(0,0,0,0.4);
    letter-spacing: 0.12em; text-transform: uppercase;
  }
  .cl-phase-name {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 1.4rem; font-weight: 400; color: #1748C7; line-height: 1;
  }
  .cl-phase-desc {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.95rem; color: #666; line-height: 1.55; flex: 1;
  }
  .cl-phase-goal {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.85rem; font-weight: 500; color: #1748C7;
    padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.08);
  }

  /* Process */
  .cl-steps { margin-top: 48px; }
  .cl-step { display: grid; grid-template-columns: 60px 1fr; gap: 32px; padding: 28px 0; }
  .cl-step-num {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 1.4rem; color: #888; line-height: 1.3;
  }
  .cl-step-title {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 1.05rem; font-weight: 500; color: #1748C7; margin-bottom: 8px;
  }
  .cl-step-desc {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.95rem; color: #888; line-height: 1.55;
  }

  /* Tournament */
  .cl-tourney-visual { background: #F5F5F3; border: 1px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 40px; }
  .cl-tourney-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 40px; padding-bottom: 24px; border-bottom: 1px solid rgba(0,0,0,0.12);
  }
  .cl-tourney-header-title {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 1.2rem; color: #1748C7;
  }
  .cl-tourney-badge {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.8rem; font-weight: 500; color: #888;
    background: rgba(0,0,0,0.04); padding: 8px 16px; border-radius: 100px; border: 1px solid rgba(0,0,0,0.08);
  }
  .cl-bracket { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 40px; overflow-x: auto; }
  .cl-bracket-round { flex: 0 0 auto; min-width: 140px; }
  .cl-bracket-label {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.7rem; font-weight: 500; color: #888;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 12px;
  }
  .cl-bracket-match {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9rem; color: #1748C7; background: rgba(0,0,0,0.03);
    padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12);
    margin-bottom: 8px; text-align: center;
  }
  .cl-bracket-arrow { color: #ccc; font-size: 1.4rem; align-self: center; }
  .cl-ranking { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; }
  .cl-rank {
    padding: 20px; border-radius: 10px; text-align: center;
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-weight: 500; font-size: 0.95rem;
  }
  .cl-rank-1st { background: rgba(124,185,194,0.15); border: 1px solid rgba(124,185,194,0.35); color: #7CB9C2; }
  .cl-rank-other { background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.12); color: #888; }

  /* Fairness */
  .cl-controls-grid { display: grid; grid-template-columns: repeat(2,1fr); gap: 20px; margin-top: 48px; }
  .cl-control-card {
    background: #F5F5F3; border-radius: 12px; padding: 28px;
    border: 1px solid rgba(0,0,0,0.12); display: flex; gap: 20px;
  }
  .cl-control-icon {
    display: flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; background: #1748C7; border-radius: 10px; flex-shrink: 0; color: #fff;
  }
  .cl-control-title {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 1rem; font-weight: 500; color: #1748C7; margin-bottom: 6px;
  }
  .cl-control-desc {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9rem; color: #888; line-height: 1.55;
  }

  /* Ratings */
  .cl-elo-stats { display: flex; gap: 64px; }
  .cl-elo-value {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: clamp(2.2rem, 4vw, 3.5rem); font-weight: 400;
    letter-spacing: -0.04em; line-height: 1; color: #1748C7; margin-bottom: 10px;
  }
  .cl-elo-label {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.95rem; color: #888;
  }

  /* FAQ */
  .cl-faq-container { display: grid; grid-template-columns: 1fr 1.4fr; gap: 80px; align-items: start; }
  .cl-faq-heading {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: clamp(2rem, 4vw, 3.2rem); font-weight: 400;
    letter-spacing: -0.04em; line-height: 1; color: #1748C7;
  }
  .cl-faq-item { border-bottom: 1px solid rgba(0,0,0,0.08); }
  .cl-faq-item:last-child { border-bottom: none; }
  .cl-faq-question {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px; cursor: pointer; padding: 24px 0; transition: opacity 0.2s;
  }
  .cl-faq-question:hover { opacity: 0.65; }
  .cl-faq-q-text {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: clamp(0.95rem, 1.1vw, 1.1rem); color: #1748C7; line-height: 1.45;
  }
  .cl-faq-answer {
    overflow: hidden; transition: max-height 0.35s ease, opacity 0.3s ease, padding-bottom 0.3s ease;
  }
  .cl-faq-answer p {
    font-family: 'GT Standard', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.95rem; color: #888; line-height: 1.65;
  }

  /* Responsive */
  @media (max-width: 1024px) { .cl-inner { padding: 80px 40px; } }
  @media (max-width: 768px) {
    .cl-inner { padding: 64px 24px; }
    .cl-title { font-size: clamp(1.8rem, 6vw, 2.4rem); margin-bottom: 24px; }
    .cl-charts-row { grid-template-columns: 1fr; }
    .cl-chart-tab { padding: 6px 14px; font-size: 0.8rem; }
    .cl-pill { padding: 8px 18px; font-size: 0.85rem; }
    .cl-phases-grid { grid-template-columns: 1fr; }
    .cl-step { grid-template-columns: 1fr; gap: 8px; }
    .cl-tourney-visual { padding: 24px; }
    .cl-tourney-header { flex-direction: column; align-items: flex-start; gap: 12px; }
    .cl-bracket-arrow { display: none; }
    .cl-bracket-round { min-width: 110px; }
    .cl-ranking { grid-template-columns: repeat(2,1fr); }
    .cl-controls-grid { grid-template-columns: 1fr; }
    .cl-elo-stats { flex-direction: column; gap: 32px; }
    .cl-faq-container { grid-template-columns: 1fr; gap: 32px; }
  }
`})),H,U,W,G,K,q,J,Y,X,we,Te,Ee,Z,Q,De,Oe,$,ke;e((()=>{l(),x(),f(),u(),A(),ye(),ve(),Ce(),D(),M(),me(),xe(),H=b(j),U=g(d.div),W=b(F),G=b(R),K=b(I),q={CnvkMR6vk:`(max-width: 809.98px)`,GJdy2z4KZ:`(min-width: 810px) and (max-width: 1199.98px)`,plbjq2e1j:`(min-width: 1200px) and (max-width: 1599.98px)`,vzS2R4MAS:`(min-width: 1600px)`},J=[],Y=`framer-vFUN0`,X={CnvkMR6vk:`framer-v-12ukusr`,GJdy2z4KZ:`framer-v-rybolp`,plbjq2e1j:`framer-v-1671oiy`,vzS2R4MAS:`framer-v-rx8qiu`},we=(e,t,n)=>e&&t?`position`:n,Te={opacity:1,rotate:0,rotateX:0,rotateY:0,scale:1,skewX:0,skewY:0,transition:{bounce:.2,delay:0,duration:.4,type:`spring`},x:0,y:0},Ee={opacity:.001,rotate:0,rotateX:0,rotateY:0,scale:1,skewX:0,skewY:0,x:0,y:0},Z=(...e)=>{for(let t of e)if(t&&typeof t==`string`)return t},Q={"Desktop XL":`vzS2R4MAS`,Desktop:`plbjq2e1j`,Mobile:`CnvkMR6vk`,Tablet:`GJdy2z4KZ`},De=({value:e})=>ce()?null:s(`style`,{dangerouslySetInnerHTML:{__html:e},"data-framer-html-style":``}),Oe=({height:e,id:t,width:n,...r})=>({...r,variant:Q[r.variant]??r.variant??`vzS2R4MAS`}),$=p(c(function(e,i){let a=ee(null),c=i??a,l=n(),{activeLocale:u,setLocale:ne}=oe(),f=le(),{style:p,className:m,layoutId:h,variant:g,...b}=Oe(e);de(te(()=>be({},u),[u]));let[x,ce]=ue(g,q,!1),T=_(Y,pe,_e,fe),D=t(E)?.isLayoutTemplate,O=!!t(ie)?.transition?.layout,k=we(D,O),A=v(`ivNzHRVci`),M=ee(null),N=v(`WzKxPzcim`),P=ae();return se({}),s(E.Provider,{value:{activeVariantId:x,humanReadableVariantMap:Q,primaryVariantId:`vzS2R4MAS`,variantClassNames:X},children:o(re,{id:h??l,children:[s(De,{value:`html body { background: var(--token-fa39109f-fc6b-47ce-8b5c-ecbce18206f9, rgb(251, 250, 246)); }`}),o(d.div,{...b,className:_(T,`framer-rx8qiu`,m),ref:c,style:{...p},children:[s(w,{children:s(S,{className:`framer-81pqax-container`,"data-framer-name":`Smooth Scroll`,isAuthoredByUser:!0,isModuleExternal:!0,layout:k,name:`Smooth Scroll`,nodeId:`f5KYKuZBU`,scopeId:`ITj9oTn6v`,children:s(j,{height:`100%`,id:`f5KYKuZBU`,infinite:!1,intensity:12,layoutId:`f5KYKuZBU`,name:`Smooth Scroll`,orientation:`vertical`,smooth:!0,width:`100%`})})}),s(d.div,{className:`framer-13668ca`,"data-framer-name":`Main`,layout:k,children:s(`div`,{className:`framer-1m6rivr`,"data-framer-name":`HERO`,id:A,ref:M,children:s(`div`,{className:`framer-ql8i6h`,"data-framer-name":`Content`,children:o(U,{animate:Te,className:`framer-af3qxh`,"data-framer-appear-id":`af3qxh`,"data-framer-name":`Text`,initial:Ee,optimized:!0,children:[s(y,{__fromCanvasComponent:!0,children:s(r,{children:s(`p`,{className:`framer-styles-preset-bgnwpq`,"data-styles-preset":`lowhArszT`,dir:`auto`,style:{"--framer-text-alignment":`center`,"--framer-text-color":`var(--token-655dcc0a-ca89-49a3-990c-16f929c98adc, rgba(23, 72, 199, 0.7))`},children:`CREATIVE ARENA`})}),className:`framer-1vj9f6e`,"data-framer-name":`Sub-header`,fonts:[`Inter`],verticalAlignment:`top`,withExternalLayout:!0}),s(y,{__fromCanvasComponent:!0,children:s(r,{children:s(`h5`,{className:`framer-styles-preset-1djcvgz`,"data-styles-preset":`mvgU8yBlz`,dir:`auto`,style:{"--framer-text-alignment":`center`},children:`Methodology`})}),className:`framer-1szhvn7`,"data-framer-name":`Header`,fonts:[`Inter`],verticalAlignment:`top`,withExternalLayout:!0}),s(y,{__fromCanvasComponent:!0,children:s(r,{children:s(`p`,{className:`framer-styles-preset-12onkkx`,"data-styles-preset":`lBKy44ghE`,dir:`auto`,style:{"--framer-text-alignment":`center`,"--framer-text-color":`var(--token-655dcc0a-ca89-49a3-990c-16f929c98adc, rgba(23, 72, 199, 0.7))`},children:`In the Creative Arena, AI models are evaluated on real professional use cases, driven by actual client deliverables from BookRunner's marketplace and voted on by our global network of 1.5M+ creative professionals.`})}),className:`framer-1h03n1z`,"data-framer-name":`Sub-header`,fonts:[`Inter`],verticalAlignment:`top`,withExternalLayout:!0})]})})})}),s(C,{breakpoint:x,overrides:{CnvkMR6vk:{height:1012,y:(f?.y||0)+0+467},GJdy2z4KZ:{y:(f?.y||0)+0+467},plbjq2e1j:{y:(f?.y||0)+0+627}},children:s(w,{height:900,width:f?.width||`100vw`,y:(f?.y||0)+0+667,children:s(S,{className:`framer-1jshclo-container`,"data-framer-name":`Stats`,id:N,layout:k,name:`Stats`,nodeId:`WzKxPzcim`,ref:P(N),scopeId:`ITj9oTn6v`,children:s(C,{breakpoint:x,overrides:{CnvkMR6vk:{style:{width:`100%`},variant:Z(`Rr3nPnmFz`)},GJdy2z4KZ:{variant:Z(`LdRC23dnq`)}},children:s(F,{axABJsFmI:!0,height:`100%`,id:`WzKxPzcim`,IrhNHvLG1:`Connecting capital with the market’s fee flow`,layoutId:`WzKxPzcim`,LSJ3r2t5e:`A book capitalises the market’s insurance fund and market-making inventory. Agent bookrunners operate under its mandate. Capital allocators choose their tranche and see the book’s NAV, P&amp;L and limits.`,name:`Stats`,style:{height:`100%`,width:`100%`},variant:Z(`ZnnBm0hY3`),width:`100%`})})})})}),s(w,{children:s(S,{className:`framer-kfjlpu-container`,isAuthoredByUser:!0,layout:k,nodeId:`LrUjRGnqD`,scopeId:`ITj9oTn6v`,children:s(R,{height:`100%`,id:`LrUjRGnqD`,layoutId:`LrUjRGnqD`,style:{width:`100%`},width:`100%`})})}),s(C,{breakpoint:x,overrides:{CnvkMR6vk:{y:(f?.y||0)+0+1679},GJdy2z4KZ:{y:(f?.y||0)+0+1567},plbjq2e1j:{y:(f?.y||0)+0+1727}},children:s(w,{height:855,width:f?.width||`100vw`,y:(f?.y||0)+0+1767,children:s(S,{className:`framer-1gxuf2g-container`,"data-framer-name":`Footer`,layout:k,name:`Footer`,nodeId:`NFj4RwM3t`,scopeId:`ITj9oTn6v`,children:s(C,{breakpoint:x,overrides:{CnvkMR6vk:{variant:Z(`UmV45IWKy`)},GJdy2z4KZ:{variant:Z(`wOotCmK8X`)},plbjq2e1j:{variant:Z(`qUz1pAYJF`)}},children:s(I,{cC2DAMmIn:`Open dashboard`,COntfgBNg:`Explore the Creative Arena leaderboard or request access to run your own evaluations.`,dWdndGE0w:`Ready to see how models stack up?`,gYf_CFHGj:`/dashboard/`,height:`100%`,hwMqHZfDo:!0,id:`NFj4RwM3t`,JTYMZWik3:!0,layoutId:`NFj4RwM3t`,name:`Footer`,style:{width:`100%`},variant:Z(`r_iaiesse`),width:`100%`})})})})})]}),s(`div`,{id:`overlay`})]})})}),[`.framer-vFUN0.framer-1t83oo7, .framer-vFUN0 .framer-1t83oo7 { display: block; }`,`.framer-vFUN0.framer-rx8qiu { align-content: center; align-items: center; background-color: var(--token-fa39109f-fc6b-47ce-8b5c-ecbce18206f9, #F5F5F3); display: flex; flex-direction: column; flex-wrap: nowrap; gap: 0px; height: min-content; justify-content: flex-start; overflow: var(--overflow-clip-fallback, clip); padding: 0px; position: relative; width: 1600px; }`,`.framer-vFUN0 .framer-81pqax-container { flex: none; height: auto; left: 50%; position: absolute; top: 0px; transform: translateX(-50%); width: auto; z-index: 1; }`,`.framer-vFUN0 .framer-13668ca { align-content: center; align-items: center; display: flex; flex: none; flex-direction: column; flex-wrap: nowrap; gap: 0px; height: min-content; justify-content: center; overflow: var(--overflow-clip-fallback, clip); padding: 0px; position: relative; width: 100%; }`,`.framer-vFUN0 .framer-1m6rivr { align-content: center; align-items: center; display: flex; flex: none; flex-direction: column; flex-wrap: nowrap; gap: 0px; height: min-content; justify-content: center; overflow: hidden; padding: 180px 0px 140px 0px; position: relative; width: 100%; }`,`.framer-vFUN0 .framer-ql8i6h { align-content: center; align-items: center; display: flex; flex: none; flex-direction: column; flex-wrap: nowrap; gap: 32px; height: min-content; justify-content: center; overflow: visible; padding: 0px; position: relative; width: 100%; z-index: 2; }`,`.framer-vFUN0 .framer-af3qxh { align-content: center; align-items: center; display: flex; flex: none; flex-direction: column; flex-wrap: nowrap; gap: 20px; height: min-content; justify-content: center; overflow: visible; padding: 0px; position: relative; width: 100%; will-change: var(--framer-will-change-effect-override, transform); }`,`.framer-vFUN0 .framer-1vj9f6e, .framer-vFUN0 .framer-1h03n1z { --framer-paragraph-spacing: 0px; flex: none; height: auto; max-width: 630px; position: relative; white-space: pre-wrap; width: 100%; word-break: break-word; word-wrap: break-word; }`,`.framer-vFUN0 .framer-1szhvn7 { --framer-paragraph-spacing: 0px; flex: none; height: auto; max-width: 770px; position: relative; white-space: pre-wrap; width: 100%; word-break: break-word; word-wrap: break-word; }`,`.framer-vFUN0 .framer-1jshclo-container { aspect-ratio: 1.7777777777777777 / 1; flex: none; height: auto; position: relative; width: 100%; }`,`.framer-vFUN0 .framer-kfjlpu-container, .framer-vFUN0 .framer-1gxuf2g-container { flex: none; height: auto; position: relative; width: 100%; }`,...N,...he,...O,`@media (min-width: 1200px) and (max-width: 1599.98px) { .framer-vFUN0.framer-rx8qiu { width: 1200px; } .framer-vFUN0 .framer-1m6rivr { padding: 140px 0px 140px 0px; } .framer-vFUN0 .framer-1vj9f6e, .framer-vFUN0 .framer-1h03n1z { max-width: 450px; } .framer-vFUN0 .framer-1szhvn7 { max-width: 580px; }}`,`@media (min-width: 810px) and (max-width: 1199.98px) { .framer-vFUN0.framer-rx8qiu { width: 810px; } .framer-vFUN0 .framer-1m6rivr { padding: 120px 60px 0px 60px; } .framer-vFUN0 .framer-ql8i6h { gap: 24px; } .framer-vFUN0 .framer-1vj9f6e, .framer-vFUN0 .framer-1h03n1z { max-width: 330px; } .framer-vFUN0 .framer-1szhvn7 { max-width: 400px; }}`,`@media (max-width: 809.98px) { .framer-vFUN0.framer-rx8qiu { width: 390px; } .framer-vFUN0 .framer-1m6rivr { padding: 100px 0px 20px 0px; } .framer-vFUN0 .framer-ql8i6h { gap: 24px; } .framer-vFUN0 .framer-1vj9f6e, .framer-vFUN0 .framer-1h03n1z { max-width: 300px; } .framer-vFUN0 .framer-1szhvn7 { max-width: 320px; } .framer-vFUN0 .framer-1jshclo-container { aspect-ratio: unset; }}`],`framer-vFUN0`),$.displayName=`Bookrunners`,$.defaultProps={height:9370,width:1600},T($,[{explicitInter:!0,fonts:[{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F`,url:`/assets/media/5vvr9Vy74if2I6bQbJvbw7SY1pQ.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116`,url:`/assets/media/EOr0mi4hNtlgWNn9if640EZzXCo.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+1F00-1FFF`,url:`/assets/media/Y9k9QrlZAqio88Klkmbd8VoMQc.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0370-03FF`,url:`/assets/media/OYrD2tBIBPvoJXiIHnLoOXnY9M.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF`,url:`/assets/media/JeYwfuaPfZHQhEG8U5gtPDZ7WQ.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2070, U+2074-207E, U+2080-208E, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`,url:`/assets/media/GrgcKwrN6d3Uz8EwcLHZxwEfC4.woff2`,weight:`400`},{cssFamilyName:`Inter`,source:`framer`,style:`normal`,uiFamilyName:`Inter`,unicodeRange:`U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+1EA0-1EF9, U+20AB`,url:`/assets/media/b6Y37FthZeALduNqHicBT6FutY.woff2`,weight:`400`}]},...H,...W,...G,...K,...h(P),...h(ge),...h(k)],{supportsExplicitInterCodegen:!0}),$.loader={load:(e,t)=>(t.locale,Promise.allSettled([m(F,{},t),m(I,{},t)]))},ke={exports:{Props:{type:`tsType`,annotations:{framerContractVersion:`1`}},queryParamNames:{type:`variable`,annotations:{framerContractVersion:`1`}},default:{type:`reactComponent`,name:`FramerITj9oTn6v`,slots:[],annotations:{framerResponsiveScreen:`true`,framerIntrinsicWidth:`1600`,framerScrollSections:`{"ivNzHRVci":{"pattern":":ivNzHRVci","name":"hero"},"WzKxPzcim":{"pattern":":WzKxPzcim","name":"stats"}}`,framerComponentViewportWidth:`true`,framerDisplayContentsDiv:`false`,framerAcceptsLayoutTemplate:`true`,framerAutoSizeImages:`true`,framerColorSyntax:`true`,framerContractVersion:`1`,framerCanvasComponentVariantDetails:`{"propertyName":"variant","data":{"default":{"layout":["fixed","auto"]},"plbjq2e1j":{"layout":["fixed","auto"]},"GJdy2z4KZ":{"layout":["fixed","auto"]},"CnvkMR6vk":{"layout":["fixed","auto"]}}}`,framerImmutableVariables:`true`,framerIntrinsicHeight:`9370`,framerLayoutTemplateFlowEffect:`true`}},__FramerMetadata__:{type:`variable`}}}}))();export{ke as __FramerMetadata__,$ as default,J as queryParamNames};
//# sourceMappingURL=Q6pf_h5HPWKJcK7KJjnDWtjbcvzo-J0UqF_uV8rvT00.DNy8sZNd.mjs.map