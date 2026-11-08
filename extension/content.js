(() => {
  'use strict';
  if (globalThis.__bookReaderInstalled) return;
  globalThis.__bookReaderInstalled = true;
  const DEFAULTS = { size:18, leading:1.85, paragraph:16, margin:30, width:1920, height:1100, font:'serif', theme:'paper', columns:2 };
  const FONTS = {
    serif: 'Georgia,"Noto Serif SC","Songti SC",SimSun,serif',
    sans: '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Consolas,monospace'
  };
  const ranges = { size:[14,28], leading:[1.3,2.4], paragraph:[0,32], margin:[16,64], width:[720,2560], height:[400,1400] };
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 5.5C8 2.8 4 3.6 2.5 4.5v15C5 18 8.5 18 12 20c3.5-2 7-2 9.5-.5v-15C20 3.6 16 2.8 12 5.5Zm0 0V20"/></svg>';
  let saved = { ...DEFAULTS };
  const controllers = new Map();
  let current = null;
  let pointedReader = null;
  let followup = null;
  const NAVIGATION_KEY = '__answer_book_navigation_v2';
  let navigation = null;
  try {
    const value = JSON.parse(sessionStorage.getItem(NAVIGATION_KEY));
    if (value && value.path === location.pathname && Date.now()-value.at < 20000) navigation = {...value,known:new Set()};
    else sessionStorage.removeItem(NAVIGATION_KEY);
  } catch { /* A blocked page storage does not affect reading. */ }
  function cleanSettings(value) {
    const result = { ...DEFAULTS };
    for (const [k,[min,max]] of Object.entries(ranges)) if (Number.isFinite(value?.[k])) result[k] = Math.min(max,Math.max(min,value[k]));
    if (value?.layoutVersion !== 2) {
      if (value?.width === 1080) result.width = DEFAULTS.width;
      if (value?.height === 510) result.height = DEFAULTS.height;
    }
    if (value?.font in FONTS) result.font = value.font;
    if (['paper','white','dark'].includes(value?.theme)) result.theme = value.theme;
    if ([1,2].includes(value?.columns)) result.columns = value.columns;
    return result;
  }
  const loaded = (async () => {
    try { if (globalThis.chrome?.storage?.local) saved = cleanSettings((await chrome.storage.local.get('bookReaderSettings')).bookReaderSettings); } catch { /* Defaults remain available if extension was reloaded. */ }
  })();
  function persist(settings) {
    saved = { ...settings,layoutVersion:2 };
    try { globalThis.chrome?.storage?.local?.set({bookReaderSettings:saved})?.catch(() => {}); } catch { /* Reinstall/reload must not break reading. */ }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node;
  }
  function visiblePoint(source) {
    const walker = document.createTreeWalker(source,NodeFilter.SHOW_TEXT);
    const top = 80;
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim() || node.parentElement.closest('button,[role="button"],script,style,.katex-html')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.bottom <= top || rect.top >= innerHeight - 100 || rect.right <= 0 || rect.left >= innerWidth) continue;
        const x = Math.max(1,rect.left + 1);
        const y = Math.min(rect.bottom-1,Math.max(top+1,rect.top+rect.height/2));
        const caret = document.caretRangeFromPoint(x,y);
        if (caret && caret.startContainer === node) return {node,offset:caret.startOffset};
        return {node,offset:0};
      }
    }
    return null;
  }
  function scrollToPoint(source, point, offset) {
    if (!point?.node.isConnected || !source.isConnected) return;
    const range = document.createRange();
    const start = Math.min(point.node.length,Math.max(0,offset - point.start));
    range.setStart(point.node,start); range.setEnd(point.node,Math.min(point.node.length,start+1));
    const delta = range.getBoundingClientRect().top - 80;
    let scroll = source.parentElement;
    while (scroll && scroll !== document.scrollingElement) {
      if (/(auto|scroll)/.test(getComputedStyle(scroll).overflowY) && scroll.scrollHeight > scroll.clientHeight) break;
      scroll = scroll.parentElement;
    }
    (scroll && scroll !== document.scrollingElement ? scroll : window).scrollBy({top:delta,behavior:'instant'});
  }
  class Reader {
    constructor(message, source) {
      this.message = message; this.source = source; this.settings = { ...saved }; this.index = 0; this.pages = [];
      this.path = location.pathname;
      this.host = el('div'); this.host.dataset.bookReader = 'host';
      this.host.dataset.bookSource = source.id || message.id || '';
      this.root = this.host.attachShadow({mode:'open'});
      const style = el('style'); style.textContent = BookReaderStyles; this.root.append(style);
      this.host.style.display = 'none';
      source.before(this.host);
    }
    async open(options = {}) {
      await loaded;
      if (this.reader) return;
      const previous = current;
      const point = options.fromStart ? null : visiblePoint(this.source);
      if (previous?.reader && previous !== this) previous.close({restorePosition:false,keepPending:true});
      this.settings = { ...saved }; current = this;
      this.immersive = !!options.immersive;
      this.showCatalog = true;
      this.expandedBooks = new Set(options.catalogState?.books || [location.pathname]);
      this.expandedBooks.add(location.pathname);
      this.expandedRounds = new Set(options.catalogState?.rounds || []);
      this.catalogScroll = options.catalogState?.scrollTop || 0;
      this.catalogSignature = null;
      this.catalogInitialized = false;
      this.autoCapture = !!options.autoCapture;
      this.pendingPoint = point;
      this.pendingOffset = options.offset || 0;
      this.selectedChapter = options.offset;
      this.hasTurned = false;
      this.originalStyle = this.source.getAttribute('style');
      this.source.style.setProperty('display','none','important');
      this.placeholder = el('div'); this.placeholder.dataset.bookReader = 'placeholder'; this.placeholder.setAttribute('aria-hidden','true'); this.source.before(this.placeholder);
      document.body.append(this.host);
      this.reader = el('section','reader'); this.reader.setAttribute('aria-label','回答分页阅读器');
      this.reader.innerHTML = `<aside class="catalog" hidden><div class="catalog-list" aria-label="会话、轮次与回答标题"></div><div class="catalog-actions"><button type="button" data-action="history">加载历史会话</button><button type="button" data-action="earlier">加载更早对话</button><p class="catalog-status" role="status" hidden></p></div></aside><div class="reading"><header class="top"><div class="layout" role="group" aria-label="页面布局"><button type="button" data-action="one" aria-label="单页显示">单页</button><button type="button" data-action="two" aria-label="双页显示">双页</button></div><div class="tools"><button type="button" data-action="catalog" aria-expanded="true" hidden>目录</button><button type="button" class="notice" data-action="refresh" title="原回答有更新" hidden>更新</button><button type="button" data-action="settings" aria-expanded="false">排版</button><button type="button" data-action="immersive" aria-pressed="false">沉浸</button><button type="button" class="plain" data-action="close">退出</button></div></header><div class="settings" hidden></div><div class="book" tabindex="0" role="region" aria-label="书页，使用左右方向键翻页"><div class="spread"></div></div><footer class="bottom"><div class="navigation"><button type="button" data-action="prev" aria-label="上一页" title="上一页（←）">←</button><span class="position" role="status" aria-live="polite"></span><button type="button" data-action="next" aria-label="下一页" title="下一页（→）">→</button></div><form class="ask"><textarea rows="1" aria-label="书内追问" placeholder="追问…"></textarea><button type="submit" aria-label="发送追问" disabled>↑</button></form><p class="ask-status" role="status" hidden></p></footer></div>`;
      this.root.append(this.reader);
      this.book = this.reader.querySelector('.book'); this.spread = this.reader.querySelector('.spread');
      this.measure = el('div','paper-content measure'); this.measure.setAttribute('aria-hidden','true'); this.reader.append(this.measure);
      this.makeSettings();
      this.ask = this.reader.querySelector('.ask textarea'); this.ask.value = this.draft || '';
      this.ask.addEventListener('input',() => { this.draft = this.ask.value; this.reader.querySelector('.ask button').disabled = !this.ask.value.trim() || this.sending; });
      this.ask.addEventListener('keydown',event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submitQuestion(); }
      });
      this.reader.querySelector('.ask').addEventListener('submit',event => { event.preventDefault(); this.submitQuestion(); });
      this.reader.querySelector('.ask button').disabled = !this.ask.value.trim();
      this.reader.addEventListener('click', e => {
        current = this;
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') { this.close(); return; }
        if (action === 'prev') this.turn(-1);
        if (action === 'next') this.turn(1);
        if (action === 'one' || action === 'two') { this.settings.columns = action === 'one' ? 1 : 2; persist(this.settings); this.schedule(); }
        if (action === 'settings') {
          const panel = this.reader.querySelector('.settings'); panel.hidden = !panel.hidden;
          e.target.setAttribute('aria-expanded', String(!panel.hidden));
        }
        if (action === 'reset') {
          this.settings = { ...DEFAULTS }; persist(this.settings); this.makeSettings(); this.schedule();
        }
        if (action === 'refresh') this.capture();
        if (action === 'immersive') this.setImmersive(!this.immersive);
        if (action === 'catalog') { this.showCatalog = !this.showCatalog; this.reflow(); }
        if (action === 'history' || action === 'earlier') this.loadCatalog(action);
        if (e.target.closest('.book')) {
          this.reader.querySelector('.settings').hidden = true;
          this.reader.querySelector('[data-action=settings]').setAttribute('aria-expanded','false');
        }
        if (e.target.tagName === 'IMG') this.zoom(e.target);
      });
      this.reader.addEventListener('focusin', () => { current = this; });
      this.reader.addEventListener('pointerdown', () => { current = this; });
      this.onKey = e => {
        if (current !== this || !this.reader || this.dialog?.open || e.altKey || e.ctrlKey || e.metaKey) return;
        const target = e.composedPath()[0];
        if (e.key === 'Escape' && !this.reader.querySelector('.settings').hidden) {
          this.reader.querySelector('.settings').hidden = true;
          this.reader.querySelector('[data-action=settings]').setAttribute('aria-expanded','false');
          this.book.focus({preventScroll:true}); return;
        }
        if (e.key === 'Escape' && this.immersive) { e.preventDefault(); this.setImmersive(false); return; }
        if (e.key === 'Tab' && this.immersive) {
          const focusable = [...this.reader.querySelectorAll('button:not(:disabled),textarea,select,input')].filter(n => n.getClientRects().length && !n.closest('[hidden]'));
          const first = focusable[0], last = focusable.at(-1);
          if (target === last && !e.shiftKey) { e.preventDefault(); first.focus(); }
          if (target === first && e.shiftKey) { e.preventDefault(); last.focus(); }
        }
        if (target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
        const rect = this.reader.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        if (!e.shiftKey && ['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); this.turn(['ArrowLeft','PageUp'].includes(e.key) ? -1 : 1);
        }
      };
      document.addEventListener('keydown',this.onKey,true);
      this.sourceObserver = new MutationObserver(() => {
        if (!this.reader) return;
        if (this.autoCapture) {
          if (!this.captureTimer) this.captureTimer = setTimeout(() => { this.captureTimer = null; if (this.reader) this.capture(); },320);
        } else this.reader.querySelector('.notice').hidden = false;
      });
      this.sourceObserver.observe(this.source,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['src']});
      this.onResize = () => this.schedule(); window.addEventListener('resize',this.onResize);
      this.resizeObserver = new ResizeObserver(() => {
        const rect = this.source.parentElement?.getBoundingClientRect();
        const key = rect && `${Math.round(rect.width)}:${Math.round(rect.left)}`;
        if (key !== this.parentSize) { this.parentSize = key; this.schedule(); }
      });
      if (this.source.parentElement?.isConnected) this.resizeObserver.observe(this.source.parentElement);
      this.capture();
      this.book.focus({preventScroll:true});
      updateEntry();
    }
    makeSettings() {
      const panel = this.reader.querySelector('.settings'); panel.replaceChildren();
      const fields = [
        ['font','字体',[['serif','衬线'],['sans','无衬线'],['mono','等宽']]],
        ['theme','纸张',[['paper','暖纸'],['white','纯白'],['dark','夜间']]],
        ['size','字号',14,28,1,'px'],['leading','行距',1.3,2.4,.05,''],
        ['paragraph','段距',0,32,2,'px'],['margin','边距',16,64,2,'px'],
        ['width','宽度',720,2560,40,'px'],['height','高度',400,1400,20,'px']
      ];
      for (const [key,label,options,max,step,unit] of fields) {
        const wrapper = el('label','setting'); const caption = el('span',null,label); wrapper.append(caption);
        let input;
        if (Array.isArray(options)) {
          input = el('select');
          for (const [value,text] of options) { const o = el('option',null,text); o.value = value; input.append(o); }
        } else {
          const output = el('output',null,`${this.settings[key]}${unit}`); caption.append(output);
          input = el('input'); input.type = 'range'; input.min = options; input.max = max; input.step = step;
          input.addEventListener('input',() => { output.textContent = `${input.value}${unit}`; });
        }
        input.name = key; input.value = this.settings[key]; input.setAttribute('aria-label',label);
        input.addEventListener('input',() => {
          this.settings[key] = Array.isArray(options) ? input.value : Number(input.value); persist(this.settings); this.schedule();
        });
        wrapper.append(input); panel.append(wrapper);
      }
      const reset = el('button','reset','重置'); reset.type = 'button'; reset.dataset.action = 'reset'; panel.append(reset);
    }
    capture() {
      this.blocks = BookPaginator.extract(this.source);
      this.chapters = BookCatalog.chapters(this.blocks);
      if (this.pendingPoint) {
        const point = this.blocks.sourcePoints.find(p => p.node === this.pendingPoint.node);
        this.pendingOffset = point ? point.start + this.pendingPoint.offset : 0;
        this.pendingPoint = null;
      }
      if (!this.readerOpened) { this.openingOffset = this.pendingOffset || 0; this.readerOpened = true; }
      this.reader.querySelector('.notice').hidden = true;
      this.reflow();
      const generation = (this.generation || 0) + 1; this.generation = generation;
      const images = this.blocks.flatMap(n => [...(n.tagName === 'IMG' ? [n] : []),...n.querySelectorAll('img')]);
      images.forEach(img => {
        if (!img.complete) {
          const update = () => { if (this.reader && this.generation === generation) this.schedule(); };
          img.addEventListener('load',update,{once:true}); img.addEventListener('error',update,{once:true});
        }
      });
      document.fonts?.ready.then(() => { if (this.reader && this.generation === generation) this.schedule(); });
    }
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.reader) this.reflow(); },100); }
    reflow() {
      if (!this.reader || !this.blocks) return;
      // Track the start of the current leaf by source-text offset when typography changes.
      const offset = this.pendingOffset ?? this.pages[this.index]?.bookOffset ?? 0;
      this.pendingOffset = undefined;
      const s = this.settings;
      const main = (this.source.isConnected && this.source.closest('main,[role="main"]')) || document.querySelector('main,[role="main"]');
      const bounds = main?.getBoundingClientRect() || {left:0,width:window.innerWidth};
      const left = Math.max(12,bounds.left + 16), right = Math.min(innerWidth-12,bounds.left+bounds.width-16);
      const widthAvailable = Math.max(240,right-left);
      const standardWidth = Math.min(s.width,widthAvailable);
      const standardHeight = Math.max(240,Math.min(s.height,innerHeight-88));
      this.placeholder.style.height = `${standardHeight}px`;
      this.syncScrollLock();
      this.host.style.cssText = this.immersive
        ? 'display:block;position:fixed;inset:0;width:100%;height:100%;z-index:2147482000;'
        : `display:block;position:fixed;left:${left+(widthAvailable-standardWidth)/2}px;top:64px;width:${standardWidth}px;height:${standardHeight}px;z-index:2147482000;`;
      this.reader.dataset.immersive = String(this.immersive);
      this.reader.setAttribute('role',this.immersive ? 'dialog' : 'region');
      if (this.immersive) this.reader.setAttribute('aria-modal','true'); else this.reader.removeAttribute('aria-modal');
      this.reader.dataset.catalog = String(this.immersive && this.showCatalog);
      this.reader.querySelector('.catalog').hidden = !this.immersive || !this.showCatalog;
      const immersiveButton = this.reader.querySelector('[data-action=immersive]');
      immersiveButton.textContent = this.immersive ? '退出沉浸' : '沉浸'; immersiveButton.setAttribute('aria-pressed',String(this.immersive));
      const catalogButton = this.reader.querySelector('[data-action=catalog]'); catalogButton.hidden = !this.immersive; catalogButton.setAttribute('aria-expanded',String(this.showCatalog));
      for (const key of ['width','height']) this.reader.querySelector(`[name=${key}]`).disabled = this.immersive;
      const width = this.reader.querySelector('.reading').getBoundingClientRect().width;
      this.columns = s.columns === 2 && width >= 800 ? 2 : 1;
      const height = Math.max(100,this.reader.clientHeight-this.reader.querySelector('.top').offsetHeight-this.reader.querySelector('.bottom').offsetHeight);
      this.reader.dataset.theme = s.theme;
      for (const [k,v] of Object.entries({columns:this.columns,height:`${height}px`,margin:`${s.margin}px`,size:`${s.size}px`,leading:s.leading,paragraph:`${s.paragraph}px`,font:FONTS[s.font],'image-height':`${height - 2*s.margin - 20}px`,'measure-width':`${width/this.columns - 2*s.margin - 2}px`,'measure-height':`${height - 2*s.margin}px`})) this.reader.style.setProperty(`--${k}`,v);
      this.pages = BookPaginator.paginate(this.blocks,this.measure);
      this.index = 0;
      for (let i=0;i<this.pages.length;i++) {
        if (this.pages[i].bookOffset > offset) break;
        this.index = Math.floor(i / this.columns)*this.columns;
      }
      this.reader.querySelector('[data-action=one]').setAttribute('aria-pressed',String(s.columns === 1));
      this.reader.querySelector('[data-action=two]').setAttribute('aria-pressed',String(s.columns === 2));
      this.render(); this.renderCatalog();
    }
    render() {
      this.spread.replaceChildren();
      for (let i=0;i<this.columns;i++) {
        const leaf = el('div','leaf'); const content = el('div','paper-content');
        const page = this.index + i;
        if (this.pages[page]) content.append(this.pages[page].cloneNode(true));
        leaf.append(content); this.spread.append(leaf);
      }
      this.reader.querySelector('[data-action=prev]').disabled = this.index === 0;
      this.reader.querySelector('[data-action=next]').disabled = this.index + this.columns >= this.pages.length;
      const end = Math.min(this.pages.length,this.index + this.columns);
      this.reader.querySelector('.position').textContent = `${this.index + 1}${end > this.index + 1 ? '–'+end : ''} / ${this.pages.length}`;
      this.book.setAttribute('aria-label',`第 ${this.index+1}${end > this.index+1 ? ' 至 '+end : ''} 页，共 ${this.pages.length} 页；左右方向键翻页`);
      this.highlightChapter();
    }
    goToOffset(offset) {
      let index = 0;
      for (let i=0;i<this.pages.length;i++) { if (this.pages[i].bookOffset > offset) break; index = i; }
      this.index = Math.floor(index/this.columns)*this.columns; this.hasTurned = true; this.selectedChapter = offset; this.render();
    }
    setImmersive(value) { this.immersive = value; this.reflow(); this.book.focus({preventScroll:true}); }
    syncScrollLock() {
      const style = document.documentElement.style;
      if (this.immersive && !this.scrollLock) {
        this.scrollLock = {value:style.getPropertyValue('overflow'),priority:style.getPropertyPriority('overflow')};
        style.setProperty('overflow','hidden');
      } else if (!this.immersive && this.scrollLock) {
        if (this.scrollLock.value) style.setProperty('overflow',this.scrollLock.value,this.scrollLock.priority); else style.removeProperty('overflow');
        this.scrollLock = null;
      }
    }
    catalogState() {
      return {books:[...this.expandedBooks],rounds:[...this.expandedRounds],scrollTop:this.reader.querySelector('.catalog-list').scrollTop};
    }
    navigateBook(book, target = {}) {
      if (book.path===location.pathname) return;
      this.ask.disabled=true;this.reader.querySelector('.ask button').disabled=true;this.status('正在切换会话…');
      navigation={path:book.path,immersive:this.immersive,at:Date.now(),known:new Set([...controllers.values()].map(r=>r.source)),catalogState:this.catalogState(),...target};
      try { sessionStorage.setItem(NAVIGATION_KEY,JSON.stringify({path:book.path,immersive:this.immersive,at:navigation.at,...target})); } catch {}
      const anchor=BookCatalog.books().find(item=>item.path===book.path)?.anchor;
      if(anchor?.isConnected)anchor.click();else location.assign(book.path);
    }
    async openRound(book, round, offset) {
      if(book.path!==location.pathname){this.navigateBook(book,{sourceId:round.sourceId,offset:offset??BookCatalog.positionFor(round.sourceId,book.path)});return;}
      if(!round.source)return;
      if(BookCatalog.sourceId(this.source)===round.sourceId){if(offset!==undefined)this.goToOffset(offset);this.book.focus({preventScroll:true});return;}
      offset=offset??BookCatalog.positionFor(round.sourceId,book.path);
      let target=[...controllers.values()].find(r=>r.source===round.source);
      if(!target){target=new Reader(round.source,round.source);controllers.set(round.source,target);}
      const state=this.catalogState();state.rounds.push(`${book.path}|${round.id}`);
      try{await target.open({immersive:this.immersive,fromStart:true,offset,catalogState:state});}
      catch{if(target.reader)target.close();}
    }
    renderCatalog() {
      if(!this.reader)return;
      const model=BookCatalog.tree(this.source,this.blocks), currentId=BookCatalog.sourceId(this.source);
      if(!this.catalogInitialized){
        const current=model.find(b=>b.current)?.rounds.find(r=>r.sourceId===currentId);
        if(current)this.expandedRounds.add(`${location.pathname}|${current.id}`);
        this.catalogInitialized=true;
      }
      const signature=JSON.stringify([model.map(b=>[b.path,b.title,b.rounds.map(r=>[r.id,r.question,r.sourceId,(r.sections||[]).map(s=>[s.title,s.offset,s.level])])]),[...this.expandedBooks],[...this.expandedRounds]]);
      if(signature===this.catalogSignature){this.highlightChapter();return;}
      this.catalogSignature=signature;
      const list=this.reader.querySelector('.catalog-list'),top=list.scrollTop||this.catalogScroll||0;
      list.replaceChildren();const tree=el('ul','catalog-tree');
      const toggle=(expanded,label,callback)=>{
        const button=el('button','tree-toggle','›');button.type='button';button.setAttribute('aria-expanded',String(expanded));button.setAttribute('aria-label',`${expanded?'收起':'展开'}${label}`);
        button.addEventListener('click',e=>{e.stopPropagation();callback();});return button;
      };
      for(const book of model){
        const bookNode=el('li','book-node');bookNode.dataset.path=book.path;bookNode.dataset.depth='1';
        const row=el('div','tree-row'),expanded=this.expandedBooks.has(book.path);
        row.append(toggle(expanded,book.title,()=>{
          if(!book.current&&!book.rounds.length){this.navigateBook(book);return;}
          if(expanded)this.expandedBooks.delete(book.path);else this.expandedBooks.add(book.path);this.renderCatalog();
        }));
        const title=el('button','book-title',book.title);title.type='button';title.title=book.title;
        if(book.current)title.setAttribute('aria-current','page');
        title.addEventListener('click',e=>{e.stopPropagation();if(book.current){if(expanded)this.expandedBooks.delete(book.path);else this.expandedBooks.add(book.path);this.renderCatalog();}else this.navigateBook(book);});
        row.append(title);bookNode.append(row);
        const rounds=el('ol','round-list');rounds.hidden=!expanded;
        book.rounds.forEach((round,index)=>{
          const key=`${book.path}|${round.id}`,open=this.expandedRounds.has(key);
          const node=el('li','round-node');node.dataset.depth='2';node.dataset.round=round.id;
          const line=el('div','tree-row');
          const expander=toggle(open,`第${index+1}轮`,()=>{if(open)this.expandedRounds.delete(key);else this.expandedRounds.add(key);this.renderCatalog();});
          expander.disabled=!round.sections?.length;
          const label=round.question || `第 ${index+1} 轮`;
          const button=el('button','round-title',`${index+1}. ${label.slice(0,76)}${label.length>76?'…':''}`);button.type='button';button.title=round.source?label:`${label}（暂无回答正文）`;button.disabled=!round.source;
          button.dataset.sourceId=round.sourceId||'';
          if(book.current&&round.sourceId===currentId)button.setAttribute('aria-current','true');
          button.addEventListener('click',e=>{e.stopPropagation();this.openRound(book,round);});line.append(expander,button);node.append(line);
          const sections=el('ul','section-list');sections.hidden=!open;
          const base=Math.min(...(round.sections||[]).map(s=>s.level));
          for(const section of round.sections||[]){
            const leaf=el('li');leaf.dataset.depth='3';
            const link=el('button','catalog-section',section.title);link.type='button';link.title=section.title;link.dataset.offset=section.offset;link.dataset.sourceId=round.sourceId;link.dataset.markdownLevel=section.level;link.dataset.path=book.path;
            link.style.paddingLeft=`${20+(section.level-base)*8}px`;
            link.addEventListener('click',e=>{e.stopPropagation();this.openRound(book,round,section.offset);});leaf.append(link);sections.append(leaf);
          }
          node.append(sections);rounds.append(node);
        });
        bookNode.append(rounds);tree.append(bookNode);
      }
      list.append(tree);list.scrollTop=top;this.catalogScroll=0;this.highlightChapter();
    }
    highlightChapter() {
      if(!this.reader)return;
      const pageStart=this.pages[this.index]?.bookOffset||0;
      const pageEnd=this.pages[this.index+this.columns]?.bookOffset??Infinity;
      const offset=this.selectedChapter>=pageStart&&this.selectedChapter<pageEnd?this.selectedChapter:pageStart;
      const active=[...(this.chapters||[])].reverse().find(c=>c.offset<=offset),id=BookCatalog.sourceId(this.source);
      for(const button of this.reader.querySelectorAll('.catalog-section')){
        if(button.dataset.path===location.pathname&&button.dataset.sourceId===id&&Number(button.dataset.offset)===active?.offset)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');
      }
    }
    async loadCatalog(kind) {
      if(this.catalogAbort){this.catalogAbort.abort();return;}
      const abort=new AbortController();this.catalogAbort=abort;
      const button=this.reader.querySelector(`[data-action=${kind}]`),original=button.textContent;
      const status=this.reader.querySelector('.catalog-status');button.textContent='停止加载';status.hidden=false;status.textContent='加载中…';
      const update=count=>{if(!this.reader||abort.signal.aborted)return;status.textContent=`已读取 ${count} ${kind==='history'?'个会话':'轮对话'}`;this.renderCatalog();};
      try{
        const count=await (kind==='history'?BookCatalog.loadHistory({signal:abort.signal,onUpdate:update}):BookCatalog.loadEarlier({source:this.source,signal:abort.signal,onUpdate:update}));
        if(this.reader){status.textContent=`已读取 ${count||0} ${kind==='history'?'个会话':'轮对话'}`;this.renderCatalog();}
      }catch(error){if(this.reader)status.textContent=error.message;}
      finally{if(this.reader)button.textContent=original;this.catalogAbort=null;}
    }
    status(text) {
      if (!this.reader) return;
      const status = this.reader.querySelector('.ask-status'); status.textContent = text; status.hidden = !text;
    }
    async submitQuestion() {
      const text = this.ask.value.trim();
      if (!text || this.sending) return;
      const surface = this.reader, submittedDraft = this.draft;
      this.sending = true; this.reader.querySelector('.ask button').disabled = true; this.status('发送中…');
      const pending = {owner:this,path:location.pathname,known:new Set([...controllers.values()].map(r=>r.source)),ready:false};
      followup = pending;
      let result;
      try { result = await BookComposer.submit(text); } catch { result = {ok:false,error:'发送失败，草稿已保留'}; }
      this.sending = false;
      if (this.reader !== surface) {
        if (result.ok && this.draft === submittedDraft) this.draft = '';
        if (followup === pending) followup = null;
        return;
      }
      if (!result.ok) {
        if (followup === pending) followup = null;
        this.status(result.error); if (this.reader) this.reader.querySelector('.ask button').disabled = false; this.ask.focus({preventScroll:true}); return;
      }
      this.draft = ''; this.ask.value = ''; pending.ready = true; this.status('等待回答…');
      this.book.focus({preventScroll:true}); discover();
    }
    turn(direction) {
      const max = Math.floor((this.pages.length - 1)/this.columns)*this.columns;
      const next = Math.min(max,Math.max(0,this.index + direction*this.columns));
      if (next !== this.index) this.hasTurned = true;
      this.selectedChapter = undefined;
      this.index = next; this.render();
    }
    zoom(image) {
      const dialog = el('dialog','zoom'); dialog.setAttribute('aria-label','图片放大预览');
      const close = el('button',null,'关闭'); close.title = '关闭（Esc）'; close.type = 'button'; const img = image.cloneNode(true);
      dialog.append(img,close); this.root.append(dialog); this.dialog = dialog;
      close.addEventListener('click',() => dialog.close()); dialog.addEventListener('click',e => { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener('close',() => { dialog.remove(); this.dialog = null; this.book.focus({preventScroll:true}); },{once:true}); dialog.showModal();
    }
    close({restorePosition = true,keepPending = false} = {}) {
      if (followup?.owner === this && !keepPending) followup = null;
      this.catalogAbort?.abort();
      this.immersive = false; this.syncScrollLock();
      const offset = this.hasTurned ? this.pages[this.index]?.bookOffset || 0 : this.openingOffset || 0;
      BookCatalog.rememberPosition(this.source,offset,this.path);
      clearTimeout(this.timer); clearTimeout(this.captureTimer); this.captureTimer = null; this.sourceObserver?.disconnect(); this.resizeObserver?.disconnect();
      document.removeEventListener('keydown',this.onKey,true); window.removeEventListener('resize',this.onResize);
      if (this.originalStyle === null) this.source.removeAttribute('style'); else this.source.setAttribute('style',this.originalStyle);
      this.dialog?.close(); this.reader?.remove(); this.reader = null; this.readerOpened = false;
      this.host.removeAttribute('style'); this.host.style.display = 'none';
      this.placeholder?.remove();
      if (this.source.isConnected) this.source.before(this.host);
      if (current === this) current = null;
      const restore = this.source.isConnected ? this.source : BookCatalog.rounds().find(r=>r.sourceId===BookCatalog.sourceId(this.source))?.source;
      const points = restore ? BookPaginator.extract(restore).sourcePoints : [];
      if (restorePosition && restore) scrollToPoint(restore,points.find(p => p.end > offset) || points.at(-1),offset);
      entryButton.focus({preventScroll:true}); updateEntry();
    }
    dispose() { if (this.reader) this.close(); this.host.remove(); }
  }
  function chooseReader() {
    if (current?.reader) return current;
    const readers = [...controllers.values()];
    const visible = readers.map(reader => {
      const rect = (reader.reader ? reader.host : reader.source).getBoundingClientRect();
      return {reader,overlap:Math.max(0,Math.min(rect.bottom,innerHeight-100)-Math.max(rect.top,80))};
    }).filter(item => item.overlap > 0).sort((a,b) => b.overlap-a.overlap);
    return visible.find(item => item.reader === pointedReader)?.reader || visible[0]?.reader || readers.at(-1);
  }
  function updateEntry() {
    const active = !!chooseReader()?.reader;
    entryButton.querySelector('span').textContent = active ? '退出阅读' : '分页阅读';
    entryButton.setAttribute('aria-pressed',String(active));
    entryHost.style.display = current?.reader ? 'none' : '';
  }
  async function activate() {
    discover();
    const target = chooseReader();
    if (!target) return {ok:false};
    try {
      if (target.reader) target.close(); else await target.open();
    } catch {
      if (target.reader) target.close();
      return {ok:false,error:'无法打开，请重新加载插件并刷新页面'};
    }
    updateEntry(); return {ok:true};
  }
  const entryHost = el('div'); entryHost.dataset.bookReader = 'entry';
  entryHost.style.cssText = 'position:fixed;right:24px;bottom:104px;z-index:2147483000;';
  const entryRoot = entryHost.attachShadow({mode:'open'});
  const entryStyle = el('style'); entryStyle.textContent = BookReaderStyles; entryRoot.append(entryStyle);
  const entryButton = el('button','launch floating'); entryButton.type = 'button'; entryButton.innerHTML = icon + '<span>分页阅读</span>';
  function showEntryMessage(text) {
    let feedback=entryRoot.querySelector('[role=status]');
    if(!feedback){feedback=el('div','feedback');feedback.setAttribute('role','status');entryRoot.prepend(feedback);}
    feedback.textContent=text;clearTimeout(feedback.timer);feedback.timer=setTimeout(()=>feedback.remove(),4000);
  }
  entryButton.addEventListener('click',async () => {
    const result = await activate();
    if (!result.ok) {
      showEntryMessage(result.error || '当前页面没有可阅读的回答');
    }
  });
  entryRoot.append(entryButton); document.body.append(entryHost);
  document.addEventListener('pointerover',event => {
    for (const reader of controllers.values()) {
      if (reader.source.contains(event.target) || reader.host.contains(event.target)) { pointedReader = reader; updateEntry(); break; }
    }
  },{passive:true});
  let entryFrame;
  document.addEventListener('scroll',() => {
    if (!entryFrame) entryFrame = requestAnimationFrame(() => { entryFrame = null; updateEntry(); });
  },{capture:true,passive:true});
  function discover() {
    for (const [message,reader] of controllers) {
      if (!message.isConnected || !reader.source.isConnected || !message.contains(reader.source)) {
        if (reader.reader) { reader.sourceObserver?.disconnect(); continue; }
        reader.dispose(); controllers.delete(message);
      }
      else if (!reader.host.isConnected) reader.source.before(reader.host);
      if (reader.reader && !reader.placeholder.isConnected && reader.source.isConnected) reader.source.before(reader.placeholder);
    }
    const candidates = [...document.querySelectorAll('[data-message-author-role="assistant"]')].map(message => ({
      message,source:message.matches('.markdown') ? message : message.querySelector('.markdown')
    }));
    // Current ChatGPT uses a semantic text-style marker instead of the legacy role/.markdown pair.
    document.querySelectorAll('[data-markdown-text-style="assistant-message"]').forEach(source => {
      if (!candidates.some(item => item.source === source)) candidates.push({message:source,source});
    });
    candidates.forEach(({message,source}) => {
      if (controllers.has(message)) return;
      if (source && (source.textContent.trim() || source.querySelector('img'))) controllers.set(message,new Reader(message,source));
    });
    if (navigation && navigation.path === location.pathname) {
      const fresh = [...controllers.values()].filter(r=>!navigation.known.has(r.source));
      let target = navigation.sourceId ? fresh.find(r=>BookCatalog.sourceId(r.source)===navigation.sourceId) : fresh.at(-1);
      if(fresh.length&&navigation.sourceId){
        const cached=BookCatalog.refresh().rounds.find(r=>r.sourceId===navigation.sourceId);
        if(cached?.source&&!fresh.some(r=>r.source===cached.source)){
          target=new Reader(cached.source,cached.source);controllers.set(cached.source,target);
        }
      }
      if(!target&&fresh.length&&navigation.sourceId&&!navigation.loader){
        const pending=navigation;pending.loader=new AbortController();showEntryMessage('正在读取所选轮次…');
        BookCatalog.loadEarlier({source:fresh.at(-1).source,signal:pending.loader.signal,onUpdate:discover}).then(()=>{
          if(navigation!==pending)return;
          navigation=null;try{sessionStorage.removeItem(NAVIGATION_KEY);}catch{}
          showEntryMessage('未找到所选轮次，可在原会话中继续加载');
        }).catch(()=>{if(navigation===pending){navigation=null;showEntryMessage('未能载入所选轮次，请在原会话中重试');}});
      }
      if (target) {
        const options={immersive:navigation.immersive,fromStart:true,offset:navigation.offset||0,catalogState:navigation.catalogState};navigation.loader?.abort();navigation = null;
        try { sessionStorage.removeItem(NAVIGATION_KEY); } catch { /* Reading is unaffected. */ }
        target.open(options).catch(()=>{if(target.reader)target.close();});
      }
    }
    if (followup?.ready && followup.path === location.pathname) {
      const target = [...controllers.values()].filter(r=>!followup.known.has(r.source)).at(-1);
      if (target) { const mode = followup.owner.immersive; followup = null; target.open({immersive:mode,fromStart:true,autoCapture:true}); }
    }
    updateEntry();
  }
  let scanTimer;
  const observer = new MutationObserver(mutations => {
    // Reader rendering is isolated in Shadow DOM; ignore changes entirely within our hosts.
    if (!mutations.some(m => !m.target.closest?.('[data-book-reader]'))) return;
    // A continuous stream must not postpone discovery indefinitely.
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; discover(); },180);
  });
  observer.observe(document.body,{childList:true,characterData:true,subtree:true}); discover();
  globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, respond) => {
    if (message.type !== 'book-reader:open') return;
    activate().then(respond).catch(() => respond({ok:false}));
    return true;
  });
})();
