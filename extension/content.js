(() => {
  'use strict';
  if (globalThis.__bookReaderInstalled) return;
  globalThis.__bookReaderInstalled = true;
  const DEFAULTS = { size:18, leading:1.85, paragraph:16, margin:30, width:1080, height:510, font:'serif', theme:'paper', columns:2 };
  const FONTS = {
    serif: 'Georgia,"Noto Serif SC","Songti SC",SimSun,serif',
    sans: '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Consolas,monospace'
  };
  const ranges = { size:[14,28], leading:[1.3,2.4], paragraph:[0,32], margin:[16,56], width:[640,1440], height:[300,720] };
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 5.5C8 2.8 4 3.6 2.5 4.5v15C5 18 8.5 18 12 20c3.5-2 7-2 9.5-.5v-15C20 3.6 16 2.8 12 5.5Zm0 0V20"/></svg>';
  let saved = { ...DEFAULTS };
  const controllers = new Map();
  let current = null;
  let pointedReader = null;
  function cleanSettings(value) {
    const result = { ...DEFAULTS };
    for (const [k,[min,max]] of Object.entries(ranges)) if (Number.isFinite(value?.[k])) result[k] = Math.min(max,Math.max(min,value[k]));
    if (value?.font in FONTS) result.font = value.font;
    if (['paper','white','dark'].includes(value?.theme)) result.theme = value.theme;
    if ([1,2].includes(value?.columns)) result.columns = value.columns;
    return result;
  }
  const loaded = (async () => {
    try { if (globalThis.chrome?.storage?.local) saved = cleanSettings((await chrome.storage.local.get('bookReaderSettings')).bookReaderSettings); } catch { /* Defaults remain available if extension was reloaded. */ }
  })();
  function persist(settings) {
    saved = { ...settings };
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
      this.host = el('div'); this.host.dataset.bookReader = 'host';
      this.root = this.host.attachShadow({mode:'open'});
      const style = el('style'); style.textContent = BookReaderStyles; this.root.append(style);
      this.host.style.display = 'none';
      source.before(this.host);
    }
    async open() {
      await loaded;
      if (this.reader) return;
      this.settings = { ...saved }; current = this;
      this.pendingPoint = visiblePoint(this.source);
      this.pendingOffset = 0;
      this.hasTurned = false;
      this.originalStyle = this.source.getAttribute('style');
      this.source.style.setProperty('display','none','important');
      this.reader = el('section','reader'); this.reader.setAttribute('aria-label','回答分页阅读器');
      this.reader.innerHTML = `<header class="top"><div class="layout" role="group" aria-label="页面布局"><button type="button" data-action="one" aria-label="单页显示">单页</button><button type="button" data-action="two" aria-label="双页显示">双页</button></div><div class="tools"><button type="button" class="notice" data-action="refresh" title="原回答有更新" hidden>更新</button><button type="button" data-action="settings" aria-expanded="false">排版</button><button type="button" class="plain" data-action="close">退出</button></div></header><div class="settings" hidden></div><div class="book" tabindex="0" role="region" aria-label="书页，使用左右方向键翻页"><div class="spread"></div></div><footer class="bottom"><div class="navigation"><button type="button" data-action="prev" aria-label="上一页" title="上一页（←）">←</button><span class="position" role="status" aria-live="polite"></span><button type="button" data-action="next" aria-label="下一页" title="下一页（→）">→</button></div></footer>`;
      this.root.append(this.reader);
      this.book = this.reader.querySelector('.book'); this.spread = this.reader.querySelector('.spread');
      this.measure = el('div','paper-content measure'); this.measure.setAttribute('aria-hidden','true'); this.reader.append(this.measure);
      this.makeSettings();
      this.reader.addEventListener('click', e => {
        current = this;
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') this.close();
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
        if (e.target.closest('.book')) {
          this.reader.querySelector('.settings').hidden = true;
          this.reader.querySelector('[data-action=settings]').setAttribute('aria-expanded','false');
        }
        if (e.target.tagName === 'IMG') this.zoom(e.target);
      });
      this.reader.addEventListener('focusin', () => { current = this; });
      this.reader.addEventListener('pointerdown', () => { current = this; });
      this.onKey = e => {
        if (current !== this || !this.reader || this.dialog?.open || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const target = e.composedPath()[0];
        if (e.key === 'Escape' && !this.reader.querySelector('.settings').hidden) {
          this.reader.querySelector('.settings').hidden = true;
          this.reader.querySelector('[data-action=settings]').setAttribute('aria-expanded','false');
          this.book.focus({preventScroll:true}); return;
        }
        if (target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
        const rect = this.reader.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        if (['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); this.turn(['ArrowLeft','PageUp'].includes(e.key) ? -1 : 1);
        }
      };
      document.addEventListener('keydown',this.onKey,true);
      this.sourceObserver = new MutationObserver(() => {
        if (this.reader) this.reader.querySelector('.notice').hidden = false;
      });
      this.sourceObserver.observe(this.source,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['src']});
      this.onResize = () => this.schedule(); window.addEventListener('resize',this.onResize);
      this.resizeObserver = new ResizeObserver(() => {
        const rect = this.host.parentElement?.getBoundingClientRect();
        const key = rect && `${Math.round(rect.width)}:${Math.round(rect.left)}`;
        if (key !== this.parentSize) { this.parentSize = key; this.schedule(); }
      });
      this.resizeObserver.observe(this.host.parentElement);
      this.capture();
      this.book.focus({preventScroll:true});
      // Initial positioning is instantaneous; page turns never move the document.
      this.host.style.scrollMarginTop = '20px';
      this.host.scrollIntoView({block:'start',behavior:'instant'});
      updateEntry();
    }
    makeSettings() {
      const panel = this.reader.querySelector('.settings'); panel.replaceChildren();
      const fields = [
        ['font','字体',[['serif','衬线'],['sans','无衬线'],['mono','等宽']]],
        ['theme','纸张',[['paper','暖纸'],['white','纯白'],['dark','夜间']]],
        ['size','字号',14,28,1,'px'],['leading','行距',1.3,2.4,.05,''],
        ['paragraph','段距',0,32,2,'px'],['margin','边距',16,56,2,'px'],
        ['width','宽度',640,1440,40,'px'],['height','高度',300,720,20,'px']
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
      const main = this.host.closest('main,[role="main"]');
      const bounds = main?.getBoundingClientRect() || {left:0,width:window.innerWidth};
      const left = Math.max(16,bounds.left + 20); const right = Math.min(window.innerWidth - 16,bounds.left + bounds.width - 20);
      const parent = this.host.parentElement.getBoundingClientRect();
      const width = Math.max(240,Math.min(s.width,right - left));
      const x = Math.max(left,Math.min(right - width,parent.left + parent.width / 2 - width / 2));
      this.host.style.cssText = `display:block;width:${width}px;max-width:none;margin-left:${x-parent.left}px;position:relative;z-index:1;`;
      this.columns = s.columns === 2 && width >= 800 ? 2 : 1;
      const height = Math.max(180,Math.min(s.height,window.innerHeight - 255));
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
      this.render();
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
    }
    turn(direction) {
      const max = Math.floor((this.pages.length - 1)/this.columns)*this.columns;
      const next = Math.min(max,Math.max(0,this.index + direction*this.columns));
      if (next !== this.index) this.hasTurned = true;
      this.index = next; this.render();
    }
    zoom(image) {
      const dialog = el('dialog','zoom'); dialog.setAttribute('aria-label','图片放大预览');
      const close = el('button',null,'关闭'); close.title = '关闭（Esc）'; close.type = 'button'; const img = image.cloneNode(true);
      dialog.append(img,close); this.root.append(dialog); this.dialog = dialog;
      close.addEventListener('click',() => dialog.close()); dialog.addEventListener('click',e => { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener('close',() => { dialog.remove(); this.dialog = null; this.book.focus({preventScroll:true}); },{once:true}); dialog.showModal();
    }
    close() {
      const offset = this.hasTurned ? this.pages[this.index]?.bookOffset || 0 : this.openingOffset || 0;
      clearTimeout(this.timer); this.sourceObserver?.disconnect(); this.resizeObserver?.disconnect();
      document.removeEventListener('keydown',this.onKey,true); window.removeEventListener('resize',this.onResize);
      if (this.originalStyle === null) this.source.removeAttribute('style'); else this.source.setAttribute('style',this.originalStyle);
      this.dialog?.close(); this.reader?.remove(); this.reader = null; this.readerOpened = false;
      this.host.removeAttribute('style'); this.host.style.display = 'none';
      if (current === this) current = null;
      const points = BookPaginator.extract(this.source).sourcePoints;
      scrollToPoint(this.source,points.find(p => p.end > offset) || points.at(-1),offset);
      entryButton.focus({preventScroll:true}); updateEntry();
    }
    dispose() { if (this.reader) this.close(); this.host.remove(); }
  }
  function chooseReader() {
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
  }
  async function activate() {
    discover();
    const target = chooseReader();
    if (!target) return {ok:false};
    try {
      if (target.reader) target.close(); else await target.open();
    } catch {
      if (target.reader) target.close();
      return {ok:false};
    }
    updateEntry(); return {ok:true};
  }
  const entryHost = el('div'); entryHost.dataset.bookReader = 'entry';
  entryHost.style.cssText = 'position:fixed;right:24px;bottom:104px;z-index:2147483000;';
  const entryRoot = entryHost.attachShadow({mode:'open'});
  const entryStyle = el('style'); entryStyle.textContent = BookReaderStyles; entryRoot.append(entryStyle);
  const entryButton = el('button','launch floating'); entryButton.type = 'button'; entryButton.innerHTML = icon + '<span>分页阅读</span>';
  entryButton.addEventListener('click',async () => {
    const result = await activate();
    if (!result.ok) {
      let feedback = entryRoot.querySelector('[role=status]');
      if (!feedback) { feedback = el('div','feedback','当前页面没有可阅读的回答'); feedback.setAttribute('role','status'); entryRoot.prepend(feedback); }
      clearTimeout(feedback.timer); feedback.timer = setTimeout(() => feedback.remove(),4000);
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
      if (!message.isConnected || !reader.source.isConnected || !message.contains(reader.source)) { reader.dispose(); controllers.delete(message); }
      else if (!reader.host.isConnected) reader.source.before(reader.host);
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
