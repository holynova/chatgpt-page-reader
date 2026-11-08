(() => {
  'use strict';
  function find() {
    return document.querySelector('[data-composer-markdown][contenteditable="true"],#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea[name="prompt"]');
  }
  const value = editor => editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
  const pause = () => new Promise(resolve => setTimeout(resolve,50));
  async function submit(text) {
    const editor = find();
    if (!editor) return {ok:false,error:'未找到 ChatGPT 输入框'};
    if (document.querySelector('[data-testid="stop-button"],button[aria-label="停止生成"],button[aria-label="Stop generating"]')) return {ok:false,error:'请等待当前回答完成'};
    const draft = value(editor).trim();
    if (draft && draft !== text.trim()) return {ok:false,error:'ChatGPT 输入框已有草稿，请先处理'};
    editor.focus({preventScroll:true});
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,text);
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:text}));
    } else {
      const selection = getSelection(); const range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      // Native editing keeps ProseMirror's DOM observer, input handlers and undo stack in sync.
      if (!document.execCommand('insertText',false,text)) return {ok:false,error:'无法填入问题，草稿已保留'};
    }
    const container = editor.closest('form,fieldset') || document;
    let send;
    for (let i=0;i<24;i++) {
      send = container.querySelector('button[type="submit"],button[data-testid="send-button"]');
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') break;
      await pause();
    }
    if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return {ok:false,error:'发送按钮不可用，问题已保留在原输入框'};
    if (value(editor).trim() !== text.trim()) return {ok:false,error:'输入框内容发生变化，未发送'};
    send.click();
    for (let i=0;i<24;i++) {
      if (!editor.isConnected || !value(editor).trim()) return {ok:true};
      await pause();
    }
    return {ok:false,error:'请退出阅读，在原输入框确认是否已发送'};
  }
  globalThis.BookComposer = {find,submit};
})();
