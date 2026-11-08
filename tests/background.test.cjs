const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const script=fs.readFileSync(require('node:path').join(__dirname,'../extension/background.js'),'utf8');
function fixture(replies) {
  const calls=[];let click;
  const chrome={
    action:{onClicked:{addListener(fn){click=fn;}},async setBadgeText(v){calls.push(['badge',v]);},async setTitle(v){calls.push(['title',v]);}},
    tabs:{async sendMessage(id,message){calls.push(['send',id,message]);const next=replies.shift();if(next instanceof Error)throw next;return next;}},
    scripting:{async executeScript(v){calls.push(['inject',v]);}}
  };
  vm.runInNewContext(script,{chrome});return {click,calls};
}
test('已加载的回答由工具栏直接启动，无重复注入',async()=>{
  const f=fixture([{ok:true}]);await f.click({id:12,url:'https://chatgpt.com/c/test'});
  assert.equal(f.calls.filter(c=>c[0]==='send').length,1);assert.ok(!f.calls.some(c=>c[0]==='inject'));
  assert.equal(f.calls.find(c=>c[0]==='badge')[1].text,'');
});
test('安装前打开的页面自动补注入后启动',async()=>{
  const f=fixture([new Error('No receiving end'),{ok:true}]);await f.click({id:12,url:'https://chatgpt.com/c/test'});
  const inject=f.calls.find(c=>c[0]==='inject')[1];assert.equal(inject.target.tabId,12);
  assert.equal(inject.files.join(','),'styles.js,paginator.js,composer.js,catalog.js,content.js');assert.equal(f.calls.filter(c=>c[0]==='send').length,2);
});
test('非ChatGPT域名不注入，即使点击工具栏已授予activeTab',async()=>{
  for(const url of ['https://example.com/','https://chatgpt.com.evil.example/','file:///tmp/chatgpt.com']){
    const f=fixture([]);await f.click({id:12,url});assert.ok(!f.calls.some(c=>['send','inject'].includes(c[0])));
    assert.equal(f.calls.find(c=>c[0]==='badge')[1].text,'!');
  }
});
test('空对话有明确状态反馈',async()=>{
  const f=fixture([{ok:false}]);await f.click({id:12,url:'https://chatgpt.com/'});
  assert.match(f.calls.find(c=>c[0]==='title')[1].title,/没有找到回答/);
});
test('注入后依旧不能通信时提示刷新',async()=>{
  const f=fixture([new Error('missing'),new Error('failed')]);await f.click({id:12,url:'https://chatgpt.com/c/test'});
  assert.match(f.calls.find(c=>c[0]==='title')[1].title,/刷新/);
});
