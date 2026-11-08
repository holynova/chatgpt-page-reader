(() => {
  'use strict';
  const BLOCKS = new Set(['P','H1','H2','H3','H4','H5','H6','UL','OL','BLOCKQUOTE','PRE','TABLE','FIGURE','HR','IMG','MATH','DL']);

  function extract(source) {
    const root = source.cloneNode(true);
    const origins = new WeakMap();
    const originalTexts = document.createTreeWalker(source,NodeFilter.SHOW_TEXT);
    const clonedTexts = document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let originalText, clonedText;
    while ((originalText = originalTexts.nextNode()) && (clonedText = clonedTexts.nextNode())) origins.set(clonedText,originalText);
    root.querySelectorAll('button,[role="button"]').forEach(n => {
      // ChatGPT renders inline entity names as buttons; their text is part of the answer.
      if (n.closest('p,li,h1,h2,h3,h4,th,td') && !n.closest('pre')) n.replaceWith(...n.childNodes);
      else n.remove();
    });
    root.querySelectorAll('script,style,link,iframe,object,embed,form,input,textarea,select,svg,canvas,[data-book-reader]').forEach(n => n.remove());
    root.querySelectorAll('.katex').forEach(n => {
      const math = n.querySelector('math');
      if (math) n.replaceWith(math);
    });
    root.querySelectorAll('*').forEach(n => {
      if (n.tagName === 'IMG') {
        n.setAttribute('src', n.src);
        n.setAttribute('loading', 'eager');
      }
      if (n.tagName === 'A') {
        const href = n.href;
        if (/^https?:\/\//i.test(href)) {
          n.setAttribute('href', href);
          n.setAttribute('target', '_blank');
          n.setAttribute('rel', 'noopener noreferrer');
        } else n.removeAttribute('href');
      }
      for (const a of [...n.attributes]) {
        if (!['href','target','rel','src','alt','title','colspan','rowspan','start','value','loading','display','xmlns','encoding','mathvariant','stretchy','fence','separator','accent','accentunder','linethickness','columnalign','rowalign','columnspacing','rowspacing','notation'].includes(a.name)) n.removeAttribute(a.name);
      }
    });
    const blocks = [];
    function visit(n) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.textContent.trim()) {
          const p = document.createElement('p'); p.append(n); blocks.push(p);
        }
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        if (BLOCKS.has(n.tagName)) blocks.push(n);
        else if (n.querySelector('p,h1,h2,h3,h4,ul,ol,pre,table,figure,blockquote')) [...n.childNodes].forEach(visit);
        else if (n.textContent.trim() || n.querySelector('img,math')) {
          const p = document.createElement('p'); p.append(n); blocks.push(p);
        }
      }
    }
    [...root.childNodes].forEach(visit);
    blocks.sourcePoints = [];
    let offset = 0;
    for (const block of blocks) {
      block.dataset.bookOffset = offset;
      const texts = document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
      const rows = new Set(); let text;
      while ((text = texts.nextNode())) {
        const row = text.parentElement.closest('tr');
        if (row && !rows.has(row)) { row.dataset.bookOffset = offset; rows.add(row); }
        const node = origins.get(text);
        if (node) blocks.sourcePoints.push({node,start:offset,end:offset+text.length});
        offset += text.length;
      }
    }
    return blocks;
  }

  function splitAt(node, offset) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text, used = 0, point;
    while ((text = walker.nextNode())) {
      if (used + text.length >= offset) { point = [text, offset - used]; break; }
      used += text.length;
    }
    if (!point) return [node.cloneNode(true), null];
    const before = document.createRange(); before.selectNodeContents(node); before.setEnd(...point);
    const after = document.createRange(); after.selectNodeContents(node); after.setStart(...point);
    const head = node.cloneNode(false); head.append(before.cloneContents());
    const tail = node.cloneNode(false); tail.append(after.cloneContents());
    if (node.dataset.bookOffset !== undefined) tail.dataset.bookOffset = Number(node.dataset.bookOffset) + offset;
    // Range may leave empty structural wrappers at a boundary.
    for (const piece of [head, tail]) {
      [...piece.querySelectorAll('p,li,ul,ol,blockquote')].reverse().forEach(n => {
        if (!n.textContent && !n.querySelector('img,math,hr')) n.remove();
      });
    }
    if (node.tagName === 'OL') {
      const start = Number(node.getAttribute('start') || 1);
      const count = head.querySelectorAll(':scope > li').length;
      const last = head.lastElementChild;
      const original = node.children[count - 1];
      const shared = last && original && last.textContent !== original.textContent;
      tail.setAttribute('start', String(start + count - (shared ? 1 : 0)));
      if (shared && tail.firstElementChild) tail.firstElementChild.style.listStyleType = 'none';
    }
    return [head, tail];
  }

  function paginate(blocks, measure) {
    const pages = [];
    measure.replaceChildren();
    const fits = () => measure.scrollHeight <= measure.clientHeight + 1;
    const filled = () => measure.childNodes.length > 0;
    function commit() {
      if (filled()) {
        const f = document.createDocumentFragment();
        while (measure.firstChild) f.append(measure.firstChild);
        f.bookOffset = Number(f.querySelector('[data-book-offset]')?.dataset.bookOffset || 0);
        pages.push(f);
      }
    }
    function oversized(node) {
      const box = document.createElement('div'); box.className = 'oversized';
      box.style.height = `${measure.clientHeight}px`; box.append(node); measure.append(box); commit();
    }
    function append(node) {
      measure.append(node);
      if (fits()) return;
      node.remove();
      // Prefer keeping short paragraphs/headings/images together.
      if (filled() && (node.textContent.length < 100 || /^(H[1-6]|IMG|FIGURE|MATH)$/.test(node.tagName))) commit();
      measure.append(node);
      if (fits()) return;
      node.remove();
      if (node.querySelector('table') || node.tagName === 'TABLE') {
        if (filled()) commit();
        oversized(node); return;
      }
      const fullText = node.textContent;
      if (!fullText.length || /^(IMG|FIGURE|MATH)$/.test(node.tagName)) {
        if (filled()) commit();
        measure.append(node);
        if (!fits()) { node.remove(); oversized(node); }
        return;
      }
      // Find the largest DOM Range that fits; keep inline emphasis and links.
      let low = 0, high = fullText.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const [trial] = splitAt(node, mid); measure.append(trial);
        const ok = fits(); trial.remove();
        if (ok) low = mid; else high = mid - 1;
      }
      if (!low) {
        if (filled()) { commit(); append(node); } else oversized(node);
        return;
      }
      // Never split a UTF-16 surrogate pair. Prefer a nearby word/line boundary.
      if (/[\uD800-\uDBFF]/.test(fullText[low - 1])) low--;
      const near = fullText.slice(Math.max(0, low - 70), low);
      const boundary = Math.max(near.lastIndexOf('\n'), near.lastIndexOf(' '));
      if (boundary >= 0 && boundary > near.length / 2) low -= near.length - boundary - 1;
      if (low <= 0) { if (filled()) { commit(); append(node); } else oversized(node); return; }
      const [head, tail] = splitAt(node, low);
      measure.append(head); commit();
      if (tail && (tail.textContent.length || tail.querySelector('img,math'))) append(tail);
    }
    function table(node) {
      // Splitting spanning cells changes their meaning: retain as one scrollable object.
      if (node.querySelector('[rowspan]:not([rowspan="1"])')) { append(wrapTable(node)); return; }
      const rows = [...node.querySelectorAll(':scope > tbody > tr,:scope > tr')];
      if (!rows.length) { append(wrapTable(node)); return; }
      let wrapper, body;
      function create() {
        const t = node.cloneNode(false);
        for (const child of node.children) if (['CAPTION','COLGROUP','THEAD'].includes(child.tagName)) t.append(child.cloneNode(true));
        body = document.createElement('tbody'); t.append(body); wrapper = wrapTable(t); measure.append(wrapper);
      }
      create();
      for (const row of rows) {
        body.append(row.cloneNode(true));
        if (body.children.length === 1) body.parentElement.dataset.bookOffset = row === rows[0] ? node.dataset.bookOffset : row.dataset.bookOffset;
        if (fits()) continue;
        body.lastChild.remove();
        if (!body.children.length) wrapper.remove();
        commit(); create(); body.append(row.cloneNode(true));
        body.parentElement.dataset.bookOffset = row === rows[0] ? node.dataset.bookOffset : row.dataset.bookOffset;
        if (!fits()) {
          wrapper.remove(); oversized(wrapper); create();
        }
      }
      if (!body.children.length) wrapper.remove();
      if (node.tFoot) {
        const footer = node.cloneNode(false); footer.append(node.tFoot.cloneNode(true)); append(wrapTable(footer));
      }
    }
    function wrapTable(n) {
      const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.append(n); return wrapper;
    }
    for (const original of blocks) {
      const node = original.cloneNode(true);
      if (/^H[1-6]$/.test(node.tagName) && filled()) {
        // Avoid leaving a heading alone at the bottom of a leaf.
        const reserve = document.createElement('div');
        reserve.style.height = `${parseFloat(getComputedStyle(measure).lineHeight) * 2}px`;
        measure.append(node,reserve); const enough = fits(); node.remove(); reserve.remove();
        if (!enough) commit();
      }
      if (node.tagName === 'TABLE') table(node); else append(node);
    }
    commit();
    if (!pages.length) pages.push(document.createDocumentFragment());
    return pages;
  }
  globalThis.BookPaginator = { extract, paginate };
})();
