globalThis.runReaderTests = async function () {
  const results = [];
  const check = (name, condition, details = '') => {
    results.push({name,passed:!!condition,...(!condition?{details}: {})});
  };
  const wait = () => new Promise(r=>setTimeout(r,240));
  const entry = document.querySelector('[data-book-reader="entry"]').shadowRoot;
  async function openFor(message) {
    const body=message.querySelector('.markdown,[data-markdown-text-style="assistant-message"]');
    body.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-80,behavior:'instant'});
    body.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
    entry.querySelector('.launch').click();await wait();
  }
  const first=document.querySelector('#first'); const second=document.querySelector('#second');
  const root=first.querySelector('[data-book-reader]').shadowRoot;
  const secondRoot=second.querySelector('[data-book-reader]').shadowRoot;
  check('固定入口在任意位置可用',getComputedStyle(entry.host).position==='fixed');
  const source=document.querySelector('#source'); const original=source.innerHTML;
  check('回答开头不再添加入口',!root.querySelector('.launch') && !secondRoot.querySelector('.launch'));
  const originalStyle=source.getAttribute('style');
  await openFor(first);
  check('仅隐藏当前正文',getComputedStyle(source).display==='none' && getComputedStyle(second.querySelector('.markdown,[data-markdown-text-style="assistant-message"]')).display!=='none');
  check('保留原操作区与输入框',!!document.querySelector('#native-actions') && !!document.querySelector('.composer textarea,.composer [contenteditable=true]'));
  const pageText=[];const overflow=[];const pageRows=[];let turns=0;
  do {
    for(const paper of root.querySelectorAll('.spread .paper-content')) {
      pageText.push(paper.textContent);
      if(paper.scrollHeight>paper.clientHeight+1)overflow.push({page:root.querySelector('.position').textContent,height:paper.clientHeight,scroll:paper.scrollHeight});
      pageRows.push(...[...paper.querySelectorAll('tbody tr')].map(r=>r.firstElementChild.textContent));
    }
    const next=root.querySelector('[data-action=next]'); if(next.disabled)break; next.click(); turns++;
  }while(turns<300);
  const all=pageText.join('');
  check('长文确实被分成多页',turns>4,turns);
  check('每页无正文垂直截断',overflow.length===0,overflow);
  const originalBlocks=BookPaginator.extract(source);
  const normalized = t=>t.replace(/编号观察维度阅读体验说明/g,'').replace(/\s/g,'');
  check('所有正文按顺序保留且没有重复',normalized(all)===normalized(originalBlocks.map(n=>n.textContent).join('')),{expected:normalized(originalBlocks.map(n=>n.textContent).join('')).length,actual:normalized(all).length});
  check('表格36行依序跨页且不丢失',pageRows.join(',')===Array.from({length:36},(_,i)=>`ROW-${i+1}`).join(','),pageRows);
  check('代码首尾及长行保留',all.includes('CODE-001') && all.includes('CODE-100') && all.includes('very_long_line_'.repeat(45)));
  check('代码逐字符保留空格和换行',all.includes(source.querySelector('pre').textContent));
  check('没有残留代码复制按钮',!all.includes('复制代码'));
  const before=root.querySelector('.position').textContent;
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
  check('方向键向前翻页',root.querySelector('.position').textContent!==before);
  const input=document.querySelector('.composer textarea,.composer [contenteditable=true]'); input.focus();
  const stable=root.querySelector('.position').textContent;
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
  check('输入框方向键不被拦截',root.querySelector('.position').textContent===stable);
  root.querySelector('[data-action=one]').click(); await wait();
  check('单页切换',root.querySelectorAll('.leaf').length===1);
  root.querySelector('[data-action=settings]').click();
  const size=root.querySelector('[name=size]');size.value='24';size.dispatchEvent(new Event('input',{bubbles:true}));await wait();
  check('字号设置生效',getComputedStyle(root.querySelector('.spread .paper-content')).fontSize==='24px');
  check('仅保存排版设置',JSON.parse(localStorage.getItem('bookReaderSettings')).size===24 && !JSON.stringify(localStorage).includes('全文结束'));
  const theme=root.querySelector('[name=theme]');theme.value='dark';theme.dispatchEvent(new Event('input',{bubbles:true}));await wait();
  check('夜间纸张设置',root.querySelector('.reader').dataset.theme==='dark');
  const update=document.createElement('p');update.textContent='【流式更新测试】';source.append(update);await wait();
  check('原回答变化提示刷新',!root.querySelector('.notice').hidden);
  root.querySelector('[data-action=refresh]').click();await wait();
  check('手动更新关闭提示',root.querySelector('.notice').hidden);
  root.querySelector('[data-action=close]').click();
  check('退出精确恢复正文原样及样式',source.getAttribute('style')===originalStyle && source.innerHTML===original+update.outerHTML);
  check('退出后固定入口仍可用',!!entry.querySelector('.launch') && !root.querySelector('.reader'));
  update.remove();
  // The workspace displays exactly one answer at a time.
  await openFor(first);root.querySelector('[data-action=close]').click();await openFor(second);
  check('切换回答时单独阅读且不混合正文',!!secondRoot.querySelector('.reader') && !root.querySelector('.reader') && !secondRoot.querySelector('.spread').textContent.includes('让阅读，回到'));
  secondRoot.querySelector('[data-action=close]').click();
  // A response arriving later must gain its own launcher.
  const dynamic=document.createElement('div');dynamic.dataset.messageAuthorRole='assistant';dynamic.innerHTML='<div class="markdown"><p>新回答</p></div>';second.after(dynamic);await wait();
  check('新回答自动出现入口',!!dynamic.querySelector('[data-book-reader]'));dynamic.remove();
  return {passed:results.filter(r=>r.passed).length,total:results.length,results};
};
