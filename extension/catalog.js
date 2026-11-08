(() => {
  'use strict';
  const bookCache = new Map(), sessionCache = new Map(), nodeIds = new WeakMap();
  const positions = new Map();
  let sequence = 0;
  const sessionKey = path => path.match(/\/c\/([^/]+)\/?$/)?.[1] || path;
  function sourceId(source) {
    const owner = source.closest('[data-chatgpt-selection-message-id],[data-message-id]');
    const id = owner?.getAttribute('data-chatgpt-selection-message-id') || owner?.getAttribute('data-message-id') || source.querySelector('[data-dil-message-id]')?.getAttribute('data-dil-message-id') || source.id;
    if (id) return id;
    if (!nodeIds.has(source)) nodeIds.set(source,`local-${++sequence}`);
    return nodeIds.get(source);
  }
  function books() {
    document.querySelectorAll('a[data-interactive-row-link][href],nav a[href],aside a[href]').forEach(anchor => {
      let url;
      try { url = new URL(anchor.href,location.href); } catch { return; }
      if (url.origin !== location.origin || !/\/c\/[^/]+\/?$/.test(url.pathname)) return;
      const title = (anchor.getAttribute('aria-label') || anchor.textContent).trim();
      if (title) bookCache.set(sessionKey(url.pathname),{path:url.pathname,title,anchor});
    });
    return [...bookCache.values()];
  }
  function chapters(blocks) {
    const result = [];
    for (const block of blocks) {
      const headings = /^H[1-6]$/.test(block.tagName) ? [block] : [...block.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      for (const heading of headings) {
        let offset = Number(block.dataset.bookOffset || 0);
        if (heading !== block) { const range = document.createRange(); range.selectNodeContents(block); range.setEndBefore(heading); offset += range.toString().length; }
        if (heading.textContent.trim()) result.push({title:heading.textContent.trim(),offset,level:Number(heading.tagName[1])});
      }
    }
    return result;
  }
  function questionText(unit) {
    const copy = unit.cloneNode(true);
    copy.querySelectorAll('button,script,style,.sr-only,[data-book-reader]').forEach(n=>n.remove());
    return copy.textContent.replace(/\s+/g,' ').trim();
  }
  function rounds() {
    const result = [], seen = new Set(); let current;
    const selector = '[data-chatgpt-search-unit-key],[data-message-author-role],[data-markdown-text-style="assistant-message"]';
    document.querySelectorAll(selector).forEach(unit => {
      if (unit.closest('[data-book-reader]')) return;
      if (unit.parentElement?.closest(selector)) return;
      const key = unit.getAttribute('data-chatgpt-search-unit-key') || '';
      const role = unit.getAttribute('data-message-author-role') || (key.endsWith(':user') ? 'user' : 'assistant');
      if (role === 'user') {
        current = {id:unit.getAttribute('data-message-id') || key || sourceId(unit),question:questionText(unit),source:null,sourceId:null};
        result.push(current); return;
      }
      const source = unit.matches('[data-markdown-text-style="assistant-message"],.markdown') ? unit : unit.querySelector('[data-markdown-text-style="assistant-message"],.markdown');
      if (!source || seen.has(source)) return;
      seen.add(source);
      if (!current || current.source) {
        const question = unit.closest('article')?.querySelector('.prompt')?.textContent.trim() || '';
        current = {id:`answer-${sourceId(source)}`,question,source:null,sourceId:null}; result.push(current);
      }
      current.source = source; current.sourceId = sourceId(source);
    });
    return result;
  }
  function refresh(currentSource, currentBlocks) {
    books();
    const key = sessionKey(location.pathname);
    let session = sessionCache.get(key);
    if (!session) { session = {rounds:[]}; sessionCache.set(key,session); }
    const visible = rounds();
    for (let i=0;i<visible.length;i++) {
      const item = visible[i]; let cached = session.rounds.find(r=>r.id===item.id || item.sourceId && r.sourceId===item.sourceId);
      if (!cached) {
        cached = {};
        const next = visible.slice(i+1).map(r=>session.rounds.findIndex(c=>c.id===r.id)).find(n=>n>=0);
        session.rounds.splice(next ?? session.rounds.length,0,cached);
      }
      if (!item.source && cached.source) { item.source=cached.source;item.sourceId=cached.sourceId; }
      Object.assign(cached,item);
      if (item.source) {
        const signature = item.source.textContent.length+':'+[...item.source.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(n=>n.textContent).join('|');
        if (item.source === currentSource && currentBlocks) cached.sections = chapters(currentBlocks);
        else if (signature !== cached.signature) cached.sections = chapters(BookPaginator.extract(item.source));
        cached.signature = signature;
      } else cached.sections = [];
    }
    return session;
  }
  function tree(currentSource, currentBlocks) {
    refresh(currentSource,currentBlocks);
    const result = books();
    if (!result.some(b=>sessionKey(b.path)===sessionKey(location.pathname))) result.unshift({path:location.pathname,title:document.title.replace(/\s*[-|·]\s*ChatGPT$/i,'') || '当前会话',anchor:null});
    return result.map(book=>{
      const current=sessionKey(book.path)===sessionKey(location.pathname);
      return {...book,path:current?location.pathname:book.path,rounds:sessionCache.get(sessionKey(book.path))?.rounds || [],current};
    });
  }
  function scrollParent(node) {
    for (let parent=node?.parentElement;parent;parent=parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight>parent.clientHeight && parent.clientHeight>0) return parent;
    }
    return document.scrollingElement;
  }
  const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
  async function loadHistory({signal,onUpdate} = {}) {
    const scroller = document.querySelector('[data-app-action-sidebar-scroll]') || scrollParent(books().find(b=>b.anchor?.isConnected)?.anchor);
    if (!scroller || scroller === document.scrollingElement || !scroller.clientHeight) throw new Error('请先展开 ChatGPT 原侧栏，再加载历史会话');
    const top = scroller.scrollTop; const expanded=[];let unchanged = 0, count = books().length;
    try {
      // Expand the same project rows and "展开显示" controls exposed by ChatGPT's own sidebar.
      const visited=new Set();
      while (!signal?.aborted) {
        const project=[...document.querySelectorAll('[data-app-action-sidebar-project-row]')].find(n=>!visited.has(n.getAttribute('data-app-action-sidebar-project-id')));
        if (!project) break;
        visited.add(project.getAttribute('data-app-action-sidebar-project-id'));
        if (project.getAttribute('data-app-action-sidebar-project-collapsed')==='true') {
          project.scrollIntoView({block:'nearest',behavior:'instant'});project.click();expanded.push(project);
        }
        await pause(650);books();onUpdate?.(bookCache.size);
        const container=project.closest('[data-sidebar-project-container-id]');
        let stable=0;
        while (!signal?.aborted && stable<4) {
          const more=[...(container?.querySelectorAll('button') || [])].find(n=>n.textContent.trim()==='展开显示'&&!n.disabled);
          const before=bookCache.size;
          if (more) more.click();
          await pause(650);books();onUpdate?.(bookCache.size);
          stable=bookCache.size===before ? stable+1 : 0;
          if (!more && stable>=2) break;
        }
      }
      while (!signal?.aborted && unchanged < 4) {
        const height = scroller.scrollHeight;
        scroller.scrollTo({top:height,behavior:'instant'}); scroller.dispatchEvent(new Event('scroll'));
        await pause(650);
        const next = books().length;
        unchanged = next === count && height === scroller.scrollHeight ? unchanged+1 : 0;
        count = next; onUpdate?.(count);
      }
      return books().length;
    } finally {
      for(const row of expanded)if(row.isConnected&&row.getAttribute('data-app-action-sidebar-project-collapsed')==='false')row.click();
      scroller.scrollTo({top,behavior:'instant'});
    }
  }
  async function loadEarlier({source,signal,onUpdate} = {}) {
    const native = source?.isConnected ? source : document.querySelector('[data-markdown-text-style="assistant-message"],[data-message-author-role="assistant"]');
    const scroller = scrollParent(native); if (!scroller) return;
    const path=location.pathname,key=sessionKey(path),top = scroller.scrollTop; let unchanged=0, count=refresh().rounds.length;
    try {
      while (!signal?.aborted && location.pathname===path && unchanged<4) {
        const height=scroller.scrollHeight;
        scroller.scrollTo({top:0,behavior:'instant'});scroller.dispatchEvent(new Event('scroll'));
        await pause(650);if(signal?.aborted||location.pathname!==path)break;const session=refresh();const next=session.rounds.length;
        unchanged=next===count&&height===scroller.scrollHeight ? unchanged+1 : 0;count=next;onUpdate?.(count);
      }
      return sessionCache.get(key)?.rounds.length || count;
    } finally { scroller.scrollTo({top,behavior:'instant'}); }
  }
  function rememberPosition(source,offset,path=location.pathname){positions.set(`${sessionKey(path)}|${sourceId(source)}`,offset);}
  function positionFor(id,path=location.pathname){return positions.get(`${sessionKey(path)}|${id}`)||0;}
  globalThis.BookCatalog = {books,chapters,rounds,refresh,tree,sourceId,loadHistory,loadEarlier,rememberPosition,positionFor};
})();
