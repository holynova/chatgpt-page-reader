globalThis.runReaderEdgeTests = async function () {
  const results = [];
  const check=(name,passed,details)=>results.push({name,passed:!!passed,...(!passed?{details}: {})});
  const wait=()=>new Promise(r=>setTimeout(r,250));
  const host=document.querySelector('[data-book-reader="host"][data-book-source="source"]');const root=host.shadowRoot;
  if(!root.querySelector('.reader')){
    document.querySelector('#source').scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-80,behavior:'instant'});
    document.querySelector('[data-book-reader="entry"]').shadowRoot.querySelector('.launch').click();
  }await wait();
  root.querySelector('[data-action=two]').click();await wait();
  const r=root.querySelector('.reader').getBoundingClientRect();
  check('阅读器位于主内容区内',r.left>=document.querySelector('main').getBoundingClientRect().left && r.right<=innerWidth,{left:r.left,right:r.right,viewport:innerWidth});
  check('窄窗口自动单页',root.querySelector('.reading').getBoundingClientRect().width>=800?root.querySelectorAll('.leaf').length===2:root.querySelectorAll('.leaf').length===1);
  root.querySelector('[data-action=ask]').click();
  check('书内输入框与翻页控件互不遮挡',root.querySelector('.navigation').getBoundingClientRect().bottom<=root.querySelector('.ask').getBoundingClientRect().top && root.querySelector('.bottom').getBoundingClientRect().bottom<=innerHeight);
  root.querySelector('[data-action=ask]').click();
  const beforeSettings=root.querySelector('.bottom').getBoundingClientRect().bottom;
  root.querySelector('[data-action=settings]').click();
  check('排版面板不推移书页与翻页控件',root.querySelector('.bottom').getBoundingClientRect().bottom===beforeSettings);
  root.querySelector('[data-action=settings]').click();
  const sx=scrollX,sy=scrollY;root.querySelector('[data-action=next]').click();
  check('翻页不移动网页',scrollX===sx && scrollY===sy);
  let found=false;let pages=0;
  while(pages++<200){
    const img=root.querySelector('.spread img');
    if(img){
      const paper=img.closest('.paper-content');
      check('图片整体适配书页',img.getBoundingClientRect().height<=paper.clientHeight && img.getBoundingClientRect().width<=paper.clientWidth);
      img.click();check('图片可放大',!!root.querySelector('dialog')?.open);root.querySelector('dialog button').click();found=true;break;
    }
    const next=root.querySelector('[data-action=next]');if(next.disabled)break;next.click();
  }
  check('图片没有丢失',found);
  // Isolate the paginator with pathological content, independent of ChatGPT markup.
  const measure=root.querySelector('.measure');
  const source=document.createElement('div');
  source.innerHTML='<p>安全正文<a href="javascript:alert(1)" onclick="alert(1)">危险链接</a><script>bad()</script><button>移除按钮</button></p><table><thead><tr><th>标题</th></tr></thead><tbody><tr><td rowspan="2">'+('跨行单元格'.repeat(300))+'</td><td>保持结构</td></tr><tr><td>第二行</td></tr></tbody></table><table><tbody><tr><td>普通行</td></tr></tbody><tfoot><tr><td>表格尾部</td></tr></tfoot></table>';
  const blocks=BookPaginator.extract(source);
  check('提取内容移除可执行属性与脚本',blocks.every(n=>!n.querySelector('script,button,[onclick],[href^="javascript:"]')));
  const paginated=BookPaginator.paginate(blocks,measure);const wrapper=document.createElement('div');for(const page of paginated)wrapper.append(page.cloneNode(true));
  check('跨行超大表格保留结构并有局部滚动',!!wrapper.querySelector('.oversized [rowspan="2"]'));
  check('表格尾部保留为表格',!!wrapper.querySelector('table > tfoot') && wrapper.textContent.includes('表格尾部'));
  const over=root.querySelector('[data-action=prev]');while(!over.disabled)over.click();
  return {viewport:innerWidth,passed:results.filter(r=>r.passed).length,total:results.length,results};
};
