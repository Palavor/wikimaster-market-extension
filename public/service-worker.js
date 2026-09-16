chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

async function sendToWikiMastersTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(`Content script indisponible (${error.message})`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'COLLECTION_STATUS') {
    chrome.storage.local.set({ wikiMastersCollectionStatus: message.payload });
    chrome.runtime.sendMessage({ type: 'WIKIMASTERS_AUTH_STATUS', payload: message.payload }).catch(() => undefined);
    return false;
  }

  if (message?.type === 'WIKIMASTERS_PRICE_UPDATE') {
    chrome.runtime.sendMessage({ type: 'WIKIMASTERS_PRICE_UPDATE', payload: message.payload }).catch(() => undefined);
    return false;
  }

  if (message?.type === 'CHECK_BIDDING_NOTIFICATIONS') {
    const auctions = Array.isArray(message.payload?.auctions) ? message.payload.auctions : [];
    chrome.storage.local.get({ wikiMastersNotifiedOutbids: {} }).then(({ wikiMastersNotifiedOutbids }) => {
      const notified = wikiMastersNotifiedOutbids && typeof wikiMastersNotifiedOutbids === 'object' ? wikiMastersNotifiedOutbids : {};
      const nextNotified = { ...notified };
      auctions.forEach((auction) => {
        if (!auction?.outbid || !auction.id) return;
        const marker = `${auction.id}:${auction.currentBid ?? auction.highestBid ?? 0}`;
        if (nextNotified[auction.id] === marker) return;
        nextNotified[auction.id] = marker;
        chrome.notifications.create(`wikimasters-outbid-${auction.id}`, {
          type: 'basic',
          title: 'Vous avez été surenchéri',
          message: `${auction.name || 'Une carte surveillée'} est maintenant à ${auction.currentBid ?? auction.highestBid ?? 0} Wikibidous.`,
          iconUrl: 'icon.svg',
        });
      });
      return chrome.storage.local.set({ wikiMastersNotifiedOutbids: nextNotified });
    }).catch(() => undefined);
    return false;
  }

  if (message?.type === 'OPEN_WIKIMASTERS_LOGIN') {
    chrome.tabs.query({ url: 'https://www.wiki-masters.com/*' })
      .then(async (tabs) => {
        const existingTab = tabs.find((tab) => tab.active) || tabs[0];
        if (!existingTab?.id) {
          const tab = await chrome.tabs.create({ url: 'https://www.wiki-masters.com/collection' });
          return { ok: true, tabId: tab.id, reused: false, authenticated: false };
        }

        await chrome.tabs.update(existingTab.id, { active: true });
        if (existingTab.windowId !== undefined) await chrome.windows.update(existingTab.windowId, { focused: true });
        try {
          const status = await sendToWikiMastersTab(existingTab.id, { type: 'GET_COLLECTION' });
          return { ok: true, tabId: existingTab.id, reused: true, authenticated: status?.requiresLogin === false };
        } catch {
          return { ok: true, tabId: existingTab.id, reused: true, authenticated: false };
        }
      })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'GET_COLLECTION') {
    if (!sender.tab?.id) {
      sendResponse({ isCollectionPage: false, requiresLogin: false, cards: [], error: 'Onglet WikiMasters introuvable' });
      return false;
    }
    sendToWikiMastersTab(sender.tab.id, message)
      .then((result) => sendResponse(result || { isCollectionPage: false, requiresLogin: false, cards: [] }))
      .catch((error) => sendResponse({ isCollectionPage: false, requiresLogin: false, cards: [], error: error.message }));
    return true;
  }

  if (message?.type === 'CREATE_AUCTION') {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const activeTab = tabs.find((tab) => tab.id && tab.url?.startsWith('https://www.wiki-masters.com/'));
      if (!activeTab?.id) throw new Error('Ouvrez une page WikiMasters dans l’onglet actif');
      return sendToWikiMastersTab(activeTab.id, message);
    })
      .then((result) => sendResponse(result || { ok: false, error: 'Réponse vide de WikiMasters' }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'PLACE_BID') {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const activeTab = tabs.find((tab) => tab.id && tab.url?.startsWith('https://www.wiki-masters.com/'));
      if (!activeTab?.id) throw new Error('Ouvrez une page WikiMasters dans l’onglet actif');
      return sendToWikiMastersTab(activeTab.id, message);
    })
      .then((result) => sendResponse(result || { ok: false, error: 'Réponse vide de WikiMasters' }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FETCH_CARD_PRICE') {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const activeTab = tabs.find((tab) => tab.id && tab.url?.startsWith('https://www.wiki-masters.com/'));
      if (!activeTab?.id) throw new Error('Ouvrez une page WikiMasters dans l’onglet actif');
      return sendToWikiMastersTab(activeTab.id, message);
    })
      .then((result) => sendResponse(result || { ok: false, error: 'Réponse vide de WikiMasters' }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== 'ANALYZE_WIKIMASTERS_API' && message?.type !== 'ANALYZE_MARKETPLACE_API' && message?.type !== 'ANALYZE_SALES_API') return false;

  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs.find((tab) => tab.id && tab.url?.startsWith('https://www.wiki-masters.com/'));
    if (!activeTab?.id) throw new Error('Ouvrez une page WikiMasters dans l’onglet actif');
    return sendToWikiMastersTab(activeTab.id, message);
  }).then((result) => {
    sendResponse(result || { ok: false, error: 'Réponse vide de WikiMasters' });
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message || 'Impossible de joindre la page WikiMasters' });
  });

  return true;
});
