'use strict';

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;
  async function status(text) {
    await chrome.action.setBadgeText({tabId:tab.id,text:text ? '!' : ''});
    await chrome.action.setTitle({tabId:tab.id,title:text || '分页阅读当前回答'});
  }
  try {
    // activeTab is deliberately used only on the two supported ChatGPT hosts.
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
      await status('请先打开 ChatGPT 中的一条回答'); return;
    }
    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id,{type:'book-reader:open'});
    } catch {
      // Tabs opened before installation do not yet have a content script.
      await chrome.scripting.executeScript({
        target:{tabId:tab.id},files:['styles.js','paginator.js','content.js']
      });
      result = await chrome.tabs.sendMessage(tab.id,{type:'book-reader:open'});
    }
    await status(result?.ok ? '' : '没有找到回答，请打开一个 ChatGPT 对话后重试');
  } catch {
    await status('无法启动，请刷新 ChatGPT 页面后重试');
  }
});
